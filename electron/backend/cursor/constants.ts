/** Env lookup for Cursor auth. Tests pass partial maps, not a full ProcessEnv. */
export type CursorProcessEnv = Record<string, string | undefined>;

export const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";
export const CURSOR_BACKEND_URL_ENV = "CURSOR_BACKEND_URL";
export const CURSOR_PRODUCTION_BACKEND_URL = "https://api.cursor.com";
export const CURSOR_SDK_AUTH_RELATIVE_PATH = "cursor-sdk/auth.json";
export const CURSOR_DEFAULT_MODEL_ID = "composer-2.5";
export const CURSOR_PREFERRED_MODEL_IDS = ["composer-2.5", "auto"] as const;
export const CURSOR_ACCOUNT_IDENTITY_PREFIX = "cursor";
export const CURSOR_SESSION_CONFIG_TRACE_FILENAME = "m-cursor-session-config-trace.jsonl";
export const CURSOR_CREDENTIAL_STORE_VERSION = 1;
export const CURSOR_BROWSER_LOGIN_ID_PREFIX = "cursor-login-";
export const CURSOR_LOGIN_URL_TIMEOUT_MS = 15_000;
export const CURSOR_MINTED_API_KEY_NAME = "Marshal";
export const CURSOR_RUN_STATUS_ERROR = "ERROR";
export const CURSOR_RUN_STATUS_FINISHED = "FINISHED";
export const CURSOR_RUN_STATUS_CANCELLED = "CANCELLED";
export const CURSOR_RUN_STATUS_RUNNING = "RUNNING";
export const CURSOR_RUN_STATUS_CREATING = "CREATING";
export const CURSOR_RUN_STATUS_EXPIRED = "EXPIRED";
export const CURSOR_SILENT_RUN_STATUSES = [
  CURSOR_RUN_STATUS_FINISHED,
  CURSOR_RUN_STATUS_CANCELLED,
  CURSOR_RUN_STATUS_RUNNING,
  CURSOR_RUN_STATUS_CREATING,
  CURSOR_RUN_STATUS_EXPIRED,
] as const;
export const CURSOR_DELTA_TOOL_CALL_STARTED = "tool-call-started";
export const CURSOR_DELTA_TOOL_CALL_COMPLETED = "tool-call-completed";
export const CURSOR_DELTA_THINKING_DELTA = "thinking-delta";
export const CURSOR_DELTA_TEXT_DELTA = "text-delta";
export const CURSOR_TOOL_RESULT_ERROR = "error";
export const CURSOR_TOOL_RESULT_SUCCESS = "success";
export const CURSOR_TOOL_CALL_FAILED_MESSAGE = "Cursor tool call failed";
export const CURSOR_STREAM_TOOL_STATUS_RUNNING = "running";
export const CURSOR_STREAM_TOOL_STATUS_COMPLETED = "completed";
export const CURSOR_MODEL_PARAM_OPTIMIZE_FOR = "optimize_for";
export const CURSOR_MODEL_PARAM_FAST = "fast";
export const CURSOR_REASONING_PARAM_ID_PATTERN = /reason|effort|thinking/i;
