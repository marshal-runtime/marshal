import { EventEmitter } from "node:events";
/**
 * IPC handlers + broadcaster for the backend-agnostic identity surface.
 *
 * The renderer calls `identity:get` to fetch the composed UserIdentity on
 * mount, then subscribes to `identity:change` push events. Main recomposes
 * + broadcasts whenever a constituent state transitions (gateway sign-in/out
 * today; Copilot auth can be wired in once it gains push semantics).
 */

import type { UserIdentity } from "../../common/marshal-ipc-contract";
import type { IdentityComposerDeps } from "../identity/identity-composer";
import { composeIdentity } from "../identity/identity-composer";
import { sharedIpcHandle } from "../remote-access/shared-handlers";
import type { IpcDeps } from "./types";

type Broadcaster = (identity: UserIdentity) => void;

/**
 * Identity transition controller — holds the broadcaster + composer deps and
 * emits typed `signed-in` / `signed-out` events.
 *
 * Identity transitions are explicit (not derived from `refresh()`) because
 * `refresh()` fires for non-sign-in reasons too — token rotation, persona-
 * photo updates, gateway state recomposes — and downstream subscribers
 * (sync lifecycle and other account-bound services) only care about the actual sign-in /
 * sign-out edges.
 *
 * Subclassing `EventEmitter` with typed `on`/`off`/`emit` overloads matches
 * the established codebase pattern (`BackgroundServiceManager`,
 * `AutomationManager`, `SettingsManager`, `McpStore`, `TenantPolicyProvider`)
 * so consumers use the standard `.on(event, fn)` / `.off(event, fn)` shape.
 */
export class IdentityController extends EventEmitter {
  constructor(
    private readonly deps: IdentityComposerDeps,
    private readonly broadcaster: Broadcaster,
  ) {
    super();
  }

  /** Compose + return the current identity. */
  async get(): Promise<UserIdentity> {
    return composeIdentity(this.deps);
  }

  /** Recompose from current state and broadcast to the renderer. Safe to call
   *  on every source transition — idempotent if nothing changed. */
  async refresh(): Promise<void> {
    const next = await composeIdentity(this.deps);
    this.broadcaster(next);
  }

  /**
   * Notify subscribers that the user just signed in with `oid`. Consumers that
   * need the identity edge — not the recomposed snapshot — subscribe via
   * `on("signed-in", ...)`. Does NOT call `refresh()` — caller controls whether
   * to broadcast the recomposed identity.
   */
  notifySignedIn(oid: string): void {
    this.emit("signed-in", oid);
  }

  /** Notify subscribers that the user just signed out. */
  notifySignedOut(): void {
    this.emit("signed-out");
  }

  override on(eventName: "signed-in", listener: (oid: string) => void): this;
  override on(eventName: "signed-out", listener: () => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(eventName: string | symbol, listener: (...args: any[]) => void): this;
  override on(
    eventName: string | symbol,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (...args: any[]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  override off(eventName: "signed-in", listener: (oid: string) => void): this;
  override off(eventName: "signed-out", listener: () => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override off(eventName: string | symbol, listener: (...args: any[]) => void): this;
  override off(
    eventName: string | symbol,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (...args: any[]) => void,
  ): this {
    return super.off(eventName, listener);
  }

  override emit(eventName: "signed-in", oid: string): boolean;
  override emit(eventName: "signed-out"): boolean;
  override emit(eventName: string | symbol, ...args: unknown[]): boolean;
  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    return super.emit(eventName, ...args);
  }
}

/** Factory shim — kept so call sites read the same as the prior factory shape
 *  and the wiring change in `main.ts` stays a one-liner. */
export function createIdentityController(
  deps: IdentityComposerDeps,
  broadcaster: Broadcaster,
): IdentityController {
  return new IdentityController(deps, broadcaster);
}

export function registerIdentityHandlers(
  { ipcHandle }: Pick<IpcDeps, "ipcHandle">,
  controller: IdentityController,
): void {
  sharedIpcHandle(ipcHandle)("identity:get", async () => ({
    success: true as const,
    identity: await controller.get(),
  }));
}
