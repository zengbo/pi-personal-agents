# 后续

Phase 1 评审时记下的后续。沙箱边界保持原样。上下文压缩已经用 pi-durable 的内置策略做完。主人接受继续搁置的是：ops 的 exec 可以绕过 `git_push` 审批，以及会话列表只有 root。retry 仍关闭，这项待确认。原先两个部署阻塞项已经按文末的选择解决。

## ops 的 exec 可以绕过 git_push

主人接受继续搁置。`ops` 默认允许 `exec`。模型可以在工作区里跑 `git push` 或 `curl`，不经过要审批的 `git_push` 工具。缓解是沙箱里没有 git 凭据，出站只走 tinyproxy 的允许名单。Phase 3 再收紧。

## 上下文压缩已开启

`startController` 使用 pi-durable 1.1.0 的内置策略 `DEFAULT_COMPACTION_POLICY`（`enabled: true`，`reserveTokens` 16384，`keepRecentTokens` 20000，`backgroundTokens` 32768）。生成准备阶段若上下文超过 `contextWindow - reserveTokens`，会先做阻塞式摘要，再发下一次模型请求。摘要写入 `pi.compaction` 条目。系统提示由 sections 在下次请求重新渲染。`selectCut` 不会在 tool call 和它的 result 中间切开，也不会切开仍有未完成 result 的 user 条目。审批规则在 `policy.sqlite`，不在对话记录里，压缩不会改写它们。

崩溃恢复沿用原来的 replay 规则：`exec` 是 unsafe，压缩之后杀掉进程也不会把同一次 exec 再跑一遍。测试把阈值和 faux 的 `contextWindow` 调低，生产路径仍是上面的默认策略。

## retry 仍然关闭（待确认）

这项还没有主人确认。当前 `retry` 是 `{ enabled: false, maxRetries: 0, baseDelayMs: 0 }`。模型失败不会自动再请求。

## 会话列表只有 root

主人接受继续搁置。`listConversations` 只返回 root。按会话分容器的隔离在 `SandboxExecutionEnv` 的单元测试里，没有端到端覆盖。

## 待审批只在内存里

未完成的审批卡只在进程内存里。崩溃后这些卡消失，恢复时按拒绝处理（fail-closed），不会当成已批准。

## set_runtime

规格点名的是 runsc → crun，两个方向都要审批。现在 runsc 不可选，所以没有方向可切。`set_runtime` 仍在危险工具名单里；请求 crun 仍要审批。请求 runsc 直接拒绝，消息是 `runsc is disabled until a set-property path exists`。重新启用之后，两个方向仍要审批。

## 部署阻塞项已按这个选择解决

细节在 [docs/deployment.md](deployment.md) 第 12 节和第 2.1 节。`NoNewPrivileges` 保持 `yes`，`ProtectSystem` 保持 `strict`，工作区父目录保持最多 `0750`、agentctl 只有 `r`/`x`。controller 的 `ReadWritePaths` 没有工作区。

### 只用 crun

生产默认 runtime 是 crun，也是唯一会启动的 runtime。启动流程不调用 `runuser`，也不做 `set-property`。crun 的 `cap_drop ALL`、`no_new_privileges`、只读根、内存 / pids / cpu（Podman 自己的参数）、pasta、tinyproxy 白名单、nft 都保持。

### runsc 重新启用（后续）

要有一条不从 agentctl 进程 `runuser` 的 set-property 路径，并在 start 之前设置 `MemoryMax=768M`、`TasksMax=256`、`CPUQuota=100%`（`RUNSC_SCOPE_PROPERTIES`）。在那之前 runsc 不能被选中，也不能启动。

### 会话叶子由 sbx helper 创建

`sbx-workspace.socket` 拉起 `User=sbx` 的服务。它只用 openat 在 `/home/sbx/workspaces/<bot>` 下创建会话叶子，模式 `0700`，属主 sbx。agentctl 只发请求。父目录仍是 sbx `0750` 加 agentctl 的 `r`/`x` ACL。

叶子是 `0700`、属主 sbx。crun 的 `keep-id:uid=1000,gid=1000` 在 sbx 跑 Podman 时，容器 uid 1000 对应宿主 sbx，所以容器能写这个叶子。会话文件的读、写、列目录、改名和 flush 都在容器里经 exec 完成（不超过 8 MiB 的 `head -c`、原始 stdin 上的 `tee`、`find` / `stat` / `mv`）。路径限制在 `/workspace`，拒绝 `..` 和越界绝对路径，`realpath` 必须落在 `/workspace` 下面。超过 8 MiB 返回 `too_large`。不把叶子改松，也不给 agentctl 加 ACL。agentctl 不在宿主上打开叶子。
