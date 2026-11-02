/**
 * Known command names for the extension ↔ MCP server protocol.
 *
 * Each string corresponds to a method on {@link IBrowserAdapter}.
 */
export type CommandName =
  | 'navigate'
  | 'waitForLoad'
  | 'goBack'
  | 'goForward'
  | 'reload'
  | 'click'
  | 'type'
  | 'hover'
  | 'scroll'
  | 'select'
  | 'focus'
  | 'getAttribute'
  | 'getProperty'
  | 'createTab'
  | 'closeTab'
  | 'switchTab'
  | 'listTabs'
  | 'getActiveTab'
  | 'handleDialog'
  | 'getDialogInfo'
  | 'captureScreenshot'
  | 'captureFullPageScreenshot'
  | 'getAccessibilityTree'
  | 'getPageContent'
  | 'getOuterHtml'
  | 'getInnerHtml'
  | 'querySelector'
  | 'querySelectorAll'
  | 'getAttributes'
  | 'executeScript'
  | 'evaluateExpression'
  | 'executeConsoleCommand'
  | 'executeScriptFile'
  | 'executeValidation'
  | 'injectScript'
  | 'removeScript'
  | 'sendCdpCommand'
  | 'attachDebugger'
  | 'detachDebugger'
  | 'setOuterHtml'
  | 'setInnerHtml'
  | 'insertAdjacentHtml'
  | 'addStyleSheet'
  | 'modifyStyle'
  | 'getComputedStyle'
  | 'getCookies'
  | 'setCookie'
  | 'waitForSelector'
  | 'waitForNavigation'
  | 'waitForNetworkIdle'
  | 'waitForCondition'
  | 'executeSteps'
  | 'connect'
  | 'disconnect'
  | 'isConnected'
  | 'getHTML'
  | 'extractData'
  | 'modifyHTML'
  | 'modifyCSS'
  | 'interceptNetwork'
  | 'getStorage'
  | 'setStorage'
  | 'clearStorage'
  | 'deleteCookie'
  | 'uploadFile'
  | 'downloadStatus'
  | 'startDownload'
  | 'listBookmarks'
  | 'createBookmark'
  | 'searchBookmarks'
  | 'searchHistory'
  | 'getHistoryEntries'
  | 'getDownloadItems'
  | 'monitorDownloads'
  | 'switchBackend'
  | 'listTools'
  | 'getMetadata'
  | 'emulateDevice'
  | 'undoModification'
  | 'revertAll'
  | 'exportSession'
  | 'importSession';

/**
 * Command request envelope for extension ↔ MCP server messaging.
 *
 * The MCP server sends CommandRequest messages to the extension via
 * Native Messaging. Each request carries a unique ID for correlation.
 */
export interface CommandRequest {
  readonly id: string;
  readonly command: CommandName;
  readonly params: Record<string, unknown>;
  readonly timestamp: number;
}

/**
 * Error payload inside a {@link CommandResponse}.
 */
export interface CommandResponseError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

/**
 * Metadata payload inside a {@link CommandResponse}.
 */
export interface CommandResponseMetadata {
  readonly duration: number;
  readonly timestamp: number;
  readonly commandId?: string;
}

/**
 * Command response envelope for extension ↔ MCP server messaging.
 *
 * The extension sends CommandResponse messages back to the MCP server.
 * The ID matches the originating CommandRequest for correlation.
 */
export interface CommandResponse<T = unknown> {
  readonly id: string;
  readonly success: boolean;
  readonly data?: T;
  readonly error?: CommandResponseError;
  readonly metadata?: CommandResponseMetadata;
}
