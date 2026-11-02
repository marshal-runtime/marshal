import { useSyncExternalStore } from "react";
import type { ComponentType } from "react";

import { ExtensionApiBuilder } from "./extension-api-factory";
import type { ExtensionAPI } from "./extension-contracts";
import type { SlotContribution, SlotProps } from "./registry";
import { registry } from "./registry";
import type { SlotContextMap, SlotId } from "./slot-ids";

// ── 1P extension manifest ────────────────────────────────────────────────────

/**
 * Manifest for a first-party (bundled) extension.
 *
 * Unlike third-party manifests (`package.json`), these carry actual React
 * component references — they live in the TypeScript bundle and are registered
 * at startup via `src/extensions/registered.ts`.
 *
 * @example
 * // src/features/people/manifest.ts
 * import { SLOT } from "@/extensions";
 * import type { Extension1PManifest } from "@/extensions";
 * import { PersonEditor } from "./PersonEditor";
 *
 * export const peopleManifest: Extension1PManifest = {
 *   id: "com.example.people",
 *   displayName: "People",
 *   description: "Person profiles and relationship intelligence.",
 *   contributes: {
 *     slots: [
 *       {
 *         slotId: SLOT.CREATE_EDITOR,
 *         component: PersonEditor,
 *         activateWhen: ({ activeFileType }) =>
 *           activeFileType === "com.example.people.person",
 *       },
 *     ],
 *   },
 * };
 */
export interface Extension1PManifest {
  /** Manifest origin for shell-renderer extensions; union can expand later. */
  readonly origin: "marshal-shell";
  /** Reverse-DNS identifier — must be unique across all registered extensions. */
  readonly id: string;
  /** Human-readable name shown in the UI Extensions tab. */
  readonly displayName: string;
  readonly description?: string;
  readonly contributes: {
    /**
     * Layout slot contributions, discriminated by `slotId` so TypeScript
     * enforces that `component` and `activateWhen` match the context type of
     * the target slot.
     *
     * Each entry registers one React component for one slot.
     * Multiple entries may target the same slot (differentiated by `activateWhen`).
     */
    slots: ReadonlyArray<
      {
        [S in SlotId]: {
          slotId: S;
          /** Replace the slot's default UI with this component. */
          component?: ComponentType<SlotProps<S>>;
          /** Activation predicate. Receives the context for slot `S` only. */
          activateWhen?: (ctx: SlotContextMap[S]) => boolean;
        };
      }[SlotId]
    >;
  };
}

// ── ExtensionClient ───────────────────────────────────────────────────────────

/**
 * Renderer-side extension registry and API builder.
 *
 * Responsibilities:
 * - Register 1P extension manifests and wire their slot contributions into the
 *   `ComponentRegistry` (the single source of truth for which component renders
 *   in each slot at a given moment).
 * - Build a scoped `ExtensionAPI` for each extension — the ONLY surface slot
 *   components may use to reach Electron. All IPC calls are routed through this
 *   object; direct `window.*` access is not available to slot component code.
 *
 * Extensions are registered declaratively with `activateWhen` — no explicit
 * activation call is needed. When a condition becomes true (e.g. a file of
 * the right type is opened) the slot component becomes active automatically.
 *
 * ── Capability model ──────────────────────────────────────────────────────────
 *
 * `buildApi(extensionId)` returns an `ExtensionAPI` that routes calls to:
 *
 * | `api.*`           | IPC Channel                    |
 * |-------------------+--------------------------------|
 * | `chat.send`       | `window.copilotAPI.send`       |
 * | `workspace.*`     | `workspace:readFile/writeFile/listDir` |
 * | `skills.list`     | `skills:list`                  |
 *
 * **Note:** Per-extension capability enforcement is not yet implemented on the
 * main process side. A future version will gate these channels by extension ID.
 *
 */
class ExtensionClient {
  private readonly _manifests = new Map<string, Extension1PManifest>();
  private readonly _disposers = new Map<string, Array<() => void>>();
  private readonly _apiBuilder = new ExtensionApiBuilder();
  private readonly _listeners = new Set<() => void>();
  // Single source of truth for both manifest list and enabled state.
  private _snapshot: Array<{ manifest: Extension1PManifest; enabled: boolean }> = [];

  /**
   * Register a 1P extension.
   *
   * All slot contributions declared in the manifest are immediately wired
   * into the `ComponentRegistry`. Contributions with an `activateWhen`
   * predicate are dormant until the predicate returns `true`.
   *
   * Returns a deregister function. For static 1P registrations that live for
   * the entire app lifetime you can safely ignore the return value.
   */
  register(manifest: Extension1PManifest): () => void {
    this._manifests.set(manifest.id, manifest);
    // Preserve the current enabled state on re-register; default to false.
    const wasEnabled = this._enabledFor(manifest.id) ?? false;
    if (wasEnabled) this._contribute(manifest);
    this._rebuildSnapshot();
    return () => this._deregister(manifest.id);
  }

  /** Return a stable snapshot of all registered manifests with their enabled state. */
  list(): Array<{ manifest: Extension1PManifest; enabled: boolean }> {
    return this._snapshot;
  }

  /** Disable an extension: removes its slot contributions from the registry. */
  disable(extensionId: string): void {
    if (!this._enabledFor(extensionId)) return;
    this._decontribute(extensionId);
    this._rebuildSnapshot({ [extensionId]: false });
  }

  /** Enable a previously disabled extension: re-registers its slot contributions. */
  enable(extensionId: string): void {
    const current = this._enabledFor(extensionId);
    if (current === undefined || current) return;
    const manifest = this._manifests.get(extensionId);
    if (manifest) this._contribute(manifest);
    this._rebuildSnapshot({ [extensionId]: true });
  }

  /** Subscribe to changes in registered/enabled state (for `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Looks up the current `enabled` value from the snapshot; `undefined` if not registered. */
  private _enabledFor(id: string): boolean | undefined {
    return this._snapshot.find((e) => e.manifest.id === id)?.enabled;
  }

  /**
   * Rebuild `_snapshot` preserving existing enabled state, applying any
   * one-off `overrides` (used by enable/disable).
   */
  private _rebuildSnapshot(overrides?: Record<string, boolean>): void {
    const prev = new Map(this._snapshot.map((e) => [e.manifest.id, e.enabled]));
    this._snapshot = Array.from(this._manifests.values()).map((manifest) => ({
      manifest,
      enabled: overrides?.[manifest.id] ?? prev.get(manifest.id) ?? false,
    }));
    this._listeners.forEach((l) => l());
  }

  private _contribute(manifest: Extension1PManifest): void {
    const disposers: Array<() => void> = [];
    for (const slot of manifest.contributes.slots) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contribution: SlotContribution<any> = {
        id: `${manifest.id}::${slot.slotId}`,
        extensionId: manifest.id,
        slotId: slot.slotId,
        component: slot.component,
        activateWhen: slot.activateWhen,
      };
      disposers.push(registry.contribute(contribution));
    }
    this._disposers.set(manifest.id, disposers);
  }

  private _decontribute(extensionId: string): void {
    (this._disposers.get(extensionId) ?? []).forEach((d) => d());
    this._disposers.delete(extensionId);
  }

  private _deregister(extensionId: string): void {
    this._manifests.delete(extensionId);
    this._decontribute(extensionId);
    this._apiBuilder.evict(extensionId);
    this._rebuildSnapshot();
  }

  /**
   * Build (or return the cached) scoped `ExtensionAPI` for a given extension.
   *
   * The returned object is memoized per `extensionId` — the same reference is
   * returned on subsequent calls, so it is safe to use as a React prop or
   * effect dependency without causing spurious re-renders.
   */
  buildApi(extensionId: string): ExtensionAPI {
    return this._apiBuilder.build(extensionId);
  }
}

/**
 * Singleton `ExtensionClient`.
 *
 * Import this in `src/extensions/registered.ts` to register 1P extension
 * manifests, and in `MarshalSlotRenderer.tsx` to resolve the scoped `api` for a
 * resolved contribution.
 */
export const extensionClient = new ExtensionClient();

/**
 * React hook that returns the list of registered 1P extensions and re-renders
 * whenever an extension is registered, enabled, or disabled.
 */
export function useExtensions(): Array<{ manifest: Extension1PManifest; enabled: boolean }> {
  return useSyncExternalStore(
    (cb) => extensionClient.subscribe(cb),
    () => extensionClient.list(),
    () => [],
  );
}
