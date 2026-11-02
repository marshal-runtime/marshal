/**
 * CDP (Chrome DevTools Protocol) helper layer for M E2E real account tests.
 *
 * Connects to a running M (Marshal) instance via remote debugging,
 * provides utilities for sending prompts, reading responses, taking
 * screenshots, and invoking IPC handlers.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import CDP from "chrome-remote-interface";

const DEFAULT_PORT = 9222;
const CONNECT_RETRY_INTERVAL_MS = 500;
const CONNECT_TIMEOUT_MS = 15_000;
const PROMPT_INPUT_TIMEOUT_MS = 5_000;
const PROMPT_SUBMIT_TIMEOUT_MS = 5_000;

let cdpInput = null;
let cdpPage = null;

/**
 * Connect to the M app via CDP with retries.
 * Returns { client, Runtime, Page, DOM, Network } for the renderer target.
 */
export async function connectToApp(port = DEFAULT_PORT) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const targets = await CDP.List({ port });
      const pageTargets = targets.filter(
        (t) => t.type === "page" && !t.url.includes("devtools://"),
      );
      const rendererTarget =
        pageTargets.find((t) => t.url.startsWith("marshal://app/")) ||
        pageTargets.find((t) => t.url.includes("/dist/index.html")) ||
        pageTargets.find((t) => !t.url.includes("mini-mode-page")) ||
        pageTargets[0];
      if (!rendererTarget) {
        throw new Error(`No renderer target found among ${targets.length} targets`);
      }

      const client = await CDP({ port, target: rendererTarget });
      const { Runtime, Page, DOM, Network, Input } = client;

      await Promise.all([Runtime.enable(), Page.enable(), DOM.enable(), Network.enable()]);
      await Page.bringToFront();
      cdpInput = Input;
      cdpPage = Page;

      return { client, Runtime, Page, DOM, Network, target: rendererTarget };
    } catch (err) {
      lastError = err;
      await sleep(CONNECT_RETRY_INTERVAL_MS);
    }
  }

  throw new Error(
    `Failed to connect to M on port ${port} after ${CONNECT_TIMEOUT_MS}ms: ${lastError?.message}`,
  );
}

/**
 * Evaluate a JS expression in the renderer context and return the result.
 */
export async function evaluate(Runtime, expression) {
  const { result, exceptionDetails } = await Runtime.evaluate({
    // Safe: `expression` is always a static internal test snippet built from hardcoded strings
    // in the test helpers — it is never derived from user input or external data, so there is
    // no code-injection vector here.
    // Rule: https://semgrep.dev/r/javascript.chrome-remote-interface.security.audit.chrome-remote-interface-compilescript-injection.chrome-remote-interface-compilescript-injection
    expression, // nosemgrep: javascript.chrome-remote-interface.security.audit.chrome-remote-interface-compilescript-injection.chrome-remote-interface-compilescript-injection
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(
      `Eval error: ${exceptionDetails.exception?.description || exceptionDetails.text}`,
    );
  }
  return result.value;
}

/**
 * Wait until the chat editor is enabled and ready for input.
 * If a stale "No SDK session" error is detected, automatically creates
 * a new session and waits again.
 */
export async function waitForReady(Runtime, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let recoveryAttempts = 0;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      Runtime,
      `!!document.querySelector('[data-testid="chat-input-editor"]:not([aria-disabled="true"])')`,
    );
    if (ready) {
      // Check for stale session error from a previous test's leftover response
      const lastMsg = await getLastAssistantMessage(Runtime).catch(() => null);
      if (lastMsg && lastMsg.includes("No SDK session")) {
        if (++recoveryAttempts > 3) {
          throw new Error("Stale SDK session persists after 3 recovery attempts");
        }
        console.log(
          `   ℹ Stale SDK session detected — creating new session (attempt ${recoveryAttempts}/3)...`,
        );
        await evaluate(
          Runtime,
          `(() => {
            const btn = document.querySelector('button[aria-label="New chat"]')
              || [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'New chat');
            if (btn) { btn.click(); return true; }
            return false;
          })()`,
        );
        await sleep(3000);
        continue;
      }
      return;
    }
    await sleep(500);
  }
  throw new Error("Chat input not ready within timeout");
}

async function getPromptState(Runtime, includeDiagnostics = false) {
  return evaluate(
    Runtime,
    `
    (() => {
      const includeDiagnostics = ${includeDiagnostics ? "true" : "false"};
      const editorEl = document.querySelector('[data-testid="chat-input-editor"]');
      const sendBtn = document.querySelector('[data-testid="send-btn"]');
      const stopBtn = document.querySelector('[data-testid="stop-btn"]');
      const active = document.activeElement;
      let lexicalState = null;
      if (includeDiagnostics && editorEl) {
        const lexicalEditor =
          editorEl.__lexicalEditor ||
          Object.keys(editorEl)
            .map((key) => editorEl[key])
            .find((value) => value && typeof value.getEditorState === 'function');
        try {
          lexicalState = lexicalEditor?.getEditorState?.().toJSON?.() ?? null;
        } catch (err) {
          lexicalState = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      return {
        editorFound: !!editorEl,
        textContent: editorEl?.textContent ?? null,
        activeElement:
          active instanceof HTMLElement
            ? {
                tagName: active.tagName,
                testId: active.getAttribute('data-testid'),
                role: active.getAttribute('role'),
                ariaLabel: active.getAttribute('aria-label'),
                outerHTML: active.outerHTML.slice(0, 240),
              }
            : null,
        editorContainsActive: !!editorEl && !!active && editorEl.contains(active),
        selectionText: window.getSelection()?.toString() ?? '',
        sendDisabled: sendBtn instanceof HTMLButtonElement ? sendBtn.disabled : null,
        sendFound: !!sendBtn,
        stopFound: !!stopBtn,
        lexicalState,
      };
    })()
  `,
  );
}

async function focusPromptEditor(Runtime) {
  if (!cdpPage) {
    throw new Error("cdp sendPrompt: CDP Page domain unavailable; call connectToApp() first");
  }
  await cdpPage.bringToFront();

  // Retry loop: press Escape to dismiss any open overlays/dialogs, then focus.
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Dismiss any open overlay (search popover, mention picker, dialog, etc.)
      if (cdpInput) {
        await cdpInput.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape" });
        await cdpInput.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
      }
      await sleep(200);
    }
    await evaluate(
      Runtime,
      `
      (() => {
        const editorEl = document.querySelector('[data-testid="chat-input-editor"]');
        if (!editorEl) throw new Error('Chat editor not found');
        editorEl.focus();
        const range = document.createRange();
        range.selectNodeContents(editorEl);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      })()
    `,
    );
    const state = await getPromptState(Runtime);
    if (state.editorContainsActive) return;
    await sleep(300);
  }

  throw new Error(
    `cdp sendPrompt: chat editor did not receive focus: ${JSON.stringify(
      await getPromptState(Runtime, true),
    )}`,
  );
}

async function clearPromptEditor(Runtime) {
  if (!cdpInput) {
    throw new Error("cdp sendPrompt: CDP Input domain unavailable; call connectToApp() first");
  }
  const state = await getPromptState(Runtime);
  if (state.textContent === "") return;

  await selectAllPromptText(Runtime);
  await cdpInput.dispatchKeyEvent({
    type: "rawKeyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await cdpInput.dispatchKeyEvent({
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });

  const deadline = Date.now() + PROMPT_INPUT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await getPromptState(Runtime);
    if (state.textContent === "") return;
    await sleep(50);
  }
  throw new Error(
    `cdp sendPrompt: chat editor did not clear before insertion: ${JSON.stringify(
      await getPromptState(Runtime, true),
    )}`,
  );
}

async function selectAllPromptText(Runtime) {
  const initialState = await getPromptState(Runtime);
  if (initialState.textContent === "") return;

  try {
    await cdpInput.dispatchKeyEvent({ type: "rawKeyDown", commands: ["selectAll"] });
    if (await waitForSelection(Runtime, initialState.textContent, 250)) return;
  } catch {
    // Fall through to the explicit platform shortcut below.
  }

  const isMac = process.platform === "darwin";
  const modifiers = isMac ? 4 : 2;
  await cdpInput.dispatchKeyEvent({
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers,
  });
  await cdpInput.dispatchKeyEvent({
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers,
  });

  if (await waitForSelection(Runtime, initialState.textContent, PROMPT_INPUT_TIMEOUT_MS)) return;

  await evaluate(
    Runtime,
    `
    (() => {
      const editorEl = document.querySelector('[data-testid="chat-input-editor"]');
      if (!editorEl) throw new Error('Chat editor not found');
      editorEl.focus();
      const range = document.createRange();
      range.selectNodeContents(editorEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    })()
  `,
  );

  if (await waitForSelection(Runtime, initialState.textContent, PROMPT_INPUT_TIMEOUT_MS)) return;

  throw new Error(
    `cdp sendPrompt: could not select existing prompt text before clearing: ${JSON.stringify(
      await getPromptState(Runtime, true),
    )}`,
  );
}

async function waitForSelection(Runtime, expectedText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getPromptState(Runtime);
    if (state.selectionText === expectedText) return true;
    await sleep(50);
  }
  return false;
}

async function insertPromptText(Runtime, text) {
  await cdpInput.insertText({ text });
  if (await waitForPromptTextContent(Runtime, text, 1_500)) {
    await waitForPromptSubmitReady(Runtime);
    return;
  }

  await clearPromptEditor(Runtime);
  for (const char of Array.from(text)) {
    await cdpInput.dispatchKeyEvent({
      type: "char",
      text: char,
      unmodifiedText: char,
    });
  }
  if (!(await waitForPromptTextContent(Runtime, text, PROMPT_INPUT_TIMEOUT_MS))) {
    throw new Error(
      `cdp sendPrompt: Lexical did not commit inserted prompt: ${JSON.stringify(
        await getPromptState(Runtime, true),
      )}`,
    );
  }
  await waitForPromptSubmitReady(Runtime);
}

async function waitForPromptTextContent(Runtime, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getPromptState(Runtime);
    if (state.textContent === text) return true;
    await sleep(50);
  }
  return false;
}

async function waitForPromptSubmitReady(Runtime, timeoutMs = PROMPT_INPUT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getPromptState(Runtime);
    if (state.sendDisabled === false || state.stopFound) return;
    await sleep(50);
  }
  throw new Error(
    `cdp sendPrompt: prompt text inserted but submit never became ready: ${JSON.stringify(
      await getPromptState(Runtime, true),
    )}`,
  );
}

async function submitPrompt(Runtime) {
  const beforeText = (await getPromptState(Runtime)).textContent;
  await cdpInput.dispatchKeyEvent({
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdpInput.dispatchKeyEvent({
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });

  const deadline = Date.now() + PROMPT_SUBMIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await getPromptState(Runtime);
    if (state.textContent === "") return;
    await sleep(50);
  }

  const state = await getPromptState(Runtime, true);
  if (!state.sendFound && !state.stopFound) {
    throw new Error(`cdp sendPrompt: prompt did not submit via Enter: ${JSON.stringify(state)}`);
  }
  if (state.stopFound) {
    throw new Error(
      `cdp sendPrompt: prompt still held text after Enter while streaming; before=${JSON.stringify(
        beforeText,
      )}, state=${JSON.stringify(state)}`,
    );
  }

  await evaluate(
    Runtime,
    `
    (() => {
      const sendBtn = document.querySelector('[data-testid="send-btn"]');
      if (!(sendBtn instanceof HTMLButtonElement)) throw new Error('Send button not found');
      if (sendBtn.disabled) throw new Error('Send button is disabled');
      sendBtn.click();
      return true;
    })()
  `,
  );

  const fallbackDeadline = Date.now() + PROMPT_SUBMIT_TIMEOUT_MS;
  while (Date.now() < fallbackDeadline) {
    const state = await getPromptState(Runtime);
    if (state.textContent === "") return;
    await sleep(50);
  }
  throw new Error(
    `cdp sendPrompt: prompt did not submit via Send button fallback: ${JSON.stringify(
      await getPromptState(Runtime, true),
    )}`,
  );
}

/**
 * Type a prompt into the Lexical chat editor and submit it through real CDP input.
 */
export async function sendPrompt(Runtime, text) {
  if (!cdpInput) {
    throw new Error("cdp sendPrompt: CDP Input domain unavailable; call connectToApp() first");
  }
  await focusPromptEditor(Runtime);
  await clearPromptEditor(Runtime);
  await insertPromptText(Runtime, text);
  await submitPrompt(Runtime);
}

/**
 * Wait for the LLM to finish responding.
 * Polls from the start — if response arrives early, returns early.
 * Guarantees at least `seconds` of wait before declaring "done".
 */
export async function waitForResponse(Runtime, seconds = 30, maxSeconds = 120) {
  const minWait = Date.now() + seconds * 1000;
  const deadline = Date.now() + maxSeconds * 1000;

  while (Date.now() < deadline) {
    const isStreaming = await evaluate(
      Runtime,
      `
      !!(document.querySelector('[data-testid="stop-btn"]') ||
         document.querySelector('[data-testid="tool-status-shimmer"]'))
    `,
    );
    if (!isStreaming && Date.now() >= minWait) return;
    await sleep(2000);
  }
  // Don't throw — test can still check the result
  console.warn("⚠️  Response may still be streaming after max timeout");
}

/**
 * Get the text content of the last assistant message.
 */
export async function getLastAssistantMessage(Runtime) {
  return evaluate(
    Runtime,
    `
    (() => {
      const msgs = document.querySelectorAll('[data-testid="message-assistant"] [data-testid="message-text"]');
      if (msgs.length === 0) return null;
      return msgs[msgs.length - 1].textContent.trim();
    })()
  `,
  );
}

/**
 * Pattern for "please confirm before I send/reply" turns the model emits
 * before destructive actions. Anchored on phrases the model actually
 * uses so it doesn't false-positive on success messages like "Message
 * confirmed and sent".
 */
const CONFIRMATION_PROMPT_RE =
  /please confirm|confirming before send|before i (send|reply)|are you sure/i;

/**
 * If the latest assistant message is a confirm-before-send prompt, send
 * an approval reply, wait for the next response, and return it. If the
 * latest message is not a confirm prompt (or is missing), return it
 * unchanged. Used by send-shaped tests to handle
 * the model's confirmation turn without false-positive duplicate sends.
 *
 * Uses waitForNewAssistantMessage (which throws on timeout) rather than
 * waitForResponse (which only warns) — without this, a stalled model
 * would let the helper return the confirmation prompt itself and
 * downstream content checks would silently warn instead of failing.
 */
export async function approveConfirmationIfRequested(Runtime) {
  const r = await getLastAssistantMessage(Runtime);
  if (!r || !CONFIRMATION_PROMPT_RE.test(r)) return r;
  console.log("   ↪ Confirmation requested, sending approval");
  const beforeCount = await getAssistantMessageCount(Runtime);
  // Verb-neutral so the same approval works across send / forward / reply / post.
  await sendPrompt(Runtime, "Yes, please proceed.");
  await waitForNewAssistantMessage(Runtime, beforeCount, 30, 90);
  return getLastAssistantMessage(Runtime);
}

/**
 * Get all assistant message texts as an array.
 */
export async function getAllAssistantMessages(Runtime) {
  return evaluate(
    Runtime,
    `
    [...document.querySelectorAll('[data-testid="message-assistant"] [data-testid="message-text"]')]
      .map(el => el.textContent.trim())
  `,
  );
}

/**
 * Get tool status line texts (tool calls shown in the UI).
 */
export async function getToolCalls(Runtime) {
  return evaluate(
    Runtime,
    `
    [...document.querySelectorAll('[data-testid="tool-status-line"]')]
      .map(el => el.textContent.trim())
  `,
  );
}

/**
 * Get the count of all messages (user + assistant).
 */
export async function getMessageCount(Runtime) {
  return evaluate(
    Runtime,
    `document.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]').length`,
  );
}

/**
 * Get the count of assistant messages only.
 */
export async function getAssistantMessageCount(Runtime) {
  return evaluate(Runtime, `document.querySelectorAll('[data-testid="message-assistant"]').length`);
}

/**
 * Wait until a new assistant message appears in the DOM (count exceeds previousCount),
 * then wait for streaming to finish. This prevents reading stale responses from
 * earlier turns when tests run sequentially.
 */
export async function waitForNewAssistantMessage(
  Runtime,
  previousCount,
  minSeconds = 10,
  maxSeconds = 120,
) {
  const minWait = Date.now() + minSeconds * 1000;
  const deadline = Date.now() + maxSeconds * 1000;

  // Phase 1: wait for a new assistant message to appear
  while (Date.now() < deadline) {
    const count = await getAssistantMessageCount(Runtime);
    if (count > previousCount) break;
    await sleep(1000);
  }

  // Fail fast if no new message arrived — continuing would read stale data
  const finalCount = await getAssistantMessageCount(Runtime);
  if (finalCount <= previousCount) {
    throw new Error(`No new assistant message appeared within ${maxSeconds}s`);
  }

  // Phase 2: wait for streaming to stop (same logic as waitForResponse)
  while (Date.now() < deadline) {
    const isStreaming = await evaluate(
      Runtime,
      `
      !!(document.querySelector('[data-testid="stop-btn"]') ||
         document.querySelector('[data-testid="tool-status-shimmer"]'))
    `,
    );
    if (!isStreaming && Date.now() >= minWait) return;
    await sleep(2000);
  }
  console.warn("⚠️  Response may still be streaming after max timeout");
}

/**
 * Check if the welcome state is visible.
 */
export async function isWelcomeVisible(Runtime) {
  return evaluate(Runtime, `!!document.querySelector('[data-testid="welcome-state"]')`);
}

/**
 * Check the auth status dot color.
 */
export async function getAuthStatus(Runtime) {
  return evaluate(
    Runtime,
    `
    (async () => {
      // Use IPC auth check — the app has no visual auth-status dot for Copilot
      if (!window.copilotAPI?.checkAuth) return 'missing';
      try {
        const result = await window.copilotAPI.checkAuth();
        return result?.isAuthenticated ? 'authenticated' : 'unauthenticated';
      } catch {
        return 'missing';
      }
    })()
  `,
  );
}

/**
 * Check if the chat input is enabled.
 */
export async function isInputEnabled(Runtime) {
  return evaluate(
    Runtime,
    `!!document.querySelector('[data-testid="chat-input-editor"]:not([aria-disabled="true"])')`,
  );
}

/**
 * Take a screenshot and save it to the results directory.
 * Returns the full path of the saved screenshot.
 */
export async function screenshot(Page, resultsDir, name) {
  const { data } = await Page.captureScreenshot({ format: "png" });
  const screenshotsDir = path.join(resultsDir, "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const filePath = path.join(screenshotsDir, name);
  fs.writeFileSync(filePath, Buffer.from(data, "base64"));
  return filePath;
}

/**
 * Invoke an IPC handler via the preload bridge.
 * E.g., invokeIPC(Runtime, 'settingsAPI', 'get') calls window.settingsAPI.get()
 */
export async function invokeIPC(Runtime, api, method, ...args) {
  const argsStr = args.map((a) => JSON.stringify(a)).join(", ");
  return evaluate(Runtime, `window.${api}.${method}(${argsStr})`);
}

/**
 * Check for visible error banners or indicators.
 */
export async function checkForErrors(Runtime) {
  return evaluate(
    Runtime,
    `
    (() => {
      const errors = [];
      // Alert role elements (covers auth errors and other banners)
      document.querySelectorAll('[role="alert"]').forEach(el => {
        const text = el.textContent.trim();
        if (text) errors.push('Alert: ' + text.slice(0, 80));
      });
      return errors;
    })()
  `,
  );
}

/**
 * Click a DOM element matching the given selector.
 */
export async function clickElement(Runtime, selector) {
  return evaluate(
    Runtime,
    `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Element not found: " + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()
  `,
  );
}

/**
 * Check if a file exists on disk (for verifying file creation).
 */
export function fileExists(filePath) {
  return fs.existsSync(filePath);
}

/**
 * Generate a timestamp string for unique test identifiers.
 */
export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Sleep for the given number of milliseconds.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get a set of browser (Edge/Chrome) PIDs currently running.
 * Used to detect whether a new browser window was spawned.
 */
export function getBrowserPids() {
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq msedge.exe" /FO CSV /NH', {
        encoding: "utf-8",
        windowsHide: true,
      });
      return new Set(
        out
          .split("\n")
          .filter((l) => l.includes("msedge"))
          .map((l) => l.split(",")[1]?.replace(/"/g, "")),
      );
    }
    const out = execSync("pgrep -f 'Microsoft Edge|Google Chrome|Chromium' || true", {
      encoding: "utf-8",
    });
    return new Set(out.trim().split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}
