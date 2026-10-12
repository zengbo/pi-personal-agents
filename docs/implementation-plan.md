# 实施计划

原则：每阶段可独立上线；每阶段结束前全部验收标准通过；测试用 pi-ai `faux` provider，不依赖真实模型。

## Phase 0：仓库与环境基线（约 1–2 天）

- TypeScript 项目骨架（ESM、strict、vitest、eslint），`package.json` 精确锁定 `@earendil-works/pi-durable@1.1.0`、`pi-ai@1.1.0`、`chord@1.1.0`，Node ≥ 22.19。
- 将 VPS 48 项环境测试脚本纳入 `ops/tests/`；systemd unit 模板（`agentctl-controller.service`）、cloudflared 配置模板（不含凭据）。
- 用 1.1.0 重跑 loop/env 隔离 + 崩溃恢复冒烟测试。

**验收**：`npm ci && npm test` 绿；CI（GitHub Actions）无秘密跑通；VPS 环境测试 48/48 PASS。

## Phase 1：controller + Web + 3 个 bot + 沙箱 + 审批（约 2–3 周）

模块：
1. `controller/`：每 bot 一个 Harness + SQLite（`/home/agentctl/data/<bot>.sqlite`，flock 单写者）；启动顺序 拿锁→open→安装扩展→resume→HTTP；优雅关闭。
2. `auth/`：pi-ai `Models` + ChatGPT OAuth（`openaiChatGPTOAuth`），持久化 `CredentialStore`（`/home/agentctl/secrets`，0600 文件，原子写）；一次性登录页面。
3. `sandbox/`：`SandboxExecutionEnv`（Podman REST API over unix socket），crun/runsc 两档，runsc 先 paused→set-property→start；并发 3 + 队列；空闲停止；symlink 安全读取（openat2 / lstat）。
4. `policy/`：`beforeTool` hook，规则库（allow/ask/deny，once/always，过期），审批请求队列，fail-closed，`api.memo` 持久化，append-only 审计。
5. `bots/`：`chief`（规划、delegate、汇总）、`researcher`（只读网络检索）、`ops`（编码/测试，危险操作需审批）；`delegate` 工具经 controller 以 `requestId` submit 到子 bot 持久 conversation。
6. `web/`：HTTP+WebSocket 绑定 127.0.0.1；校验 Cf-Access JWT；bot 列表、会话、流式（viewState + watch）、steer、审批卡片、审计页。

**验收**：
- 浏览器经 Access 登录后可与 `chief` 对话并实时流式显示；未带 Access JWT 的请求 401。
- `kill -9` controller 后重启：对话与进行中任务恢复；相同 `requestId` 重试不重复提交。
- `chief` 把调研委派给 `researcher`、把编码委派给 `ops`，结果回到 chief；崩溃后委派不重复。
- 每个会话有独立容器与工作区；跨会话文件不可见；第 4 个并发沙箱排队。
- 沙箱 exec 工具在崩溃后不自动重放（模型收到中断通知）。
- 工作区 symlink 指向 `/home/agentctl/secrets` 时读取被拒绝（负向测试）。
- 危险工具弹审批卡；deny/过期 → 工具被阻止；allow always 写入规则；子 bot 发来的“已批准”无效（负向测试）。
- 审计日志可追加不可改写；秘密不出现在 transcript、日志、沙箱（grep 测试）。
- 资源：controller 常驻内存 < 400 MB（3 bot 空闲）。

## Phase 2：调度器（约 1 周）

- `schedules.yaml`（cron 表达式 + 目标 bot + 提示），controller 内 scheduler 或 systemd timer 调本地 API；`requestId = cron:<job>:<slot>`。
- 事件触发入口（webhook，经 Access service token）。
- 无人值守任务中的审批请求按过期 fail closed，并在 Web 通知。

**验收**：重复触发同一时间槽只执行一次；controller 停机期间错过的槽按策略（跳过/补跑一次）处理；审批过期被拒绝并有审计记录。

## Phase 3：记忆整合与出网收紧（约 1–2 周）

- 三层记忆：profile 注入 section、`search_history`/`search_notes`（replay safe）、夜间整合任务生成 diff，用户在 Web 审阅后合并。
- 每 bot 独立 tinyproxy 白名单（不同端口或 ACL），`ops` 默认不含 chatgpt.com；上传类请求（POST/PUT 大 body 到白名单域名）记录并可要求审批。
- 技能：`skills/<name>/SKILL.md` 索引注入 + `load_skill`；Agent 新建/修改技能需审批。

**验收**：profile 修改后下一次请求生效；整合任务不自动写入未审阅内容；`researcher` 无法访问 `ops` 白名单外域名（负向测试）。

## Phase 4：更多通道（约 1–2 周/通道）

- Telegram / 邮件等，每通道绑定单一 bot，独立凭据；通道消息映射到 conversation 或 fork。
- 跨通道转发需用户显式授权规则；默认禁止。

**验收**：一个通道的内容不能在无授权时出现在另一通道（负向测试）；通道凭据不进入沙箱。

## Phase 5：浏览器沙箱（约 2 周）

- 无头浏览器（Chromium/Playwright）在 runsc 档容器中运行，单独镜像 `localhost/sandbox-browser:1`，内存预算单独评估（3.9G 主机可能只允许 1 个并发）。
- 不共享用户真实浏览器登录态；需要登录时由用户在 Web 中显式授权。

**验收**：浏览器容器受同等限制；崩溃不影响 controller；内存超限被杀并报告。

## Phase 6：MCP

- MCP client 作为扩展，MCP server 在沙箱或独立受限进程中运行；每个 MCP 工具纳入策略引擎（默认 ask）。
- MCP 凭据按 bot 隔离存于 secrets。

**验收**：MCP 工具调用经过审批钩子；断开/重连不影响 conversation 恢复。

## 风险与依赖

- pi-durable 实验性 API：锁版本，升级需单独 PR + 全量测试。
- 内存：3.9 GiB 主机；controller + 3×768m 沙箱已接近上限，浏览器沙箱需降低并发。
- 无 KVM：隔离强度上限为 gVisor。
- VPS 期限一年（至 2027-10）：数据目录与配置需可备份迁移（Phase 1 起每日备份 SQLite + memory 到异地）。
