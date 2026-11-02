import { z } from 'zod';

/** All valid command names in the extension ↔ MCP server protocol. */
export const CommandNameSchema = z.enum([
  'navigate',
  'waitForLoad',
  'goBack',
  'goForward',
  'reload',
  'click',
  'type',
  'hover',
  'scroll',
  'select',
  'focus',
  'getAttribute',
  'getProperty',
  'createTab',
  'closeTab',
  'switchTab',
  'listTabs',
  'getActiveTab',
  'handleDialog',
  'getDialogInfo',
  'captureScreenshot',
  'captureFullPageScreenshot',
  'getAccessibilityTree',
  'getPageContent',
  'getOuterHtml',
  'getInnerHtml',
  'querySelector',
  'querySelectorAll',
  'getAttributes',
  'executeScript',
  'evaluateExpression',
  'executeConsoleCommand',
  'executeScriptFile',
  'executeValidation',
  'injectScript',
  'removeScript',
  'sendCdpCommand',
  'attachDebugger',
  'detachDebugger',
  'setOuterHtml',
  'setInnerHtml',
  'insertAdjacentHtml',
  'addStyleSheet',
  'modifyStyle',
  'getComputedStyle',
  'getCookies',
  'setCookie',
  'waitForSelector',
  'waitForNavigation',
  'waitForNetworkIdle',
  'waitForCondition',
  'executeSteps',
  'connect',
  'disconnect',
  'isConnected',
  'getHTML',
  'extractData',
  'modifyHTML',
  'modifyCSS',
  'interceptNetwork',
  'getStorage',
  'setStorage',
  'clearStorage',
  'deleteCookie',
  'uploadFile',
  'downloadStatus',
  'startDownload',
  'listBookmarks',
  'createBookmark',
  'searchBookmarks',
  'searchHistory',
  'getHistoryEntries',
  'getDownloadItems',
  'monitorDownloads',
  'switchBackend',
  'listTools',
  'getMetadata',
  'emulateDevice',
  'undoModification',
  'revertAll',
  'exportSession',
  'importSession',
]);

/** Zod schema for the command request envelope. */
export const CommandRequestSchema = z.object({
  id: z.string().min(1),
  command: CommandNameSchema,
  params: z.record(z.string(), z.unknown()),
  timestamp: z.number(),
});

/** Inferred type from CommandRequestSchema. */
export type CommandRequestParsed = z.infer<typeof CommandRequestSchema>;

/** Zod schema for browser navigation parameters. */
export const NavigateParamsSchema = z.object({
  url: z.string().url(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from NavigateParamsSchema. */
export type NavigateParams = z.infer<typeof NavigateParamsSchema>;

/** Zod schema for element click parameters. Accepts a CSS selector OR raw x,y coordinates. */
export const ClickParamsSchema = z.object({
  selector: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().positive().optional(),
  timeout: z.number().int().positive().optional(),
}).refine(
  (data) => data.selector !== undefined || (data.x !== undefined && data.y !== undefined),
  { message: 'Either selector or both x and y coordinates are required' },
);

/** Inferred type from ClickParamsSchema. */
export type ClickParams = z.infer<typeof ClickParamsSchema>;

/** Zod schema for text input parameters. */
export const TypeParamsSchema = z.object({
  selector: z.string().min(1),
  text: z.string(),
  delay: z.number().int().nonnegative().optional(),
  clearFirst: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from TypeParamsSchema. */
export type TypeParams = z.infer<typeof TypeParamsSchema>;

/** Zod schema for screenshot parameters. */
export const ScreenshotParamsSchema = z.object({
  selector: z.string().min(1).optional(),
  format: z.enum(['png', 'jpeg', 'webp']).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  fullPage: z.boolean().optional(),
});

/** Inferred type from ScreenshotParamsSchema. */
export type ScreenshotParams = z.infer<typeof ScreenshotParamsSchema>;

/** Zod schema for element hover parameters. */
export const HoverParamsSchema = z.object({
  selector: z.string().min(1),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from HoverParamsSchema. */
export type HoverParams = z.infer<typeof HoverParamsSchema>;

/** Zod schema for page/element scroll parameters. */
export const ScrollParamsSchema = z.object({
  selector: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  behavior: z.enum(['auto', 'smooth']).optional(),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from ScrollParamsSchema. */
export type ScrollParams = z.infer<typeof ScrollParamsSchema>;

/** Zod schema for select element parameters. */
export const SelectParamsSchema = z.object({
  selector: z.string().min(1),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
  label: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from SelectParamsSchema. */
export type SelectParams = z.infer<typeof SelectParamsSchema>;

/** Zod schema for createTab parameters. */
export const CreateTabParamsSchema = z.object({
  url: z.string().url().optional(),
  active: z.boolean().optional(),
  windowId: z.number().int().positive().optional(),
});

/** Inferred type from CreateTabParamsSchema. */
export type CreateTabParams = z.infer<typeof CreateTabParamsSchema>;

/** Zod schema for closeTab parameters. */
export const CloseTabParamsSchema = z.object({
  tabId: z.number().int().positive(),
});

/** Inferred type from CloseTabParamsSchema. */
export type CloseTabParams = z.infer<typeof CloseTabParamsSchema>;

/** Zod schema for switchTab parameters. */
export const SwitchTabParamsSchema = z.object({
  tabId: z.number().int().positive(),
});

/** Inferred type from SwitchTabParamsSchema. */
export type SwitchTabParams = z.infer<typeof SwitchTabParamsSchema>;

/** Zod schema for listTabs parameters (no required fields). */
export const ListTabsParamsSchema = z.object({});

/** Inferred type from ListTabsParamsSchema. */
export type ListTabsParams = z.infer<typeof ListTabsParamsSchema>;

/** Zod schema for handleDialog parameters. */
export const HandleDialogParamsSchema = z.object({
  action: z.enum(['accept', 'dismiss']),
  promptText: z.string().optional(),
});

/** Inferred type from HandleDialogParamsSchema. */
export type HandleDialogParams = z.infer<typeof HandleDialogParamsSchema>;

/** Zod schema for getDialogInfo parameters (no required fields). */
export const GetDialogInfoParamsSchema = z.object({});

/** Inferred type from GetDialogInfoParamsSchema. */
export type GetDialogInfoParams = z.infer<typeof GetDialogInfoParamsSchema>;

/** Zod schema for waitForSelector parameters. */
export const WaitForSelectorParamsSchema = z.object({
  selector: z.string().min(1),
  condition: z.enum(['visible', 'hidden', 'present']).optional(),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from WaitForSelectorParamsSchema. */
export type WaitForSelectorParams = z.infer<typeof WaitForSelectorParamsSchema>;

/** Zod schema for waitForNavigation parameters. */
export const WaitForNavigationParamsSchema = z.object({
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from WaitForNavigationParamsSchema. */
export type WaitForNavigationParams = z.infer<typeof WaitForNavigationParamsSchema>;

/** Zod schema for waitForNetworkIdle parameters. */
export const WaitForNetworkIdleParamsSchema = z.object({
  idleThreshold: z.number().int().positive().optional(),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from WaitForNetworkIdleParamsSchema. */
export type WaitForNetworkIdleParams = z.infer<typeof WaitForNetworkIdleParamsSchema>;

/** Zod schema for waitForCondition parameters. */
export const WaitForConditionParamsSchema = z.object({
  expression: z.string().min(1),
  pollingInterval: z.number().int().positive().optional(),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from WaitForConditionParamsSchema. */
export type WaitForConditionParams = z.infer<typeof WaitForConditionParamsSchema>;

/** Zod schema for getAccessibilityTree parameters. */
export const GetAccessibilityTreeParamsSchema = z.object({
  maxDepth: z.number().int().positive().optional(),
  includeIgnored: z.boolean().optional(),
});

/** Inferred type from GetAccessibilityTreeParamsSchema. */
export type GetAccessibilityTreeParams = z.infer<typeof GetAccessibilityTreeParamsSchema>;

/** Zod schema for getHTML parameters. */
export const GetHTMLParamsSchema = z.object({
  selector: z.string().optional(),
});

/** Inferred type from GetHTMLParamsSchema. */
export type GetHTMLParams = z.infer<typeof GetHTMLParamsSchema>;

/** Zod schema for extractData parameters. */
export const ExtractDataParamsSchema = z.object({
  type: z.enum(['table', 'attributes', 'structured']),
  selector: z.string().optional(),
  attributes: z.array(z.string()).optional(),
});

/** Inferred type from ExtractDataParamsSchema. */
export type ExtractDataParams = z.infer<typeof ExtractDataParamsSchema>;

/** Zod schema for executeScript parameters. */
export const ExecuteScriptParamsSchema = z.object({
  script: z.string().min(1),
  args: z.array(z.unknown()).optional(),
  timeout: z.number().int().positive().optional(),
  world: z.enum(['MAIN', 'ISOLATED']).optional(),
});

/** Inferred type from ExecuteScriptParamsSchema. */
export type ExecuteScriptParams = z.infer<typeof ExecuteScriptParamsSchema>;

/** Zod schema for executeConsoleCommand parameters. */
export const ExecuteConsoleCommandParamsSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from ExecuteConsoleCommandParamsSchema. */
export type ExecuteConsoleCommandParams = z.infer<typeof ExecuteConsoleCommandParamsSchema>;

/** Zod schema for modifyHTML tool parameters. */
export const ModifyHTMLParamsSchema = z.object({
  action: z.enum(['modifyText', 'addElement', 'removeElement', 'modifyAttribute']),
  selector: z.string().min(1),
  text: z.string().optional(),
  html: z.string().optional(),
  position: z.enum(['beforebegin', 'afterbegin', 'beforeend', 'afterend']).optional(),
  attribute: z.string().optional(),
  value: z.string().nullable().optional(),
});

/** Inferred type from ModifyHTMLParamsSchema. */
export type ModifyHTMLParams = z.infer<typeof ModifyHTMLParamsSchema>;

/** Zod schema for modifyCSS tool parameters. */
export const ModifyCSSParamsSchema = z.object({
  action: z.enum(['setStyle', 'addClass', 'removeClass', 'injectStylesheet']),
  selector: z.string().optional(),
  styles: z.record(z.string(), z.string()).optional(),
  className: z.string().optional(),
  css: z.string().optional(),
});

/** Inferred type from ModifyCSSParamsSchema. */
export type ModifyCSSParams = z.infer<typeof ModifyCSSParamsSchema>;

/** Zod schema for network interception parameters. */
export const InterceptNetworkParamsSchema = z.object({
  action: z.enum([
    'enableInterception',
    'disableInterception',
    'getInterceptedRequests',
    'modifyRequest',
    'blockRequest',
  ]),
  tabId: z.number().int().positive().optional(),
  patterns: z.array(z.string()).optional(),
  requestId: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  responseCode: z.number().int().positive().optional(),
});

/** Inferred type from InterceptNetworkParamsSchema. */
export type InterceptNetworkParams = z.infer<typeof InterceptNetworkParamsSchema>;

/** Zod schema for storage management parameters. */
export const StorageParamsSchema = z.object({
  action: z.enum([
    'getCookies',
    'setCookie',
    'deleteCookie',
    'getLocalStorage',
    'setLocalStorage',
    'getSessionStorage',
    'setSessionStorage',
    'clearStorage',
  ]),
  domain: z.string().optional(),
  url: z.string().optional(),
  key: z.string().optional(),
  value: z.string().optional(),
  cookie: z
    .object({
      name: z.string(),
      value: z.string(),
      domain: z.string().optional(),
      path: z.string().optional(),
      secure: z.boolean().optional(),
      httpOnly: z.boolean().optional(),
      sameSite: z.enum(['strict', 'lax', 'none']).optional(),
      expirationDate: z.number().optional(),
      url: z.string().optional(),
    })
    .optional(),
  cookieName: z.string().optional(),
});

/** Inferred type from StorageParamsSchema. */
export type StorageParams = z.infer<typeof StorageParamsSchema>;

/** Zod schema for file upload parameters. */
export const FileOpsParamsSchema = z.object({
  action: z.enum(['uploadFile', 'downloadStatus', 'startDownload']),
  selector: z.string().min(1).optional(),
  filePaths: z.array(z.string()).optional(),
  downloadId: z.number().int().positive().optional(),
  url: z.string().optional(),
});

/** Inferred type from FileOpsParamsSchema. */
export type FileOpsParams = z.infer<typeof FileOpsParamsSchema>;

/** Zod schema for navigation history parameters. */
export const HistoryParamsSchema = z.object({
  action: z.enum(['goBack', 'goForward', 'reload']),
  hard: z.boolean().optional(),
});

/** Inferred type from HistoryParamsSchema. */
export type HistoryParams = z.infer<typeof HistoryParamsSchema>;

/** Zod schema for bookmarks API parameters. */
export const BookmarksParamsSchema = z.object({
  action: z.enum(['list', 'create', 'search']),
  parentId: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
});

/** Inferred type from BookmarksParamsSchema. */
export type BookmarksParams = z.infer<typeof BookmarksParamsSchema>;

/** Zod schema for browser history API parameters. */
export const BrowserHistoryParamsSchema = z.object({
  action: z.enum(['search', 'getEntries']),
  text: z.string().optional(),
  startTime: z.number().optional(),
  endTime: z.number().optional(),
  maxResults: z.number().int().positive().optional(),
});

/** Inferred type from BrowserHistoryParamsSchema. */
export type BrowserHistoryParams = z.infer<typeof BrowserHistoryParamsSchema>;

/** Zod schema for downloads API parameters. */
export const DownloadsParamsSchema = z.object({
  action: z.enum(['getItems', 'monitor']),
  query: z.string().optional(),
  state: z.enum(['in_progress', 'interrupted', 'complete']).optional(),
  limit: z.number().int().positive().optional(),
});

/** Inferred type from DownloadsParamsSchema. */
export type DownloadsParams = z.infer<typeof DownloadsParamsSchema>;

/** Zod schema for backend switching parameters. */
export const SwitchBackendParamsSchema = z.object({
  backend: z.enum(['chrome', 'edge', 'remote']),
  wsUrl: z.string().optional(),
  bearerToken: z.string().optional(),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from SwitchBackendParamsSchema. */
export type SwitchBackendParams = z.infer<typeof SwitchBackendParamsSchema>;

/** Zod schema for tool listing/discovery parameters. */
export const ListToolsParamsSchema = z.object({
  backend: z.enum(['chrome', 'edge', 'remote']).optional(),
  category: z.string().optional(),
});

/** Inferred type from ListToolsParamsSchema. */
export type ListToolsParams = z.infer<typeof ListToolsParamsSchema>;

/** Zod schema for page metadata extraction parameters. */
export const MetadataParamsSchema = z.object({});

/** Inferred type from MetadataParamsSchema. */
export type MetadataParams = z.infer<typeof MetadataParamsSchema>;

/** Zod schema for executing a JavaScript file in the page context. */
export const ExecuteScriptFileParamsSchema = z.object({
  file: z.string().min(1),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from ExecuteScriptFileParamsSchema. */
export type ExecuteScriptFileParams = z.infer<typeof ExecuteScriptFileParamsSchema>;

/** Zod schema for validation script execution parameters. */
export const ExecuteValidationParamsSchema = z.object({
  script: z.string().min(1),
  timeout: z.number().int().positive().optional(),
});

/** Inferred type from ExecuteValidationParamsSchema. */
export type ExecuteValidationParams = z.infer<typeof ExecuteValidationParamsSchema>;

/** Zod schema for mobile device emulation parameters. */
export const EmulationParamsSchema = z.object({
  action: z.enum(['emulate', 'reset']),
  preset: z.enum(['iPhone 14', 'iPhone 14 Pro Max', 'Pixel 7', 'iPad Pro', 'Galaxy S23']).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  deviceScaleFactor: z.number().positive().optional(),
  mobile: z.boolean().optional(),
  userAgent: z.string().optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
  touchEnabled: z.boolean().optional(),
});

/** Inferred type from EmulationParamsSchema. */
export type EmulationParams = z.infer<typeof EmulationParamsSchema>;

/** Zod schema for undo/revert modification parameters. */
export const UndoRevertParamsSchema = z.object({
  action: z.enum(['undoLastHTML', 'revertAllHTML', 'undoLastCSS', 'revertAllCSS']),
  tabId: z.number().int().positive().optional(),
});

/** Inferred type from UndoRevertParamsSchema. */
export type UndoRevertParams = z.infer<typeof UndoRevertParamsSchema>;

/** Zod schema for session management parameters. */
export const SessionParamsSchema = z.object({
  action: z.enum(['export', 'import']),
  data: z.string().optional(),
});

/** Inferred type from SessionParamsSchema. */
export type SessionParams = z.infer<typeof SessionParamsSchema>;
