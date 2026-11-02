import { openMcpOAuthPrompt } from "@/hooks/mcp-oauth-store";

import type { AppNotice } from "./appNotice";
import { useMcpAttention } from "./useMcpAttention";

export function useMcpNotices(): AppNotice[] {
  const attention = useMcpAttention();
  if (!attention) return [];

  return attention.items.map((item) => {
    const failed = item.state === "failed";
    const action = item.oauthAction;
    return {
      id: `mcp:${item.key}`,
      source: "mcp",
      severity: failed ? "danger" : "action",
      icon: failed ? "error" : "shield",
      title: failed ? `${item.name} failed to connect` : `${item.name} needs sign-in`,
      body: item.statusLabel ?? (failed ? "Connection failed" : "Sign-in required"),
      actions: action
        ? [
            {
              id: `mcp:${item.key}:${action.reason}`,
              label: action.label,
              ariaLabel: `${action.label} to ${item.name}`,
              tone: failed ? "secondary" : "primary",
              telemetry: "sign-in",
              disabled: action.disabled,
              onAction: () =>
                openMcpOAuthPrompt({
                  serverName: item.name,
                  defaultLoginHint: item.uiState?.alias ?? item.server.oauthAlias,
                  reason: action.reason,
                  forceReauth: action.forceReauth,
                }),
            },
          ]
        : undefined,
    };
  });
}
