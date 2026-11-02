import { createLogger } from "../../common/marshal-logger";

const defaultLog = createLogger("RuntimeSessionLifecycle");

export interface RuntimeSessionLifecyclePort {
  startRuntimeSession(request: {
    sessionId: string;
    workspaceName: string;
    parentSessionId?: string;
  }): Promise<unknown>;
  endRuntimeSession(request: {
    sessionId: string;
    parentSessionId?: string;
    outcome?: string;
  }): Promise<unknown>;
}

export interface SessionLifecycleDispatcherDeps {
  readonly port: RuntimeSessionLifecyclePort;
  readonly resolveWorkspaceName: (sessionId: string) => Promise<string | null | undefined>;
  readonly log?: Pick<typeof defaultLog, "warn">;
}

export interface SessionLifecycleEvent {
  readonly sessionId: string;
  readonly parentSessionId?: string;
}

/**
 * Runtime-neutral bridge from Marshal session lifecycle to the Marshal
 * Runtime's `startSession` / `endSession`: start once per session per app
 * run, end only for sessions started this run. Calls are fire-and-forget and
 * never throw into the caller; failures are logged with metadata only.
 */
export class SessionLifecycleDispatcher {
  private readonly starts = new Map<
    string,
    { readonly started: Promise<boolean>; readonly parentSessionId?: string }
  >();
  private readonly log: Pick<typeof defaultLog, "warn">;

  constructor(private readonly deps: SessionLifecycleDispatcherDeps) {
    this.log = deps.log ?? defaultLog;
  }

  sessionStarted(event: SessionLifecycleEvent): Promise<void> {
    const existing = this.starts.get(event.sessionId);
    if (existing) return existing.started.then(() => undefined);
    const started = this.start(event);
    this.starts.set(event.sessionId, {
      started,
      ...(event.parentSessionId ? { parentSessionId: event.parentSessionId } : {}),
    });
    return started.then(() => undefined);
  }

  sessionEnded(event: SessionLifecycleEvent & { readonly outcome?: string }): Promise<void> {
    const entry = this.starts.get(event.sessionId);
    if (!entry) return Promise.resolve();
    this.starts.delete(event.sessionId);
    const parentSessionId = event.parentSessionId ?? entry.parentSessionId;
    return entry.started.then(async (ok) => {
      if (!ok) return;
      try {
        await this.deps.port.endRuntimeSession({
          sessionId: event.sessionId,
          ...(parentSessionId ? { parentSessionId } : {}),
          ...(event.outcome ? { outcome: event.outcome } : {}),
        });
      } catch (error) {
        this.warn("endSession", event.sessionId, error);
      }
    });
  }

  private async start(event: SessionLifecycleEvent): Promise<boolean> {
    try {
      const workspaceName = await this.deps.resolveWorkspaceName(event.sessionId);
      if (!workspaceName) return false;
      await this.deps.port.startRuntimeSession({
        sessionId: event.sessionId,
        workspaceName,
        ...(event.parentSessionId ? { parentSessionId: event.parentSessionId } : {}),
      });
      return true;
    } catch (error) {
      this.warn("startSession", event.sessionId, error);
      return false;
    }
  }

  private warn(operation: string, sessionId: string, error: unknown): void {
    try {
      this.log.warn(`Runtime ${operation} failed`, {
        sessionId,
        error: error instanceof Error ? error.name : typeof error,
        code:
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined,
      });
    } catch {
      // Logging must never surface into session start or delete.
    }
  }
}
