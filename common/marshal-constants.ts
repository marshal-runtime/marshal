/** App display name — single source of truth for branding. */
export const APP_NAME = "Marshal";

/**
 * Header-bar title. The only surface allowed to mention the previous product
 * name; everywhere else uses {@link APP_NAME}.
 */
export const APP_HEADER_TITLE = "Marshal Runtime Harness";

/** Title of the `settings` card that approves `forget { completely: true }`. */
export const FORGET_COMPLETELY_CARD_TITLE = "Forget Memory Completely";

/** Stable host-app identifier used by the telemetry event model. */
export const TELEMETRY_HOST_APP = "Marshal";

/** Runtime app branding mode. */
export type AppMode = "dev" | "beta" | "release";

/**
 * Semantic actions for permission card responses.
 * Old values ("allow-type", "allow-all") kept temporarily during migration — removed in cleanup task.
 */
export type PermissionAction =
  | "allow"
  | "allow-type"
  | "allow-all"
  | "allow-session"
  | "always-allow"
  | "deny";
