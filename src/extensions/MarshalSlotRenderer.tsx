// Renderer-owned extension slot resolution and error isolation.
import { createLogger } from "@common/marshal-logger";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { extensionClient } from "./extension-client";
import { registry, useRegistryVersion } from "./registry";
import type { SlotContextMap, SlotId } from "./slot-ids";

const log = createLogger("SlotRenderer");

/** Lightweight error boundary that silently swallows slot render errors. */
class SlotErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    log.error("slot component threw:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

interface SlotRendererProps<S extends SlotId> {
  /** The layout region to render a contribution for. */
  slotId: S;
  /**
   * Context specific to slot `S`. TypeScript infers `S` from `slotId`, so
   * passing a sidebar context to an editor slot is a compile-time error.
   */
  slotCtx: SlotContextMap[S];
  /**
   * Rendered when no contribution is active for this slot in the current context.
   * Preserves the existing default UI when no extension has registered for the slot.
   */
  fallback?: ReactNode;
  /**
   * When false, caller is responsible for subscribing to registry updates.
   * Useful in large lists (e.g. file tree) to avoid one subscription per row.
   */
  subscribeToRegistry?: boolean;
}

/**
 * Renders the active slot contribution, or `fallback` when
 * no contribution matches the current context.
 *
 * Generic over `S extends SlotId`: TypeScript infers `S` from the `slotId`
 * prop and enforces that `slotCtx` has the correct type for that slot.
 *
 * **How it works:**
 * 1. Subscribes to the registry via `useRegistryVersion(subscribeToRegistry)`
 *    (concurrent-safe).
 * 2. Calls `registry.resolve(slotId, slotCtx)` — returns the component and
 *    the `extensionId` that registered it.
 * 3. Calls `extensionClient.buildApi(extensionId)` to get the scoped
 *    `ExtensionAPI` for that extension. The result is memoized, so the same
 *    reference is passed on every render unless the extension changes.
 * 4. Renders `<Component ctx={slotCtx} api={api} />` or `fallback`.
 *
 * Components rendered here receive a scoped `api` and must NOT access
 * `window.*` directly. All Electron communication goes through `props.api`.
 */
export function SlotRenderer<S extends SlotId>({
  slotId,
  slotCtx,
  fallback = null,
  subscribeToRegistry = true,
}: SlotRendererProps<S>) {
  // Subscribe to registry mutations — triggers a re-render when contributions
  // are added or removed so the resolved component stays up to date.
  useRegistryVersion(subscribeToRegistry);

  const resolved = registry.resolve(slotId, slotCtx);
  if (!resolved) return <>{fallback}</>;

  const { component: ResolvedComponent, extensionId } = resolved;
  const api = extensionClient.buildApi(extensionId);

  return (
    <SlotErrorBoundary key={extensionId}>
      <ResolvedComponent ctx={slotCtx} api={api} />
    </SlotErrorBoundary>
  );
}
