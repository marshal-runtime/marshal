/**
 * Browser command implementations.
 *
 * Each function takes a CDP port (and optional args), connects to the
 * active page target, executes the command, and returns a JSON-serialisable
 * result. Connection management is handled per-invocation so each CLI call
 * is stateless.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  connectToActivePage,
  getPageTargets,
  createTarget,
  closeTarget,
  activateTarget,
  CDPClient,
} from "./cdp.js";
import type { TargetInfo } from "./cdp.js";
import type { AccessibilityNode } from "./shared/index";

/* oxlint-disable eslint/no-await-in-loop -- CDP input sequences and polling loops must remain ordered */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CmdResult {
  success: boolean;
  [key: string]: unknown;
}

function ok(data: Record<string, unknown> = {}): CmdResult {
  return { success: true, ...data };
}

function fail(message: string): CmdResult {
  return { success: false, error: message };
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- callers supply the CDP method's response contract
function cdpResponse<T>(value: unknown): T {
  // Raw CDP responses are interpreted at this protocol boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as T;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

type PageAction = (client: CDPClient, target: TargetInfo) => Promise<CmdResult>;

// Module-level target override — set by CLI to make --target work on all commands.
let _targetOverride: string | undefined;

/** Set a CDP target ID override. When set, all commands connect to this
 *  specific target instead of the default active page. Supports prefix matching. */
export function setTargetOverride(targetId: string | undefined): void {
  _targetOverride = targetId;
}

/** Connect → run action → disconnect. Uses _targetOverride when set. */
async function withPage(port: number, action: PageAction): Promise<CmdResult> {
  const { client, target } = await connectToActivePage(port, _targetOverride);
  try {
    return await action(client, target);
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export async function navigate(port: number, url: string, waitUntil?: string): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const result = cdpResponse<{
      frameId?: string;
      errorText?: string;
    }>(await client.send("Page.navigate", { url }));

    if (result.errorText) {
      return fail(`Navigation error: ${result.errorText}`);
    }

    // Wait for the page to load
    if (waitUntil === "networkidle") {
      await client.send("Page.setLifecycleEventsEnabled", { enabled: true });
      await client.waitForEvent("Page.lifecycleEvent", 30_000);
    } else {
      await client.waitForEvent("Page.loadEventFired", 30_000);
    }

    // Get page title
    const titleResult = cdpResponse<{ result?: { value?: string } }>(
      await client.send("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      }),
    );

    return ok({ url, title: titleResult.result?.value ?? "" });
  });
}

export async function goBack(port: number): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const history = cdpResponse<{
      currentIndex: number;
      entries: Array<{ url: string; title: string }>;
    }>(await client.send("Page.getNavigationHistory"));

    if (history.currentIndex <= 0) {
      return fail("No previous page in history");
    }

    const entry = history.entries[history.currentIndex - 1];
    await client.send("Page.navigateToHistoryEntry", { entryId: history.currentIndex - 1 });
    return ok({ url: entry.url, title: entry.title });
  });
}

export async function goForward(port: number): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const history = cdpResponse<{
      currentIndex: number;
      entries: Array<{ url: string; title: string }>;
    }>(await client.send("Page.getNavigationHistory"));

    if (history.currentIndex >= history.entries.length - 1) {
      return fail("No next page in history");
    }

    const entry = history.entries[history.currentIndex + 1];
    await client.send("Page.navigateToHistoryEntry", { entryId: history.currentIndex + 1 });
    return ok({ url: entry.url, title: entry.title });
  });
}

export async function reload(port: number, hard = false): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.send("Page.reload", { ignoreCache: hard });
    await client.waitForEvent("Page.loadEventFired", 30_000);
    return ok();
  });
}

// ---------------------------------------------------------------------------
// DOM interaction
// ---------------------------------------------------------------------------

async function resolveSelector(
  client: CDPClient,
  selector: string,
): Promise<{ nodeId: number; objectId: string } | null> {
  const doc = cdpResponse<{
    root: { nodeId: number };
  }>(await client.send("DOM.getDocument", { depth: 0 }));

  const query = cdpResponse<{ nodeId: number }>(
    await client.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    }),
  );

  if (!query.nodeId) return null;

  const resolved = cdpResponse<{ object: { objectId: string } }>(
    await client.send("DOM.resolveNode", {
      nodeId: query.nodeId,
    }),
  );

  return { nodeId: query.nodeId, objectId: resolved.object.objectId };
}

async function getElementCenter(
  client: CDPClient,
  selector: string,
): Promise<{ x: number; y: number } | null> {
  const doc = cdpResponse<{
    root: { nodeId: number };
  }>(await client.send("DOM.getDocument", { depth: 0 }));
  const query = cdpResponse<{ nodeId: number }>(
    await client.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    }),
  );

  if (!query.nodeId) return null;

  const box = cdpResponse<{ model: { content: number[] } }>(
    await client.send("DOM.getBoxModel", {
      nodeId: query.nodeId,
    }),
  );

  // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
  const q = box.model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  return { x, y };
}

export async function click(
  port: number,
  selector?: string,
  button: "left" | "right" | "middle" = "left",
  rawX?: number,
  rawY?: number,
  clickCount = 1,
  modifiers = 0,
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    let x: number;
    let y: number;

    if (rawX !== undefined && rawY !== undefined) {
      // Coordinate-based click — no selector needed
      x = rawX;
      y = rawY;
    } else if (selector) {
      await client.send("DOM.enable");
      const center = await getElementCenter(client, selector);
      if (!center) {
        return fail(`Element not found: ${selector}`);
      }
      x = center.x;
      y = center.y;
    } else {
      return fail("Provide a CSS selector or --x and --y coordinates");
    }

    const buttonIndex = button === "left" ? 0 : button === "right" ? 2 : 1;

    // Send incrementing clickCount pairs (required for double/triple-click)
    for (let i = 1; i <= clickCount; i++) {
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        buttons: buttonIndex,
        clickCount: i,
        modifiers,
      });

      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        buttons: buttonIndex,
        clickCount: i,
        modifiers,
      });
    }

    return ok({ selector: selector ?? `(${String(x)},${String(y)})`, x, y, clickCount, modifiers });
  });
}

export async function type(
  port: number,
  selector: string,
  text: string,
  clearFirst = false,
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.send("DOM.enable");

    // Focus the element
    const node = await resolveSelector(client, selector);
    if (!node) {
      return fail(`Element not found: ${selector}`);
    }

    await client.send("DOM.focus", { nodeId: node.nodeId });

    if (clearFirst) {
      // Select all and delete
      await client.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)}).select()`,
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Delete",
        code: "Delete",
      });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete" });
    }

    await client.send("Input.insertText", { text });

    return ok({ selector, text });
  });
}

/**
 * Type text at the current cursor/focus position using CDP Input.insertText.
 * Works with contentEditable surfaces (Word Online, Google Docs, rich text
 * editors) where there is no <input> element — just a blinking caret.
 */
export async function typeAtCursor(port: number, text: string): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.send("Input.insertText", { text });
    return ok({ text, mode: "insertText" });
  });
}

export async function select(
  port: number,
  selector: string,
  value?: string,
  label?: string,
  index?: number,
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    let script: string;
    if (value !== undefined) {
      script = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`;
    } else if (label !== undefined) {
      script = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const opt = Array.from(el.options).find(o => o.text === ${JSON.stringify(label)}); if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); return opt.value; } return null; })()`;
    } else if (index !== undefined) {
      script = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.selectedIndex = ${String(index)}; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`;
    } else {
      return fail("Provide --value, --label, or --index");
    }

    const result = cdpResponse<{ result?: { value?: unknown } }>(
      await client.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
      }),
    );

    if (result.result?.value === null) {
      return fail(`Element not found or option not matched: ${selector}`);
    }

    return ok({ selector, selectedValue: result.result?.value });
  });
}

export async function hover(port: number, selector: string): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.send("DOM.enable");

    const center = await getElementCenter(client, selector);
    if (!center) {
      return fail(`Element not found: ${selector}`);
    }

    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: center.x,
      y: center.y,
    });

    return ok({ selector, x: center.x, y: center.y });
  });
}

export async function scroll(port: number, x = 0, y = 0, selector?: string): Promise<CmdResult> {
  return withPage(port, async (client) => {
    if (selector) {
      await client.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})?.scrollBy(${String(x)}, ${String(y)})`,
      });
    } else {
      await client.send("Runtime.evaluate", {
        expression: `window.scrollBy(${String(x)}, ${String(y)})`,
      });
    }
    return ok({ x, y, selector });
  });
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

export async function screenshot(
  port: number,
  options: {
    selector?: string;
    format?: string;
    quality?: number;
    fullPage?: boolean;
    output?: string;
  } = {},
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const format = options.format ?? "png";
    const params: Record<string, unknown> = { format };

    if (options.quality && format !== "png") {
      params["quality"] = options.quality;
    }

    if (options.fullPage) {
      // Get full page dimensions
      const metrics = cdpResponse<{
        contentSize: { width: number; height: number };
      }>(await client.send("Page.getLayoutMetrics"));
      params["clip"] = {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1,
      };
    } else if (options.selector) {
      await client.send("DOM.enable");
      const center = await getElementCenter(client, options.selector);
      if (!center) {
        return fail(`Element not found: ${options.selector}`);
      }

      const doc = cdpResponse<{
        root: { nodeId: number };
      }>(await client.send("DOM.getDocument", { depth: 0 }));
      const query = cdpResponse<{ nodeId: number }>(
        await client.send("DOM.querySelector", {
          nodeId: doc.root.nodeId,
          selector: options.selector,
        }),
      );

      const box = cdpResponse<{ model: { content: number[] } }>(
        await client.send("DOM.getBoxModel", {
          nodeId: query.nodeId,
        }),
      );

      const q = box.model.content;
      const x1 = Math.min(q[0], q[6]);
      const y1 = Math.min(q[1], q[3]);
      const x2 = Math.max(q[2], q[4]);
      const y2 = Math.max(q[5], q[7]);
      params["clip"] = { x: x1, y: y1, width: x2 - x1, height: y2 - y1, scale: 1 };
    }

    const result = cdpResponse<{ data: string }>(
      await client.send("Page.captureScreenshot", params),
    );

    if (options.output) {
      const outputPath = resolve(options.output);
      writeFileSync(outputPath, Buffer.from(result.data, "base64"));
      return ok({ path: outputPath, format });
    }

    return ok({ data: result.data, format, encoding: "base64" });
  });
}

export async function getHtml(port: number, selector?: string): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const expression = selector
      ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML ?? null`
      : "document.documentElement.outerHTML";

    const result = cdpResponse<{ result?: { value?: string } }>(
      await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      }),
    );

    if (result.result?.value === null || result.result?.value === undefined) {
      return fail(selector ? `Element not found: ${selector}` : "Could not get HTML");
    }

    return ok({ html: result.result.value });
  });
}

export async function accessibilityTree(port: number, _maxDepth?: number): Promise<CmdResult> {
  return withPage(port, async (client) => {
    // DOM-walking via Runtime.evaluate.
    // This eliminates Chrome-internal pseudo-nodes (InlineTextBox, StaticText)
    // that bloat the tree without adding value for agent consumption.
    const { getDomWalkerScript, normalizeAriaTree, renderAriaSnapshot, extractRefMap } =
      await import("./shared/index");

    const walkerScript = getDomWalkerScript();

    const evalResult = cdpResponse<{
      result?: { value?: { tree: AccessibilityNode; nodeCount: number } };
      exceptionDetails?: { text: string };
    }>(
      await client.send("Runtime.evaluate", {
        expression: walkerScript,
        returnByValue: true,
        awaitPromise: false,
      }),
    );

    if (evalResult.exceptionDetails) {
      return fail(`DOM walker failed: ${evalResult.exceptionDetails.text}`);
    }

    const walkerResult = evalResult.result?.value;
    if (!walkerResult?.tree) {
      return fail("DOM walker returned empty tree");
    }

    // Normalise and render as YAML snapshot
    const normalised = normalizeAriaTree(walkerResult.tree);
    const snapshot = renderAriaSnapshot(normalised);
    const refs = extractRefMap(normalised);

    return ok({
      snapshot,
      ...(Object.keys(refs).length > 0 ? { refs } : {}),
      nodeCount: walkerResult.nodeCount,
    });
  });
}

export async function extractData(
  port: number,
  dataType: string,
  selector?: string,
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    if (dataType === "table") {
      const script = `(() => {
        const table = document.querySelector(${JSON.stringify(selector ?? "table")});
        if (!table) return null;
        const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent?.trim());
        const rows = Array.from(table.querySelectorAll('tbody tr')).map(tr =>
          Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim())
        );
        return { headers, rows };
      })()`;

      const result = cdpResponse<{ result?: { value?: unknown } }>(
        await client.send("Runtime.evaluate", {
          expression: script,
          returnByValue: true,
        }),
      );

      if (!result.result?.value) {
        return fail("Table not found");
      }
      return ok({ type: "table", data: result.result.value });
    }

    if (dataType === "structured") {
      const script = `(() => {
        const meta = {};
        document.querySelectorAll('meta').forEach(m => {
          const name = m.getAttribute('name') || m.getAttribute('property');
          if (name) meta[name] = m.getAttribute('content');
        });
        return {
          title: document.title,
          url: location.href,
          meta,
          headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(h => ({
            level: h.tagName, text: h.textContent?.trim()
          })),
          links: Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map(a => ({
            text: a.textContent?.trim(), href: a.href
          })),
          images: Array.from(document.querySelectorAll('img')).slice(0, 20).map(i => ({
            alt: i.alt, src: i.src
          })),
        };
      })()`;

      const result = cdpResponse<{ result?: { value?: unknown } }>(
        await client.send("Runtime.evaluate", {
          expression: script,
          returnByValue: true,
        }),
      );

      return ok({ type: "structured", data: result.result?.value });
    }

    return fail(`Unknown extraction type: ${dataType}. Use "table" or "structured".`);
  });
}

export async function getMetadata(port: number): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const script = `(() => ({
      title: document.title,
      url: location.href,
      description: document.querySelector('meta[name="description"]')?.content ?? '',
      canonical: document.querySelector('link[rel="canonical"]')?.href ?? '',
      favicon: document.querySelector('link[rel="icon"]')?.href ?? document.querySelector('link[rel="shortcut icon"]')?.href ?? '',
      ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? '',
      ogDescription: document.querySelector('meta[property="og:description"]')?.content ?? '',
      ogImage: document.querySelector('meta[property="og:image"]')?.content ?? '',
      ogUrl: document.querySelector('meta[property="og:url"]')?.content ?? '',
      lang: document.documentElement.lang ?? '',
    }))()`;

    const result = cdpResponse<{ result?: { value?: unknown } }>(
      await client.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
      }),
    );

    return ok({ metadata: result.result?.value });
  });
}

// ---------------------------------------------------------------------------
// Profile / auth verification
// ---------------------------------------------------------------------------

export async function profileInfo(port: number): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.send("Network.enable");

    const cookieResult = cdpResponse<{
      cookies: Array<{
        domain: string;
        name: string;
        httpOnly: boolean;
        secure: boolean;
        expires: number;
      }>;
    }>(await client.send("Network.getAllCookies"));
    const cookies = cookieResult.cookies ?? [];

    // Group by domain
    const domains = new Map<string, number>();
    for (const cookie of cookies) {
      domains.set(cookie.domain, (domains.get(cookie.domain) ?? 0) + 1);
    }

    // Sort by cookie count
    const topDomains = [...domains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([domain, count]) => ({ domain, cookies: count }));

    // Detect auth cookies (session, token, auth, jwt, sid, csrf, etc.)
    const authCookieNames = /session|token|auth|login|sid|jwt|csrf|identity|account|sso/i;
    const authDomains = cookies
      .filter((c) => authCookieNames.test(c.name))
      .map((c) => c.domain)
      .filter((v, i, a) => a.indexOf(v) === i);

    // Check well-known service domains
    const wellKnown = [
      { name: "Google", pattern: /\.google\.com$/ },
      { name: "GitHub", pattern: /\.github\.com$/ },
      { name: "Microsoft", pattern: /\.microsoft\.com$|\.live\.com$|\.office\.com$/ },
      { name: "Azure DevOps", pattern: /\.dev\.azure\.com$|\.visualstudio\.com$/ },
      { name: "AWS", pattern: /\.aws\.amazon\.com$|\.amazonaws\.com$/ },
      { name: "Slack", pattern: /\.slack\.com$/ },
      { name: "Notion", pattern: /\.notion\.so$/ },
      { name: "LinkedIn", pattern: /\.linkedin\.com$/ },
      { name: "Twitter/X", pattern: /\.twitter\.com$|\.x\.com$/ },
      { name: "Facebook", pattern: /\.facebook\.com$/ },
    ];

    const detectedServices = wellKnown
      .filter((svc) => authDomains.some((d) => svc.pattern.test(d)))
      .map((svc) => svc.name);

    return ok({
      totalCookies: cookies.length,
      uniqueDomains: domains.size,
      topDomains,
      domainsWithAuth: authDomains,
      loggedInServices: detectedServices,
    });
  });
}

// ---------------------------------------------------------------------------
// Keyboard input
// ---------------------------------------------------------------------------

/**
 * Key name → CDP key descriptor mapping.
 *
 * Covers common navigation / modifier keys. For printable characters
 * the key name IS the character (e.g. "a", "A", "1", "/").
 */
const KEY_DESCRIPTORS: Record<
  string,
  { key: string; code: string; keyCode?: number; text?: string }
> = {
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  F1: { key: "F1", code: "F1", keyCode: 112 },
  F2: { key: "F2", code: "F2", keyCode: 113 },
  F3: { key: "F3", code: "F3", keyCode: 114 },
  F4: { key: "F4", code: "F4", keyCode: 115 },
  F5: { key: "F5", code: "F5", keyCode: 116 },
  F6: { key: "F6", code: "F6", keyCode: 117 },
  F7: { key: "F7", code: "F7", keyCode: 118 },
  F8: { key: "F8", code: "F8", keyCode: 119 },
  F9: { key: "F9", code: "F9", keyCode: 120 },
  F10: { key: "F10", code: "F10", keyCode: 121 },
  F11: { key: "F11", code: "F11", keyCode: 122 },
  F12: { key: "F12", code: "F12", keyCode: 123 },
};

/** Modifier key names used in combo strings like "Control+a". */
const MODIFIER_FLAGS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Ctrl: 2,
  Meta: 4,
  Command: 4,
  Cmd: 4,
  Shift: 8,
};

/**
 * Dispatch a keyboard key or key combination via CDP `Input.dispatchKeyEvent`.
 *
 * `combo` is a string like "Tab", "Enter", "Control+a", "Shift+ArrowDown".
 * Modifier keys are pressed before the main key and released after.
 */
export async function pressKey(port: number, combo: string): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const parts = combo.split("+");
    const mainKeyName = parts.pop();
    const modifiers = parts;
    if (!mainKeyName) return fail("A key name is required.");

    // Compute the CDP modifier bitmask
    let modifierBits = 0;
    for (const mod of modifiers) {
      const flag = MODIFIER_FLAGS[mod];
      if (flag === undefined) {
        return fail(`Unknown modifier: "${mod}". Use Alt, Control, Meta, or Shift.`);
      }
      modifierBits |= flag;
    }

    // Resolve the main key descriptor
    const desc = KEY_DESCRIPTORS[mainKeyName];
    let key: string;
    let code: string;
    let keyCode: number | undefined;
    let text: string | undefined;

    if (desc) {
      key = desc.key;
      code = desc.code;
      keyCode = desc.keyCode;
      text = desc.text;
    } else if (mainKeyName.length === 1) {
      // Printable character
      key = mainKeyName;
      code = `Key${mainKeyName.toUpperCase()}`;
      keyCode = mainKeyName.toUpperCase().charCodeAt(0);
      text = mainKeyName;
    } else {
      return fail(`Unknown key: "${mainKeyName}". Use a key name like Tab, Enter, ArrowDown, etc.`);
    }

    // Press modifier keys
    for (const mod of modifiers) {
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: mod === "Ctrl" ? "Control" : mod === "Cmd" || mod === "Command" ? "Meta" : mod,
        code: `${mod === "Ctrl" ? "Control" : mod === "Cmd" || mod === "Command" ? "Meta" : mod}Left`,
        modifiers: modifierBits,
      });
    }

    // When Ctrl / Alt / Meta are held, suppress the `text` field so the
    // browser treats it as a shortcut (Ctrl+A) rather than inserting "a".
    // Shift-only combos (e.g. Shift+End, Shift+A) still need text for uppercase letters.
    const hasNonShiftModifier = (modifierBits & ~8) !== 0; // bits other than Shift (8)
    const effectiveText = hasNonShiftModifier ? undefined : text;

    // Key down
    const keyDownParams: Record<string, unknown> = {
      type: "keyDown",
      key,
      code,
      modifiers: modifierBits,
    };
    if (keyCode !== undefined) keyDownParams["windowsVirtualKeyCode"] = keyCode;
    if (effectiveText) keyDownParams["text"] = effectiveText;
    await client.send("Input.dispatchKeyEvent", keyDownParams);

    // Key up
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      modifiers: modifierBits,
    });

    // Release modifier keys (reverse order)
    for (const mod of [...modifiers].reverse()) {
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: mod === "Ctrl" ? "Control" : mod === "Cmd" || mod === "Command" ? "Meta" : mod,
        code: `${mod === "Ctrl" ? "Control" : mod === "Cmd" || mod === "Command" ? "Meta" : mod}Left`,
      });
    }

    return ok({ key: combo });
  });
}

// ---------------------------------------------------------------------------
// Mouse drag
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated modifier string (e.g. "ctrl,shift") into a
 * CDP modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8).
 */
export function parseModifierFlags(modStr?: string): number {
  if (!modStr) return 0;
  let bits = 0;
  for (const mod of modStr.split(",")) {
    switch (mod.trim().toLowerCase()) {
      case "alt":
        bits |= 1;
        break;
      case "ctrl":
      case "control":
        bits |= 2;
        break;
      case "meta":
      case "cmd":
      case "command":
        bits |= 4;
        break;
      case "shift":
        bits |= 8;
        break;
    }
  }
  return bits;
}

/**
 * Mouse drag from (startX, startY) → (endX, endY).
 *
 * Sends mousePressed at start, interpolated mouseMoved events, then
 * mouseReleased at end. Used for text selection, slider manipulation,
 * drag-and-drop, etc.
 */
export async function drag(
  port: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps = 10,
  modifiers = 0,
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    // Mouse down at start position
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: startX,
      y: startY,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers,
    });

    // Interpolated mouse move events
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(startX + (endX - startX) * (i / steps));
      const y = Math.round(startY + (endY - startY) * (i / steps));
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "left",
        buttons: 1,
        modifiers,
      });
    }

    // Mouse up at end position
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: endX,
      y: endY,
      button: "left",
      buttons: 0,
      clickCount: 1,
      modifiers,
    });

    return ok({ startX, startY, endX, endY, steps, modifiers });
  });
}

// ---------------------------------------------------------------------------
// Script execution
// ---------------------------------------------------------------------------

/**
 * Execute JavaScript in a specific CDP target (page or iframe).
 *
 * When `targetId` is provided the client connects directly to that target's
 * WebSocket endpoint, allowing code execution inside iframes or workers
 * that have their own execution context.
 */
export async function executeInTarget(
  port: number,
  script: string,
  targetId: string,
): Promise<CmdResult> {
  // connectToActivePage with targetId handles all target resolution
  // (exact match, prefix match, and good error messages)
  const { client } = await connectToActivePage(port, targetId);
  try {
    const result = cdpResponse<{
      result?: { value?: unknown; type?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      await client.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        awaitPromise: true,
      }),
    );

    if (result.exceptionDetails) {
      return fail(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "Script execution failed",
      );
    }

    return ok({ result: result.result?.value ?? result.result?.description });
  } finally {
    await client.close();
  }
}

export async function executeScript(port: number, script: string): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const result = cdpResponse<{
      result?: { value?: unknown; type?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      await client.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        awaitPromise: true,
      }),
    );

    if (result.exceptionDetails) {
      return fail(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "Script execution failed",
      );
    }

    return ok({ result: result.result?.value ?? result.result?.description });
  });
}

export async function executeConsole(port: number, command: string): Promise<CmdResult> {
  return executeScript(port, command);
}

// ---------------------------------------------------------------------------
// Wait operations
// ---------------------------------------------------------------------------

export async function waitForSelector(
  port: number,
  selector: string,
  condition: "visible" | "hidden" | "present" = "visible",
  timeout = 30_000,
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const pollInterval = 250;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      let script: string;
      if (condition === "hidden") {
        script = `!document.querySelector(${JSON.stringify(selector)}) || document.querySelector(${JSON.stringify(selector)}).offsetParent === null`;
      } else if (condition === "visible") {
        script = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el && el.offsetParent !== null; })()`;
      } else {
        script = `!!document.querySelector(${JSON.stringify(selector)})`;
      }

      const result = cdpResponse<{ result?: { value?: boolean } }>(
        await client.send("Runtime.evaluate", {
          expression: script,
          returnByValue: true,
        }),
      );

      if (result.result?.value === true) {
        return ok({ selector, condition });
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    return fail(
      `Timed out waiting for selector "${selector}" (${condition}) after ${String(timeout)}ms`,
    );
  });
}

export async function waitForNavigation(port: number, timeout = 30_000): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.waitForEvent("Page.loadEventFired", timeout);
    return ok();
  });
}

export async function waitForNetworkIdle(port: number, timeout = 30_000): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.send("Network.enable");

    let inflight = 0;
    let lastActivity = Date.now();
    const idleThreshold = 500;

    client.on("Network.requestWillBeSent", () => {
      inflight++;
      lastActivity = Date.now();
    });
    client.on("Network.loadingFinished", () => {
      inflight = Math.max(0, inflight - 1);
      lastActivity = Date.now();
    });
    client.on("Network.loadingFailed", () => {
      inflight = Math.max(0, inflight - 1);
      lastActivity = Date.now();
    });

    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (inflight === 0 && Date.now() - lastActivity >= idleThreshold) {
        return ok();
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    return fail(`Network did not become idle within ${String(timeout)}ms`);
  });
}

export async function waitForCondition(
  port: number,
  expression: string,
  timeout = 30_000,
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const pollInterval = 250;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const result = cdpResponse<{ result?: { value?: unknown } }>(
        await client.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
        }),
      );

      if (result.result?.value) {
        return ok({ expression, value: result.result.value });
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    return fail(`Condition not met within ${String(timeout)}ms: ${expression}`);
  });
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

export async function listTabs(port: number): Promise<CmdResult> {
  const pages = await getPageTargets(port);
  return ok({
    tabs: pages.map((p) => ({
      id: p.id,
      title: p.title,
      url: p.url,
    })),
    count: pages.length,
  });
}

export async function createTab(port: number, url?: string): Promise<CmdResult> {
  const target = await createTarget(port, url);
  return ok({
    id: target.id,
    title: target.title,
    url: target.url,
  });
}

export async function switchTab(port: number, targetId: string): Promise<CmdResult> {
  await activateTarget(port, targetId);
  return ok({ id: targetId });
}

export async function closeTab(port: number, targetId: string): Promise<CmdResult> {
  await closeTarget(port, targetId);
  return ok({ id: targetId });
}

// ---------------------------------------------------------------------------
// Device emulation
// ---------------------------------------------------------------------------

interface DevicePreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent: string;
}

const DEVICE_PRESETS: Record<string, DevicePreset> = {
  "iphone-14": {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "iphone-14-pro-max": {
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "pixel-7": {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  },
  "ipad-pro": {
    width: 1024,
    height: 1366,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "galaxy-s23": {
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  },
};

export async function emulateDevice(
  port: number,
  options: {
    action: "emulate" | "reset";
    preset?: string;
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
    userAgent?: string;
    orientation?: "portrait" | "landscape";
  },
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    if (options.action === "reset") {
      await client.send("Emulation.clearDeviceMetricsOverride");
      await client.send("Network.setUserAgentOverride", { userAgent: "" });
      return ok({ action: "reset" });
    }

    let preset: DevicePreset | undefined;
    if (options.preset) {
      const key = options.preset.toLowerCase().replace(/\s+/g, "-");
      preset = DEVICE_PRESETS[key];
      if (!preset) {
        const available = Object.keys(DEVICE_PRESETS).join(", ");
        return fail(`Unknown preset: ${options.preset}. Available: ${available}`);
      }
    }

    const width = options.width ?? preset?.width ?? 375;
    const height = options.height ?? preset?.height ?? 812;
    const deviceScaleFactor = options.deviceScaleFactor ?? preset?.deviceScaleFactor ?? 1;
    const mobile = options.mobile ?? preset?.mobile ?? false;
    const userAgent = options.userAgent ?? preset?.userAgent ?? "";

    let finalWidth = width;
    let finalHeight = height;
    if (options.orientation === "landscape" && height > width) {
      finalWidth = height;
      finalHeight = width;
    }

    await client.send("Emulation.setDeviceMetricsOverride", {
      width: finalWidth,
      height: finalHeight,
      deviceScaleFactor,
      mobile,
    });

    if (userAgent) {
      await client.send("Network.setUserAgentOverride", { userAgent });
    }

    await client.send("Emulation.setTouchEmulationEnabled", { enabled: mobile });

    return ok({
      action: "emulate",
      width: finalWidth,
      height: finalHeight,
      deviceScaleFactor,
      mobile,
      preset: options.preset,
    });
  });
}

// ---------------------------------------------------------------------------
// Dialog handling
// ---------------------------------------------------------------------------

export async function handleDialog(
  port: number,
  action: "accept" | "dismiss",
  trigger: string,
  promptText?: string,
  timeout = 10_000,
): Promise<CmdResult> {
  // Dialog handling requires a persistent CDP session: we enable the Page
  // domain, set up a dialog listener, execute the trigger expression
  // (e.g. "document.querySelector('button').click()"), then wait for and
  // handle the resulting dialog — all in a single WebSocket connection.
  return withPage(port, async (client) => {
    const handleParams: Record<string, unknown> = { accept: action === "accept" };
    if (promptText !== undefined) {
      handleParams["promptText"] = promptText;
    }

    // Set up listener BEFORE triggering
    const dialogPromise = client.waitForEvent("Page.javascriptDialogOpening", timeout);

    // Fire the trigger (don't await — JS execution will block on the dialog)
    void client
      .send("Runtime.evaluate", {
        expression: trigger,
        awaitPromise: false,
      })
      .catch(() => {
        /* expected to resolve only after dialog is dismissed */
      });

    // Wait for the dialog to appear
    const dialogInfo = (await dialogPromise) as {
      message?: string;
      type?: string;
      url?: string;
    };

    // Handle it
    await client.send("Page.handleJavaScriptDialog", handleParams);

    return ok({
      action,
      dialogType: dialogInfo.type,
      dialogMessage: dialogInfo.message,
    });
  });
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

export async function uploadFile(
  port: number,
  selector: string,
  filePaths: string[],
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.send("DOM.enable");

    const node = await resolveSelector(client, selector);
    if (!node) {
      return fail(`Element not found: ${selector}`);
    }

    const absolutePaths = filePaths.map((p) => resolve(p));
    await client.send("DOM.setFileInputFiles", {
      files: absolutePaths,
      nodeId: node.nodeId,
    });

    return ok({ selector, files: absolutePaths, count: absolutePaths.length });
  });
}

export async function download(
  port: number,
  url: string,
  output?: string,
  timeout = 60_000,
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    // Use in-page fetch to download (respects browser cookies & auth)
    const fetchScript = `(async () => {
      try {
        const res = await fetch(${JSON.stringify(url)});
        if (!res.ok) return { error: res.status + ' ' + res.statusText };
        const blob = await res.blob();
        const reader = new FileReader();
        return new Promise(resolve => {
          reader.onload = () => {
            const dataUrl = reader.result;
            const base64 = dataUrl.toString().split(',')[1] || '';
            resolve({ base64, type: blob.type, size: blob.size });
          };
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return { error: e.message };
      }
    })()`;

    const result = cdpResponse<{
      result?: {
        value?: {
          base64?: string;
          type?: string;
          size?: number;
          error?: string;
        };
      };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      await client.send("Runtime.evaluate", {
        expression: fetchScript,
        returnByValue: true,
        awaitPromise: true,
        timeout,
      }),
    );

    if (result.exceptionDetails) {
      return fail(
        `Download failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Unknown error"}`,
      );
    }

    const value = result.result?.value;
    if (!value) return fail("Download failed: no response");
    if (value.error) return fail(`Download failed: ${value.error}`);
    if (!value.base64) return fail("Download failed: empty response body");

    const filename = output ?? url.split("/").pop()?.split("?")[0] ?? "download";
    const savePath = resolve(filename);
    const data = Buffer.from(value.base64, "base64");
    writeFileSync(savePath, data);

    return ok({ url, path: savePath, size: data.length, mimeType: value.type });
  });
}

// ---------------------------------------------------------------------------
// Network monitoring
// ---------------------------------------------------------------------------

interface NetworkEntry {
  url: string;
  method: string;
  type?: string;
  status?: number;
  mimeType?: string;
  size?: number;
}

export async function networkLog(port: number, duration = 5000): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.send("Network.enable");

    const requestMap = new Map<string, NetworkEntry>();

    client.on("Network.requestWillBeSent", (params) => {
      const request = recordValue(params["request"]);
      const requestId = stringValue(params["requestId"]);
      if (request && requestId) {
        requestMap.set(requestId, {
          url: stringValue(request.url) ?? "",
          method: stringValue(request.method) ?? "GET",
          type: stringValue(params["type"]),
        });
      }
    });

    client.on("Network.responseReceived", (params) => {
      const requestId = stringValue(params["requestId"]);
      if (!requestId) return;
      const response = recordValue(params["response"]);
      const entry = requestMap.get(requestId);
      if (entry && response) {
        entry.status = numberValue(response.status);
        entry.mimeType = stringValue(response.mimeType);
      }
    });

    client.on("Network.loadingFinished", (params) => {
      const requestId = stringValue(params["requestId"]);
      if (!requestId) return;
      const entry = requestMap.get(requestId);
      if (entry) {
        entry.size = numberValue(params["encodedDataLength"]);
      }
    });

    await new Promise((r) => setTimeout(r, duration));

    const requests = [...requestMap.values()];
    return ok({ requests, count: requests.length, durationMs: duration });
  });
}

// ---------------------------------------------------------------------------
// Cookie management
// ---------------------------------------------------------------------------

export async function getCookies(port: number, domain?: string): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.send("Network.enable");

    const result = cdpResponse<{
      cookies: Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        expires: number;
        size: number;
        httpOnly: boolean;
        secure: boolean;
        sameSite: string;
      }>;
    }>(await client.send("Network.getAllCookies"));

    let cookies = result.cookies ?? [];
    if (domain) {
      cookies = cookies.filter((c) => c.domain.includes(domain));
    }

    return ok({ cookies, count: cookies.length });
  });
}

export async function setCookie(
  port: number,
  options: {
    name: string;
    value: string;
    domain: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
    expires?: number;
  },
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.send("Network.enable");

    const params: Record<string, unknown> = {
      name: options.name,
      value: options.value,
      domain: options.domain,
    };
    if (options.path) params["path"] = options.path;
    if (options.secure) params["secure"] = options.secure;
    if (options.httpOnly) params["httpOnly"] = options.httpOnly;
    if (options.sameSite) params["sameSite"] = options.sameSite;
    if (options.expires) params["expires"] = options.expires;

    const result = cdpResponse<{ success?: boolean }>(
      await client.send("Network.setCookie", params),
    );

    if (result.success === false) {
      return fail(`Failed to set cookie: ${options.name}`);
    }

    return ok({ name: options.name, domain: options.domain });
  });
}

export async function deleteCookie(port: number, name: string, domain: string): Promise<CmdResult> {
  return withPage(port, async (client) => {
    await client.send("Network.enable");
    await client.send("Network.deleteCookies", { name, domain });
    return ok({ name, domain });
  });
}

// ---------------------------------------------------------------------------
// DOM modification
// ---------------------------------------------------------------------------

export async function injectCSS(port: number, css: string): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const result = cdpResponse<{ result?: { value?: boolean } }>(
      await client.send("Runtime.evaluate", {
        expression: `(() => {
        const style = document.createElement('style');
        style.setAttribute('data-agentic-browser', 'injected');
        style.textContent = ${JSON.stringify(css)};
        document.head.appendChild(style);
        return true;
      })()`,
        returnByValue: true,
      }),
    );

    return ok({ injected: result.result?.value === true });
  });
}

export async function modifyAttribute(
  port: number,
  selector: string,
  attribute: string,
  value?: string,
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const script =
      value !== undefined
        ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.setAttribute(${JSON.stringify(attribute)}, ${JSON.stringify(value)});
          return { set: true };
        })()`
        : `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.removeAttribute(${JSON.stringify(attribute)});
          return { removed: true };
        })()`;

    const result = cdpResponse<{ result?: { value?: unknown } }>(
      await client.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
      }),
    );

    if (result.result?.value === null) {
      return fail(`Element not found: ${selector}`);
    }

    return ok({ selector, attribute, ...recordValue(result.result?.value) });
  });
}

export async function insertHTML(
  port: number,
  selector: string,
  html: string,
  position: "beforebegin" | "afterbegin" | "beforeend" | "afterend" = "beforeend",
): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.insertAdjacentHTML(${JSON.stringify(position)}, ${JSON.stringify(html)});
      return true;
    })()`;

    const result = cdpResponse<{ result?: { value?: unknown } }>(
      await client.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
      }),
    );

    if (result.result?.value === null) {
      return fail(`Element not found: ${selector}`);
    }

    return ok({ selector, position });
  });
}

export async function removeElement(port: number, selector: string): Promise<CmdResult> {
  return withPage(port, async (client) => {
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.remove();
      return true;
    })()`;

    const result = cdpResponse<{ result?: { value?: unknown } }>(
      await client.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
      }),
    );

    if (result.result?.value === null) {
      return fail(`Element not found: ${selector}`);
    }

    return ok({ selector, removed: true });
  });
}
