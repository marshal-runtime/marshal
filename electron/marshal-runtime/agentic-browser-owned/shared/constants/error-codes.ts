import { ErrorCode } from '../types/errors.js';

/**
 * Map of error codes to their default human-readable messages.
 */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  [ErrorCode.ELEMENT_NOT_FOUND]: 'The specified element could not be found on the page',
  [ErrorCode.TIMEOUT]: 'The operation timed out',
  [ErrorCode.NAVIGATION_FAILED]: 'Navigation to the specified URL failed',
  [ErrorCode.SCREENSHOT_FAILED]: 'Failed to capture screenshot',
  [ErrorCode.CDP_ERROR]: 'Chrome DevTools Protocol error',
  [ErrorCode.UNKNOWN]: 'An unknown error occurred',
  [ErrorCode.TAB_NOT_FOUND]: 'The specified tab could not be found',
  [ErrorCode.SCRIPT_EXECUTION_FAILED]: 'JavaScript execution failed',
  [ErrorCode.CONNECTION_FAILED]: 'Failed to connect to the browser',
  [ErrorCode.NOT_CONNECTED]: 'Browser adapter is not connected',
  [ErrorCode.DIALOG_NOT_FOUND]: 'No dialog is currently open',
  [ErrorCode.INJECTION_FAILED]: 'Content script injection failed',
  [ErrorCode.INVALID_SELECTOR]: 'The provided CSS selector is invalid',
  [ErrorCode.PERMISSION_DENIED]: 'Permission denied for the requested operation',
  [ErrorCode.COOKIE_ERROR]: 'Cookie operation failed',
  [ErrorCode.STYLE_ERROR]: 'CSS style operation failed',
  [ErrorCode.REMOTE_CONNECTION_FAILED]: 'Remote browser connection failed',
} as const;
