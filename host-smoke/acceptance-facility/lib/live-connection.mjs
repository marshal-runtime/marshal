import { chromium } from "@playwright/test";
import CDP from "chrome-remote-interface";

// Mirrors e2e-real/marshal-cdp-helpers.mjs's connectToApp() so this facility's
// live-gated scripts (identify-installed-artifact, execute-application-route,
// drive-native-frame) reach an already-running Marshal the same way the
// repo's own real-account E2E harness does, instead of inventing a second
// connection mechanism. Read-only reference to that file's pattern; this
// module does not import from e2e-real/ (a different lane's territory) and
// does not launch or restart Marshal — it only connects to a debug port an
// operator already opened (e.g. via `pnpm electron:debug`).
//
// F-DEPLOY-2 repair (guard order is absolute — see Field Guide decision 1):
// (a) live mode requires an EXPLICIT port everywhere; there is no default
// port anymore (the removed DEFAULT_PORT=9222 is exactly what let
// identify-installed-artifact.mjs attach to the operator's personal Google
// Chrome when it happened to be listening on 9222 instead of Marshal's
// documented 9333 debug port). (b) before ANY Runtime.evaluate, every
// connector verifies the endpoint is actually a Marshal renderer: first a
// non-evaluating /json/version metadata check — F-DEPLOY-2b (Codex-found,
// independently confirmed): this rejects a known desktop-browser `Browser`
// signature only when `User-Agent` ALSO lacks a Marshal/Electron marker
// (Electron's own `Browser` field is Chrome-shaped, so `Browser` alone is
// ambiguous — see isKnownNonMarshalBrowserString()'s doc comment below) —
// then exactly one marker-probe evaluate (checks for the Marshal-only
// window.sessionsAPI/window.runtimeUiAPI preload globals) as the FIRST
// evaluate on the connection — nothing else evaluates before it passes, and
// this probe is mandatory regardless of the metadata check's outcome (a
// spoofed Marshal/Electron User-Agent never substitutes for it). (c) target
// matching only ever accepts a confident URL match (marshal://app/index.html
// primary, legacy /dist/index.html secondary); every prior blind first-page
// fallback is removed — no match is a typed refusal, never a guess.
const CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_INTERVAL_MS = 500;

const MARSHAL_APP_URL_MARKER = "marshal://app/index.html";
const LEGACY_DIST_URL_MARKER = "/dist/index.html";

// F-DEPLOY-2b (Codex-found, independently confirmed — see Field Guide
// SUPERSESSION section): the `Browser` field alone is NOT a reliable
// Marshal-vs-desktop-browser signal. Electron's own CDP handshake reports the
// underlying Chromium build's product string here — for this repo's Electron
// 41.1.1, that is literally "Chrome/146.0.7680.166" (verified live against
// the deployed host's own debug port; see
// example-receipts/live-demonstration/json-version-9333.json) — the exact
// same shape a real desktop Google Chrome install reports. The 3b8e99bc3
// repair's comment claiming Electron reports "Electron/<version>" here was
// false and caused it to refuse the real Marshal. What actually differs is
// the `User-Agent` field: Electron always appends its own product markers
// there (`Marshal/<version> ... Electron/<version>`), which a real desktop
// Chrome/Firefox/Safari/Edge/Opera install never does. So: reject only when
// `Browser` matches a known desktop-browser family AND `User-Agent` carries
// neither marker — never on `Browser` alone, and a passing User-Agent is
// still only ever "inconclusive, don't reject here", never itself a pass. A
// spoofed `Marshal/`/`Electron/` User-Agent on a non-Marshal endpoint falls
// through this check and is still caught by the mandatory marker-probe
// evaluate below (metadata alone never suffices).
const KNOWN_NON_MARSHAL_BROWSER_PATTERN = /^(Chrome|Firefox|Safari|Edg|OPR)\//;
const MARSHAL_OR_ELECTRON_USER_AGENT_PATTERN = /\b(Marshal|Electron)\//;

// The only expression permitted to evaluate before endpoint verification
// passes — and the only evaluate this module ever runs before a caller's own
// work. Checks for globals `electron/preload.cjs` exposes via
// contextBridge.exposeInMainWorld, which only exist inside a real Marshal
// renderer.
export const MARSHAL_RENDERER_MARKER_EXPRESSION =
  'typeof window.sessionsAPI !== "undefined" && typeof window.runtimeUiAPI !== "undefined"';

export class LiveConnectionRefusalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiveConnectionRefusalError";
    this.code = code;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertExplicitPort(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new LiveConnectionRefusalError(
      "missing-explicit-cdp-port",
      `An explicit positive integer CDP port is required; received ${JSON.stringify(port)}. ` +
        "Live mode never assumes a default port.",
    );
  }
}

/**
 * Pure decision logic for the /json/version pre-evaluate check, unit-testable
 * without a live browser. Rejects only when `browser` matches a known
 * real-desktop-browser product string AND `userAgent` carries neither the
 * `Marshal/` nor `Electron/` marker (F-DEPLOY-2b: `browser` alone is
 * ambiguous — Electron reports a Chrome-shaped `browser` string too).
 * Anything else — a legitimate headless test browser's `browser` string, or a
 * `browser` match paired with a Marshal/Electron-marked `userAgent` — is
 * inconclusive here and falls through to the authoritative marker-probe
 * evaluate; this function never itself grants a pass.
 */
export function isKnownNonMarshalBrowserString(browser, userAgent) {
  if (typeof browser !== "string" || !KNOWN_NON_MARSHAL_BROWSER_PATTERN.test(browser)) {
    return false;
  }
  return !(typeof userAgent === "string" && MARSHAL_OR_ELECTRON_USER_AGENT_PATTERN.test(userAgent));
}

/**
 * Pure decision logic for target matching, unit-testable without a live
 * browser. No blind first-page/[0] fallback: a confident URL match or
 * nothing — `null` means "refuse", never "guess".
 * @param {Array<{url?: unknown}>} pageTargets
 * @returns {{url: string} | null}
 */
export function selectMarshalPageTarget(pageTargets) {
  const targets = Array.isArray(pageTargets) ? pageTargets : [];
  return (
    targets.find(
      (target) => typeof target?.url === "string" && target.url.includes(MARSHAL_APP_URL_MARKER),
    ) ??
    targets.find(
      (target) => typeof target?.url === "string" && target.url.includes(LEGACY_DIST_URL_MARKER),
    ) ??
    null
  );
}

/** Evaluates a static, hardcoded expression in the connected renderer and returns its JSON-serializable value. */
export async function evaluateInRenderer(client, expression) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    // Safe: `expression` is always one of this file's own static, hardcoded
    // snippets below — never derived from user input or external data.
    expression, // nosemgrep: javascript.chrome-remote-interface.security.audit.chrome-remote-interface-compilescript-injection.chrome-remote-interface-compilescript-injection
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(
      `CDP eval error: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
    );
  }
  return result.value;
}

async function verifyNotAKnownDesktopBrowser(port) {
  // Errors here (e.g. ECONNREFUSED because nothing is listening yet) are left
  // to propagate — the caller's retry loop treats them as "not up yet",
  // distinct from a confident "this is a real browser" refusal.
  const version = await CDP.Version({ port });
  if (isKnownNonMarshalBrowserString(version?.Browser, version?.["User-Agent"])) {
    throw new LiveConnectionRefusalError(
      "non-marshal-endpoint",
      `/json/version on port ${port} reported Browser=${JSON.stringify(version?.Browser)} with no ` +
        `Marshal/Electron marker in User-Agent=${JSON.stringify(version?.["User-Agent"])} — a real desktop ` +
        "browser signature — refusing to attach (this is the exact F-DEPLOY-2 scenario: an operator's " +
        "personal browser happened to be listening on the CDP port instead of Marshal).",
    );
  }
}

export async function connectToRunningMarshal(port) {
  assertExplicitPort(port);
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let lastError;
  // Sequential retry-with-backoff against a single port, not independent
  // work to parallelize — each attempt must see the previous attempt's
  // failure before waiting and retrying. A LiveConnectionRefusalError is a
  // confident, non-transient verdict and is never retried — it always
  // propagates immediately out of the loop.
  while (Date.now() < deadline) {
    let client;
    try {
      // eslint-disable-next-line no-await-in-loop
      await verifyNotAKnownDesktopBrowser(port);
      // eslint-disable-next-line no-await-in-loop
      const targets = await CDP.List({ port });
      const pageTargets = targets.filter(
        (target) => target.type === "page" && !target.url.includes("devtools://"),
      );
      const rendererTarget = selectMarshalPageTarget(pageTargets);
      if (!rendererTarget) {
        throw new LiveConnectionRefusalError(
          "no-marshal-page",
          `No page among ${pageTargets.length} on port ${port} confidently matched ` +
            `${MARSHAL_APP_URL_MARKER} or the legacy ${LEGACY_DIST_URL_MARKER} — refusing to guess which page ` +
            "is Marshal's renderer.",
        );
      }
      // eslint-disable-next-line no-await-in-loop
      client = await CDP({ port, target: rendererTarget });
      // The FIRST and only permissible evaluation before this connection is
      // handed back to the caller for its own work.
      // eslint-disable-next-line no-await-in-loop
      const isMarshalRenderer = await evaluateInRenderer(
        client,
        MARSHAL_RENDERER_MARKER_EXPRESSION,
      );
      if (!isMarshalRenderer) {
        // eslint-disable-next-line no-await-in-loop
        await client.close();
        throw new LiveConnectionRefusalError(
          "non-marshal-endpoint",
          `The matched page (${rendererTarget.url}) does not expose Marshal's preload globals ` +
            "(window.sessionsAPI/window.runtimeUiAPI) — refusing to attach.",
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([client.Runtime.enable(), client.Page.enable()]);
      return { client, target: rendererTarget };
    } catch (error) {
      if (error instanceof LiveConnectionRefusalError) throw error;
      lastError = error;
      // eslint-disable-next-line no-await-in-loop
      await sleep(CONNECT_RETRY_INTERVAL_MS);
    }
  }
  throw new Error(`Failed to connect to a running Marshal on port ${port}: ${lastError?.message}`);
}

/**
 * Playwright-backed connection for scripts that must reach INSIDE a
 * sandboxed cross-origin packaged-app iframe (drive-native-frame.mjs).
 * chrome-remote-interface's Runtime.evaluate runs in the top-level
 * renderer's own JS realm and cannot cross into a different-origin iframe's
 * document (the same restriction the app's own script has); Playwright's
 * `page.frameLocator()` dispatches through the browser's automation layer
 * instead of JS property access, the same technique proven in
 * ../native-frame/controlled-scenarios.browser.test.tsx.
 */
export async function connectPageOverCDP(port) {
  assertExplicitPort(port);
  await verifyNotAKnownDesktopBrowser(port);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());
  const matched = selectMarshalPageTarget(pages.map((candidate) => ({ url: candidate.url() })));
  const page = matched ? pages.find((candidate) => candidate.url() === matched.url) : undefined;
  if (!page) {
    await browser.close();
    throw new LiveConnectionRefusalError(
      "no-marshal-page",
      `No page among ${pages.length} on port ${port} confidently matched ${MARSHAL_APP_URL_MARKER} or the ` +
        `legacy ${LEGACY_DIST_URL_MARKER} — refusing to guess which page is Marshal's renderer.`,
    );
  }
  // The FIRST and only permissible evaluation before this page is handed back
  // to the caller for its own work.
  const isMarshalRenderer = await page.evaluate(MARSHAL_RENDERER_MARKER_EXPRESSION);
  if (!isMarshalRenderer) {
    await browser.close();
    throw new LiveConnectionRefusalError(
      "non-marshal-endpoint",
      `The matched page (${page.url()}) does not expose Marshal's preload globals ` +
        "(window.sessionsAPI/window.runtimeUiAPI) — refusing to attach.",
    );
  }
  return { browser, page };
}

/**
 * True only when the operator has explicitly opted into driving a live,
 * already-running Marshal instance. Every D4 script defaults to a "blocked"
 * receipt without this — the hard boundary in this facility's task ("no
 * restarts/builds of the live app") means this facility never sets it
 * itself; the parent flips it on when running against the live deployment.
 */
export function liveModeRequested() {
  return process.env.ACCEPTANCE_FACILITY_ALLOW_LIVE === "1";
}

/**
 * F-DEPLOY-2 repair (a): there is no default port. A live-mode run that
 * omits ACCEPTANCE_FACILITY_CDP_PORT is refused before any connection is
 * attempted, rather than silently falling back to whatever happened to be
 * listening on a hardcoded default (9222 — the operator's personal Chrome,
 * in the reproduced finding).
 */
export function liveModePort() {
  const raw = process.env.ACCEPTANCE_FACILITY_CDP_PORT?.trim();
  if (!raw) {
    throw new LiveConnectionRefusalError(
      "missing-explicit-cdp-port",
      "ACCEPTANCE_FACILITY_CDP_PORT must be set explicitly for live mode — there is no default port. " +
        "(F-DEPLOY-2: a silent default previously attached to whatever happened to be listening on 9222.)",
    );
  }
  const port = Number(raw);
  assertExplicitPort(port);
  return port;
}
