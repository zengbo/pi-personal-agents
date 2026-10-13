import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface AuditEvent {
  readonly time: number;
  readonly kind: "tool" | "decision" | "rule" | "ignored";
  readonly bot: string;
  readonly tool: string;
  readonly taskId: string;
  readonly outcome: string;
  readonly actor: string;
}

/**
 * Append-only JSONL. There is no delete or rewrite path.
 * `chattr +a` is attempted once and ignored when the filesystem refuses it.
 */
export class AuditLog {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.closeSync(fs.openSync(file, "a", 0o600));
    fs.chmodSync(file, 0o600);
    spawnSync("chattr", ["+a", file], { stdio: "ignore" });
  }

  append(event: AuditEvent): void {
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o600 });
  }

  read(): AuditEvent[] {
    const text = fs.readFileSync(this.file, "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AuditEvent);
  }

  path(): string {
    return this.file;
  }
}
