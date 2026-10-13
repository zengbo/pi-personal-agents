/**
 * Parent ACL for agentctl. The controller does not create session leaves.
 * Leaves are created by the sbx workspace helper (mode 0700, owner of that process).
 * Group-write or any other-access is looser than 0750; this ACL is only r/x.
 */
export function parentAclArgs(parent: string, user = "agentctl"): readonly string[] {
  return ["setfacl", "-m", `u:${user}:rx`, parent];
}
