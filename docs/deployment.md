# 在 VPS 上部署 controller

这份说明给在 `racknerd_us` 上操作的人。主机现状以 [docs/vps-environment.md](vps-environment.md) 为准。仓库里的 CI 只检查脚本能不能列出 48 项，不登录这台机器，也不在这里填写真实密钥。

下面的主机名、邮箱、aud 都是占位符，和 `.env.example` 一致。把真实值只写在 VPS 的 `0700` 目录里。

## 1. 前置条件

在动手之前，这台 Ubuntu 主机上需要已经有：

| 组件 | 要求 |
|---|---|
| Podman | rootless，用户 `sbx`。controller 只连 `/run/sbx/podman.sock`（crun）。主机上可以仍有 `/run/sbx/podman-runsc.sock`，给 `ops/tests/sandbox-env.sh` 用 |
| runsc / gVisor | 生产 controller 不启动 runsc，`set_runtime` 选 runsc 会被拒绝。重新启用要等有 set-property 路径，见第 12 节 |
| nftables | `table inet sbx_egress`：只放行 sbx 相关 uid 访问 `127.0.0.1:8888`，其余出站丢弃 |
| tinyproxy | 只听 `127.0.0.1:8888`，`FilterDefaultDeny Yes`，再加上域名白名单 |
| cloudflared | 系统用户 `cloudflared`，把 tunnel 转到本机回环 |
| Node.js | `>= 22.19.0`。systemd 单元里的路径是 `/usr/bin/node`，所以这个路径必须是这个版本 |
| npm | `>= 11`。本仓库 `packageManager` 是 `npm@11.6.2`。安装依赖用 `npm ci`，不要加 `--legacy-peer-deps` |

helper 创建会话叶子时用宿主上的 `python3` 调 `openat2`（syscall 437）。这是宿主工具，不是镜像里的工具。会话文件的读、写、列目录、改名、stat 和 flush 不走这条路径，它们在容器里经 exec 完成。

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
- `/home/sbx/workspaces` 和 `/home/sbx/workspaces/<bot>`：属主 `sbx`，模式 `0750`。给 agentctl 的 ACL 只有 `r`/`x`（`setfacl -m u:agentctl:rx`）。父目录已经比 `0750` 松时，helper 拒绝创建叶子，也不会把父目录 chmod 得更松。
- `/home/sbx/workspaces/<bot>/<session>`：会话叶子。由 sbx helper 创建，模式 `0700`，属主 `sbx`。agentctl 不 `mkdir`。controller 单元的 `ReadWritePaths` 不包含这块路径。
- `user-1001.slice` 的兜底写在 `/etc/systemd/system/user-1001.slice.d/limits.conf`：`MemoryMax=2600M`、`MemorySwapMax=512M`、`TasksMax=2048`、`CPUQuota=250%`。

创建示例（在 VPS 上，由操作者执行）：

```bash
install -d -o agentctl -g agentctl -m 0700 /home/agentctl/data /home/agentctl/secrets
install -d -o sbx -g sbx -m 0750 /home/sbx /home/sbx/workspaces
for bot in chief researcher ops; do
  install -d -o sbx -g sbx -m 0750 "/home/sbx/workspaces/$bot"
done
setfacl -m u:agentctl:rx /home/sbx /home/sbx/workspaces
for bot in chief researcher ops; do
  setfacl -m u:agentctl:rx "/home/sbx/workspaces/$bot"
done
```

叶子不在这里创建。下面第 2.1 节的 helper 收到请求后才建 `<session>`，模式 `0700`。不要把 `/home/agentctl`、Podman socket 或 secrets 挂进容器。

crun 的 `--userns keep-id:uid=1000,gid=1000` 在 sbx 的 rootless Podman 里把容器 uid 1000 映到宿主 `sbx`。`0700` 且属主是 `sbx` 的叶子，容器进程能读写。叶子保持 `0700`，不加 ACL，也不改成 `0777`。`SandboxExecutionEnv` 的文件操作在容器里经 exec 完成（不超过 8 MiB 的 `head -c`、原始 stdin 上的 `tee`、`find` / `stat` / `mv`）。路径限制在 `/workspace`，拒绝 `..` 和越出 `/workspace` 的绝对路径，并用 `realpath` 确认目标落在 `/workspace` 下面。单次读写超过 `MAX_FILE_BYTES`（8 MiB）时返回 `too_large`，不把超出的字节交回去。agentctl 不在宿主上打开叶子。hijack 协议里只有输出带 8 字节帧头，stdin 是原始字节，写完后 `socket.end()` 半关。

### 2.1 会话叶子 helper

helper 只做一件事：在已经存在的 `<bot>` 父目录下创建或核对一个会话叶子。名字必须是单个路径分量（bot：`^[a-z][a-z0-9-]{0,40}$`，session：`^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$`）。`..`、斜杠、NUL、符号链接都拒绝。创建用 `openat2`（`RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS`）和 `mkdirat`，不用把 `root/bot/session` 拼成一个字符串再 `mkdir`。叶子 `0700`，属主是 helper 进程；单元里 `User=sbx`，所以属主是 `sbx`。父目录不会被 chmod。

agentctl 只往套接字写一行 JSON：`{"bot":"ops","session":"root"}`。成功回答 `{"ok":true}`。失败回答 `{"ok":false,"error":"<code>"}`，`error` 是固定短码，不带路径。

单元文件：

- `ops/systemd/sbx-workspace.socket`
- `ops/systemd/sbx-workspace.service`

套接字 `/run/sbx/workspace.sock`，`SocketUser=sbx`，`SocketGroup=agentctl`，`SocketMode=0660`。只允许 sbx 和 `agentctl` 组连接。禁止 `0666`、`0662`、`0777` 和 `chmod a+rw`。`/run/sbx` 本身保持 sbx 可进入，不要对其他用户可写。

服务是 `User=sbx`，`NoNewPrivileges=yes`，`ProtectSystem=strict`，`ProtectHome=read-only`，`ReadWritePaths=/home/sbx/workspaces`。`ProtectHome=read-only` 让 `/home` 可见但是只读，`ReadWritePaths` 再把工作区树打开。不要改成 `ProtectHome=yes`：那会把 `/home` 藏起来，`ReadWritePaths` 经常加不回去。这行只出现在 helper 单元上。`agentctl-controller.service` 的 `NoNewPrivileges`、`ProtectSystem` 和 `ReadWritePaths` 保持原样，不加入工作区。

脚本放在 `/usr/local/lib`，helper 不依赖 `/home/agentctl` 可写。安装（在 VPS 上，由操作者执行；先停在第 3 节把代码检出到 `/home/agentctl/app`）：

```bash
install -d -o root -g root -m 0755 /usr/local/lib/pi-personal-agents
install -o root -g root -m 0644 \
  /home/agentctl/app/src/sandbox/workspace-helper.ts \
  /usr/local/lib/pi-personal-agents/sbx-workspace.ts
install -o root -g root -m 0644 \
  /home/agentctl/app/ops/systemd/sbx-workspace.socket \
  /etc/systemd/system/sbx-workspace.socket
install -o root -g root -m 0644 \
  /home/agentctl/app/ops/systemd/sbx-workspace.service \
  /etc/systemd/system/sbx-workspace.service
systemctl daemon-reload
systemctl enable --now sbx-workspace.socket
```

只 enable socket 单元。systemd 在第一次连接时拉起服务。升级 controller 时把 `sbx-workspace.ts` 按上面的 `install` 再复制一次，然后 `systemctl restart sbx-workspace.socket`。

装好后核对 helper 真能在只读的 `/home` 上写出 `0700` 叶子，并且 controller 单元没有因此放宽：

```bash
systemctl show sbx-workspace.service -p ProtectHome -p ReadWritePaths -p NoNewPrivileges -p ProtectSystem
python3 - <<'PY'
import socket
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect("/run/sbx/workspace.sock")
s.sendall(b'{"bot":"ops","session":"deploy-check"}\n')
print(s.recv(128).decode())
PY
stat -c '%a %U' /home/sbx/workspaces/ops/deploy-check
systemctl show agentctl-controller.service -p ReadWritePaths -p NoNewPrivileges -p ProtectSystem
rmdir /home/sbx/workspaces/ops/deploy-check
```

期望：helper 的 `ProtectHome=read-only`，`ReadWritePaths=/home/sbx/workspaces`，`NoNewPrivileges=yes`，`ProtectSystem=strict`；套接字回答 `{"ok":true}`；叶子是 `700 sbx`；controller 的 `ReadWritePaths` 仍只有 `/home/agentctl/data` 和 `/home/agentctl/secrets`。然后删掉这次核对用的空叶子。

controller 用 `PPA_WORKSPACE_SOCKET`（默认 `/run/sbx/workspace.sock`）请求叶子。这个变量不是秘密，可以写在 `controller.env`，也可以省略。

### Podman socket 给 agentctl 的访问

controller 以 `agentctl`（uid 1000）直接连 crun 的 unix socket（`UnixPodmanClient`）：

- `/run/sbx/podman.sock`（crun）。生产启动只走这个 socket。

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

这就是 `bash ops/tests/sandbox-env.sh`，目录里仍是 48 项：

- crun 与 runsc 各一组 T1–T6（身份、只读根、内存 / pids / CPU、出网、代理白名单、容器里看不到 Podman socket 和 `/home/agentctl`）
- H1–H16（用户、目录模式、两个 socket、镜像、runsc wrapper、slice 上限、nft、tinyproxy、工作区权限、symlink / `..` / 硬链接）
- T8（三个沙箱并发时内存与 sshd）
- T9（运行中的沙箱不超过 3）

生产只启用 crun 期间，runsc 那一组 T1–T6 以及 H6、H8 是主机专用、可选。脚本仍会执行它们，失败或缺少 runsc 时记为 SKIP，不让整套失败，也不从目录里删掉。重新启用 runsc 之后，这些检查再改回必过。其余项必须通过：crun 的 T1–T6、H1–H5、H7、H9–H16、T8、T9。T9 在 runsc 套接字不存在时只数 crun 的容器。

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

期望没有上面那五个。除上面标成可选的 runsc 检查以外，其余项都通过才算这台机器的沙箱环境可用。CI 不会在 GitHub 上重跑这 48 项。

## 9. 生产只启动 crun

`createPodmanDriver` 的顺序是：

1. runtime 不是 `crun`：直接抛错 `runsc is disabled until a set-property path exists`。不 create，不 start。
2. `POST /v4.0.0/libpod/containers/create`，socket 只有 `/run/sbx/podman.sock`。命令是 `sleep infinity`。
3. start。

controller 进程里没有 `runuser`，也没有 `systemctl set-property`。crun 的内存、pids、cpu 限制在 Podman 自己的 spec 上（`src/sandbox/flags.ts`：768MiB、pids 256、cpu quota/period 100000），和 `cap_drop ALL`、`no_new_privileges`、只读根、pasta、tinyproxy 白名单、nft `sbx_egress` 一起保留。

`set_runtime` 的参数里仍能写出 `runsc`，这样模型选它时会拿到上面那句拒绝，而不是静默切换。工具实现和 `beforeTool` 都不会把 runtime 记成 runsc。`set_runtime` 仍在危险工具名单里；目标是 `crun` 时仍要审批。

`ops/tests/sandbox-env.sh` 仍列出 runsc 那一组 T1–T6 和 H6/H8。crun-only 期间它们是主机专用、可选，失败记为 SKIP。那是主机环境脚本，不是 controller 的启动路径。脚本里对 scope 属性的 `|| true` 仍是测试夹具。

重新启用 runsc 要先有一条不经过 agentctl `runuser` 的 set-property 路径，并且在 start 之前加上 `MemoryMax=768M`、`TasksMax=256`、`CPUQuota=100%`（`RUNSC_SCOPE_PROPERTIES`）。在那之前 runsc 不可选。见第 12 节。

同时看第 4 节，确认镜像里有 `bash` 和 `sleep`。

### 9.1 核对 write_file 的二进制 stdin

`write_file` 把字节从 exec 的 stdin 交给容器里的 `tee`。确认容器里的文件和宿主上准备的字节逐字节相同：比较两边的 sha256。不要在宿主上对 `0700` 叶子做 `sha256sum`，agentctl 打不开它。

`write_file` 工具的 `content` 是字符串，按 UTF-8 编码，`0xff` 不能靠这个字符串保住。下面这段用 `Uint8Array` 走 `UnixPodmanClient.exec`，和 `SandboxExecutionEnv.writeFile` 写给 `tee` 的 stdin 是同一条路：原始字节，没有 8 字节 multiplex 头。容器需要已经在跑。`$id` 用 `podman ps` 里该会话的容器 id。

```bash
python3 - <<'PY'
from pathlib import Path
import hashlib
payload = bytes([0x00, 0xff, 0x41, 0x0a, 0x00])
Path("/tmp/ppa-bin.dat").write_bytes(payload)
print(hashlib.sha256(payload).hexdigest())
PY

id=$(podman --url unix:///run/sbx/podman.sock ps -q | head -n 1)
test -n "$id"
cd /home/agentctl/app
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"
PPA_BIN_CHECK_ID="$id" node --experimental-strip-types --input-type=module --eval '
import { readFileSync } from "node:fs";
import { UnixPodmanClient } from "./src/sandbox/podman.ts";
const id = process.env.PPA_BIN_CHECK_ID ?? "";
if (id.length === 0) {
  process.stderr.write("missing container id\n");
  process.exit(1);
}
const stdin = new Uint8Array(readFileSync("/tmp/ppa-bin.dat"));
const client = new UnixPodmanClient({ crun: "/run/sbx/podman.sock" });
const result = await client.exec("crun", id, ["tee", "--", "/workspace/bin.dat"], { stdin, cwd: "/workspace" });
if (result.exitCode !== 0) {
  process.stderr.write(result.stderr + "\n");
  process.exit(1);
}
'
podman --url unix:///run/sbx/podman.sock exec "$id" sha256sum /workspace/bin.dat
podman --url unix:///run/sbx/podman.sock exec "$id" rm -f /workspace/bin.dat
rm -f /tmp/ppa-bin.dat
```

上面 python 打印的摘要必须和容器里 `sha256sum` 的第一列相同。若 stdin 被加上 multiplex 头，容器里的文件会多出 8 字节，摘要对不上。样本只有几字节；超过 8 MiB 的写入会在 exec 之前被拒绝。

## 10. 升级与回滚

升级：

```bash
systemctl stop agentctl-controller
cd /home/agentctl/app
git fetch
git checkout <要运行的提交>
npm ci
install -o root -g root -m 0644 \
  src/sandbox/workspace-helper.ts \
  /usr/local/lib/pi-personal-agents/sbx-workspace.ts
systemctl restart sbx-workspace.socket
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
| `runsc is disabled until a set-property path exists` | 有人请求了 runsc。容器没有 create。见第 9 节 |
| `sandbox stop failed: <id>` | 空闲容器 stop 失败。`<id>` 只是容器 id。槽位仍会释放。这一行没有命令输出，也没有环境变量 |
| `listening` 之后浏览器 401 | Access JWT 的 `aud`、`iss`、`email` 与环境变量不一致，或 `email` 不是 `PPA_OWNER_EMAIL` |
| 浏览器 403 | POST 或 WebSocket 的 `Origin` 不是 `https://<CLOUDFLARED_HOSTNAME>` |

cloudflared 自身的日志用它的系统单元看（常见是 `journalctl -u cloudflared`）。tunnel 通、本机 `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/` 在没有 JWT 时是 `401`，说明 controller 在听，并且没有把页面暴露成匿名可读。

## 12. 部署阻塞项

下面两件主人已经选定。`NoNewPrivileges` 仍是 `yes`，`ProtectSystem` 仍是 `strict`，工作区父目录仍是最多 `0750`、agentctl 只有 `r`/`x`。controller 的 `ReadWritePaths` 仍只有 `/home/agentctl/data` 和 `/home/agentctl/secrets`。

### runsc：先只用 crun

生产 runtime 默认并且只有 crun。runsc 不可选。`set_runtime` 请求 runsc 时拒绝，消息是 `runsc is disabled until a set-property path exists`。启动流程里没有 `runuser`，也没有 `set-property`。crun 容器保持原有限制：`cap_drop ALL`、`no_new_privileges`、只读根、内存 / pids / cpu 走 Podman 自己的参数、pasta、tinyproxy 白名单、nft。

重新启用 runsc 是后续，不是现在的缺口。要有一条不从 agentctl 进程 `runuser` 的 set-property 路径，并在 start 之前加上 `MemoryMax=768M`、`TasksMax=256`、`CPUQuota=100%`。见 [docs/follow-ups.md](follow-ups.md)。

### 会话叶子：sbx helper 创建

叶子由 `User=sbx` 的 socket 激活服务创建，模式 `0700`，属主 `sbx`。校验是 openat，拒绝 `..` 和符号链接。agentctl 只发请求。父目录保持 sbx `0750` 加 agentctl 的 `r`/`x` ACL。安装步骤在第 2.1 节。会话文件的读写在容器内 exec 完成，agentctl 不在宿主上打开叶子，叶子权限和 ACL 都不改。

模型请求重试已开启，没有新的环境变量。策略是 pi-durable 1.1.0 的 `DEFAULT_RETRY_POLICY`：最多再请求 3 次，间隔 2 秒、4 秒、8 秒，单次不超过 60 秒。只重发模型请求。网络、429、5xx、overloaded 会等；认证失败和 4xx 校验错误不会等。三次仍失败时，对话里能看到模型的错误文本。见 [docs/follow-ups.md](follow-ups.md)。
