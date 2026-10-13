# 在 VPS 上部署 controller

这份说明给在 `racknerd_us` 上操作的人。主机现状以 [docs/vps-environment.md](vps-environment.md) 为准。仓库里的 CI 只检查脚本能不能列出 48 项，不登录这台机器，也不在这里填写真实密钥。

下面的主机名、邮箱、aud 都是占位符，和 `.env.example` 一致。把真实值只写在 VPS 的 `0700` 目录里。

## 1. 前置条件

在动手之前，这台 Ubuntu 主机上需要已经有：

| 组件 | 要求 |
|---|---|
| Podman | rootless，用户 `sbx`。两个 API socket：`/run/sbx/podman.sock`（crun）、`/run/sbx/podman-runsc.sock`（gVisor） |
| runsc / gVisor | `/usr/local/bin/runsc-rootless` 的参数里带 `--ignore-cgroups`。runsc 自己不施加 cgroup 限制 |
| nftables | `table inet sbx_egress`：只放行 sbx 相关 uid 访问 `127.0.0.1:8888`，其余出站丢弃 |
| tinyproxy | 只听 `127.0.0.1:8888`，`FilterDefaultDeny Yes`，再加上域名白名单 |
| cloudflared | 系统用户 `cloudflared`，把 tunnel 转到本机回环 |
| Node.js | `>= 22.19.0`。systemd 单元里的路径是 `/usr/bin/node`，所以这个路径必须是这个版本 |
| npm | `>= 11`。本仓库 `packageManager` 是 `npm@11.6.2`。安装依赖用 `npm ci`，不要加 `--legacy-peer-deps` |

另外，controller 读工作区时用宿主上的 `python3` 调 `openat2`（syscall 437）。这是宿主工具，不是镜像里的工具。

对外只开 SSH（22）。Web 不直接听公网。

## 2. 用户、目录、权限

| 用户 | uid | 拥有 |
|---|---|---|
| `agentctl` | 1000 | `/home/agentctl/app`（检出的仓库）、`/home/agentctl/data`、`/home/agentctl/secrets` |
| `sbx` | 1001 | rootless Podman，以及 `/home/sbx/workspaces` |
| `cloudflared` | system | tunnel 凭据，放在 `/etc/cloudflared/` |
| build 用户 | 维护窗口单独使用 | 构建 `localhost/sandbox-base:1` 的上下文。构建完把镜像放进 sbx 的 crun 存储 |

目录模式：

- `/home/agentctl/data`：`0700`，属主 `agentctl`。每个 bot 一个 SQLite（`chief.sqlite`、`researcher.sqlite`、`ops.sqlite`），加上 `policy.sqlite` 和 `audit.jsonl`。
- `/home/agentctl/secrets`：`0700`，属主 `agentctl`。`controller.env` 用 `0600`。ChatGPT OAuth 材料也在这里，一个 provider 一个 JSON，写入时是 `0600`。
- `/home/sbx/workspaces/<bot>/<session>`：父目录属主 `sbx`，模式最多 `0750`。可以给 agentctl 加只含 `r`/`x` 的 ACL。只有会话叶子可以是 `0777`。父目录已经比 `0750` 松时，controller 会拒绝，不会把它 chmod 得更松。在当前 systemd 单元下，agentctl 创建不了这个叶子，见第 12 节。
- `user-1001.slice` 的兜底写在 `/etc/systemd/system/user-1001.slice.d/limits.conf`：`MemoryMax=2600M`、`MemorySwapMax=512M`、`TasksMax=2048`、`CPUQuota=250%`。

创建示例（在 VPS 上，由操作者执行）：

```bash
install -d -o agentctl -g agentctl -m 0700 /home/agentctl/data /home/agentctl/secrets
install -d -o sbx -g sbx -m 0750 /home/sbx/workspaces
```

`ensureWorkspace` 会尝试创建会话叶子并把它设成 `0777`。当前单元下这一步做不到，见第 12 节。不要把 `/home/agentctl`、Podman socket 或 secrets 挂进容器。

### Podman socket 给 agentctl 的访问

controller 以 `agentctl`（uid 1000）直接连这两个 unix socket（`UnixPodmanClient`）：

- `/run/sbx/podman.sock`（crun）
- `/run/sbx/podman-runsc.sock`（gVisor）

socket 的属主保持 `sbx`。`agentctl` 的连接权只用下面两种之一：

- 一个只包含 `agentctl` 的用户组，socket 模式 `0660`
- 用户 ACL，例如 `u:agentctl:rw`，socket 模式 `0600`

`/run/sbx` 目录本身保持 `sbx` 可进入，不要对其他用户可写。禁止把 socket 改成 `0666`、`0662`、`0777`，也禁止 `chmod a+rw` 或任何让 `agentctl` 和 `sbx` 以外的用户能连上的模式。组或 ACL 只加到 `agentctl` 这一个账号。

## 3. 检出代码与安装依赖

以 `agentctl` 在 `/home/agentctl/app` 检出要运行的提交，然后：

```bash
cd /home/agentctl/app
npm ci
```

`@earendil-works/pi-durable`、`pi-ai`、`chord` 都精确锁在 `1.1.0`。不要改这三行的版本范围。

## 4. 沙箱镜像

仓库里没有 Containerfile。镜像由 build 用户在维护窗口构建，标签必须是 `localhost/sandbox-base:1`，并且出现在 sbx 的 crun 存储里（`npm run test:vps` 的 H7 会查这个名字）。

镜像里必须有 `bash` 和 `sleep`：

- 容器的常驻命令是 `sleep infinity`（`src/sandbox/spec.ts`）。
- 工具执行走 Podman exec，命令是 `bash -lc`（`src/sandbox/podman.ts`）。

在 VPS 上确认这两个程序在镜像里，并且这次检查不要带上生产用的挂载：

```bash
runuser -u sbx -- env XDG_RUNTIME_DIR=/run/user/1001 \
  podman --url unix:///run/sbx/podman.sock run --rm --network none \
  localhost/sandbox-base:1 bash -lc 'command -v bash && command -v sleep'
```

两条路径都打印出来才算通过。这次 `podman run` 只查二进制，不能代替生产参数。生产容器始终是：`--cap-drop ALL`、`no-new-privileges`、只读根、`--userns keep-id:uid=1000,gid=1000`、内存和 swap 各 768MiB、pids 256、cpu 1、网络 pasta、代理 `http://10.0.2.2:8888`。完整列表与 `ops/tests/sandbox-env.sh` 里的 `HARD_FLAGS` 以及 `src/sandbox/flags.ts` 保持一致。

## 5. 环境变量

systemd 从 `/home/agentctl/secrets/controller.env` 读环境（`EnvironmentFile=-`，文件可以还不存在，但缺必填变量时进程会退出）。模式 `0600`，属主 `agentctl`。不要把这个文件提交进仓库，也不要写进单元文件。

必填（名字与 `.env.example` 相同，下面仍是占位符）：

```bash
PPA_OWNER_EMAIL=owner@example.com
CLOUDFLARED_HOSTNAME=chat.example.com
CLOUDFLARE_ACCESS_TEAM_DOMAIN=example.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=0000000000000000000000000000000000000000000000000000000000000000
CLOUDFLARE_ACCESS_JWKS_URL=https://example.cloudflareaccess.com/cdn-cgi/access/certs
```

含义：

- `PPA_OWNER_EMAIL`：JWT 的 `email` 必须与它逐字相同。审批记录里的操作者就是这个邮箱。
- `CLOUDFLARED_HOSTNAME`：纯主机名，不要写 `https://`。POST 和 WebSocket 的 `Origin` 必须等于 `https://` 加上这个主机名。
- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`：纯主机名。JWT 的 `iss` 必须等于 `https://` 加上它。
- `CLOUDFLARE_ACCESS_AUD`：Access 应用的 AUD tag。
- `CLOUDFLARE_ACCESS_JWKS_URL`：该团队的证书地址，一般是 `https://<team-domain>/cdn-cgi/access/certs`。启动时拉不到 JWKS，进程直接退出。

可选，默认值如下：

| 变量 | 默认 |
|---|---|
| `PPA_PORT` | `8787` |
| `PPA_DATA_DIR` | `/home/agentctl/data` |
| `PPA_SECRETS_DIR` | `/home/agentctl/secrets` |
| `PPA_WORKSPACE_ROOT` | `/home/sbx/workspaces` |
| `PPA_MODEL_ID` | `gpt-5.1` |
| `OPENAI_CHATGPT_OAUTH_PATH` | 文档占位，指向 `/home/agentctl/secrets/` 下的文件 |

模型凭据不进仓库。ChatGPT OAuth 由 `/login` 的一次性验证码写入 `PPA_SECRETS_DIR` 里的 provider JSON（`0600`）。API key 若使用，也只放在该目录，或放在 `controller.env` 这种未入库的环境文件里。`.env.example` 里只有占位符。

监听地址写死为 `127.0.0.1`。`PPA_BIND` 出现在示例里，代码不会接受别的地址。

## 6. Cloudflare Tunnel 与 Access

1. 在 Cloudflare 上为这台机器建一条 tunnel。凭据 JSON 放在 `/etc/cloudflared/<tunnel-id>.json`，属主是 `cloudflared`，不要放进仓库。
2. 把 `ops/cloudflared/config.yml.template` 抄到 cloudflared 的配置路径，替换两个占位符：
   - `tunnel` / `credentials-file` 用真实 tunnel id。
   - `hostname` 用 `CLOUDFLARED_HOSTNAME`。
   - `service` 保持 `http://127.0.0.1:8787`。最后一条是 `http_status:404`。
3. 为这个 hostname 建一个 Access 应用（self-hosted）。策略只允许 `PPA_OWNER_EMAIL` 这一个邮箱。不要把应用开成整个域名上的任何人，也不要把 aud 配成别的应用。
4. 从该应用复制 AUD tag，写入 `CLOUDFLARE_ACCESS_AUD`。团队域名写入 `CLOUDFLARE_ACCESS_TEAM_DOMAIN`。
5. 启动 cloudflared。它只把流量送到本机 `127.0.0.1:8787`。controller 自己不听公网。

浏览器打开 `https://<CLOUDFLARED_HOSTNAME>/`。Access 通过之后，页面用 `CF_Authorization` cookie。服务端也接受请求头 `Cf-Access-Jwt-Assertion`。

## 7. systemd

单元模板是 `ops/systemd/agentctl-controller.service`。CI 不会把它装到机器上。操作者在 VPS 上复制到 `/etc/systemd/system/agentctl-controller.service` 后：

```bash
systemctl daemon-reload
systemctl enable --now agentctl-controller
```

单元要点：`User=agentctl`，工作目录 `/home/agentctl/app`，`EnvironmentFile=-/home/agentctl/secrets/controller.env`，启动命令：

```text
/usr/bin/node --experimental-strip-types /home/agentctl/app/src/controller.ts
```

`UMask=0077`，`NoNewPrivileges=yes`，`ProtectSystem=strict`。可写路径只有 `/home/agentctl/data` 和 `/home/agentctl/secrets`。`/home/agentctl/app` 对服务是只读的，所以 `npm ci` 要在启动服务之前做完。

进程起来后标准输出一行：`listening 127.0.0.1:8787 bots=chief,researcher,ops`。

## 8. 跑 `npm run test:vps`

在 VPS 上、仓库目录里，用 root 执行：

```bash
cd /home/agentctl/app
npm run test:vps
```

这就是 `bash ops/tests/sandbox-env.sh`，一共 48 项：

- crun 与 runsc 各一组 T1–T6（身份、只读根、内存 / pids / CPU、出网、代理白名单、容器里看不到 Podman socket 和 `/home/agentctl`）
- H1–H16（用户、目录模式、两个 socket、镜像、runsc wrapper、slice 上限、nft、tinyproxy、工作区权限、symlink / `..` / 硬链接）
- T8（三个沙箱并发时内存与 sshd）
- T9（运行中的沙箱不超过 3）

直接执行这个脚本时（包括只列出名字的 `--list`），下面五个变量只要有一个非空，脚本就以状态 1 退出：

- `SBX_NFT_SNAPSHOT`
- `SBX_TINYPROXY_CONF`
- `SBX_LISTEN_SNAPSHOT`
- `SBX_WORKSPACE_ROOT`
- `SBX_SLICE_LIMITS`

这五个只在单元测试 source 该文件之后才允许设置。在 VPS 上跑之前先确认它们没有出现在环境里：

```bash
env | grep '^SBX_' || true
```

期望没有上面那五个。48 项都通过才算这台机器的沙箱环境可用。CI 不会在 GitHub 上重跑这 48 项。

## 9. runsc 的 set-property 时机

runsc 档的限制不靠 `podman --memory`。`createPodmanDriver` 的顺序是：

1. `POST /v4.0.0/libpod/containers/create`。容器已创建，尚未 start。命令是 `sleep infinity`。
2. 仅 runsc：`systemctl --user set-property libpod-conmon-<id>.scope MemoryMax=768M TasksMax=256 CPUQuota=100%`。进程的 uid 不是 1001 时，代码会在前面加上 `runuser -u sbx -- env XDG_RUNTIME_DIR=/run/user/1001`。
3. 这一步退出码不是 0：stop 并删除该容器，然后抛错，不 start。
4. 退出码是 0：才 start。

验收脚本在 start 之前对 set-property 使用了 `|| true`，那是测试夹具。controller 没有这条放行。

以 `sbx` 的用户会话可以核对 scope 是否在 start 之前就存在（把 `<id>` 换成 create 打印的 id，参数与 `ops/tests/sandbox-env.sh` 的 `HARD_FLAGS` 相同，镜像 `localhost/sandbox-base:1`，命令 `sleep infinity`）：

```bash
# podman create（不要 start）之后立刻，在 sbx 的用户会话里：
systemctl --user status "libpod-conmon-<id>.scope"
systemctl --user set-property "libpod-conmon-<id>.scope" \
  MemoryMax=768M TasksMax=256 CPUQuota=100%
```

scope 在 start 之前不存在时，删掉这个容器，不要 start。这次核对只说明主机上的 scope 时机。它不能说明 `agentctl` 服务里的 `runuser -u sbx` 会成功。

服务实际跑不起来：单元是 `User=agentctl`（uid 1000）并且 `NoNewPrivileges=yes`。`runuser` 要换成 uid 1001，在这个限制下失败。set-property 失败后容器被 stop，runsc 档不会 start。这是未解决项，部署前必须先定，见第 12 节。

同时看第 4 节，确认镜像里有 `bash` 和 `sleep`。

## 10. 升级与回滚

升级：

```bash
systemctl stop agentctl-controller
cd /home/agentctl/app
git fetch
git checkout <要运行的提交>
npm ci
systemctl start agentctl-controller
```

`/home/agentctl/data` 和 `/home/agentctl/secrets` 留在原地。不要为了升级删掉 SQLite 或 OAuth 文件。

回滚用同一套步骤，把检出改回先前的提交，再 `npm ci`。依赖仍是 lockfile 里的 `1.1.0`。

对话里一旦有 `pi.compaction` 条目（上下文压缩写入的摘要），就保持 pi-durable `1.1.0`。不要把这三个 `@earendil-works/*` 包换成更旧的版本再打开同一批 SQLite。

## 11. 日志与排障

```bash
journalctl -u agentctl-controller -e
```

正常启动能看到 `listening 127.0.0.1:8787 bots=chief,researcher,ops`。

| 日志 | 含义 |
|---|---|
| `missing CLOUDFLARE_ACCESS_AUD`（或其它 `missing …`） | `controller.env` 少了必填变量，或文件权限让 `agentctl` 读不到 |
| `access jwks request failed` / `access jwks had no rsa keys` | 第一次拉取失败，进程退出。检查 `CLOUDFLARE_ACCESS_JWKS_URL` 从这台机器是否可达 |
| `jwks refresh failed: …` | 运行中的刷新失败。这一行只会出现固定短句（`access jwks request failed`、`access jwks had no rsa keys` 或 `request failed`），不会带上 token、cookie 或完整 URL。已有密钥还留着 |
| `runsc limits were not applied; container was not started` | runsc 的 `set-property` 失败。容器已 stop，没有 start。在当前单元里，uid 1000 的 `runuser -u sbx` 会走这条失败，见第 12 节 |
| `sandbox stop failed: <id>` | 空闲容器 stop 失败。`<id>` 只是容器 id。槽位仍会释放。这一行没有命令输出，也没有环境变量 |
| `listening` 之后浏览器 401 | Access JWT 的 `aud`、`iss`、`email` 与环境变量不一致，或 `email` 不是 `PPA_OWNER_EMAIL` |
| 浏览器 403 | POST 或 WebSocket 的 `Origin` 不是 `https://<CLOUDFLARED_HOSTNAME>` |

cloudflared 自身的日志用它的系统单元看（常见是 `journalctl -u cloudflared`）。tunnel 通、本机 `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/` 在没有 JWT 时是 `401`，说明 controller 在听，并且没有把页面暴露成匿名可读。

## 12. 未解决，部署前必须先定

下面两件事主人还没有选定做法。候选并列在这里，也写在 [docs/follow-ups.md](follow-ups.md)。候选都不改这三项：`NoNewPrivileges` 保持 `yes`，`ProtectSystem` 保持 `strict`，工作区父目录保持最多 `0750`、agentctl 只有 `r`/`x`。

### runsc 容器起不来

`createPodmanDriver` 在 uid 不是 1001 时用 `runuser -u sbx` 执行 `systemctl --user set-property`。服务用户是 `agentctl`（uid 1000），单元又有 `NoNewPrivileges=yes`，这次 `runuser` 失败。失败则 stop 并且不 start，所以 runsc 档没有容器能跑起来。crun 档不走 `runuser`，它只依赖第 2 节的 socket 权限。

候选：

- 单独一个 `User=sbx` 的辅助单元，在 sbx 自己的用户会话里执行 `set-property`。agentctl 把容器 id 交给它，交接用的本地套接字只允许 `agentctl` 连接。
- 把 `set-property` 放在 sbx 已经拥有的用户会话里完成，agentctl 进程里不调用 `runuser`。
- 在这件事情定下来之前，只启用 crun 档。

### 会话工作区叶子创建不了

两件事实叠在一起：

- 单元是 `ProtectSystem=strict`，`ReadWritePaths` 只有 `/home/agentctl/data` 和 `/home/agentctl/secrets`。
- `/home/sbx/workspaces` 和 `<bot>` 父目录属主是 `sbx`，模式 `0750`，agentctl 的 ACL 只有 `r`/`x`。

`ensureWorkspace` 要在这个父目录下创建 `<session>` 叶子。服务进程既写不进这块路径，也没有在父目录里建目录的权限。

候选：

- 由 uid 1001 的辅助进程创建叶子并设成 `0777`。agentctl 只使用已经存在的叶子。
- 部署时由 `sbx` 为会用到的会话预先建好叶子，至少包括每个 bot 的 root 会话。
- 叶子不存在时由 sbx 的用户会话创建；controller 在叶子缺失时失败并记日志，不自己 `mkdir`。
