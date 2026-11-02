import { toMcpServerKey } from "@common/mcp-server-key-normalization";
import { useSyncExternalStore } from "react";

import {
  getMcpOAuthAction,
  getMcpServerStatusLabel,
  type OAuthAction,
} from "@/features/plugins/mcp-server-utils";
import { mcpOAuthStore, type McpOAuthUiState } from "@/hooks/mcp-oauth-store";
import { useMcpServers } from "@/shared/hooks/useMcpServerCatalog";
import type { McpServerInfo } from "@/types/electron";

export type McpStartupItemState = "ready" | "connecting" | "needs-auth" | "failed";

export interface McpAttentionItem {
  key: string;
  name: string;
  statusLabel: string | undefined;
  toolCount: number | undefined;
  oauthAction: OAuthAction | null;
  uiState: McpOAuthUiState | undefined;
  state: McpStartupItemState;
  server: McpServerInfo;
}

export interface McpAttentionData {
  /**
   * Servers that require user action right now (`needs-auth` or `failed`).
   * Ready and connecting servers are intentionally excluded — the card is an
   * attention surface, not a roster. The Plugins panel is the canonical
   * place to inspect the full MCP server inventory.
   */
  items: McpAttentionItem[];
}

function classifyState(server: McpServerInfo, uiState?: McpOAuthUiState): McpStartupItemState {
  // Active OAuth UI flows take precedence over the steady-state server.status,
  // mirroring getMcpServerStatusLabel().
  if (uiState?.state === "connecting") return "connecting";
  if (uiState?.state === "failed") return "failed";
  if (uiState?.state === "connected") return "ready";

  switch (server.status) {
    case "connected":
      return "ready";
    case "pending":
      return "connecting";
    case "needs-auth":
      return "needs-auth";
    case "failed":
      return "failed";
    default:
      // No status reported yet — treat as connecting so the card surfaces
      // the cold-start window rather than silently rendering "ready".
      return "connecting";
  }
}

/**
 * View-model for MCP attention notices rendered in the app-status rail.
 *
 * The notice is an **attention surface**, not a roster: it only renders when at
 * least one MCP server needs the user to do something (sign-in required, or
 * a connection failure). Ready and connecting servers are intentionally not
 * surfaced here — the Plugins panel is the canonical place to inspect the
 * full inventory.
 *
 * Returns null when there is nothing requiring attention (all servers are
 * ready, still connecting, disabled, or not configured).
 *
 * Derived from live state on every render, never persisted into
 * `StoredSession`. Servers in `disabled` or `not_configured` status are
 * filtered out before classification (built-ins the user has not enabled,
 * tenant-disabled, etc.).
 */
export function useMcpAttention(): McpAttentionData | null {
  const { data: servers } = useMcpServers();
  const oauthUi = useSyncExternalStore(mcpOAuthStore.subscribe, mcpOAuthStore.getUiStateSnapshot);

  if (!servers || servers.length === 0) return null;

  const relevant = servers.filter((s) => s.status !== "disabled" && s.status !== "not_configured");
  if (relevant.length === 0) return null;

  const items: McpAttentionItem[] = [];
  for (const server of relevant) {
    const key = toMcpServerKey(server.name);
    const uiState = oauthUi[key];
    const state = classifyState(server, uiState);
    // Attention-only: skip ready and connecting servers. They are not actionable
    // and are visible in the Plugins panel for users who want a full view.
    if (state !== "needs-auth" && state !== "failed") continue;
    items.push({
      key,
      name: server.name,
      statusLabel: getMcpServerStatusLabel(server, uiState),
      toolCount: server.tools?.length,
      oauthAction: getMcpOAuthAction(server, uiState),
      uiState,
      state,
      server,
    });
  }

  if (items.length === 0) return null;
  return { items };
}
