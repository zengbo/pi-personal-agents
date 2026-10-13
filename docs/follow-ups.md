# 后续

Phase 1 评审时记下的后续。沙箱边界保持原样。上下文压缩已经用 pi-durable 的内置策略做完；retry 和只列出 root 会话这两项主人接受继续搁置。

## ops 的 exec 可以绕过 git_push

`ops` 默认允许 `exec`。模型可以在工作区里跑 `git push` 或 `curl`，不经过要审批的 `git_push` 工具。缓解是沙箱里没有 git 凭据，出站只走 tinyproxy 的允许名单。Phase 3 再收紧。

## 上下文压缩已开启

`startController` 使用 pi-durable 1.1.0 的内置策略 `DEFAULT_COMPACTION_POLICY`（`enabled: true`，`reserveTokens` 16384，`keepRecentTokens` 20000，`backgroundTokens` 32768）。生成准备阶段若上下文超过 `contextWindow - reserveTokens`，会先做阻塞式摘要，再发下一次模型请求。摘要写入 `pi.compaction` 条目。系统提示由 sections 在下次请求重新渲染。`selectCut` 不会在 tool call 和它的 result 中间切开，也不会切开仍有未完成 result 的 user 条目。审批规则在 `policy.sqlite`，不在对话记录里，压缩不会改写它们。

崩溃恢复沿用原来的 replay 规则：`exec` 是 unsafe，压缩之后杀掉进程也不会把同一次 exec 再跑一遍。测试把阈值和 faux 的 `contextWindow` 调低，生产路径仍是上面的默认策略。

## retry 仍然关闭

主人接受继续搁置。`retry` 是 `{ enabled: false, maxRetries: 0, baseDelayMs: 0 }`。模型失败不会自动再请求。

## 会话列表只有 root

主人接受继续搁置。`listConversations` 只返回 root。按会话分容器的隔离在 `SandboxExecutionEnv` 的单元测试里，没有端到端覆盖。

## 待审批只在内存里

未完成的审批卡只在进程内存里。崩溃后这些卡消失，恢复时按拒绝处理（fail-closed），不会当成已批准。

## set_runtime 两个方向都要审批

规格点名的是 runsc → crun。实现里换回 runsc 也要审批。两个方向都问，比规格更严。
