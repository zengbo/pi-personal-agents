import type { FileCredentialStore, StoredOAuth } from "./file-credential-store.ts";

export interface LoginNotice {
  readonly type: string;
  readonly message?: string;
  readonly url?: string;
  readonly userCode?: string;
  readonly verificationUri?: string;
}

export interface LoginDriver {
  login(interaction: {
    readonly signal: AbortSignal;
    prompt(prompt: { readonly type: string; readonly message: string }): Promise<string>;
    notify(event: LoginNotice): void;
  }): Promise<StoredOAuth>;
}

/**
 * One-shot login page. The OAuth driver prompts; the page shows the notice and
 * posts the code back. Stored tokens are never rendered.
 */
export class LoginSession {
  private pending: ((value: string) => void) | undefined;
  private notices: LoginNotice[] = [];
  private started = false;
  private failure = "";
  private readonly driver: LoginDriver;
  private readonly store: FileCredentialStore;
  private readonly providerId: string;

  constructor(driver: LoginDriver, store: FileCredentialStore, providerId: string) {
    this.driver = driver;
    this.store = store;
    this.providerId = providerId;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const controller = new AbortController();
    void this.driver
      .login({
        signal: controller.signal,
        prompt: (prompt) =>
          new Promise((resolve) => {
            this.pending = resolve;
            this.notices.push({ type: "prompt", message: prompt.message });
          }),
        notify: (event) => {
          this.notices.push(event);
        },
      })
      .then(async (credential) => {
        await this.store.modify(this.providerId, async () => credential);
        this.notices.push({ type: "done", message: "登录已保存" });
      })
      .catch(() => {
        this.failure = "登录失败";
      });
  }

  submit(code: string): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.(code);
  }

  html(): string {
    const last = this.notices.at(-1);
    const message = this.failure || last?.message || "等待登录";
    const url = last?.url ?? last?.verificationUri ?? "";
    const userCode = last?.userCode ?? "";
    return `<!doctype html>
<html lang="zh">
<meta charset="utf-8">
<title>登录</title>
<body>
<p>${escapeHtml(message)}</p>
${url.length > 0 ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : ""}
${userCode.length > 0 ? `<p>代码 ${escapeHtml(userCode)}</p>` : ""}
<form method="post" action="/login/code">
<label>授权码 <input name="code" autocomplete="off"></label>
<button type="submit">提交</button>
</form>
</body>
</html>`;
  }
}

export async function chatgptLoginDriver(): Promise<LoginDriver> {
  const file = new URL("../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js", import.meta.url);
  const loaded = (await import(file.href)) as {
    openaiChatGPTOAuth?: { login: LoginDriver["login"] };
  };
  const oauth = loaded.openaiChatGPTOAuth;
  if (oauth === undefined) {
    throw new Error("openaiChatGPTOAuth is not available");
  }
  return {
    login: (interaction) => oauth.login(interaction),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
