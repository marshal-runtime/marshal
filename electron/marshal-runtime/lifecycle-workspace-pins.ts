import { randomUUID } from "node:crypto";

export const LIFECYCLE_PIN_METADATA_KEY = "marshalLifecyclePin";

/**
 * Pins the workspace a session resolved to at `startSession`, so its
 * `endSession` still resolves after the session record is deleted. A pin is
 * honoured only for the same session's lifecycle call carrying its one-off token.
 */
export class LifecycleWorkspacePins<Scope> {
  private readonly bySession = new Map<string, Scope>();
  private readonly byToken = new Map<string, { sessionId: string; scope: Scope }>();

  remember(sessionId: string, scope: Scope): void {
    this.bySession.set(sessionId, scope);
  }

  take(sessionId: string): Scope | undefined {
    const scope = this.bySession.get(sessionId);
    this.bySession.delete(sessionId);
    return scope;
  }

  async withPin<T>(
    sessionId: string,
    scope: Scope,
    run: (token: string) => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
    this.byToken.set(token, { sessionId, scope });
    try {
      return await run(token);
    } finally {
      this.byToken.delete(token);
    }
  }

  resolve(
    sessionId: string | undefined,
    metadata: Readonly<Record<string, unknown>> | undefined,
  ): Scope | undefined {
    const token = metadata?.[LIFECYCLE_PIN_METADATA_KEY];
    const pin = typeof token === "string" ? this.byToken.get(token) : undefined;
    return pin && pin.sessionId === sessionId ? pin.scope : undefined;
  }
}
