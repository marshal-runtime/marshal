import type { GoalRuntimeSnapshot } from "@common/goal-contract";
import type { RelayProviderRuntimeSnapshot } from "@common/relay-provider-settings";
import type { QueryClient } from "@tanstack/react-query";

import { goalQueryKey } from "../../features/chat/goal/useGoalState";
import {
  addRelayProviderSetupEvent,
  removeRelayProviderSetupEvent,
  RELAY_PROVIDER_SETTINGS_QUERY_KEY,
  RELAY_PROVIDER_SETUP_QUERY_KEY,
  type RelayProviderSetupEvents,
} from "../../features/integrations/relayProviderQueryKeys";

let activeGoalSubscription: (() => void) | null = null;

/** Call once at app boot — subscriptions live outside React so events
 *  fired while a panel is unmounted still invalidate the cache. */
export function wireQueryInvalidations(qc: QueryClient): () => void {
  const unsubAutomations =
    window.automationsAPI?.onChanged?.(() => {
      void qc.invalidateQueries({ queryKey: ["automations"] });
    }) ?? (() => {});

  const unsubRuntimeExtensions =
    window.runtimeExtensionsAPI?.onChanged?.(() => {
      void qc.invalidateQueries({ queryKey: ["runtime-ui", "packaged-resource"] });
      void qc.invalidateQueries({ queryKey: ["runtime-ui", "placements"] });
    }) ?? (() => {});

  const unsubModels =
    window.modelsAPI?.onChanged?.(() => {
      void qc.invalidateQueries({ queryKey: ["models"], exact: true });
    }) ?? (() => {});

  const unsubSkills =
    window.skillsAPI?.onChanged?.(() => {
      void qc.invalidateQueries({ queryKey: ["skills"] });
      void qc.invalidateQueries({ queryKey: ["automations"] });
    }) ?? (() => {});

  const unsubWorkspaceRegistry =
    window.workspaceAPI?.onWorkspaceRegistryChange?.(() => {
      void qc.invalidateQueries({ queryKey: ["workspaces"] });
      void qc.invalidateQueries({ queryKey: ["workspace", "root"] });
      void qc.invalidateQueries({ queryKey: ["workspace", "uiState"] });
    }) ?? (() => {});

  // settings:changed fires whenever SettingsManager.save() runs in main —
  // includes "Always allow" writes from in-chat permission cards via
  // PermissionPolicy → settingsManager.update(). The per-hook listener in
  // usePermissions only catches this while SettingsPanel/HeartbeatPanel is
  // mounted; wiring here ensures the ["permissions", "config"] cache is
  // invalidated even when the user is in chat, so opening Settings → Permissions
  // always reflects the latest state.
  const unsubSettings =
    window.settingsAPI?.onChanged?.(() => {
      void qc.invalidateQueries({ queryKey: ["permissions", "config"] });
    }) ?? (() => {});

  const unsubRelayProviderSettings =
    window.relayProviderSettingsAPI?.onChanged?.((snapshot) => {
      void qc.invalidateQueries({ queryKey: RELAY_PROVIDER_SETTINGS_QUERY_KEY, exact: true });
      if (shouldClearRelaySetup(snapshot)) {
        qc.setQueryData<RelayProviderSetupEvents>(RELAY_PROVIDER_SETUP_QUERY_KEY, (current = {}) =>
          removeRelayProviderSetupEvent(current, snapshot.providerKey, snapshot.accountId),
        );
      }
    }) ?? (() => {});

  const unsubRelayProviderSetup =
    window.relayProviderSettingsAPI?.onSetupChanged?.((event) => {
      qc.setQueryData<RelayProviderSetupEvents>(RELAY_PROVIDER_SETUP_QUERY_KEY, (current = {}) =>
        addRelayProviderSetupEvent(current, event),
      );
    }) ?? (() => {});

  const unsubSessionHydration =
    window.sessionsAPI?.onHydrationChanged?.((event) => {
      if (event.state !== "loaded") return;
      // Only refresh the hydrated session. The list isn't affected by a content
      // load; its title/preview changes arrive via onMetadataChanged, so a
      // ["sessions"] refetch here was a redundant full-list fetch on every open.
      void qc.invalidateQueries({ queryKey: ["session", event.sessionId] });
    }) ?? (() => {});

  activeGoalSubscription?.();
  const unsubGoal =
    window.goalAPI?.onChanged?.((event) => {
      const { sessionId, snapshot } = event;
      qc.setQueryData<GoalRuntimeSnapshot | null>(goalQueryKey(sessionId), snapshot);
    }) ?? (() => {});
  activeGoalSubscription = unsubGoal;

  return () => {
    unsubAutomations();
    unsubModels();
    unsubSkills();
    unsubRuntimeExtensions();
    unsubWorkspaceRegistry();
    unsubSettings();
    unsubRelayProviderSettings();
    unsubRelayProviderSetup();
    unsubSessionHydration();
    if (activeGoalSubscription === unsubGoal) {
      activeGoalSubscription();
      activeGoalSubscription = null;
    }
  };
}

function shouldClearRelaySetup(snapshot: RelayProviderRuntimeSnapshot): boolean {
  return ["connected", "disconnected", "disabled", "unavailable"].includes(
    snapshot.connection.state,
  );
}
