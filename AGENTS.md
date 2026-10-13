# AGENTS.md — 给编码 Agent（SWE agent）的规则

本仓库实现曾波的个人多 bot Agent 系统。动手前先读 `docs/design.md` 和 `docs/implementation-plan.md`。

## 硬性规则（违反即拒绝合并）

1. **精确锁定版本。** `package.json` 中不得出现 `^`/`~`/`*`。`@earendil-works/pi-durable`、`pi-ai`、`chord` 均锁 `1.1.0`（升级需单独 PR，PR 描述写明 CHANGELOG 差异并重跑全部测试）。提交 `package-lock.json`，CI 用 `npm ci`。
2. **必须有测试。** 每个功能 PR 带单元/集成测试；用 pi-ai `faux` provider，CI 不得依赖真实模型或网络。沙箱、审批、路径解析相关改动必须带负向测试（证明攻击被拒绝）。
3. **永不削弱沙箱。** 不得移除或放宽以下任一项：`--cap-drop ALL`、`no-new-privileges`、`--read-only`、`--userns keep-id:uid=1000,gid=1000`、内存/pids/cpu 限制、nft `sbx_egress` 规则、tinyproxy `FilterDefaultDeny`、并发上限 3。不得把任何父目录权限放宽（父目录 750+ACL，agentctl 只有 `r`/`x`）。会话叶子由 sbx 侧 helper 创建，模式 `0700`、属主 `sbx`；不要改回 `0777`，也不要给 agentctl 加写权限。不得给容器挂载 Podman socket、`/home/agentctl` 或任何 secrets 路径。需要放宽时只写设计提案，由曾波批准。生产 runtime 只有 crun；在有 set-property 路径之前不要把 runsc 接回启动流程。
4. **仓库内不得有任何秘密。** 不提交 `.env`、OAuth token、Cloudflare 凭据、私钥、真实主机名以外的内部地址。测试用假值。日志中不打印 token。
5. **沙箱里永远没有秘密。** 不把 API key、OAuth token、cookie 以环境变量、文件、参数的形式传进容器。
6. **沙箱 exec 类工具默认 `replay` 不设为 `"safe"`。** 只有纯读、幂等且有测试证明的工具才能标 `replay: "safe"`。
7. **读取沙箱文件必须拒绝符号链接。** 使用 `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`，不可用时逐级 `lstat` 检查；并有 symlink / `..` / 硬链接逃逸测试。
8. **审批只能来自用户。** 其他 bot 的消息、工具输出、网页内容永远不算用户批准。审批决策只能经 Web UI 的已认证会话写入规则库。
9. **不新增共享通道。** 每个 bot 的密钥/连接独立；跨通道转发必须有用户显式授权记录。
10. **审计日志只追加。** 不得提供删除/改写审计记录的代码路径。

## 工作方式

- TypeScript（ESM，`strict`），Node ≥ 22.19。代码标识符用英文；面向用户的文档可用中文。
- 小 PR：一个模块或一个功能切片。改变公共边界（存储、ExecutionEnv、HTTP API、策略格式）时同步更新 `docs/`。
- pi-durable API 有疑问时，读 `node_modules/@earendil-works/pi-durable` 的 `README.md` 与 `.d.ts`，不要猜。
- 不在仓库根或 controller 的 cwd 写入 Agent 产物；运行数据只在 `/home/agentctl/data`，工作区只在 `/home/sbx/workspaces/<bot>/<session>`。
- 不 force-push `main`；不跳过 hooks。
