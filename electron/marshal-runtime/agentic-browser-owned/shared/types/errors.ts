/**
 * Error codes for browser operations.
 *
 * Used throughout the extension and MCP server to provide
 * structured, machine-readable error responses.
 */
export enum ErrorCode {
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  TIMEOUT = 'TIMEOUT',
  NAVIGATION_FAILED = 'NAVIGATION_FAILED',
  SCREENSHOT_FAILED = 'SCREENSHOT_FAILED',
  CDP_ERROR = 'CDP_ERROR',
  UNKNOWN = 'UNKNOWN',
  TAB_NOT_FOUND = 'TAB_NOT_FOUND',
  SCRIPT_EXECUTION_FAILED = 'SCRIPT_EXECUTION_FAILED',
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  NOT_CONNECTED = 'NOT_CONNECTED',
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
  INJECTION_FAILED = 'INJECTION_FAILED',
  INVALID_SELECTOR = 'INVALID_SELECTOR',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  COOKIE_ERROR = 'COOKIE_ERROR',
  STYLE_ERROR = 'STYLE_ERROR',
  REMOTE_CONNECTION_FAILED = 'REMOTE_CONNECTION_FAILED',
}

/** Structured error response returned by tool handlers. */
export interface ErrorResponse {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}
