// Owns permission-kind routing constants.

// Permission-kind routing constants shared between the dispatcher
// (resolveEffectiveServerName in permission-policy.ts) and the
// KIND_SERVER_FALLBACK_RULE.

export const KIND_TO_SERVER_FALLBACK: Partial<Record<string, string>> = {
  url: "playwright", // URL visits come from browser_navigate (playwright MCP)
  write: "filesystem", // SDK file writes follow filesystem server permissions
  read: "filesystem", // SDK file reads (view/grep/glob) follow filesystem server permissions
};

// Cross-approval: a kind:<k> request is approved if any listed tool key is enabled.
export const KIND_TO_MCP_TOOLS: Partial<Record<string, string[]>> = {
  url: [
    "mcp:playwright:browser_navigate",
    "tool:web_fetch", // SDK built-in; same egress risk class as browser_navigate.
  ],
};
