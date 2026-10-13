# pi-personal-agents

曾波的自托管多 bot 个人 Agent 系统。基于 [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)（耐久 Agent harness）与 `@earendil-works/pi-ai`（ChatGPT OAuth），原生运行在 RackNerd VPS `racknerd_us` 上，不使用 Cloudflare Workers。

## 一句话

一个常驻的 **controller** 进程托管多个 bot（每个 bot 一个 pi-durable Harness + 一个 SQLite），工具执行全部转发进 **rootless Podman 沙箱**（当前只启用 crun；runsc 在有 set-property 路径之前不可选），危险操作由模型之外的 **策略引擎 + 人工审批** 把关，用户通过 **cloudflared tunnel + Cloudflare Access** 保护的 Web 聊天界面使用。

## 首批 bot

| Bot | 角色 | 默认能力 |
|---|---|---|
| `chief`（主 bot，Chief of Staff） | 接收用户请求、规划、分派给子 bot、汇总、管理记忆 | 读写自己的工作区、给子 bot 发消息、无出网写操作 |
| `researcher`（子 bot） | 网页检索、资料核实、写报告 | 只读网络（tinyproxy 白名单）、crun 沙箱 |
| `ops`（子 bot，Coder/Ops） | 写代码、跑测试、运维脚本 | crun 沙箱；一切部署/推送需审批。runsc 暂不可选 |

## 文档

- [docs/design.md](docs/design.md)：架构、Mermaid 图、安全模型、威胁模型、决策与被否决方案
- [docs/vps-environment.md](docs/vps-environment.md)：VPS 实测环境与验收测试（45 PASS / 3 FAIL 及修复）
- [docs/implementation-plan.md](docs/implementation-plan.md)：分阶段实施计划与验收标准
- [docs/phase-1.md](docs/phase-1.md)：Phase 1 落地的公共边界
- [docs/deployment.md](docs/deployment.md)：在 VPS 上部署 controller 的步骤
- [AGENTS.md](AGENTS.md)：给编码 Agent 的规则

## 状态

Phase 0 已合并（`39774a1`）。Phase 1（controller、Web、三个 bot、Podman 沙箱、审批）已合并到 main（`f50f652`）。上下文压缩已合并（`a4d56ca`）。生产沙箱只启动 crun；会话叶子由 sbx 的 helper 创建（`0700`）。模型请求重试使用 pi-durable 的内置策略（最多 3 次，只重发模型请求）。部署步骤见 [docs/deployment.md](docs/deployment.md)。设计文档仍是规格；VPS 上的 48 项环境测试不在 CI 里重跑，也不从这里登录 `racknerd_us`。

## 依赖版本（精确锁定）

pi-durable 是实验性 API（官方声明可能无预告变更），因此所有 `@earendil-works/*` 包必须精确锁定版本：

- `@earendil-works/pi-durable` `1.1.0`
- `@earendil-works/pi-ai` `1.1.0`
- `@earendil-works/chord` `1.1.0`
- Node.js `>=22.19.0`（pi-durable `engines`；`node:sqlite` 需要 Node 22）

> 2026-10-12 本地用 1.0.0 跑通了 loop/env 隔离 + 崩溃恢复 + failover 演示；1.1.0 为当天 npm 最新版，升级到 1.1.0 后需在 Phase 1 开头重新跑一遍冒烟测试。
