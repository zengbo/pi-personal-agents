#!/usr/bin/env bash
# VPS environment suite for racknerd_us (48 checks).
# Run on the host as root: bash ops/tests/sandbox-env.sh
# List names without touching the host: bash ops/tests/sandbox-env.sh --list
#
# This script does not SSH, does not read secret file contents, and does not
# mount the Podman socket, /home/agentctl, or any secrets into a container.
# Live execution is for an operator on the VPS. CI only checks --list.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_SANDBOXES=3
ALLOW_PROBE_HOST="${SBX_ALLOW_PROBE_HOST:-github.com}"
DENY_PROBE_HOST="${SBX_DENY_PROBE_HOST:-not-allowlisted.example}"

# Mandatory container flags. Keep these in lockstep with docs/vps-environment.md.
HARD_FLAGS=(
  --userns "keep-id:uid=1000,gid=1000"
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --tmpfs /home/sbx
  --memory 768m
  --memory-swap 768m
  --pids-limit 256
  --cpus 1
  --network pasta
  -e HTTP_PROXY=http://10.0.2.2:8888
  -e HTTPS_PROXY=http://10.0.2.2:8888
  -e http_proxy=http://10.0.2.2:8888
  -e https_proxy=http://10.0.2.2:8888
)

CATALOG="$(cat <<'EOF'
T1a-crun	crun: id uid is 1000
T1b-crun	crun: id gid is 1000
T1c-crun	crun: effective capabilities are empty
T1d-crun	crun: NoNewPrivs is set
T2a-crun	crun: / is read-only
T2b-crun	crun: /tmp is writable
T2c-crun	crun: /home/sbx is writable
T3a-crun	crun: allocation past 768m is OOM-killed
T3c-crun	crun: fork past 256 pids fails
T3e-crun	crun: CPU quota is 1 core
T4a-crun	crun: direct egress fails
T5a-crun	crun: proxy CONNECT to an allowlisted host returns 200
T5b-crun	crun: proxy CONNECT to a non-allowlisted host returns 403
T6a-crun	crun: Podman socket is not visible
T6b-crun	crun: /home/agentctl is not visible
T1a-runsc	runsc: id uid is 1000
T1b-runsc	runsc: id gid is 1000
T1c-runsc	runsc: effective capabilities are empty
T1d-runsc	runsc: NoNewPrivs is set
T2a-runsc	runsc: / is read-only
T2b-runsc	runsc: /tmp is writable
T2c-runsc	runsc: /home/sbx is writable
T3a-runsc	runsc: allocation past 768m is OOM-killed
T3c-runsc	runsc: fork past 256 pids fails or the sandbox is killed
T3e-runsc	runsc: scope CPU quota is 100%
T4a-runsc	runsc: direct egress fails
T5a-runsc	runsc: proxy CONNECT to an allowlisted host returns 200
T5b-runsc	runsc: proxy CONNECT to a non-allowlisted host returns 403
T6a-runsc	runsc: Podman socket is not visible
T6b-runsc	runsc: /home/agentctl is not visible
H1	agentctl uid is 1000
H2	sbx uid is 1001
H3	/home/agentctl/data is mode 0700 and owned by agentctl
H4	/home/agentctl/secrets is mode 0700 and owned by agentctl
H5	crun API socket exists
H6	runsc API socket exists
H7	localhost/sandbox-base:1 exists in the crun store
H8	runsc-rootless wrapper passes --ignore-cgroups
H9	user-1001.slice MemoryMax is 2600M
H10	user-1001.slice MemorySwapMax is 512M
H11	user-1001.slice TasksMax is 2048
H12	user-1001.slice CPUQuota is 250%
H13	nft table inet sbx_egress exists and drops other egress
H14	tinyproxy binds 127.0.0.1:8888 and FilterDefaultDeny is Yes
H15	workspace parents stay at most 0750; only a session leaf may be 0777
H16	symlink, dotdot, and hardlink workspace reads are rejected
T8	three 768m sandboxes keep host used memory under 3000 MiB and sshd alive
T9	running sandbox containers do not exceed 3
EOF
)"

if [[ "${1:-}" == "--list" ]]; then
  printf '%s\n' "$CATALOG"
  exit 0
fi

sbx() {
  if [[ "$(id -un)" == "sbx" ]]; then
    "$@"
    return
  fi
  runuser -u sbx -- env XDG_RUNTIME_DIR=/run/user/1001 "$@"
}

socket_for() {
  if [[ "$1" == "crun" ]]; then
    printf '%s\n' "unix:///run/sbx/podman.sock"
  else
    printf '%s\n' "unix:///run/sbx/podman-runsc.sock"
  fi
}

apply_runsc_limits() {
  local id="$1"
  sbx systemctl --user set-property "libpod-conmon-${id}.scope" MemoryMax=768M TasksMax=256 CPUQuota=100%
}

# Create a sleeping container. runsc limits are applied again after start, and the
# callback runs only then, so the test command is not the process in the unlimited window.
# Usage: with_sleep_ctr <crun|runsc> <callback> [callback args...]
# The callback is invoked as: callback <url> <id> [args...]
with_sleep_ctr() {
  local runtime="$1"
  local callback="$2"
  shift 2
  local url name id rc=0
  url="$(socket_for "$runtime")"
  name="ppa-${runtime}-${BASHPID}-${RANDOM}"
  id="$(sbx podman --url "$url" create --name "$name" "${HARD_FLAGS[@]}" localhost/sandbox-base:1 sleep 180)" || return 1
  if [[ "$runtime" == "runsc" ]]; then
    # The conmon scope may not exist until start. Ignore a miss here.
    apply_runsc_limits "$id" || true
  fi
  sbx podman --url "$url" start "$id" >/dev/null || rc=$?
  if [[ "$rc" -eq 0 && "$runtime" == "runsc" ]]; then
    apply_runsc_limits "$id" || rc=$?
  fi
  if [[ "$rc" -eq 0 ]]; then
    "$callback" "$url" "$id" "$@" || rc=$?
  fi
  sbx podman --url "$url" rm -f "$id" >/dev/null 2>&1 || true
  return "$rc"
}

exec_out() {
  local url="$1" id="$2"
  shift 2
  sbx podman --url "$url" exec "$id" "$@"
}

check_uid() {
  with_sleep_ctr "$1" _uid_is_1000
}
_uid_is_1000() {
  local uid
  uid="$(exec_out "$1" "$2" id -u)" || return 1
  [[ "$uid" == "1000" ]] || return 1
}

check_gid() {
  with_sleep_ctr "$1" _gid_is_1000
}
_gid_is_1000() {
  local gid
  gid="$(exec_out "$1" "$2" id -g)" || return 1
  [[ "$gid" == "1000" ]] || return 1
}

check_caps() {
  with_sleep_ctr "$1" _caps_empty
}
_caps_empty() {
  local line
  line="$(exec_out "$1" "$2" grep '^CapEff:' /proc/self/status)" || return 1
  [[ "$line" == *"0000000000000000" ]] || return 1
}

check_nnp() {
  with_sleep_ctr "$1" _nnp_set
}
_nnp_set() {
  local line
  line="$(exec_out "$1" "$2" grep '^NoNewPrivs:' /proc/self/status)" || return 1
  [[ "$line" == *":	1" || "$line" == *": 1" ]] || return 1
}

check_root_ro() {
  with_sleep_ctr "$1" _root_ro
}
_root_ro() {
  if exec_out "$1" "$2" touch /ro-probe >/dev/null 2>&1; then
    echo "root filesystem accepted a write" >&2
    return 1
  fi
}

check_tmp_rw() {
  with_sleep_ctr "$1" _tmp_rw
}
_tmp_rw() {
  exec_out "$1" "$2" sh -c 'touch /tmp/probe && rm /tmp/probe' || return 1
}

check_home_rw() {
  with_sleep_ctr "$1" _home_rw
}
_home_rw() {
  exec_out "$1" "$2" sh -c 'touch /home/sbx/probe && rm /home/sbx/probe' || return 1
}

check_memory() {
  with_sleep_ctr "$1" _memory_oom
}
_memory_oom() {
  local url="$1" id="$2" rc=0 oom
  set +e
  exec_out "$url" "$id" dd if=/dev/zero of=/tmp/fill bs=1M count=900 status=none >/dev/null 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 137 || "$rc" -eq 9 ]]; then
    return 0
  fi
  oom="$(sbx podman --url "$url" inspect --format '{{.State.OOMKilled}}' "$id" 2>/dev/null || true)"
  if [[ "$oom" == "true" ]]; then
    return 0
  fi
  echo "memory limit not enforced (rc=$rc oom=${oom:-unknown})" >&2
  return 1
}

check_pids() {
  with_sleep_ctr "$1" _pids_limited
}
_pids_limited() {
  local url="$1" id="$2" rc=0 out fail_count
  set +e
  out="$(exec_out "$url" "$id" bash -c 'ok=0; fail=0; i=0; while [ "$i" -lt 400 ]; do if sleep 30 >/dev/null 2>&1 & then ok=$((ok+1)); else fail=$((fail+1)); fi; i=$((i+1)); done; echo "ok=$ok fail=$fail"' 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -eq 137 || "$rc" -eq 9 ]]; then
    return 0
  fi
  fail_count="${out##*fail=}"
  fail_count="${fail_count%%[!0-9]*}"
  if [[ "${fail_count:-0}" -gt 0 ]]; then
    return 0
  fi
  echo "pids limit not enforced (rc=$rc)" >&2
  return 1
}

check_cpu() {
  local runtime="$1"
  if [[ "$runtime" == "crun" ]]; then
    with_sleep_ctr "$runtime" _cpu_crun
  else
    with_sleep_ctr "$runtime" _cpu_runsc
  fi
}
_cpu_crun() {
  local nanos
  nanos="$(sbx podman --url "$1" inspect --format '{{.HostConfig.NanoCpus}}' "$2")" || return 1
  [[ "$nanos" == "1000000000" ]] || return 1
}
_cpu_runsc() {
  local quota
  quota="$(sbx systemctl --user show "libpod-conmon-$2.scope" -p CPUQuotaPerSecUSec --value)" || return 1
  [[ "$quota" == "1s" || "$quota" == "100%" ]] || return 1
}

check_direct_egress() {
  with_sleep_ctr "$1" _direct_egress_blocked
}
_direct_egress_blocked() {
  local url="$1" id="$2" rc=0 err
  set +e
  err="$(exec_out "$url" "$id" bash -c 'echo >/dev/tcp/1.1.1.1/443' 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo "direct egress succeeded" >&2
    return 1
  fi
  if [[ "$err" == *"/dev/tcp"* && "$err" == *"No such file"* ]]; then
    echo "bash /dev/tcp is unavailable; egress result is inconclusive" >&2
    return 1
  fi
}

check_proxy_allow() {
  with_sleep_ctr "$1" _proxy_status "$ALLOW_PROBE_HOST" 200
}
check_proxy_deny() {
  with_sleep_ctr "$1" _proxy_status "$DENY_PROBE_HOST" 403
}
_proxy_status() {
  local url="$1" id="$2" host="$3" want="$4" line
  line="$(exec_out "$url" "$id" bash -c "exec 3<>/dev/tcp/10.0.2.2/8888 || exit 2; printf 'CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Connection: close\r\n\r\n' >&3; IFS= read -r status <&3; printf '%s\n' \"\$status\"; exec 3>&-")" || return 1
  [[ "$line" == *" ${want}"* ]] || return 1
}

check_no_socket() {
  with_sleep_ctr "$1" _no_socket
}
_no_socket() {
  local url="$1" id="$2" rc=0
  set +e
  exec_out "$url" "$id" sh -c 'test -e /run/sbx/podman.sock || test -e /run/sbx/podman-runsc.sock'
  rc=$?
  set -e
  # test -e returns 0 when the socket is visible. That is a failure.
  if [[ "$rc" -eq 0 ]]; then
    echo "podman socket is visible inside the container" >&2
    return 1
  fi
}

check_no_agentctl() {
  with_sleep_ctr "$1" _no_agentctl
}
_no_agentctl() {
  local url="$1" id="$2" rc=0
  set +e
  exec_out "$url" "$id" sh -c 'test -e /home/agentctl'
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo "/home/agentctl is visible inside the container" >&2
    return 1
  fi
}

test_T1a_crun() { check_uid crun; }
test_T1b_crun() { check_gid crun; }
test_T1c_crun() { check_caps crun; }
test_T1d_crun() { check_nnp crun; }
test_T2a_crun() { check_root_ro crun; }
test_T2b_crun() { check_tmp_rw crun; }
test_T2c_crun() { check_home_rw crun; }
test_T3a_crun() { check_memory crun; }
test_T3c_crun() { check_pids crun; }
test_T3e_crun() { check_cpu crun; }
test_T4a_crun() { check_direct_egress crun; }
test_T5a_crun() { check_proxy_allow crun; }
test_T5b_crun() { check_proxy_deny crun; }
test_T6a_crun() { check_no_socket crun; }
test_T6b_crun() { check_no_agentctl crun; }
test_T1a_runsc() { check_uid runsc; }
test_T1b_runsc() { check_gid runsc; }
test_T1c_runsc() { check_caps runsc; }
test_T1d_runsc() { check_nnp runsc; }
test_T2a_runsc() { check_root_ro runsc; }
test_T2b_runsc() { check_tmp_rw runsc; }
test_T2c_runsc() { check_home_rw runsc; }
test_T3a_runsc() { check_memory runsc; }
test_T3c_runsc() { check_pids runsc; }
test_T3e_runsc() { check_cpu runsc; }
test_T4a_runsc() { check_direct_egress runsc; }
test_T5a_runsc() { check_proxy_allow runsc; }
test_T5b_runsc() { check_proxy_deny runsc; }
test_T6a_runsc() { check_no_socket runsc; }
test_T6b_runsc() { check_no_agentctl runsc; }

require_dir_mode() {
  local path="$1" mode="$2" owner="$3" actual_mode actual_owner
  [[ ! -L "$path" ]] || return 1
  actual_mode="$(stat -c %a "$path")" || return 1
  [[ "$actual_mode" == "$mode" ]] || return 1
  actual_owner="$(stat -c %U "$path")" || return 1
  [[ "$actual_owner" == "$owner" ]] || return 1
}

test_H1() {
  [[ "$(id -u agentctl)" == "1000" ]]
}
test_H2() {
  [[ "$(id -u sbx)" == "1001" ]]
}
test_H3() {
  require_dir_mode /home/agentctl/data 700 agentctl
}
test_H4() {
  require_dir_mode /home/agentctl/secrets 700 agentctl
}
test_H5() {
  [[ -S /run/sbx/podman.sock ]]
}
test_H6() {
  [[ -S /run/sbx/podman-runsc.sock ]]
}
test_H7() {
  sbx podman --url "$(socket_for crun)" image exists localhost/sandbox-base:1
}
test_H8() {
  grep -F -q -- '--ignore-cgroups' /usr/local/bin/runsc-rootless
}
test_H9() {
  slice_has MemoryMax 2600M 2726297600
}
test_H10() {
  slice_has MemorySwapMax 512M 536870912
}
test_H11() {
  slice_has TasksMax 2048 2048
}
test_H12() {
  local quota limits
  limits="${SBX_SLICE_LIMITS:-/etc/systemd/system/user-1001.slice.d/limits.conf}"
  quota="$(systemctl show user-1001.slice -p CPUQuotaPerSecUSec --value 2>/dev/null || true)"
  if [[ "$quota" == "2.5s" || "$quota" == "250%" ]]; then
    return 0
  fi
  grep -E -q '^CPUQuota=250%' "$limits" || return 1
}
slice_has() {
  local prop="$1" pretty="$2" bytes="$3" value limits
  limits="${SBX_SLICE_LIMITS:-/etc/systemd/system/user-1001.slice.d/limits.conf}"
  value="$(systemctl show user-1001.slice -p "$prop" --value 2>/dev/null || true)"
  if [[ "$value" == "$pretty" || "$value" == "$bytes" || "$value" == "${pretty%M}" ]]; then
    return 0
  fi
  grep -E -q "^${prop}=${pretty}$" "$limits" || return 1
}
test_H13() {
  local rules
  if [[ -n "${SBX_NFT_SNAPSHOT:-}" ]]; then
    rules="$(cat "$SBX_NFT_SNAPSHOT")" || return 1
  else
    rules="$(nft list table inet sbx_egress)" || return 1
  fi
  [[ "$rules" == *"8888"* ]] || return 1
  [[ "$rules" == *"drop"* || "$rules" == *"reject"* ]] || return 1
}
test_H14() {
  local conf="" candidate
  local -a candidates=()
  if [[ -n "${SBX_TINYPROXY_CONF:-}" ]]; then
    candidates=("$SBX_TINYPROXY_CONF")
  else
    candidates=(/etc/tinyproxy/tinyproxy.conf /etc/tinyproxy.conf)
  fi
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      conf="$candidate"
      break
    fi
  done
  [[ -n "$conf" ]] || return 1
  grep -E -q '^[[:space:]]*FilterDefaultDeny[[:space:]]+Yes[[:space:]]*$' "$conf" || return 1
  if [[ -n "${SBX_LISTEN_SNAPSHOT:-}" ]]; then
    grep -F -q '127.0.0.1:8888' "$SBX_LISTEN_SNAPSHOT" || return 1
  else
    ss -ltn | grep -F -q '127.0.0.1:8888' || return 1
  fi
}
test_H15() {
  local root="${SBX_WORKSPACE_ROOT:-/home/sbx/workspaces}"
  [[ -d "$root" ]] || return 1
  [[ ! -L "$root" ]] || return 1
  local mode
  mode="$(stat -c %a "$root")" || return 1
  # 027 = group-write plus any other-access. 0750 clears those bits; 0755 does not.
  [[ $((8#$mode & 8#027)) -eq 0 ]] || return 1
  local bot session smode
  for bot in "$root"/*; do
    [[ -d "$bot" ]] || continue
    [[ ! -L "$bot" ]] || return 1
    mode="$(stat -c %a "$bot")" || return 1
    [[ $((8#$mode & 8#027)) -eq 0 ]] || return 1
    for session in "$bot"/*; do
      [[ -e "$session" ]] || continue
      [[ ! -L "$session" ]] || return 1
      smode="$(stat -c %a "$session")" || return 1
      # A session leaf may be 0777. 022 = group-write or other-write.
      [[ "$smode" == "777" || $((8#$smode & 8#022)) -eq 0 ]] || return 1
    done
  done
}
test_H16() {
  node --experimental-strip-types "$ROOT/path-escape-check.ts" self-test >/dev/null || return 1
  if [[ -d /home/agentctl && ! -L /home/agentctl ]]; then
    local tmp out rc=0
    tmp="$(mktemp -d)" || return 1
    out="$(mktemp)" || { rm -rf "$tmp"; return 1; }
    ln -s /home/agentctl "$tmp/agentctl" || { rm -rf "$tmp" "$out"; return 1; }
    set +e
    node --experimental-strip-types "$ROOT/path-escape-check.ts" read "$tmp" agentctl >"$out" 2>/dev/null
    rc=$?
    set -e
    if [[ "$rc" -eq 0 || -s "$out" ]]; then
      rm -rf "$tmp" "$out"
      echo "symlink to /home/agentctl was readable" >&2
      return 1
    fi
    rm -rf "$tmp" "$out" || return 1
  fi
}
test_T8() {
  local url id i rc=0
  url="$(socket_for crun)"
  local -a ids=()
  cleanup_t8() {
    local existing
    for existing in "${ids[@]}"; do
      sbx podman --url "$url" rm -f "$existing" >/dev/null 2>&1 || true
    done
  }
  trap cleanup_t8 RETURN
  for i in 1 2 3; do
    id="$(sbx podman --url "$url" create --name "ppa-t8-${BASHPID}-${i}" "${HARD_FLAGS[@]}" localhost/sandbox-base:1 sleep 90)" || return 1
    ids+=("$id")
    sbx podman --url "$url" start "$id" >/dev/null || return 1
  done
  sleep 2 || return 1
  if ! awk '
    $1 == "MemTotal:" { total = $2 }
    $1 == "MemAvailable:" { avail = $2 }
    END {
      if (total == 0) exit 1
      used = (total - avail) / 1024
      if (used < 3000) exit 0
      exit 1
    }
  ' /proc/meminfo; then
    rc=1
    echo "host used memory is not under 3000 MiB" >&2
  fi
  if ! systemctl is-active --quiet ssh && ! systemctl is-active --quiet sshd && ! pgrep -x sshd >/dev/null; then
    rc=1
    echo "sshd is not alive" >&2
  fi
  return "$rc"
}
test_T9() {
  local runtime url count=0 n
  for runtime in crun runsc; do
    url="$(socket_for "$runtime")"
    n="$(sbx podman --url "$url" ps -q | wc -l)" || return 1
    n="${n// /}"
    count=$((count + n)) || return 1
  done
  if [[ "$count" -gt "$MAX_SANDBOXES" ]]; then
    echo "running sandboxes=$count exceeds $MAX_SANDBOXES" >&2
    return 1
  fi
}

# Sourced by unit tests so they can call one check. Executing the file runs the suite.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

# `if "$fn"` disables set -e for the whole call, including helpers. Checks use
# `|| return 1` so an early failure is not replaced by a later success.
pass=0
fail=0
while IFS=$'\t' read -r id _desc; do
  [[ -n "$id" ]] || continue
  fn="test_${id//-/_}"
  if ! declare -F "$fn" >/dev/null; then
    echo "FAIL $id (missing $fn)"
    fail=$((fail + 1))
    continue
  fi
  if "$fn"; then
    echo "PASS $id"
    pass=$((pass + 1))
  else
    echo "FAIL $id"
    fail=$((fail + 1))
  fi
done <<<"$CATALOG"

echo "$pass passed, $fail failed (max sandboxes=$MAX_SANDBOXES)"
[[ "$fail" -eq 0 ]]
