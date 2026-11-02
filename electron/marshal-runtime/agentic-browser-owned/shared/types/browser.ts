import type { ErrorResponse } from "./errors.js";
import type { Result } from "./tools.js";

// ---------------------------------------------------------------------------
// Navigation option types (FR-001)
// ---------------------------------------------------------------------------

/** Condition to wait for during navigation. */
export type WaitUntilCondition = "load" | "domcontentloaded" | "networkidle";

/** Options for navigating to a URL. */
export interface NavigateOptions {
  readonly url: string;
  readonly waitUntil?: WaitUntilCondition;
  readonly timeout?: number;
}

// ---------------------------------------------------------------------------
// DOM interaction option types (FR-002)
// ---------------------------------------------------------------------------

/** Options for clicking an element (by selector) or a viewport coordinate. */
export interface ClickOptions {
  readonly selector?: string;
  readonly x?: number;
  readonly y?: number;
  readonly button?: "left" | "right" | "middle";
  readonly clickCount?: number;
  readonly timeout?: number;
}

/** Options for typing text into an element. */
export interface TypeOptions {
  readonly selector: string;
  readonly text: string;
  readonly delay?: number;
  readonly clearFirst?: boolean;
  readonly timeout?: number;
}

/** Options for hovering over an element. */
export interface HoverOptions {
  readonly selector: string;
  readonly timeout?: number;
}

/** Options for scrolling within the page or an element. */
export interface ScrollOptions {
  readonly selector?: string;
  readonly x?: number;
  readonly y?: number;
  readonly behavior?: "auto" | "smooth";
  readonly timeout?: number;
}

/** Options for selecting a value in a `<select>` element. */
export interface SelectOptions {
  readonly selector: string;
  readonly value?: string;
  readonly values?: readonly string[];
  readonly label?: string;
  readonly index?: number;
  readonly timeout?: number;
}

/** Options for focusing an element. */
export interface FocusOptions {
  readonly selector: string;
  readonly timeout?: number;
}

/** Options for retrieving an element attribute. */
export interface GetAttributeOptions {
  readonly selector: string;
  readonly attribute: string;
  readonly timeout?: number;
}

/** Options for retrieving an element property. */
export interface GetPropertyOptions {
  readonly selector: string;
  readonly property: string;
  readonly timeout?: number;
}

// ---------------------------------------------------------------------------
// Tab management types (FR-003)
// ---------------------------------------------------------------------------

/** Options for creating a new tab. */
export interface CreateTabOptions {
  readonly url?: string;
  readonly active?: boolean;
  readonly windowId?: number;
}

/** Information about a browser tab. */
export interface TabInfo {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
  readonly windowId: number;
}

// ---------------------------------------------------------------------------
// Dialog handling types (FR-007)
// ---------------------------------------------------------------------------

/** Type of browser dialog. */
export type DialogType = "alert" | "confirm" | "prompt" | "beforeunload";

/** Information about a browser dialog. */
export interface DialogInfo {
  readonly type: DialogType;
  readonly message: string;
  readonly defaultPrompt?: string;
}

/** Options for handling a dialog. */
export interface HandleDialogOptions {
  readonly accept: boolean;
  readonly promptText?: string;
}

// ---------------------------------------------------------------------------
// Screenshot types (FR-026)
// ---------------------------------------------------------------------------

/** Options for capturing a screenshot. */
export interface ScreenshotOptions {
  readonly selector?: string;
  readonly format?: "png" | "jpeg" | "webp";
  readonly quality?: number;
  readonly fullPage?: boolean;
}

/** Clip region for element screenshots (CDP Page.captureScreenshot clip). */
export interface ScreenshotClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale?: number;
}

/** Result of a screenshot capture. */
export interface ScreenshotResult {
  readonly data: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Page metadata types (FR-031)
// ---------------------------------------------------------------------------

/** Open Graph metadata extracted from a page. */
export interface OpenGraphMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly image?: string;
  readonly url?: string;
  readonly type?: string;
  readonly siteName?: string;
}

/** Structured page metadata extracted from the DOM. */
export interface PageMetadata {
  readonly title: string;
  readonly description?: string;
  readonly canonicalUrl?: string;
  readonly language?: string;
  readonly favicon?: string;
  readonly openGraph: OpenGraphMetadata;
  readonly metaTags: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Accessibility types (FR-027)
// ---------------------------------------------------------------------------

/** Bounding box representing an element's position and size in CSS pixels. */
export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Accessibility tree node. */
export interface AccessibilityNode {
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly description?: string;
  readonly ref?: string;
  readonly selector?: string;
  readonly states?: readonly string[];
  readonly boundingBox?: BoundingBox;
  readonly offScreen?: boolean;
  readonly children?: readonly AccessibilityNode[];
}

// ---------------------------------------------------------------------------
// HTML content types (FR-028, FR-029)
// ---------------------------------------------------------------------------

/** Options for querying a single DOM element. */
export interface QuerySelectorOptions {
  readonly selector: string;
  readonly timeout?: number;
}

/** Options for querying multiple DOM elements. */
export interface QuerySelectorAllOptions {
  readonly selector: string;
  readonly timeout?: number;
  readonly limit?: number;
}

/** Serialised representation of a DOM element returned by queries. */
export interface DomElementInfo {
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly textContent: string;
  readonly innerHtml: string;
  readonly outerHtml: string;
}

// ---------------------------------------------------------------------------
// Script execution types (FR-032, FR-033)
// ---------------------------------------------------------------------------

/** Options for executing JavaScript in the page context. */
export interface ExecuteScriptOptions {
  readonly script: string;
  readonly args?: readonly unknown[];
  readonly timeout?: number;
}

/** Options for evaluating a JavaScript expression. */
export interface EvaluateExpressionOptions {
  readonly expression: string;
  readonly timeout?: number;
}

/** Options for executing a console command. */
export interface ConsoleCommandOptions {
  readonly command: string;
  readonly timeout?: number;
}

// ---------------------------------------------------------------------------
// Custom JS file execution & validation types (FR-034, FR-035)
// ---------------------------------------------------------------------------

/** Options for executing a JavaScript file in the page context. */
export interface ExecuteScriptFileOptions {
  readonly file: string;
  readonly timeout?: number;
}

/** Options for running a validation script in the page context. */
export interface ExecuteValidationOptions {
  readonly script: string;
  readonly timeout?: number;
}

/** Status of a single assertion within a validation run. */
export type AssertionStatus = "passed" | "failed" | "skipped";

/** Result of an individual assertion in a validation script. */
export interface AssertionResult {
  readonly name: string;
  readonly status: AssertionStatus;
  readonly message?: string;
}

/** Structured validation report returned by validation mode. */
export interface ValidationResult {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly assertions: readonly AssertionResult[];
}

// ---------------------------------------------------------------------------
// Content script injection types (FR-010)
// ---------------------------------------------------------------------------

/** Options for injecting a content script. */
export interface InjectScriptOptions {
  readonly tabId: number;
  readonly code?: string;
  readonly file?: string;
  readonly allFrames?: boolean;
}

/** Options for removing an injected content script. */
export interface RemoveScriptOptions {
  readonly tabId: number;
  readonly scriptId: string;
}

// ---------------------------------------------------------------------------
// CDP types (FR-013)
// ---------------------------------------------------------------------------

/** Options for sending a CDP command. */
export interface CdpCommandOptions {
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly tabId?: number;
  readonly timeout?: number;
}

// ---------------------------------------------------------------------------
// Live HTML modification types (FR-045)
// ---------------------------------------------------------------------------

/** Options for setting outerHTML of an element. */
export interface SetOuterHtmlOptions {
  readonly selector: string;
  readonly html: string;
  readonly timeout?: number;
}

/** Options for setting innerHTML of an element. */
export interface SetInnerHtmlOptions {
  readonly selector: string;
  readonly html: string;
  readonly timeout?: number;
}

/** Position for inserting adjacent HTML. */
export type InsertPosition = "beforebegin" | "afterbegin" | "beforeend" | "afterend";

/** Options for inserting HTML adjacent to an element. */
export interface InsertAdjacentHtmlOptions {
  readonly selector: string;
  readonly position: InsertPosition;
  readonly html: string;
  readonly timeout?: number;
}

// ---------------------------------------------------------------------------
// Live CSS modification types (FR-046)
// ---------------------------------------------------------------------------

/** Options for adding a stylesheet. */
export interface AddStyleSheetOptions {
  readonly css: string;
  readonly tabId?: number;
}

/** Options for modifying an element's style. */
export interface ModifyStyleOptions {
  readonly selector: string;
  readonly styles: Readonly<Record<string, string>>;
  readonly timeout?: number;
}

/** Options for getting computed style of an element. */
export interface GetComputedStyleOptions {
  readonly selector: string;
  readonly properties?: readonly string[];
  readonly timeout?: number;
}

// ---------------------------------------------------------------------------
// Cookie types (FR-048)
// ---------------------------------------------------------------------------

/** Browser cookie representation. */
export interface CookieData {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: "strict" | "lax" | "none";
  readonly expirationDate?: number;
}

/** Options for retrieving cookies. */
export interface GetCookiesOptions {
  readonly url?: string;
  readonly domain?: string;
  readonly name?: string;
}

// ---------------------------------------------------------------------------
// Wait / polling types (FR-054)
// ---------------------------------------------------------------------------

/** Options for waiting for a CSS selector to appear. */
export interface WaitForSelectorOptions {
  readonly selector: string;
  readonly visible?: boolean;
  readonly hidden?: boolean;
  readonly timeout?: number;
}

/** Options for waiting for navigation to complete. */
export interface WaitForNavigationOptions {
  readonly waitUntil?: WaitUntilCondition;
  readonly timeout?: number;
}

/** Options for waiting for a custom condition. */
export interface WaitForConditionOptions {
  readonly expression: string;
  readonly pollingInterval?: number;
  readonly timeout?: number;
}

// ---------------------------------------------------------------------------
// Multi-step execution types (FR-051)
// ---------------------------------------------------------------------------

/** A single step in a multi-step autonomous execution plan. */
export interface ExecutionStep {
  readonly action: string;
  readonly params: Record<string, unknown>;
}

/** Result of a single execution step. */
export interface StepResult {
  readonly stepIndex: number;
  readonly action: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: ErrorResponse;
}

/** Options for multi-step execution. */
export interface ExecuteStepsOptions {
  readonly steps: readonly ExecutionStep[];
  readonly stopOnError?: boolean;
  readonly timeout?: number;
}

/** Result of a multi-step execution. */
export interface ExecuteStepsResult {
  readonly results: readonly StepResult[];
  readonly completedCount: number;
  readonly totalCount: number;
}

// ---------------------------------------------------------------------------
// Lifecycle types (FR-009, FR-015)
// ---------------------------------------------------------------------------

/** Options for connecting the browser adapter. */
export interface ConnectOptions {
  readonly timeout?: number;
}

/** Connection status of the browser adapter. */
export interface ConnectionStatus {
  readonly connected: boolean;
  readonly browserName?: string;
  readonly browserVersion?: string;
}

// ---------------------------------------------------------------------------
// Bookmark types (FR-012)
// ---------------------------------------------------------------------------

/** Browser bookmark node. */
export interface BookmarkNode {
  readonly id: string;
  readonly parentId?: string;
  readonly title: string;
  readonly url?: string;
  readonly dateAdded?: number;
  readonly children?: readonly BookmarkNode[];
}

// ---------------------------------------------------------------------------
// Browser history types (FR-012)
// ---------------------------------------------------------------------------

/** Browser history entry. */
export interface HistoryEntry {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly lastVisitTime?: number;
  readonly visitCount?: number;
}

// ---------------------------------------------------------------------------
// Download item types (FR-012)
// ---------------------------------------------------------------------------

/** Browser download item. */
export interface DownloadItem {
  readonly id: number;
  readonly url: string;
  readonly filename: string;
  readonly state: string;
  readonly bytesReceived: number;
  readonly totalBytes: number;
  readonly startTime: string;
  readonly mime?: string;
}

// ---------------------------------------------------------------------------
// Mobile emulation types (FR-041, FR-042)
// ---------------------------------------------------------------------------

/** Screen orientation for mobile emulation. */
export type ScreenOrientation = "portrait" | "landscape";

/** Known device preset names for mobile emulation. */
export type DevicePresetName =
  | "iPhone 14"
  | "iPhone 14 Pro Max"
  | "Pixel 7"
  | "iPad Pro"
  | "Galaxy S23";

/** Configuration for a single device preset. */
export interface DevicePreset {
  readonly name: DevicePresetName;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
  readonly userAgent: string;
}

/** Options for emulating a mobile device. */
export interface EmulationConfig {
  readonly preset?: DevicePresetName;
  readonly width?: number;
  readonly height?: number;
  readonly deviceScaleFactor?: number;
  readonly mobile?: boolean;
  readonly userAgent?: string;
  readonly orientation?: ScreenOrientation;
  readonly touchEnabled?: boolean;
}

/** Result of an emulation operation. */
export interface EmulationResult {
  readonly enabled: boolean;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
  readonly userAgent?: string;
  readonly orientation: ScreenOrientation;
  readonly touchEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Remote connection types (FR-036)
// ---------------------------------------------------------------------------

/** TLS certificate validation options for remote connections (NFR-016). */
export interface TlsOptions {
  readonly rejectUnauthorized?: boolean;
  readonly certificateFingerprint?: string;
}

/** Options for establishing a remote WebSocket CDP connection. */
export interface RemoteConnectOptions {
  readonly bearerToken?: string;
  readonly timeout?: number;
  readonly tls?: TlsOptions;
}

/** Status of a remote WebSocket CDP connection. */
export interface RemoteConnectionStatus extends ConnectionStatus {
  readonly wsUrl: string;
  readonly latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Sandbox environment types (FR-038)
// ---------------------------------------------------------------------------

/** Options for creating a sandbox browser session with isolated state. */
export interface SandboxOptions {
  readonly name?: string;
  readonly proxyServer?: string;
  readonly proxyBypassList?: string;
}

/** Information about an active sandbox session. */
export interface SandboxSessionInfo {
  readonly sessionId: string;
  readonly browserContextId: string;
  readonly name: string;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Remote IP connection types (FR-039)
// ---------------------------------------------------------------------------

/** Options for connecting to a browser at a specific IP address. */
export interface RemoteIPOptions {
  readonly host: string;
  readonly port: number;
  readonly secure?: boolean;
  readonly path?: string;
  readonly tls?: TlsOptions;
  readonly bearerToken?: string;
  readonly timeout?: number;
}

// ---------------------------------------------------------------------------
// IBrowserAdapter interface
// ---------------------------------------------------------------------------

/**
 * Browser abstraction interface.
 *
 * All tool handlers depend on this interface rather than browser-specific APIs.
 * Implementations exist for Chrome, Edge, and remote (WebSocket/CDP) browsers.
 */
export interface IBrowserAdapter {
  // -- Lifecycle (FR-009, FR-015) -------------------------------------------

  /**
   * Connect the adapter to the browser.
   *
   * @param options - Optional connection options
   * @returns Connection status, or an error
   */
  connect(options?: ConnectOptions): Promise<Result<ConnectionStatus, ErrorResponse>>;

  /**
   * Disconnect the adapter from the browser.
   *
   * @returns Void on success, or an error
   */
  disconnect(): Promise<Result<void, ErrorResponse>>;

  /**
   * Check whether the adapter is currently connected to a browser.
   *
   * @returns `true` if connected, `false` otherwise
   */
  isConnected(): boolean;

  // -- Navigation (FR-001) -------------------------------------------------

  /**
   * Navigate the current tab to a URL.
   *
   * @param options - Navigation options including URL and wait conditions
   * @returns The final URL after navigation, or an error
   */
  navigate(options: NavigateOptions): Promise<Result<string, ErrorResponse>>;

  /**
   * Wait for the page to reach a specific load state.
   *
   * @param waitUntil - The load condition to wait for
   * @param timeout - Maximum wait time in milliseconds
   * @returns Void on success, or an error
   */
  waitForLoad(
    waitUntil?: WaitUntilCondition,
    timeout?: number,
  ): Promise<Result<void, ErrorResponse>>;

  /**
   * Navigate the current tab back in history.
   *
   * @returns The URL after navigating back, or an error
   */
  goBack(): Promise<Result<string, ErrorResponse>>;

  /**
   * Navigate the current tab forward in history.
   *
   * @returns The URL after navigating forward, or an error
   */
  goForward(): Promise<Result<string, ErrorResponse>>;

  /**
   * Reload the current page.
   *
   * @param hard - If true, bypass the cache (hard reload)
   * @returns The URL after reload, or an error
   */
  reload(hard?: boolean): Promise<Result<string, ErrorResponse>>;

  // -- DOM Interaction (FR-002) ---------------------------------------------

  /**
   * Click an element on the page.
   *
   * @param options - Click options including selector and button type
   * @returns Void on success, or an error
   */
  click(options: ClickOptions): Promise<Result<void, ErrorResponse>>;

  /**
   * Type text into an element.
   *
   * @param options - Type options including selector, text, and optional delay
   * @returns Void on success, or an error
   */
  type(options: TypeOptions): Promise<Result<void, ErrorResponse>>;

  /**
   * Hover over an element.
   *
   * @param options - Hover options including selector
   * @returns Void on success, or an error
   */
  hover(options: HoverOptions): Promise<Result<void, ErrorResponse>>;

  /**
   * Scroll within the page or a specific element.
   *
   * @param options - Scroll options including offsets and behavior
   * @returns Void on success, or an error
   */
  scroll(options: ScrollOptions): Promise<Result<void, ErrorResponse>>;

  /**
   * Select a value in a `<select>` element.
   *
   * @param options - Select options including selector and value
   * @returns The selected values, or an error
   */
  select(options: SelectOptions): Promise<Result<readonly string[], ErrorResponse>>;

  /**
   * Focus an element.
   *
   * @param options - Focus options including selector
   * @returns Void on success, or an error
   */
  focus(options: FocusOptions): Promise<Result<void, ErrorResponse>>;

  /**
   * Get an attribute value from an element.
   *
   * @param options - Options including selector and attribute name
   * @returns The attribute value (or `null` if absent), or an error
   */
  getAttribute(options: GetAttributeOptions): Promise<Result<string | null, ErrorResponse>>;

  /**
   * Get a JavaScript property value from an element.
   *
   * @param options - Options including selector and property name
   * @returns The property value, or an error
   */
  getProperty(options: GetPropertyOptions): Promise<Result<unknown, ErrorResponse>>;

  // -- Tab Management (FR-003) ----------------------------------------------

  /**
   * Create a new browser tab.
   *
   * @param options - Options for the new tab
   * @returns Information about the created tab, or an error
   */
  createTab(options?: CreateTabOptions): Promise<Result<TabInfo, ErrorResponse>>;

  /**
   * Close a specific tab.
   *
   * @param tabId - The ID of the tab to close
   * @returns Void on success, or an error
   */
  closeTab(tabId: number): Promise<Result<void, ErrorResponse>>;

  /**
   * Switch to a specific tab.
   *
   * @param tabId - The ID of the tab to activate
   * @returns Void on success, or an error
   */
  switchTab(tabId: number): Promise<Result<void, ErrorResponse>>;

  /**
   * Get information about all open tabs.
   *
   * @returns Array of tab information, or an error
   */
  listTabs(): Promise<Result<readonly TabInfo[], ErrorResponse>>;

  /**
   * Get information about the currently active tab.
   *
   * @returns Active tab information, or an error
   */
  getActiveTab(): Promise<Result<TabInfo, ErrorResponse>>;

  // -- Dialog Handling (FR-007) ---------------------------------------------

  /**
   * Handle (accept or dismiss) the current browser dialog.
   *
   * @param options - Options specifying whether to accept and optional prompt text
   * @returns Void on success, or an error
   */
  handleDialog(options: HandleDialogOptions): Promise<Result<void, ErrorResponse>>;

  /**
   * Get information about the currently open dialog, if any.
   *
   * @returns Dialog info or `null` if no dialog is open, or an error
   */
  getDialogInfo(): Promise<Result<DialogInfo | null, ErrorResponse>>;

  // -- Screenshot (FR-026) --------------------------------------------------

  /**
   * Capture a screenshot of the visible viewport or a specific element.
   *
   * @param options - Screenshot options including format and quality
   * @returns Screenshot data as base64 with metadata, or an error
   */
  captureScreenshot(options?: ScreenshotOptions): Promise<Result<ScreenshotResult, ErrorResponse>>;

  /**
   * Capture a full-page screenshot.
   *
   * @param options - Screenshot options (fullPage is forced to true)
   * @returns Screenshot data as base64 with metadata, or an error
   */
  captureFullPageScreenshot(
    options?: Omit<ScreenshotOptions, "fullPage" | "selector">,
  ): Promise<Result<ScreenshotResult, ErrorResponse>>;

  // -- Accessibility (FR-027) -----------------------------------------------

  /**
   * Retrieve the accessibility tree of the current page.
   *
   * @returns Root accessibility node, or an error
   */
  getAccessibilityTree(): Promise<Result<AccessibilityNode, ErrorResponse>>;

  // -- HTML Content (FR-028) ------------------------------------------------

  /**
   * Get the full HTML content of the current page.
   *
   * @returns Page HTML string, or an error
   */
  getPageContent(): Promise<Result<string, ErrorResponse>>;

  /**
   * Get the outerHTML of an element.
   *
   * @param selector - CSS selector for the target element
   * @param timeout - Maximum wait time in milliseconds
   * @returns The element's outerHTML, or an error
   */
  getOuterHtml(selector: string, timeout?: number): Promise<Result<string, ErrorResponse>>;

  /**
   * Get the innerHTML of an element.
   *
   * @param selector - CSS selector for the target element
   * @param timeout - Maximum wait time in milliseconds
   * @returns The element's innerHTML, or an error
   */
  getInnerHtml(selector: string, timeout?: number): Promise<Result<string, ErrorResponse>>;

  // -- DOM Querying (FR-029) ------------------------------------------------

  /**
   * Query a single DOM element matching a CSS selector.
   *
   * @param options - Query options including selector
   * @returns Serialised element info, or an error
   */
  querySelector(
    options: QuerySelectorOptions,
  ): Promise<Result<DomElementInfo | null, ErrorResponse>>;

  /**
   * Query all DOM elements matching a CSS selector.
   *
   * @param options - Query options including selector and optional limit
   * @returns Array of serialised element info, or an error
   */
  querySelectorAll(
    options: QuerySelectorAllOptions,
  ): Promise<Result<readonly DomElementInfo[], ErrorResponse>>;

  /**
   * Get all attributes of an element.
   *
   * @param selector - CSS selector for the target element
   * @param timeout - Maximum wait time in milliseconds
   * @returns Map of attribute names to values, or an error
   */
  getAttributes(
    selector: string,
    timeout?: number,
  ): Promise<Result<Readonly<Record<string, string>>, ErrorResponse>>;

  // -- Script Execution (FR-032) --------------------------------------------

  /**
   * Execute JavaScript in the page context.
   *
   * @param options - Script execution options
   * @returns The execution result, or an error
   */
  executeScript(options: ExecuteScriptOptions): Promise<Result<unknown, ErrorResponse>>;

  /**
   * Evaluate a JavaScript expression and return its value.
   *
   * @param options - Expression evaluation options
   * @returns The expression result, or an error
   */
  evaluateExpression(options: EvaluateExpressionOptions): Promise<Result<unknown, ErrorResponse>>;

  // -- Console Command (FR-033) ---------------------------------------------

  /**
   * Execute a console command in the page context.
   *
   * @param options - Console command options
   * @returns The command result, or an error
   */
  executeConsoleCommand(options: ConsoleCommandOptions): Promise<Result<unknown, ErrorResponse>>;

  // -- Custom JS File Execution (FR-034) ------------------------------------

  /**
   * Load and execute a JavaScript file in the page context.
   *
   * @param options - Script file execution options including file path or URL
   * @returns The execution result, or an error
   */
  executeScriptFile(options: ExecuteScriptFileOptions): Promise<Result<unknown, ErrorResponse>>;

  // -- Validation Scripts (FR-035) ------------------------------------------

  /**
   * Execute a validation script and return structured pass/fail results.
   *
   * @param options - Validation execution options
   * @returns Structured validation result with assertion details, or an error
   */
  executeValidation(
    options: ExecuteValidationOptions,
  ): Promise<Result<ValidationResult, ErrorResponse>>;

  // -- Content Script Injection (FR-010) ------------------------------------

  /**
   * Inject a content script into a tab.
   *
   * @param options - Injection options including target tab and script
   * @returns The injection result, or an error
   */
  injectScript(options: InjectScriptOptions): Promise<Result<unknown, ErrorResponse>>;

  /**
   * Remove a previously injected content script.
   *
   * @param options - Removal options including target tab and script ID
   * @returns Void on success, or an error
   */
  removeScript(options: RemoveScriptOptions): Promise<Result<void, ErrorResponse>>;

  // -- CDP (FR-013) ---------------------------------------------------------

  /**
   * Send a Chrome DevTools Protocol command.
   *
   * @param options - CDP command options including method and params
   * @returns The CDP command result, or an error
   */
  sendCdpCommand(options: CdpCommandOptions): Promise<Result<unknown, ErrorResponse>>;

  /**
   * Attach the CDP debugger to a tab.
   *
   * @param tabId - The ID of the tab to attach to
   * @returns Void on success, or an error
   */
  attachDebugger(tabId: number): Promise<Result<void, ErrorResponse>>;

  /**
   * Detach the CDP debugger from a tab.
   *
   * @param tabId - The ID of the tab to detach from
   * @returns Void on success, or an error
   */
  detachDebugger(tabId: number): Promise<Result<void, ErrorResponse>>;

  // -- Live HTML Modification (FR-045) --------------------------------------

  /**
   * Set the outerHTML of an element.
   *
   * @param options - Options including selector and replacement HTML
   * @returns Void on success, or an error
   */
  setOuterHtml(options: SetOuterHtmlOptions): Promise<Result<void, ErrorResponse>>;

  /**
   * Set the innerHTML of an element.
   *
   * @param options - Options including selector and replacement HTML
   * @returns Void on success, or an error
   */
  setInnerHtml(options: SetInnerHtmlOptions): Promise<Result<void, ErrorResponse>>;

  /**
   * Insert HTML adjacent to an element.
   *
   * @param options - Options including selector, position, and HTML
   * @returns Void on success, or an error
   */
  insertAdjacentHtml(options: InsertAdjacentHtmlOptions): Promise<Result<void, ErrorResponse>>;

  // -- Live CSS Modification (FR-046) ---------------------------------------

  /**
   * Add a stylesheet to a tab.
   *
   * @param options - Options including CSS text and optional target tab
   * @returns A stylesheet ID for later removal, or an error
   */
  addStyleSheet(options: AddStyleSheetOptions): Promise<Result<string, ErrorResponse>>;

  /**
   * Modify inline styles of an element.
   *
   * @param options - Options including selector and style map
   * @returns Void on success, or an error
   */
  modifyStyle(options: ModifyStyleOptions): Promise<Result<void, ErrorResponse>>;

  /**
   * Get the computed style of an element.
   *
   * @param options - Options including selector and optional property filter
   * @returns Map of property names to computed values, or an error
   */
  getComputedStyle(
    options: GetComputedStyleOptions,
  ): Promise<Result<Readonly<Record<string, string>>, ErrorResponse>>;

  // -- Cookies (FR-048) -----------------------------------------------------

  /**
   * Get cookies matching the given criteria.
   *
   * @param options - Filter options for cookies
   * @returns Array of matching cookies, or an error
   */
  getCookies(options?: GetCookiesOptions): Promise<Result<readonly CookieData[], ErrorResponse>>;

  /**
   * Set a cookie.
   *
   * @param cookie - Cookie data to set
   * @returns Void on success, or an error
   */
  setCookie(cookie: CookieData): Promise<Result<void, ErrorResponse>>;

  // -- Wait / Polling (FR-054) ----------------------------------------------

  /**
   * Wait for an element matching a CSS selector to appear.
   *
   * @param options - Wait options including selector and visibility conditions
   * @returns Void on success, or an error
   */
  waitForSelector(options: WaitForSelectorOptions): Promise<Result<void, ErrorResponse>>;

  /**
   * Wait for a navigation to complete.
   *
   * @param options - Wait options including load condition
   * @returns The URL after navigation, or an error
   */
  waitForNavigation(options?: WaitForNavigationOptions): Promise<Result<string, ErrorResponse>>;

  /**
   * Wait for a custom JavaScript condition to become truthy.
   *
   * @param options - Wait options including expression and polling interval
   * @returns Void on success, or an error
   */
  waitForCondition(options: WaitForConditionOptions): Promise<Result<void, ErrorResponse>>;

  // -- Multi-Step Execution (FR-051) ----------------------------------------

  /**
   * Execute a sequence of browser actions autonomously.
   *
   * @param options - Execution options including steps and error handling
   * @returns Aggregated step results, or an error
   */
  executeSteps(options: ExecuteStepsOptions): Promise<Result<ExecuteStepsResult, ErrorResponse>>;

  // -- Bookmarks (FR-012) ---------------------------------------------------

  /**
   * List bookmarks, optionally filtered by parent folder.
   *
   * @param parentId - Optional parent folder ID to list children of
   * @returns Array of bookmark nodes, or an error
   */
  listBookmarks(parentId?: string): Promise<Result<readonly BookmarkNode[], ErrorResponse>>;

  /**
   * Create a new bookmark.
   *
   * @param title - Bookmark title
   * @param url - Bookmark URL (omit for folders)
   * @param parentId - Optional parent folder ID
   * @returns The created bookmark node, or an error
   */
  createBookmark(
    title: string,
    url?: string,
    parentId?: string,
  ): Promise<Result<BookmarkNode, ErrorResponse>>;

  /**
   * Search bookmarks by query string.
   *
   * @param query - Search query matching title or URL
   * @returns Array of matching bookmark nodes, or an error
   */
  searchBookmarks(query: string): Promise<Result<readonly BookmarkNode[], ErrorResponse>>;

  // -- Browser History (FR-012) ---------------------------------------------

  /**
   * Search browser history by text query.
   *
   * @param text - Search text matching URL or title
   * @param startTime - Optional start time filter (epoch ms)
   * @param endTime - Optional end time filter (epoch ms)
   * @param maxResults - Optional maximum number of results
   * @returns Array of history entries, or an error
   */
  searchHistory(
    text: string,
    startTime?: number,
    endTime?: number,
    maxResults?: number,
  ): Promise<Result<readonly HistoryEntry[], ErrorResponse>>;

  /**
   * Retrieve recent browser history entries.
   *
   * @param maxResults - Maximum number of entries to return
   * @returns Array of history entries, or an error
   */
  getHistoryEntries(maxResults?: number): Promise<Result<readonly HistoryEntry[], ErrorResponse>>;

  // -- Downloads (FR-012) ---------------------------------------------------

  /**
   * Retrieve download items, optionally filtered.
   *
   * @param query - Optional filename/URL search query
   * @param state - Optional state filter
   * @param limit - Optional maximum number of results
   * @returns Array of download items, or an error
   */
  getDownloadItems(
    query?: string,
    state?: string,
    limit?: number,
  ): Promise<Result<readonly DownloadItem[], ErrorResponse>>;

  /**
   * Monitor active downloads by returning in-progress items.
   *
   * @returns Array of in-progress download items, or an error
   */
  monitorDownloads(): Promise<Result<readonly DownloadItem[], ErrorResponse>>;
}
