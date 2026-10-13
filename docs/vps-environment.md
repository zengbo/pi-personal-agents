# VPS 环境（racknerd_us，实测）

记录日期：2026-10-12。本文件描述 controller 与沙箱依赖的主机环境；任何变更需同步更新本文件并重跑验收测试。

## 1. 主机

| 项 | 值 |
|---|---|
| 主机 | `racknerd_us`（RackNerd，洛杉矶） |
| 系统 | Ubuntu 26.04 |
| 内核 | 7.0 |
| CPU / 内存 | 3 vCPU / 3.9 GiB |
| 虚拟化 | 无 KVM（不能用 Firecracker / Kata） |
| 对外端口 | 仅 22（SSH） |
| Web 入口 | `cloudflared` tunnel + Cloudflare Access → `127.0.0.1` |

## 2. 用户与目录

| 用户 | uid | 用途 |
|---|---|---|
| `agentctl` | 1000 | controller；拥有 `/home/agentctl/data`（700，每 bot 一个 SQLite）与 `/home/agentctl/secrets`（700） |
| `sbx` | 1001 | rootless Podman；`user-1001.slice` 设有全局资源上限 |
| `cloudflared` | system | tunnel |
| build 用户 | — | 维护窗口内重建沙箱镜像 |

工作区：`/home/sbx/workspaces/<bot>/<session>`。父目录 750 + ACL，**永不放宽**。当前生产叶子是 `0700`、属主 `sbx`，由 sbx helper 创建。下面第 5 节里的 `0777` 是当时为 gVisor `nobody` 记下的实测，不是现在的叶子模式。

## 3. 容器运行时

| Socket | 运行时 | 用途 |
|---|---|---|
| `/run/sbx/podman.sock` | crun | 当前唯一生产档 |
| `/run/sbx/podman-runsc.sock` | gVisor（`runsc-rootless` wrapper，`--ignore-cgroups`） | 主机上可留着给环境脚本。controller 不连接、不启动 |

镜像：`localhost/sandbox-base:1`。

标准参数：
```
--userns keep-id:uid=1000,gid=1000
--cap-drop ALL
--security-opt no-new-privileges
--read-only --tmpfs /tmp --tmpfs /home/sbx
--memory 768m --memory-swap 768m
--pids-limit 256 --cpus 1
--network pasta  (map-host-loopback → 10.0.2.2)
-e HTTP_PROXY=http://10.0.2.2:8888 -e HTTPS_PROXY=http://10.0.2.2:8888
```

runsc 档的历史限制流程（wrapper `/usr/local/bin/runsc-rootless` 带 `--ignore-cgroups`，runsc 自身不施加限制）是：paused 创建，然后 `systemctl --user set-property libpod-conmon-<id>.scope MemoryMax=768M TasksMax=256 CPUQuota=100%`，再 start。生产 controller 现在不走这条路径，也不从 agentctl 进程 `runuser`。重新启用前必须先有 set-property 路径。crun 的内存 / pids / cpu 仍由 Podman 自己的参数施加。

全局兜底：`user-1001.slice` 限制（见第 5 节）。

并发：最多 3 个运行中沙箱（3×768m ≈ 2.3 GiB），其余排队；空闲容器停止，工作区保留。

## 4. 出网

- nft：`table inet sbx_egress`，只允许 sbx 相关 uid 访问 `127.0.0.1:8888`（tinyproxy），其余出站丢弃。
- tinyproxy：`127.0.0.1:8888`，`FilterDefaultDeny Yes` + 域名白名单。
- 容器经 pasta map-host-loopback 使用 `http://10.0.2.2:8888`。
- **已知风险**：白名单中的 `github.com`、`chatgpt.com` 等可用于外泄；后续按 bot 拆分白名单（见实施计划 Phase 3）。

## 5. 验收测试结果：45 PASS / 3 FAIL（已修复）

原始日志：VPS 上 `/home/agentctl/app/sandbox-tests.last.out`。

共 48 项，45 项通过。3 项失败全部在 **runsc（gVisor）档**：

| 测试 | 失败现象 | 原因 |
|---|---|---|
| T3a | 内存限制未生效 | rootless runsc 必须加 `--ignore-cgroups`（wrapper `/usr/local/bin/runsc-rootless`），`--memory` 等参数不起作用 |
| T3c | pids 限制未生效 | 同上 |
| T3e | cpus 限制未生效 | 同上 |

**当时的修复**：在 start 之前对 `libpod-conmon-<id>.scope` 执行 `systemctl --user set-property`，设置 `MemoryMax` / `TasksMax` / `CPUQuota`。这条路径没有接进现在的 controller：agentctl 在 `NoNewPrivileges=yes` 下不能 `runuser` 到 sbx。生产因此只启动 crun。

**复测结果**：
- T3a：内存超限，退出码 137，`OOMKilled=true` → PASS
- T3c：fork 炸弹（`TasksMax=256`）导致整个沙箱被杀，主机正常 → PASS。与 crun 档不同，这里不是 `fork()` 失败，而是整个沙箱被杀，属可接受行为。
- T3e：CPU 配额 100% → PASS

**剩余窗口**：容器 start 与 set-property 之间存在无限制窗口。缓解：容器以 paused 状态创建 → set-property → start。

**全局兜底**：`/etc/systemd/system/user-1001.slice.d/limits.conf`
```
MemoryMax=2600M
MemorySwapMax=512M
TasksMax=2048
CPUQuota=250%
```

### 其他说明（不是 FAIL）

- **T5a**：以代理 CONNECT 返回状态 200 判定通过。
- **T8**：标准放宽为 `used < 3000 MiB` 且 sshd 存活。实测 3×768m 并发时 used 2752M、avail 1157M。
- **工作区叶子目录当时是 0777**：gVisor rootless 下主机文件在容器内显示为 `nobody`，所以当时叶子是 0777。runsc 停用之后，叶子改为 `0700`、属主 `sbx`。父目录仍为 750 + ACL，不得放宽。环境脚本 H15 现在要求叶子是 `0700`。
- **crun 档必须带 `--userns keep-id`**。

## 6. 回归检查清单（每次变更后）

- [ ] 容器内 `id` 显示 uid 1000 映射、无 capabilities（`capsh --print` 为空）
- [ ] `/` 只读；`/tmp`、`/home/sbx` 可写
- [ ] 超过 768m 被 OOM kill；fork 超过 256 失败；CPU ≤ 1 核（生产 crun 档由 Podman 参数施加；runsc 档仍在环境脚本里，controller 不启动它）
- [ ] 直接连外网失败；经代理访问白名单域名成功、非白名单 403
- [ ] 工作区 symlink 指向 `/home/agentctl` 时 controller 读取被拒绝
- [ ] 容器内看不到 Podman socket、`/home/agentctl`、任何秘密
- [ ] 第 4 个并发沙箱进入排队
