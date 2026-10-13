import { MAX_RUNNING_SANDBOXES, SANDBOX_IDLE_MS } from "./flags.ts";

export type RuntimeKind = "crun" | "runsc";

export interface SandboxSession {
  readonly bot: string;
  readonly session: string;
  readonly runtime: RuntimeKind;
  readonly workspaceLeaf: string;
}

export interface StartedSandbox {
  readonly containerId: string;
}

export interface SandboxDriver {
  start(session: SandboxSession): Promise<StartedSandbox>;
  stop(session: SandboxSession, containerId: string): Promise<void>;
}

export interface SandboxLease {
  readonly containerId: string;
  readonly session: SandboxSession;
  release(): void;
}

type SlotState = "starting" | "running" | "stopping";

interface Slot {
  session: SandboxSession;
  state: SlotState;
  containerId: string;
  refs: number;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: unknown) => void;
  cancelIdle?: () => void;
}

interface Waiter {
  session: SandboxSession;
  signal?: AbortSignal;
  resolve: (lease: SandboxLease) => void;
  reject: (error: unknown) => void;
  cleanup?: () => void;
}

export interface SandboxPoolOptions {
  readonly maxRunning?: number;
  readonly idleMs?: number;
  readonly schedule?: (ms: number, fn: () => void) => () => void;
}

/**
 * At most `maxRunning` containers (default 3). A further session waits in FIFO
 * order until one is stopped. Aborting the wait removes it from the queue.
 * Releasing the last user starts the idle timer; the workspace is not deleted.
 */
export class SandboxPool {
  private readonly maxRunning: number;
  private readonly idleMs: number;
  private readonly schedule: (ms: number, msFn: () => void) => () => void;
  private readonly slots = new Map<string, Slot>();
  private readonly waiters: Waiter[] = [];
  private readonly driver: SandboxDriver;

  constructor(driver: SandboxDriver, options: SandboxPoolOptions = {}) {
    this.driver = driver;
    this.maxRunning = options.maxRunning ?? MAX_RUNNING_SANDBOXES;
    this.idleMs = options.idleMs ?? SANDBOX_IDLE_MS;
    this.schedule = options.schedule ?? ((ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => {
        clearTimeout(timer);
      };
    });
    if (this.maxRunning < 1 || this.maxRunning > MAX_RUNNING_SANDBOXES) {
      throw new Error("sandbox concurrency cannot exceed 3");
    }
  }

  runningCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.state === "running" || slot.state === "starting") {
        count += 1;
      }
    }
    return count;
  }

  queuedCount(): number {
    return this.waiters.length;
  }

  async acquire(session: SandboxSession, signal?: AbortSignal): Promise<SandboxLease> {
    if (signal?.aborted) {
      throw abortError();
    }
    const key = sessionKey(session);
    const existing = this.slots.get(key);
    if (existing !== undefined && existing.state !== "stopping") {
      existing.cancelIdle?.();
      existing.cancelIdle = undefined;
      existing.refs += 1;
      await existing.ready;
      return this.lease(existing);
    }
    if (this.runningCount() >= this.maxRunning || this.waiters.length > 0) {
      return this.enqueue(session, signal);
    }
    return this.startNew(session);
  }

  async shutdown(): Promise<void> {
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup?.();
      waiter.reject(abortError());
    }
    const stopping: Promise<void>[] = [];
    for (const slot of this.slots.values()) {
      slot.cancelIdle?.();
      stopping.push(this.stopSlot(slot));
    }
    await Promise.all(stopping);
  }

  private enqueue(session: SandboxSession, signal?: AbortSignal): Promise<SandboxLease> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { session, resolve, reject };
      if (signal !== undefined) {
        waiter.signal = signal;
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(abortError());
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }
      this.waiters.push(waiter);
    });
  }

  private async startNew(session: SandboxSession): Promise<SandboxLease> {
    let resolveReady: () => void = () => {};
    let rejectReady: (error: unknown) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const slot: Slot = {
      session,
      state: "starting",
      containerId: "",
      refs: 1,
      ready,
      resolveReady,
      rejectReady,
    };
    this.slots.set(sessionKey(session), slot);
    try {
      const started = await this.driver.start(session);
      slot.containerId = started.containerId;
      slot.state = "running";
      slot.resolveReady();
      return this.lease(slot);
    } catch (error) {
      slot.state = "stopping";
      this.slots.delete(sessionKey(session));
      slot.rejectReady(error);
      this.pump();
      throw error;
    }
  }

  private lease(slot: Slot): SandboxLease {
    let released = false;
    return {
      containerId: slot.containerId,
      session: slot.session,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        slot.refs -= 1;
        if (slot.refs > 0 || slot.state !== "running") {
          return;
        }
        slot.cancelIdle = this.schedule(this.idleMs, () => {
          slot.cancelIdle = undefined;
          if (slot.refs === 0) {
            void this.stopSlot(slot);
          }
        });
      },
    };
  }

  private async stopSlot(slot: Slot): Promise<void> {
    if (slot.state !== "running") {
      return;
    }
    slot.state = "stopping";
    slot.cancelIdle?.();
    slot.cancelIdle = undefined;
    try {
      await this.driver.stop(slot.session, slot.containerId);
    } finally {
      this.slots.delete(sessionKey(slot.session));
      this.pump();
    }
  }

  private pump(): void {
    while (this.runningCount() < this.maxRunning && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        return;
      }
      if (waiter.signal?.aborted) {
        waiter.cleanup?.();
        waiter.reject(abortError());
        continue;
      }
      waiter.cleanup?.();
      void this.startNew(waiter.session).then(waiter.resolve, waiter.reject);
    }
  }
}

function sessionKey(session: SandboxSession): string {
  return `${session.bot}/${session.session}`;
}

function abortError(): Error {
  const error = new Error("sandbox queue aborted");
  error.name = "AbortError";
  return error;
}
