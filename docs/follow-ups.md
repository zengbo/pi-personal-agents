# 后续

Phase 1 评审时记下的后续。沙箱边界保持原样。上下文压缩已经用 pi-durable 的内置策略做完。主人接受继续搁置的是：ops 的 exec 可以绕过 `git_push` 审批，以及会话列表只有 root。retry 仍关闭，这项待确认。部署还有两件必须先定的事，见文末。

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

## set_runtime 两个方向都要审批

规格点名的是 runsc → crun。实现里换回 runsc 也要审批。两个方向都问，比规格更严。

## 未解决，部署前必须先定

细节和操作说明在 [docs/deployment.md](deployment.md) 第 12 节。候选都不改这三项：`NoNewPrivileges` 保持 `yes`，`ProtectSystem` 保持 `strict`，工作区父目录保持最多 `0750`、agentctl 只有 `r`/`x`。下面不选定哪一条。

### runsc 的 set-property

`createPodmanDriver` 在 uid 不是 1001 时用 `runuser -u sbx` 执行 `systemctl --user set-property`。服务是 `User=agentctl`（uid 1000）并且 `NoNewPrivileges=yes`，这次 `runuser` 失败。失败则容器被 stop 且不会 start，所以 runsc 档起不来。

候选：

- 单独一个 `User=sbx` 的辅助单元，在 sbx 自己的用户会话里执行 `set-property`。agentctl 把容器 id 交给它，交接用的本地套接字只允许 `agentctl` 连接。
- 把 `set-property` 放在 sbx 已经拥有的用户会话里完成，agentctl 进程里不调用 `runuser`。
- 在这件事情定下来之前，只启用 crun 档。

### 会话工作区叶子

`ProtectSystem=strict` 的 `ReadWritePaths` 没有 `/home/sbx/workspaces`。父目录属主是 `sbx`、模式 `0750`，agentctl 只有 `r`/`x` ACL。`ensureWorkspace` 因此创建不了 `<bot>/<session>` 叶子。

候选：

- 由 uid 1001 的辅助进程创建叶子并设成 `0777`。agentctl 只使用已经存在的叶子。
- 部署时由 `sbx` 为会用到的会话预先建好叶子，至少包括每个 bot 的 root 会话。
- 叶子不存在时由 sbx 的用户会话创建；controller 在叶子缺失时失败并记日志，不自己 `mkdir`。
