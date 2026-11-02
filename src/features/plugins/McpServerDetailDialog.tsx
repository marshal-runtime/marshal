import type { McpServerInfo } from "@common/marshal-ipc-contract";
import { toMcpServerKey } from "@common/mcp-server-key-normalization";
import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  mcpOAuthStore,
  openMcpOAuthPrompt,
  useIsMutatingMcpServerSignOut,
  useSignOutMcpServerMutation,
} from "@/hooks/mcp-oauth-store";

import {
  getMcpOAuthAction,
  getMcpOAuthSecondaryAction,
  getMcpServerDescription,
  getMcpServerDetails,
} from "./mcp-server-utils";
import { CustomDetailDialog } from "./PluginsDetailDialog";
import type { PluginsCategory } from "./usePluginsData";

/**
 * UI-only snapshot of a card the user clicked on (icon, displayName,
 * description, scope, …) — NOT a live MCP server reference. The dialog
 * reads live status/OAuth/sign-out state from the OAuth store and the
 * `customMcpServerInfos` lookup, so the dialog reflects the current
 * state, not the values that were true when the user opened it.
 */
export interface SelectedCustomItem {
  type: PluginsCategory;
  id?: string;
  name: string;
  displayName?: string;
  icon: string;
  description?: string;
  instructions?: string;
  details?: { label: string; value: string; linkify?: boolean }[];
  scope?: "local" | "global" | "bundled";
  bundleDirs?: string[];
}

interface McpServerDetailDialogProps {
  /** Snapshot of the user's selection; also drives the vanished-server fallback. */
  selectedCustom: SelectedCustomItem;
  /** Unfiltered list of custom MCP server infos. Used (NOT
   *  `filteredMcpServers`) so the live lookup keeps working after the user
   *  types a search query that would exclude the open server. */
  customMcpServerInfos: McpServerInfo[];
  /** User-initiated close (X button, sign-out success, vanished-server fallback). */
  onClose: () => void;
  /** Auto-close on the `connecting → connected` rising edge. Kept distinct
   *  from {@link onClose} so the dialog doesn't have to orchestrate any
   *  parent-scoped side effects (e.g. clearing a status banner that lives
   *  outside this dialog) — the parent decides what "auto-closed" means. */
  onAutoClose: () => void;
}

/**
 * Detail dialog for a custom MCP server. Owns the live-server lookup,
 * OAuth UI store subscription, rising-edge auto-close, and sign-out
 * mutation. See {@link McpServerDetailDialogProps} for the two
 * distinct-callback contract (`onClose` vs `onAutoClose`).
 */
export function McpServerDetailDialog({
  selectedCustom,
  customMcpServerInfos,
  onClose,
  onAutoClose,
}: McpServerDetailDialogProps) {
  const oauthUiStates = useSyncExternalStore(
    mcpOAuthStore.subscribe,
    mcpOAuthStore.getUiStateSnapshot,
  );

  const liveServer = customMcpServerInfos.find((s) => s.name === selectedCustom.name);
  const liveUiState = oauthUiStates[toMcpServerKey(selectedCustom.name)];

  // `selectedCustom.name` is non-empty for the lifetime of this mount
  // (parent uses `{selectedCustom && <McpServerDetailDialog ... />}`), so
  // the hooks have a stable identity for rules-of-hooks.
  const isSigningOut = useIsMutatingMcpServerSignOut(selectedCustom.name);
  const signOutMutation = useSignOutMcpServerMutation(selectedCustom.name);

  // Rising-edge only: close on `connecting → connected`. Initial ref is
  // `undefined`, so a dialog opened on an already-connected server sees
  // `undefined → connected` (not a connecting→connected edge) and stays
  // open. Implemented as a `useEffect` so calling the parent callback
  // doesn't fire during a child render (the react-compiler lint rule
  // catches that statically).
  const prevStateRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevStateRef.current;
    const next = liveUiState?.state;
    prevStateRef.current = next;
    if (prev === "connecting" && next === "connected") {
      onAutoClose();
    }
  }, [liveUiState?.state, onAutoClose]);

  if (!liveServer) {
    return (
      <CustomDetailDialog
        open={true}
        title={selectedCustom.displayName ?? selectedCustom.name}
        icon={selectedCustom.icon}
        description={selectedCustom.description}
        instructions={selectedCustom.instructions}
        details={selectedCustom.details}
        bundleDirs={selectedCustom.bundleDirs}
        itemType="mcp-servers"
        onClose={onClose}
      />
    );
  }

  const primaryAction = getMcpOAuthAction(liveServer, liveUiState, isSigningOut);
  const secondaryAction = getMcpOAuthSecondaryAction(liveServer, liveUiState, isSigningOut);
  const primaryActionInput =
    liveServer.requiresOAuth && primaryAction
      ? { label: "Username or alias", placeholder: "alias or user@domain.com" }
      : undefined;

  return (
    <CustomDetailDialog
      open={true}
      title={selectedCustom.displayName ?? selectedCustom.name}
      icon={selectedCustom.icon}
      description={getMcpServerDescription(liveServer)}
      instructions={selectedCustom.instructions}
      details={getMcpServerDetails(liveServer, liveUiState)}
      bundleDirs={selectedCustom.bundleDirs}
      itemType="mcp-servers"
      onClose={onClose}
      // MCP removal is intentionally NOT offered from the detail dialog —
      // it lives on the McpServersTab card menu so plugin-managed MCPs
      // (no `scope`) are protected from removal by construction (the dialog
      // never carries an onRemove for any MCP, regardless of management).
      primaryActionLabel={primaryAction?.label}
      primaryActionInput={primaryActionInput}
      primaryActionDisabled={primaryAction?.disabled === true}
      onPrimaryAction={
        primaryAction
          ? (inputValue?: string) => {
              openMcpOAuthPrompt({
                serverName: selectedCustom.name,
                defaultLoginHint: inputValue ?? liveServer.oauthAlias,
                reason: primaryAction.reason,
                forceReauth: primaryAction.forceReauth,
              });
            }
          : undefined
      }
      secondaryActionLabel={secondaryAction?.label}
      secondaryActionDisabled={secondaryAction?.disabled === true}
      onSecondaryAction={
        secondaryAction
          ? () => {
              // Don't close synchronously — let the mutation's onSuccess
              // close so the user sees an error toast in place if the IPC
              // fails (rather than the dialog vanishing and the toast
              // appearing over the now-empty panel).
              signOutMutation.mutate(undefined, { onSuccess: onClose });
            }
          : undefined
      }
    />
  );
}
