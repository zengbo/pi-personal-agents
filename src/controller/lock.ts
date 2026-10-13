import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface FileLock {
  release(): Promise<void>;
}

/**
 * Exclusive flock. A second controller exits instead of opening the same SQLite.
 * The holder is its own process group and exits once this pid is gone, so
 * SIGKILL cannot leave the lock behind.
 */
export function holdFlock(lockPath: string): Promise<FileLock> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.closeSync(fs.openSync(lockPath, "a", 0o600));
  fs.chmodSync(lockPath, 0o600);
  const child: ChildProcess = spawn(
    "flock",
    ["-n", "--", lockPath, "/bin/sh", "-c", `while /bin/kill -0 ${process.pid} 2>/dev/null; do /bin/sleep 0.2; done`],
    { stdio: "ignore", env: { PATH: "/usr/bin:/bin" }, detached: true },
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        release: () =>
          new Promise((done) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              done();
              return;
            }
            child.once("exit", () => {
              done();
            });
            if (child.pid === undefined) {
              child.kill();
            } else {
              try {
                process.kill(-child.pid, "SIGTERM");
              } catch {
                child.kill();
              }
            }
          }),
      });
    }, 40);
    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new Error(`database lock held (exit ${code ?? "signal"})`));
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}
