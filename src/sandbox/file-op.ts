/**
 * Session file operations run inside the container.
 * The controller never opens the leaf. Paths stay under /workspace.
 * The same script is what `runFileOp` executes against a temp root in tests.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { FileError } from "@earendil-works/pi-durable/env";

export const CONTAINER_WORKSPACE = "/workspace";

const SCRIPT_LINES = [
  "set -euo pipefail",
  "set -f",
  "die() { printf '%s\\n' \"$1\" >&2; exit 1; }",
  'root=$(realpath -e -- "$1") || die root',
  'op=$2',
  'req=${3-}',
  'extra=${4-}',
  "under_root() {",
  '  case "$1" in',
  '    "$root"|"$root"/*) return 0 ;;',
  "    *) return 1 ;;",
  "  esac",
  "}",
  "classify_symlink() {",
  "  local candidate resolved",
  '  candidate=$1',
  '  if ! resolved=$(realpath -e -- "$candidate" 2>/dev/null); then',
  "    die symlink",
  "  fi",
  '  if under_root "$resolved"; then',
  "    die symlink",
  "  fi",
  "  die escape",
  "}",
  "confine() {",
  "  local input joined part",
  '  input=$1',
  '  case "$input" in',
  "    *$'\\n'*|*$'\\t'*) die invalid ;;",
  "  esac",
  '  case "$input" in',
  '    /*) joined=$input ;;',
  '    *) joined="$root/$input" ;;',
  "  esac",
  "  local IFS=/",
  '  for part in $joined; do',
  '    if [[ "$part" == ".." ]]; then',
  "      die dotdot",
  "    fi",
  "  done",
  '  case "$joined" in',
  '    "$root"|"$root"/*) ;;',
  "    *) die escape ;;",
  "  esac",
  '  printf "%s" "$joined"',
  "}",
  "assert_real_chain() {",
  "  local dir acc part resolved",
  '  dir=$1',
  '  case "$dir" in',
  '    "$root"|"$root"/*) ;;',
  "    *) die escape ;;",
  "  esac",
  '  acc=""',
  "  local IFS=/",
  '  for part in $dir; do',
  '    if [[ -z "$part" ]]; then',
  "      continue",
  "    fi",
  '    if [[ "$part" == ".." ]]; then',
  "      die dotdot",
  "    fi",
  '    if [[ -z "$acc" ]]; then',
  '      acc="/$part"',
  "    else",
  '      acc="$acc/$part"',
  "    fi",
  '    case "$acc" in',
  '      "$root"|"$root"/*) ;;',
  "      *) continue ;;",
  "    esac",
  '    if [[ -L "$acc" ]]; then',
  '      classify_symlink "$acc"',
  "    fi",
  '    if [[ -e "$acc" ]]; then',
  '      resolved=$(realpath -e -- "$acc") || die not_found',
  '      if ! under_root "$resolved"; then',
  "        die escape",
  "      fi",
  "    fi",
  "  done",
  "}",
  "op_read() {",
  "  local candidate resolved links",
  '  candidate=$(confine "$1")',
  '  if [[ "$candidate" == "$root" ]]; then die not_file; fi',
  '  if [[ ! -e "$candidate" && ! -L "$candidate" ]]; then die not_found; fi',
  '  if [[ -L "$candidate" ]]; then classify_symlink "$candidate"; fi',
  '  resolved=$(realpath -e -- "$candidate") || die not_found',
  '  if ! under_root "$resolved"; then die escape; fi',
  '  if [[ -d "$resolved" ]]; then die not_file; fi',
  '  if [[ ! -f "$resolved" ]]; then die not_file; fi',
  '  links=$(stat -c %h -- "$resolved") || die unknown',
  '  if [[ "$links" -gt 1 ]]; then die hardlink; fi',
  '  if [[ -L "$candidate" ]]; then classify_symlink "$candidate"; fi',
  '  cat -- "$resolved"',
  "}",
  "write_bytes() {",
  "  local candidate resolved links append",
  '  candidate=$(confine "$1")',
  '  append=$2',
  '  if [[ "$candidate" == "$root" ]]; then die invalid; fi',
  '  assert_real_chain "$(dirname -- "$candidate")"',
  '  if [[ -L "$candidate" ]]; then classify_symlink "$candidate"; fi',
  '  if [[ -d "$candidate" ]]; then die not_file; fi',
  '  if [[ -e "$candidate" ]]; then',
  '    resolved=$(realpath -e -- "$candidate") || die not_found',
  '    if ! under_root "$resolved"; then die escape; fi',
  '    if [[ ! -f "$resolved" ]]; then die not_file; fi',
  '    links=$(stat -c %h -- "$resolved") || die unknown',
  '    if [[ "$links" -gt 1 ]]; then die hardlink; fi',
  '    if [[ "$append" == "append" ]]; then',
  '      tee -a -- "$resolved" >/dev/null',
  "    else",
  '      tee -- "$resolved" >/dev/null',
  "    fi",
  "    return 0",
  "  fi",
  '  if [[ "$append" == "append" ]]; then',
  '    tee -a -- "$candidate" >/dev/null',
  "  else",
  '    tee -- "$candidate" >/dev/null',
  "  fi",
  "}",
  "op_truncate() {",
  "  local candidate resolved links size",
  '  candidate=$(confine "$1")',
  '  size=$2',
  '  [[ "$size" =~ ^[0-9]+$ ]] || die invalid',
  '  if [[ -L "$candidate" ]]; then classify_symlink "$candidate"; fi',
  '  if [[ ! -e "$candidate" ]]; then die not_found; fi',
  '  resolved=$(realpath -e -- "$candidate") || die not_found',
  '  if ! under_root "$resolved"; then die escape; fi',
  '  if [[ ! -f "$resolved" ]]; then die not_file; fi',
  '  links=$(stat -c %h -- "$resolved") || die unknown',
  '  if [[ "$links" -gt 1 ]]; then die hardlink; fi',
  '  truncate -s "$size" -- "$resolved"',
  "}",
  "op_flush() {",
  "  local candidate resolved",
  '  candidate=$(confine "$1")',
  '  if [[ -L "$candidate" ]]; then classify_symlink "$candidate"; fi',
  '  if [[ ! -e "$candidate" ]]; then die not_found; fi',
  '  resolved=$(realpath -e -- "$candidate") || die not_found',
  '  if ! under_root "$resolved"; then die escape; fi',
  '  sync -- "$resolved"',
  "}",
  "op_rename() {",
  "  local src dest resolved_src dest_parent resolved_dest",
  '  src=$(confine "$1")',
  '  dest=$(confine "$2")',
  '  if [[ "$src" == "$root" || "$dest" == "$root" ]]; then die invalid; fi',
  '  if [[ -L "$src" ]]; then classify_symlink "$src"; fi',
  '  if [[ ! -e "$src" ]]; then die not_found; fi',
  '  resolved_src=$(realpath -e -- "$src") || die not_found',
  '  if ! under_root "$resolved_src"; then die escape; fi',
  '  dest_parent=$(dirname -- "$dest")',
  '  assert_real_chain "$dest_parent"',
  '  if [[ ! -d "$dest_parent" ]]; then die not_found; fi',
  '  if [[ -L "$dest" ]]; then classify_symlink "$dest"; fi',
  '  if [[ -e "$dest" ]]; then',
  '    resolved_dest=$(realpath -e -- "$dest") || die not_found',
  '    if ! under_root "$resolved_dest"; then die escape; fi',
  "  fi",
  '  mv -- "$resolved_src" "$dest"',
  "}",
  "op_stat() {",
  "  local candidate resolved kind size mtime",
  '  candidate=$(confine "$1")',
  '  if [[ -L "$candidate" ]]; then classify_symlink "$candidate"; fi',
  '  if [[ ! -e "$candidate" ]]; then die not_found; fi',
  '  resolved=$(realpath -e -- "$candidate") || die not_found',
  '  if ! under_root "$resolved"; then die escape; fi',
  '  if [[ -d "$resolved" ]]; then',
  "    kind=directory",
  '  elif [[ -f "$resolved" ]]; then',
  "    kind=file",
  "  else",
  "    die invalid",
  "  fi",
  '  size=$(stat -c %s -- "$resolved") || die unknown',
  '  mtime=$(stat -c %Y -- "$resolved") || die unknown',
  '  printf "%s %s %s\\n" "$kind" "$size" "$mtime"',
  "}",
  "op_list() {",
  "  local candidate resolved name entry kind size mtime",
  '  candidate=$(confine "$1")',
  '  if [[ -L "$candidate" ]]; then classify_symlink "$candidate"; fi',
  '  if [[ ! -e "$candidate" ]]; then die not_found; fi',
  '  resolved=$(realpath -e -- "$candidate") || die not_found',
  '  if ! under_root "$resolved"; then die escape; fi',
  '  if [[ ! -d "$resolved" ]]; then die not_directory; fi',
  '  while IFS= read -r name; do',
  '    [[ -n "$name" ]] || continue',
  '    entry="$resolved/$name"',
  '    if [[ -L "$entry" ]]; then',
  '      printf "%s\\tsymlink\\t0\\t0\\n" "$name"',
  "      continue",
  "    fi",
  '    if [[ -d "$entry" ]]; then',
  "      kind=directory",
  '    elif [[ -f "$entry" ]]; then',
  "      kind=file",
  "    else",
  "      kind=file",
  "    fi",
  '    size=$(stat -c %s -- "$entry") || die unknown',
  '    mtime=$(stat -c %Y -- "$entry") || die unknown',
  '    printf "%s\\t%s\\t%s\\t%s\\n" "$name" "$kind" "$size" "$mtime"',
  '  done < <(ls -A -- "$resolved")',
  "}",
  "op_exists() {",
  "  local candidate resolved",
  '  candidate=$(confine "$1")',
  '  if [[ -L "$candidate" ]]; then classify_symlink "$candidate"; fi',
  '  if [[ ! -e "$candidate" ]]; then',
  "    printf 'no\\n'",
  "    return 0",
  "  fi",
  '  resolved=$(realpath -e -- "$candidate") || die not_found',
  '  if ! under_root "$resolved"; then die escape; fi',
  "  printf 'yes\\n'",
  "}",
  "op_mkdir() {",
  "  local candidate mode parent",
  '  candidate=$(confine "$1")',
  '  mode=${2-}',
  '  if [[ "$candidate" == "$root" ]]; then return 0; fi',
  '  assert_real_chain "$candidate"',
  '  if [[ "$mode" == "recursive" ]]; then',
  '    mkdir -p -- "$candidate"',
  "  else",
  '    parent=$(dirname -- "$candidate")',
  '    [[ -d "$parent" ]] || die not_found',
  '    mkdir -- "$candidate"',
  "  fi",
  "}",
  "op_rm() {",
  "  local candidate mode recursive force resolved",
  '  candidate=$(confine "$1")',
  '  mode=${2-}',
  "  recursive=0",
  "  force=0",
  '  case "$mode" in',
  "    recursive) recursive=1 ;;",
  "    force) force=1 ;;",
  "    recursive-force) recursive=1; force=1 ;;",
  '    ""|plain) ;;',
  "    *) die invalid ;;",
  "  esac",
  '  if [[ "$candidate" == "$root" ]]; then die invalid; fi',
  '  if [[ -L "$candidate" ]]; then',
  '    rm -- "$candidate"',
  "    return 0",
  "  fi",
  '  if [[ ! -e "$candidate" ]]; then',
  '    if [[ "$force" -eq 1 ]]; then return 0; fi',
  "    die not_found",
  "  fi",
  '  resolved=$(realpath -e -- "$candidate") || die not_found',
  '  if ! under_root "$resolved"; then die escape; fi',
  '  if [[ "$resolved" == "$root" ]]; then die invalid; fi',
  '  if [[ "$recursive" -eq 1 ]]; then',
  '    rm -r -- "$resolved"',
  "  else",
  '    rm -- "$resolved"',
  "  fi",
  "}",
  "safe_component() {",
  '  [[ "$1" =~ ^[A-Za-z0-9._-]{0,40}$ ]] || die invalid',
  "}",
  "op_mktemp_dir() {",
  "  local prefix created rel",
  '  prefix=${1:-tmp-}',
  '  [[ -n "$prefix" ]] || prefix=tmp-',
  '  safe_component "$prefix"',
  '  mkdir -p -- "$root/.tmp"',
  '  created=$(mktemp -d -- "$root/.tmp/${prefix}XXXXXX") || die unknown',
  '  if ! under_root "$created"; then die escape; fi',
  '  rel=${created#"$root"/}',
  '  printf "%s\\n" "$rel"',
  "}",
  "op_mktemp_file() {",
  "  local prefix suffix created rel",
  '  prefix=${1:-tmp-}',
  '  suffix=${2-}',
  '  [[ -n "$prefix" ]] || prefix=tmp-',
  '  safe_component "$prefix"',
  '  safe_component "$suffix"',
  '  mkdir -p -- "$root/.tmp"',
  '  if [[ -n "$suffix" ]]; then',
  '    created=$(mktemp --suffix="$suffix" -- "$root/.tmp/${prefix}XXXXXX") || die unknown',
  "  else",
  '    created=$(mktemp -- "$root/.tmp/${prefix}XXXXXX") || die unknown',
  "  fi",
  '  if ! under_root "$created"; then die escape; fi',
  '  rel=${created#"$root"/}',
  '  printf "%s\\n" "$rel"',
  "}",
  'case "$op" in',
  '  read) op_read "$req" ;;',
  '  write) write_bytes "$req" plain ;;',
  '  append) write_bytes "$req" append ;;',
  '  truncate) op_truncate "$req" "$extra" ;;',
  '  flush) op_flush "$req" ;;',
  '  rename) op_rename "$req" "$extra" ;;',
  '  stat) op_stat "$req" ;;',
  '  list) op_list "$req" ;;',
  '  exists) op_exists "$req" ;;',
  '  mkdir) op_mkdir "$req" "$extra" ;;',
  '  rm) op_rm "$req" "$extra" ;;',
  '  mktemp-dir) op_mktemp_dir "$extra" ;;',
  '  mktemp-file) op_mktemp_file "$req" "$extra" ;;',
  "  *) die invalid ;;",
  "esac",
];

export const FILE_OP_SCRIPT = SCRIPT_LINES.join("\n");

export interface ParsedFileOp {
  readonly op: string;
  readonly path: string;
  readonly extra?: string;
}

export function fileOpArgv(op: string, containerPath: string, extra?: string): readonly string[] {
  const argv = ["bash", "-c", FILE_OP_SCRIPT, "fileop", CONTAINER_WORKSPACE, op, containerPath];
  if (extra !== undefined) {
    argv.push(extra);
  }
  return argv;
}

export function parseFileOpArgv(command: string | readonly string[]): ParsedFileOp | undefined {
  if (typeof command === "string") {
    return undefined;
  }
  if (
    command.length < 7
    || command[0] !== "bash"
    || command[1] !== "-c"
    || command[2] !== FILE_OP_SCRIPT
    || command[3] !== "fileop"
    || command[4] !== CONTAINER_WORKSPACE
  ) {
    return undefined;
  }
  const op = command[5];
  const requestPath = command[6];
  if (op === undefined || requestPath === undefined) {
    return undefined;
  }
  const extra = command[7];
  return extra === undefined ? { op, path: requestPath } : { op, path: requestPath, extra };
}

/** Lexical confinement. `..` and absolute paths outside /workspace never reach exec. */
export function confineWorkspacePath(cwd: string, input: string): string {
  if (input.includes("\0") || cwd.includes("\0")) {
    throw new FileError("invalid", "nul", input);
  }
  if (input.split("/").includes("..") || cwd.split("/").includes("..")) {
    throw new FileError("invalid", "dotdot", input);
  }
  const joined = input.startsWith("/") ? input : path.posix.join(cwd.length === 0 ? CONTAINER_WORKSPACE : cwd, input);
  if (joined.split("/").includes("..")) {
    throw new FileError("invalid", "dotdot", input);
  }
  const normalized = path.posix.normalize(joined);
  if (normalized.split("/").includes("..")) {
    throw new FileError("invalid", "dotdot", input);
  }
  if (normalized !== CONTAINER_WORKSPACE && !normalized.startsWith(`${CONTAINER_WORKSPACE}/`)) {
    throw new FileError("invalid", "escape", input);
  }
  return normalized;
}

export interface LocalFileOpResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Run the container script against a directory that stands in for /workspace. */
export function runFileOp(root: string, op: string, target: string, stdin?: Uint8Array, extra?: string): LocalFileOpResult {
  const args = ["-c", FILE_OP_SCRIPT, "fileop", root, op, target];
  if (extra !== undefined) {
    args.push(extra);
  }
  const result = spawnSync("bash", args, {
    input: stdin === undefined ? undefined : Buffer.from(stdin),
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : "";
  return { exitCode: result.status ?? 1, stdout, stderr };
}
