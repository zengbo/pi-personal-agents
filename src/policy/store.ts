import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface PolicyRule {
  readonly id: string;
  readonly bot: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, string>>;
  readonly decision: "allow" | "deny";
  readonly scope: "always";
  readonly expiresAt: number | null;
  readonly createdBy: "user";
}

export class PolicyStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY,
        bot TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        decision TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at INTEGER,
        created_by TEXT NOT NULL
      )
    `);
  }

  insert(rule: PolicyRule): void {
    if (rule.createdBy !== "user" || rule.scope !== "always") {
      throw new Error("only a user can store an always rule");
    }
    this.db
      .prepare(
        `INSERT INTO rules (id, bot, tool, args_json, decision, scope, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rule.id, rule.bot, rule.tool, JSON.stringify(rule.args), rule.decision, rule.scope, rule.expiresAt, rule.createdBy);
  }

  list(): PolicyRule[] {
    const rows = this.db
      .prepare("SELECT id, bot, tool, args_json, decision, scope, expires_at, created_by FROM rules ORDER BY id")
      .all() as Record<string, string | number | null>[];
    return rows.map((row) => ({
      id: String(row.id),
      bot: String(row.bot),
      tool: String(row.tool),
      args: JSON.parse(String(row.args_json)) as Record<string, string>,
      decision: row.decision === "deny" ? "deny" : "allow",
      scope: "always",
      expiresAt: typeof row.expires_at === "number" ? row.expires_at : null,
      createdBy: "user",
    }));
  }

  close(): void {
    this.db.close();
  }
}
