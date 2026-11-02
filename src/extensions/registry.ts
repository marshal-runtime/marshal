import { createLogger } from "@common/marshal-logger";
import { useSyncExternalStore } from "react";
import type { ComponentType } from "react";

import type { ExtensionAPI } from "./extension-contracts";
import type { SlotContextMap, SlotId } from "./slot-ids";

const log = createLogger("ComponentRegistry");

// Re-export context types so consumers import from one place.
export type {
  SlotContextBase,
  CreatePanelSlotContext,
  CreatePanelPrimarySidebarContext,
  SlotContextMap,
} from "./slot-ids";

// ── Context passed to every slot component ───────────────────────────────────

/**
 * Resolves to the context type for a specific slot.
 *
 * @example
 * // In a CREATE_EDITOR slot component:
 * import type { SlotContext } from "@/extensions";
 * import { SLOT } from "@/extensions";
 * type Ctx = SlotContext<typeof SLOT.CREATE_EDITOR>; // → SlotContextBase
 *
 * // In a CREATE_PRIMARY_SIDEBAR slot component:
 * type SidebarCtx = SlotContext<typeof SLOT.CREATE_PRIMARY_SIDEBAR>; // → PrimarySidebarContext
 */
export type SlotContext<S extends SlotId = SlotId> = SlotContextMap[S];

// ── Slot component contract ──────────────────────────────────────────────────

/**
 * Base props received by every registered slot component, parameterized by
 * the target slot.
 *
 * - `ctx` — context specific to the slot (e.g. only `CREATE_PRIMARY_SIDEBAR`
 *           includes `onFileSelect`).
 * - `api` — scoped capability surface. Use this for ALL Electron communication;
 *           never access `window.*` directly from a slot component.
 */
export interface SlotProps<S extends SlotId = SlotId> {
  /** Slot-specific context snapshot. */
  ctx: SlotContextMap[S];
  /**
   * Scoped extension API injected by `ExtensionClient`.
   * The only sanctioned way for a slot component to reach Electron.
   */
  api: ExtensionAPI;
}

// ── Contribution descriptor ───────────────────────────────────────────────────

/**
 * Descriptor passed to `registry.contribute()` to register a component or a
 * set of prop customizations for a named layout slot.
 *
 * Supply **`component`** to fully replace the slot's default UI, or
 * **`customizeProps`** to augment it without replacing it — or both.
 * TypeScript enforces that all fields are consistent with the target `slotId`.
 *
 * @template S - The target `SlotId`. Inferred from `slotId` at the call site.
 */
export interface SlotContribution<S extends SlotId = SlotId> {
  /**
   * Unique contribution ID. Re-registering with the same ID replaces the
   * previous entry (idempotent — safe to call inside a `useEffect`).
   */
  id: string;

  /**
   * The extension that owns this contribution.
   * Used by `SlotRenderer` to look up the scoped `ExtensionAPI` from
   * `ExtensionClient.buildApi()`. Must match the `id` field of the
   * `Extension1PManifest` that registered this contribution.
   */
  extensionId: string;

  /** Target layout region. */
  slotId: S;

  /**
   * The React component to render in place of the slot's default UI.
   * Omit when only providing `customizeProps`.
   */
  component?: ComponentType<SlotProps<S>>;

  /**
   * Optional activation guard evaluated on every render.
   * Receives the context specific to slot `S` — not a generic object.
   * Omit to always activate. Return `true` to activate, `false` to pass.
   *
   * @example
   * activateWhen: ({ activeFileType }) =>
   *   activeFileType === "com.example.people.person",
   */
  activateWhen?: (ctx: SlotContextMap[S]) => boolean;
}

// ── Registry ─────────────────────────────────────────────────────────────────

type Listener = () => void;
const NOOP_UNSUBSCRIBE = (): void => {};
const NOOP_SUBSCRIBE = (_listener: Listener): (() => void) => NOOP_UNSUBSCRIBE;
const ZERO_SNAPSHOT = (): number => 0;

class ComponentRegistry {
  // Stored as any internally; the public API enforces per-slot type safety.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _contributions = new Map<string, SlotContribution<any>>();
  private readonly _listeners = new Set<Listener>();
  private _version = 0;

  /**
   * Register a slot contribution.
   *
   * Returns a **disposer** function — call it to deregister (e.g. in a
   * `useEffect` cleanup). Safe to call multiple times with the same `id`.
   *
   * @example
   * const dispose = registry.contribute({
   *   id: "people.person-editor",
   *   slotId: SLOT.CREATE_EDITOR,
   *   component: PersonEditor,
   *   activateWhen: ({ activeFileType }) =>
   *     activeFileType === "com.example.people.person",
   * });
   * // Later: dispose();
   */
  contribute<S extends SlotId>(contribution: SlotContribution<S>): () => void {
    this._contributions.set(contribution.id, contribution);
    this._bumpAndNotify();
    return () => {
      this._contributions.delete(contribution.id);
      this._bumpAndNotify();
    };
  }

  /**
   * Resolve the active contribution for a slot.
   * Returns `{ component, extensionId }` when a match is found, or `null`
   * when no contribution is active (the `<SlotRenderer>` renders `fallback`).
   */
  resolve<S extends SlotId>(
    slotId: S,
    ctx: SlotContextMap[S],
  ): { component: ComponentType<SlotProps<S>>; extensionId: string } | null {
    for (const c of this._contributions.values()) {
      if (c.slotId !== slotId) continue;
      if (!c.component) continue;
      if (!this._safeActivate(c, ctx)) continue;
      // Safe: we verified c.slotId === slotId, so the generic parameter matches S.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return {
        component: c.component as ComponentType<SlotProps<S>>,
        extensionId: c.extensionId,
      };
    }
    return null;
  }

  /**
   * Subscribe to registry mutations (additions / removals).
   * Used internally by `useRegistryVersion()` via `useSyncExternalStore`.
   */
  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * Monotonically increasing version counter.
   * Stable snapshot value for `useSyncExternalStore` — increments on every
   * mutation, never goes backwards.
   */
  getVersion(): number {
    return this._version;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _safeActivate(c: SlotContribution<any>, ctx: unknown): boolean {
    if (!c.activateWhen) return true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-type-assertion
      return (c.activateWhen as (ctx: unknown) => boolean)(ctx);
    } catch (e) {
      log.error(`activateWhen threw for "${c.id}":`, e);
      return false;
    }
  }

  private _bumpAndNotify(): void {
    this._version++;
    this._listeners.forEach((l) => l());
  }
}

/**
 * Global singleton registry.
 *
 * Import this wherever you need to register contributions (`registered.ts`)
 * or resolve them (`MarshalSlotRenderer.tsx`). Never import the `ComponentRegistry`
 * class directly — use the singleton.
 */
export const registry = new ComponentRegistry();

/**
 * React hook that returns the current registry version and re-renders the
 * calling component whenever any contribution is added or removed.
 *
 * Uses `useSyncExternalStore` for concurrent-safe updates. Call this before
 * `registry.resolve()` in any component that needs to stay in sync.
 *
 * Pass `enabled = false` to opt out of subscriptions while preserving
 * React Hooks call order in callers.
 */
export function useRegistryVersion(enabled = true): number {
  return useSyncExternalStore(
    enabled ? (cb) => registry.subscribe(cb) : NOOP_SUBSCRIBE,
    enabled ? () => registry.getVersion() : ZERO_SNAPSHOT,
    enabled ? () => registry.getVersion() : ZERO_SNAPSHOT,
  );
}
