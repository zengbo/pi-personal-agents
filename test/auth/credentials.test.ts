import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileCredentialStore } from "../../src/auth/file-credential-store.ts";
import { LoginSession, chatgptLoginDriver } from "../../src/auth/login.ts";
import { containerEnv } from "../../src/sandbox/env.ts";

describe("credential store", () => {
  it("writes 0600 files and does not reveal the token through list or the login page", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ppa-secrets-"));
    try {
      const store = new FileCredentialStore(root);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      const login = new LoginSession(
        {
          async login(interaction) {
            interaction.notify({ type: "info", message: "打开登录页" });
            await interaction.prompt({ type: "manual_code", message: "粘贴授权码" });
            return { type: "oauth", access: "super-secret-token", refresh: "refresh-secret", expires: 1 };
          },
        },
        store,
        "openai",
      );
      login.start();
      await waitFor(async () => login.html().includes("粘贴授权码"));
      expect(login.html()).not.toContain("super-secret-token");
      login.submit("code-from-user");
      await waitFor(async () => (await store.read("openai")) !== undefined);
      const fileMode = statSync(path.join(root, "openai.json")).mode & 0o777;
      expect(fileMode).toBe(0o600);
      const listed = await store.list();
      expect(JSON.stringify(listed)).not.toContain("super-secret-token");
      expect(login.html()).not.toContain("super-secret-token");
      const left = store.modify("openai", async (current) => {
        if (current?.type !== "oauth") {
          throw new Error("missing");
        }
        return { ...current, access: `${current.access}-a` };
      });
      const right = store.modify("openai", async (current) => {
        if (current?.type !== "oauth") {
          throw new Error("missing");
        }
        return { ...current, access: `${current.access}-b` };
      });
      await Promise.all([left, right]);
      const saved = await store.read("openai");
      expect(saved?.type === "oauth" ? saved.access : "").toBe("super-secret-token-a-b");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads the pinned ChatGPT OAuth flow without calling the network", async () => {
    const driver = await chatgptLoginDriver();
    const loaded = driver as { login: unknown };
    expect(typeof loaded.login).toBe("function");
    const file = new URL("../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js", import.meta.url);
    const mod = (await import(file.href)) as { openaiChatGPTOAuth: { name: string } };
    expect(mod.openaiChatGPTOAuth.name).toContain("ChatGPT");
  });

  it("strips secrets from the container environment", () => {
    const env = containerEnv({
      OPENAI_API_KEY: "super-secret-token",
      PATH: "/usr/bin",
      NOTES: "/home/agentctl/secrets/token",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(JSON.stringify(env)).not.toContain("super-secret-token");
    expect(JSON.stringify(env)).not.toContain("/home/agentctl");
    expect(env.HTTP_PROXY).toBe("http://10.0.2.2:8888");
  });
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}
