/**
 * useAutomationCapabilities — exposes the active backend's automation feature
 * flags to the renderer.
 *
 * The main process composes `BackendCapabilities` from the active backend
 * (Copilot / Gateway); this hook fetches the nested `automations` sub-object.
 * Consumers should branch on individual flags (`caps.multiStep`, etc.) rather
 * than on backend identity — per the Phase 2 abstraction spec, renderer code
 * checks `BackendCapabilities`, never `backend.origin`.
 *
 * Loading-state default: while the query is loading (or `window.backendAPI`
 * isn't present, e.g. in test harnesses that don't install it), the hook
 * returns the copilot-flavored all-true default so the UI never flickers
 * fields out during app startup. The trade-off: in gateway mode, capability-
 * gated sections briefly render against all-true defaults before settling.
 * Callers that want to hide gated sections during the settle window should
 * use `useAutomationCapabilitiesQuery()` (sibling hook below) instead, which
 * surfaces `isLoading` so the caller can render a placeholder / skeleton.
 */
import type { AutomationCapabilities } from "@common/marshal-ipc-contract";

import { useBackendCapabilitiesQuery } from "./useBackendCapabilities";

const ALL_ENABLED: AutomationCapabilities = {
  multiStep: true,
  workingDir: true,
  skills: true,
  perAutomationPermissions: true,
  conditionTrigger: true,
  heartbeat: true,
  heartbeatRunNow: true,
  bundleImport: true,
  exportImport: true,
  githubImport: true,
};

export function useAutomationCapabilities(): AutomationCapabilities {
  const { capabilities } = useBackendCapabilitiesQuery();

  return capabilities?.automations ?? ALL_ENABLED;
}

/**
 * Sibling hook to `useAutomationCapabilities()` that also surfaces the
 * loading state. Use when the caller wants to suppress capability-gated
 * sections during the brief settle window (e.g. gateway mode, where the
 * all-true loading default would render workDays/permissions/Run Now then
 * snap closed). `useAutomationCapabilities()` keeps its
 * `AutomationCapabilities` return type for the call sites that don't need
 * the loading bit (AutomationListView / AutomationFormView).
 *
 * Both hooks consume the shared backend-capabilities query, so adding this
 * costs zero extra IPC traffic.
 */
export function useAutomationCapabilitiesQuery(): {
  capabilities: AutomationCapabilities;
  isLoading: boolean;
} {
  const query = useBackendCapabilitiesQuery();

  return {
    capabilities: query.capabilities?.automations ?? ALL_ENABLED,
    isLoading: query.isLoading,
  };
}
