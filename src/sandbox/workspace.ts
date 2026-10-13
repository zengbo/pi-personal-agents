import fs from "node:fs";
import path from "node:path";

const PARENT_MODE = 0o750;
const LEAF_MODE = 0o777;
/** Group-write or any other-access. 0750 clears these bits; 0755 does not. */
const LOOSER_THAN_0750 = 0o027;

export class WorkspaceModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceModeError";
  }
}

export function sessionPaths(root: string, bot: string, session: string): { parent: string; leaf: string } {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(bot)) {
    throw new WorkspaceModeError("invalid bot name");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(session)) {
    throw new WorkspaceModeError("invalid session name");
  }
  return {
    parent: path.join(root, bot),
    leaf: path.join(root, bot, session),
  };
}

function modeBits(dir: string): number {
  return fs.lstatSync(dir).mode & 0o777;
}

/**
 * Create `root/bot` at 0750 and `root/bot/session` at 0777.
 * An existing parent that is looser than 0750 is refused. This function never
 * chmod's a parent to anything looser than 0750.
 */
export function ensureWorkspace(
  root: string,
  bot: string,
  session: string,
  applyAcl?: (parent: string) => void,
): string {
  const { parent, leaf } = sessionPaths(root, bot, session);
  ensureDirectory(root, PARENT_MODE);
  ensureDirectory(parent, PARENT_MODE);
  const parentMode = modeBits(parent);
  if ((parentMode & LOOSER_THAN_0750) !== 0) {
    throw new WorkspaceModeError(`parent ${parent} is mode ${parentMode.toString(8)}, looser than 0750`);
  }
  if (fs.existsSync(leaf)) {
    const stat = fs.lstatSync(leaf);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkspaceModeError("session leaf is not a real directory");
    }
  } else {
    fs.mkdirSync(leaf);
  }
  fs.chmodSync(leaf, LEAF_MODE);
  applyAcl?.(parent);
  if ((modeBits(parent) & LOOSER_THAN_0750) !== 0) {
    throw new WorkspaceModeError("parent mode was widened");
  }
  return leaf;
}

function ensureDirectory(dir: string, mode: number): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode });
    fs.chmodSync(dir, mode);
    return;
  }
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorkspaceModeError(`${dir} is not a real directory`);
  }
  if ((modeBits(dir) & LOOSER_THAN_0750) !== 0) {
    throw new WorkspaceModeError(`${dir} is looser than 0750`);
  }
}

export function parentAclArgs(parent: string, user = "agentctl"): readonly string[] {
  return ["setfacl", "-m", `u:${user}:rx`, parent];
}
