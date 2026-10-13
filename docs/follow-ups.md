# 后续

Phase 1 评审时记下、这一阶段先不做的事。沙箱边界保持原样，这里没有放宽。

## ops 的 exec 可以绕过 git_push

`ops` 默认允许 `exec`。模型可以在工作区里跑 `git push` 或 `curl`，不经过要审批的 `git_push` 工具。缓解是沙箱里没有 git 凭据，出站只走 tinyproxy 的允许名单。Phase 3 再收紧。

## compaction 和 retry 关着

`startController` 把两项都关掉。测试和生产走同一条路径，所以生产现在也是关的。

## 会话列表只有 root

`listConversations` 只返回 root。按会话分容器的隔离在 `SandboxExecutionEnv` 的单元测试里，没有端到端覆盖。

## 待审批只在内存里

未完成的审批卡只在进程内存里。崩溃后这些卡消失，恢复时按拒绝处理（fail-closed），不会当成已批准。

## set_runtime 两个方向都要审批

规格点名的是 runsc → crun。实现里换回 runsc 也要审批。两个方向都问，比规格更严。
