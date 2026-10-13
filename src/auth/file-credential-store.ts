import fs from "node:fs";
import path from "node:path";

export interface StoredApiKey {
  readonly type: "api_key";
  readonly key?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface StoredOAuth {
  readonly type: "oauth";
  readonly refresh: string;
  readonly access: string;
  readonly expires: number;
  readonly [key: string]: unknown;
}

export type StoredCredential = StoredApiKey | StoredOAuth;

export interface StoredCredentialInfo {
  readonly providerId: string;
  readonly type: StoredCredential["type"];
}

/**
 * One JSON file per provider under a 0700 directory. Writes are 0600 and atomic
 * (temp file in the same directory, then rename). `modify` is the only write path.
 */
export class FileCredentialStore {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }

  async read(providerId: string): Promise<StoredCredential | undefined> {
    return this.readUnlocked(providerId);
  }

  async list(): Promise<readonly StoredCredentialInfo[]> {
    const names = fs.readdirSync(this.directory);
    const infos: StoredCredentialInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const providerId = name.slice(0, -".json".length);
      const credential = this.readUnlocked(providerId);
      if (credential !== undefined) {
        infos.push({ providerId, type: credential.type });
      }
    }
    return infos;
  }

  async modify(
    providerId: string,
    fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
  ): Promise<StoredCredential | undefined> {
    return this.lock(providerId, async () => {
      const current = this.readUnlocked(providerId);
      const next = await fn(current);
      if (next === undefined) {
        return current;
      }
      this.writeUnlocked(providerId, next);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.lock(providerId, async () => {
      const file = this.file(providerId);
      if (fs.existsSync(file)) {
        fs.rmSync(file);
      }
    });
  }

  private async lock<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.chains.set(
      providerId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private file(providerId: string): string {
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(providerId)) {
      throw new Error("invalid provider id");
    }
    return path.join(this.directory, `${providerId}.json`);
  }

  private readUnlocked(providerId: string): StoredCredential | undefined {
    const file = this.file(providerId);
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredCredential;
    if (parsed.type !== "api_key" && parsed.type !== "oauth") {
      throw new Error("credential file is not a known type");
    }
    return parsed;
  }

  private writeUnlocked(providerId: string, credential: StoredCredential): void {
    const file = this.file(providerId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(credential), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  }
}
