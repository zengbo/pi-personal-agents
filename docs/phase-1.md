# Phase 1：controller、Web、三个 bot、沙箱、审批

Phase 0 的规格仍以 `docs/design.md` 与 `docs/implementation-plan.md` 为准。本文只记录这一阶段落地的公共边界，以及和规格不完全相同的地方。

## 进程

`ops/systemd/agentctl-controller.service` 的 `ExecStart` 是：

```text
/usr/bin/node --experimental-strip-types /home/agentctl/app/src/controller.ts
```

不生成 `dist/`。启动顺序是拿 flock → `Harness.open` → 安装扩展 → `resume` → 只在 `127.0.0.1` 上听 HTTP。每个 bot 一个 SQLite（`<data>/<bot>.sqlite`）和一把 flock。持锁进程单独成组，并在 controller 的 pid 消失后退出，所以 `SIGKILL` 不会把锁留住。

每个 bot 打开 pi-durable 自带的 compaction（`DEFAULT_COMPACTION_POLICY`）。超过上下文窗口减去 `reserveTokens` 时，生成会先摘要再继续。retry 仍是关的（`enabled: false`，`maxRetries: 0`，`baseDelayMs: 0`）。压缩已经落地。只列出 root 会话这一项主人接受继续搁置；retry 仍关闭，待确认。见 `docs/follow-ups.md`。

会话列表只返回 root。`Harness` 没有 `scanConversations`（那是 Storage 上的方法），fork 出来的会话还没接到 Web。

## 环境变量

占位符在 `.env.example`。没有真实团队、密钥或 tunnel 凭据。

| 变量 | 作用 |
|---|---|
| `CLOUDFLARE_ACCESS_AUD` | JWT `aud`，必填 |
| `CLOUDFLARE_ACCESS_JWKS_URL` | RS256 JWKS，必填。启动时拉取，失败则进程退出。之后每 10 分钟刷新；未知 `kid` 再拉一次，两次至少隔 30 秒。刷新失败保留已有密钥并记一行不含 token 的日志，不让未处理的 rejection 退出进程。未知 `kid` 再拉失败仍是 401 |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN` | 必填，拼成 `iss`（`https://<domain>`），每次都校验 |
| `CLOUDFLARED_HOSTNAME` | 必填。POST 和 WebSocket 的 `Origin` 必须等于 `https://<hostname>` |
| `PPA_OWNER_EMAIL` | 必填。JWT `email` 必须与它完全一致，审批人只记这个邮箱 |
| `PPA_DATA_DIR` | 默认 `/home/agentctl/data` |
| `PPA_SECRETS_DIR` | 默认 `/home/agentctl/secrets` |
| `PPA_WORKSPACE_ROOT` | 默认 `/home/sbx/workspaces` |
| `PPA_PORT` | 默认 `8787` |
| `PPA_MODEL_ID` | 默认 `gpt-5.1` |

`PPA_BIND` 只是文档里的说明。代码拒绝除 `127.0.0.1` 以外的监听地址。

## HTTP

全部要求 Access JWT：请求头 `Cf-Access-Jwt-Assertion`，或 cookie `CF_Authorization`。缺失、算法不是 RS256、签名、`aud`、`iss`、`exp`、`nbf`、`iat`、`email` 任一失败都是 401。`iss` 必须等于 `https://<CLOUDFLARE_ACCESS_TEAM_DOMAIN>`。`nbf` 和 `iat` 必须是数字，比控制器时钟超前超过 60 秒就拒绝。过期（`exp`）没有这 60 秒的宽限。`email` 缺失、为空、或不是 `PPA_OWNER_EMAIL` 都拒绝，不会退回成 `"user"`。

POST（审批、提交、登录码）和 WebSocket 升级还要 `Origin` 与 `https://<CLOUDFLARED_HOSTNAME>` 完全一致，包括带着 JWT 头的请求。缺 Origin 或别的站点是 403，而且先于 JWT 检查。GET 不查 Origin。审批和提交的正文必须是 JSON 对象，坏 JSON 是 400 `bad json`，不会把异常抛出进程。WebSocket 上的坏 JSON 只关掉那条连接。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` | 中文单页：bot、流式记录、转向、审批卡、审计链接 |
| GET | `/login` | 一次性 ChatGPT 登录页，不渲染 token |
| POST | `/login/code` | 表单字段 `code` |
| GET | `/api/bots` | `{ bots }` |
| GET | `/api/bots/:bot/conversations` | `{ conversations: [{ id: "root" }] }` |
| POST | `/api/bots/:bot/conversations/:id/submit` | JSON：`content`、`requestId`、可选 `whenBusy`（`steer` 或 `followUp`） |
| GET | `/api/approvals` | 未过期的审批卡 |
| POST | `/api/approvals/:id` | `{ decision: "allow_once" \| "allow_always" \| "deny" }` |
| GET | `/api/audit` | 审计 JSONL 的当前内容 |

WebSocket 任意路径升级，同样要上面的 Origin。客户端发 `{ type: "watch", bot, conversationId }` 收 `view` 与 `approvals`；`submit` 与 HTTP 相同；`decide` 用 JWT 里的 email 当用户会话。服务端帧不打码。浏览器页靠 Access cookie，因为页面里的 `WebSocket` 不能加自定义头。

## 策略

规则表在 `<data>/policy.sqlite`，只插入。审计是 `<data>/audit.jsonl`，只 `appendFileSync`，并尝试一次 `chattr +a`。

默认允许：`read_file`、`search_notes`、`delegate`。`ops` 另外允许 `write_file` 和 `exec`（都限制在该会话的 `/workspace` 里）。下面这些工具要审批：`send_external`、`git_push`、`deploy`、`pay`、`delete_outside`、`add_egress_domain`、`set_runtime`、`forward_channel`。其它名字直接拒绝。

只有 `actor.kind === "user"` 且带非空 `sessionId` 的决定能通过。其它 bot 的“已批准”会记一条 `untrusted` 审计，不会写规则。`allow_always` 才插入规则。过期或异常都拒绝。决定记在 `api.memo("approval:<taskId>")`，恢复时不重复询问。

`set_runtime` 仍要审批。runsc 当前不可选：请求 runsc 会被拒绝，不会记成运行时。重新启用之后，规格里的两个方向仍都要审批。

## 沙箱

并发最多 3。第 4 个进 FIFO 队列，`AbortSignal` 可以取消等待。空闲默认 10 分钟后 stop，工作区保留。生产只启动 crun：create 然后 start，不调用 `runuser`，也不做 `set-property`。runsc 在有 set-property 路径之前不启动。crun 的内存、pids、cpu 限制在 Podman spec 上，没有放宽。

容器 spec：`cap_drop: ["ALL"]`、`no_new_privileges`、只读根文件系统、`keep-id:uid=1000,gid=1000`、内存和 swap 各 768MiB、pids 256、cpu quota/period 100000、不继承宿主环境、不挂代理以外的秘密、bind 只挂会话叶子到 `/workspace`。父目录 0750，agentctl 只有 `r`/`x` ACL。会话叶子由 sbx helper 创建，模式 `0700`，属主 sbx。已经比 0750 松的父目录直接拒绝，不会 chmod 放宽。controller 不 `mkdir` 叶子，单元的 `ReadWritePaths` 也不包含工作区。

会话文件的读、写、列目录、改名和 flush 在容器内 exec 完成。路径限制在 `/workspace`，拒绝 `..` 和越界绝对路径，`realpath` 必须落在 `/workspace` 下。指向工作区外的符号链接、硬链接都不返回文件内容。controller 不打开叶子。helper 创建叶子仍用宿主 `python3` 调 `openat2`。`ops/tests/path-escape-check.ts` 仍覆盖这条创建侧的 openat2 库，CI 断言当前内核走的是 openat2。

`ops/tests/sandbox-env.sh` 被直接执行（含 `--list`）时，只要 `SBX_NFT_SNAPSHOT`、`SBX_TINYPROXY_CONF`、`SBX_LISTEN_SNAPSHOT`、`SBX_WORKSPACE_ROOT`、`SBX_SLICE_LIMITS` 任一非空就退出 1。单元测试 source 这个文件之后仍然可以设置这些变量。第 4 个沙箱的排队在 controller 的池里测，不在 VPS 脚本里补。

## 工具 replay

`read_file`、`search_notes`、`delegate` 是 `replay: "safe"`。`delegate` 的子提交用 `requestId = delegate:<taskId>`，重复提交不会再开一轮。`write_file`、`exec`、`git_push`、`deploy`、`set_runtime` 是 `unsafe`。崩溃后 exec 不自动再跑。

## 测试里没有做的事

CI 不跑真实模型和真实网络，也不 SSH 到 `racknerd_us`。Phase 0 的 48 项主机测试没有在 VPS 上重跑。浏览器手工点选没有接进 CI；Web 行为由 HTTP 与原始 WebSocket 客户端覆盖（页面不能给 `WebSocket` 加 Access 头，测试用升级请求头）。
