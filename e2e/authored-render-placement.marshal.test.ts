/**
 * ISOLATED browser E2E for authored-render placement (reserved owner
 * marshal.react-ui): real Electron app in an acceptance-enabled E2E build,
 * fresh temp userData/run root (never the live profile), no CDP port (a
 * Playwright pipe drives the app; the user's live app on 9333 has a
 * different userData directory, so its singleton lock is never contested).
 *
 * Flow: write real TSX into the scope workspace -> ui.compile -> ui.render
 * with a manifest declaring one safe read action (capability ui.renders.list)
 * -> ui.application.open on every surface -> inspect the nested iframe DOM ->
 * click the action and observe its runtime result -> update/focus/close ->
 * mid-script ui.notification.show. Evidence (screenshots + JSON) is written
 * to MARSHAL_PLACEMENT_EVIDENCE_DIR when set.
 *
 * Run:
 *   RUNROOT=/private/tmp/authored-placement-run; rm -rf $RUNROOT; mkdir -p $RUNROOT/temp
 *   TMPDIR=$RUNROOT/temp MARSHAL_PLACEMENT_RUN_ROOT=$RUNROOT \
 *     pnpm test:e2e:file e2e/authored-render-placement.marshal.test.ts
 * (TMPDIR must live inside the run root: the acceptance harness requires the
 *  E2E app-data dir to stay inside its run root.)
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { launchPersistentE2EApp, seedTestData } from "./marshal-fixtures";

const SCOPE = { sessionId: "e2e-fresh", workspaceName: "marshal" } as const;
const SURFACES = ["inline-card", "fullscreen", "tab", "panel"] as const;
const OWNER = "marshal.react-ui";

const RUN_ROOT = requireRunRoot();
const evidenceDir =
  process.env.MARSHAL_PLACEMENT_EVIDENCE_DIR?.trim() || path.join(RUN_ROOT, "placement-evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const evidence: Record<string, unknown>[] = [];

function requireRunRoot(): string {
  const runRoot = process.env.MARSHAL_PLACEMENT_RUN_ROOT?.trim();
  if (!runRoot || !path.isAbsolute(runRoot)) {
    throw new Error("MARSHAL_PLACEMENT_RUN_ROOT (absolute) is required.");
  }
  if (!os.tmpdir().startsWith(runRoot)) {
    throw new Error(
      `TMPDIR must live inside the run root (tmpdir=${os.tmpdir()}, runRoot=${runRoot}).`,
    );
  }
  return runRoot;
}

function record(step: string, detail: unknown): void {
  evidence.push({ step, at: new Date().toISOString(), detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Walk a path of keys through unknown JSON, returning unknown. */
function pick(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface AcceptanceInvoke {
  capability: string;
  input: unknown;
  idempotencyKey: string;
  sessionId: string;
  workspaceName: string;
}

async function invoke(page: Page, request: AcceptanceInvoke): Promise<unknown> {
  return page.evaluate(async (req) => {
    const holder: unknown = Reflect.get(window, "runtimeAcceptanceAPI");
    if (typeof holder !== "object" || holder === null) {
      throw new Error("runtimeAcceptanceAPI unavailable — acceptance build/env missing");
    }
    const operation: unknown = Reflect.get(holder, "invoke");
    if (typeof operation !== "function") {
      throw new Error("runtimeAcceptanceAPI.invoke unavailable");
    }
    const value: unknown = await Reflect.apply(operation, holder, [req]);
    return value;
  }, request);
}

async function acceptancePaths(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const holder: unknown = Reflect.get(window, "runtimeAcceptanceAPI");
    if (typeof holder !== "object" || holder === null) {
      throw new Error("runtimeAcceptanceAPI unavailable — acceptance build/env missing");
    }
    const operation: unknown = Reflect.get(holder, "getPaths");
    if (typeof operation !== "function") {
      throw new Error("runtimeAcceptanceAPI.getPaths unavailable");
    }
    const value: unknown = await Reflect.apply(operation, holder, []);
    return value;
  });
}

/** Unwrap {success, value:{ok, error, value}} envelopes, throwing on failure. */
function unwrap(result: unknown, label: string): unknown {
  if (pick(result, "success") === false) {
    throw new Error(`${label} bridge failed: ${JSON.stringify(pick(result, "error"))}`);
  }
  const inner = pick(result, "value") ?? result;
  if (pick(inner, "ok") === false) {
    throw new Error(`${label} failed: ${JSON.stringify(pick(inner, "error"))}`);
  }
  return pick(inner, "value") ?? inner;
}

/**
 * Explicit isolated test-profile approvals for the portable-ui policy buckets
 * (the product's own per-tool grant surface; never allow-all mode). Returns
 * the patched settings file path.
 */
function applyTestProfileGrants(): string {
  const settingsFile = path.join(E2E_DATA_DIR, "marshal-settings.json");
  const settings: unknown = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  if (!isRecord(settings)) throw new Error("Seeded settings are not an object.");
  const permissions = isRecord(settings.permissions) ? settings.permissions : {};
  const tools = isRecord(permissions.tools) ? permissions.tools : {};
  settings.permissions = {
    ...permissions,
    tools: {
      ...tools,
      "tool:runtime-portable-ui:trusted_ui": true,
      "tool:runtime-portable-ui:ui.render": true,
      "tool:runtime-portable-ui:ui.renders.get": true,
      "tool:runtime-portable-ui:ui.renders.list": true,
      "tool:runtime-portable-ui:ui.components.get": true,
      "tool:runtime-portable-ui:ui.components.list": true,
      "tool:runtime-portable-ui:ui.applications.list": true,
    },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  return settingsFile;
}

/** Per-frame message/error capture installed by the page init script. */
async function collectFrameDiagnostics(page: Page): Promise<Record<string, readonly string[]>> {
  const messagesByFrame: Record<string, readonly string[]> = {};
  for (const [index, frame] of page.frames().entries()) {
    // eslint-disable-next-line no-await-in-loop -- frames are sampled sequentially so the capture stays ordered
    messagesByFrame[`frame-${index}:${frame.url().slice(0, 40)}`] = await frame
      .evaluate(() => {
        const raw: unknown = Reflect.get(window, "__diagMessages");
        const messages = Array.isArray(raw) ? raw.map(String) : [];
        return [`BODY: ${document.body?.innerHTML.slice(0, 500) ?? "<none>"}`, ...messages];
      })
      .catch((frameError: unknown) => [`evaluate failed: ${String(frameError)}`]);
  }
  return messagesByFrame;
}

/**
 * The srcdoc component frame belonging to the largest on-screen surface (the
 * fullscreen dialog), so the action's effect lands in the evidence screenshot
 * — visibility alone cannot detect occlusion between the four surfaces.
 */
async function findComponentFrame(page: Page): Promise<ReturnType<Page["frames"]>[number]> {
  let componentFrame;
  let bestArea = -1;
  for (const frame of page.frames()) {
    if (frame.url() !== "about:srcdoc") continue;
    // eslint-disable-next-line no-await-in-loop -- frames are inspected sequentially until the component frame is found
    const count = await frame.locator('[data-testid="refresh"]').count();
    if (count === 0) continue;
    // eslint-disable-next-line no-await-in-loop -- surface geometry is measured per candidate frame in order
    const surfaceElement = await frame.parentFrame()?.frameElement();
    // eslint-disable-next-line no-await-in-loop -- surface geometry is measured per candidate frame in order
    const box = surfaceElement ? await surfaceElement.boundingBox() : null;
    const area = box ? box.width * box.height : 0;
    if (area > bestArea) {
      bestArea = area;
      componentFrame = frame;
    }
  }
  if (!componentFrame) throw new Error("No component frame exposes the refresh control.");
  return componentFrame;
}

type PlacementFrame = ReturnType<Page["frames"]>[number];

/** Waits for the top-layer app container, recording chrome diagnostics on timeout. */
async function pollForModal(
  modalState: () => Promise<{ readonly active: boolean }>,
  templateFrame: PlacementFrame,
): Promise<void> {
  try {
    await expect.poll(async () => (await modalState()).active, { timeout: 10_000 }).toBe(true);
  } catch (pollError) {
    const chromeStatus = await templateFrame
      .locator("#chrome-status")
      .first()
      .textContent({ timeout: 2_000 })
      .catch(() => null);
    record("fullscreen-enter-diagnostics", { chromeStatus });
    throw pollError;
  }
}

/**
 * Presses Escape while focus sits inside the child iframe and records the
 * ACTUAL outcome; falls back to the host Exit control when the nested
 * browsing context consumes the key. Asserts the modal is gone either way.
 */
async function exitFullscreenRecordingEscapeBehavior(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const escapeFromChildExited = await page
    .waitForFunction(
      () =>
        ![...document.querySelectorAll('[data-testid="runtime-ui-app-container"]')].some(
          (element) => element.matches(":modal"),
        ),
      undefined,
      { timeout: 3_000 },
    )
    .then(() => true)
    .catch(() => false);
  record("fullscreen-escape-from-child", { exited: escapeFromChildExited });
  // The sandbox bootstrap now relays Escape from nested documents; this is a
  // hard product requirement, not a best-effort fallback.
  expect(escapeFromChildExited, "Escape exits fullscreen from the child iframe").toBe(true);
  record("fullscreen-exit", { via: "Escape while child iframe focused (sandbox relay)" });
}

function requireComponentChild(templateFrame: PlacementFrame): PlacementFrame {
  const child = templateFrame.childFrames().find((frame) => frame.url() === "about:srcdoc");
  if (!child) throw new Error("Panel template has no component child frame.");
  return child;
}

/** The unique renderer-template frame when exactly one instance is open. */
async function findSoleTemplateFrame(page: Page): Promise<PlacementFrame> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const chromeFrames: PlacementFrame[] = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      // eslint-disable-next-line no-await-in-loop -- frames are counted sequentially per retry pass
      const count = await frame
        .locator("#chrome")
        .count()
        .catch(() => 0);
      if (count > 0) chromeFrames.push(frame);
    }
    if (chromeFrames.length === 1) return chromeFrames[0];
    if (Date.now() > deadline) {
      throw new Error(`Expected exactly one template frame, found ${chromeFrames.length}.`);
    }
    // eslint-disable-next-line no-await-in-loop -- bounded retry until the fresh instance renders
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  }
}

/** Decoded marshal-runtime meta from the component document (identity proof). */
async function componentRuntimeMeta(componentFrame: PlacementFrame): Promise<unknown> {
  return componentFrame.evaluate(() => {
    const encoded =
      document.querySelector('meta[name="marshal-runtime"]')?.getAttribute("content") ?? "";
    if (!encoded) return null;
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  });
}

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test("authored render places, acts, updates, focuses, and closes on real surfaces", async () => {
  const token = randomBytes(16).toString("hex");
  seedTestData();
  const settingsFile = applyTestProfileGrants();
  record("test-profile-grants", { settingsFile });
  const app = await launchPersistentE2EApp({
    userDataDir: path.join(RUN_ROOT, "user-data"),
    seed: false,
    extraEnv: {
      MARSHAL_RUNTIME_ACCEPTANCE: "1",
      MARSHAL_RUNTIME_ACCEPTANCE_TOKEN: token,
      MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT: RUN_ROOT,
    },
  });
  const consoleLog: string[] = [];
  try {
    const page = await app.firstWindow();
    await page.addInitScript(() => {
      const sink: string[] = [];
      Reflect.set(window, "__diagMessages", sink);
      window.addEventListener("message", (event) => {
        try {
          if (sink.length < 400) sink.push(JSON.stringify(event.data).slice(0, 400));
        } catch {
          sink.push("<unserializable>");
        }
      });
      window.addEventListener("error", (event) => {
        sink.push(`ERROR: ${event.message} @${event.filename}:${event.lineno}`);
      });
      window.addEventListener("unhandledrejection", (event) => {
        sink.push(`REJECTION: ${String(event.reason).slice(0, 300)}`);
      });
      document.addEventListener("securitypolicyviolation", (event) => {
        sink.push(
          `CSP: ${event.violatedDirective} blocked ${event.blockedURI} line=${event.lineNumber} policy=${event.originalPolicy.slice(0, 200)}`,
        );
      });
    });
    page.on("console", (message) => {
      if (consoleLog.length < 200)
        consoleLog.push(`${message.type()}: ${message.text().slice(0, 300)}`);
    });
    await page.waitForLoadState("domcontentloaded");

    const paths = await acceptancePaths(page);
    const workspaceRoot = asText(pick(paths, "value", "workspaceRoot"));
    expect(workspaceRoot, `workspaceRoot from acceptance paths: ${JSON.stringify(paths)}`).not.toBe(
      "",
    );
    const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
    fs.writeFileSync(
      path.join(workspaceRoot, "authored-status-panel.tsx"),
      fs.readFileSync(path.join(fixturesDir, "authored-status-panel.tsx"), "utf8"),
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "echo-action-module.ts"),
      fs.readFileSync(path.join(fixturesDir, "echo-action-module.ts"), "utf8"),
    );
    record("workspace-fixture", { workspaceRoot });

    const compiledRaw = await invoke(page, {
      ...SCOPE,
      capability: "ui.compile",
      input: { entryPath: "authored-status-panel.tsx", title: "Authored placement panel" },
      idempotencyKey: "e2e-compile-1",
    });
    record("ui.compile-raw", JSON.parse(JSON.stringify(compiledRaw)));
    const compiled = unwrap(compiledRaw, "ui.compile");
    const componentId = asText(pick(compiled, "output", "component", "id"));
    expect(componentId, "compiled component id").not.toBe("");
    record("ui.compile", { componentId });

    const manifest = {
      version: "1.0.0",
      presentationModes: ["inline", "fullscreen"],
      actions: [
        {
          id: "list-renders",
          version: "1.0.0",
          title: "List renders",
          target: { kind: "capability", capability: "ui.renders.list" },
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          allowedScopes: ["session"],
          requiredPermissions: [],
          risk: "read",
          idempotency: "supported",
        },
        {
          id: "echo-input",
          version: "1.0.0",
          title: "Echo action input",
          target: {
            kind: "module",
            module: { kind: "workspace_file", path: "echo-action-module.ts" },
          },
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["agentId"],
            properties: { agentId: { type: "string" }, seed: { type: "number" } },
          },
          outputSchema: { type: "object", additionalProperties: true },
          allowedScopes: ["session"],
          requiredPermissions: [],
          risk: "read",
          idempotency: "supported",
        },
      ],
      tools: [],
    };
    const rendered = unwrap(
      await invoke(page, {
        ...SCOPE,
        capability: "ui.render",
        input: {
          componentId,
          props: { label: "hello-from-e2e" },
          fallback: { summary: "Authored placement panel" },
          application: manifest,
        },
        idempotencyKey: "e2e-render-1",
      }),
      "ui.render",
    );
    const renderId = asText(pick(rendered, "output", "render", "id"));
    expect(renderId, "render id").toMatch(/^[a-f0-9]{64}$/);
    record("ui.render", { renderId });

    const listed = unwrap(
      await invoke(page, {
        ...SCOPE,
        capability: "ui.applications.list",
        input: {},
        idempotencyKey: "e2e-projection-1",
      }),
      "ui.applications.list",
    );
    const applications = pick(listed, "output", "applications");
    const projected = (Array.isArray(applications) ? applications : []).find(
      (entry) => pick(entry, "id") === renderId,
    );
    expect(asText(pick(projected, "ownerId"))).toBe(OWNER);
    record("projection", projected ?? null);

    const instances: Record<string, string> = {};
    for (const surface of SURFACES) {
      // eslint-disable-next-line no-await-in-loop -- surfaces must open sequentially so screenshots and instance evidence stay deterministic
      const openedRaw = await invoke(page, {
        ...SCOPE,
        capability: "ui.application.open",
        input: {
          extensionId: OWNER,
          applicationId: renderId,
          surface,
          state: { origin: "e2e" },
          idempotencyKey: `e2e-open-${surface}`,
        },
        idempotencyKey: `e2e-open-${surface}`,
      });
      const opened = unwrap(openedRaw, `ui.application.open ${surface}`);
      const instanceId = asText(
        pick(opened, "output", "value", "instance", "instanceId") ||
          pick(opened, "output", "instance", "instanceId"),
      );
      expect(instanceId, `instance for ${surface}`).not.toBe("");
      instances[surface] = instanceId;
      record(`open:${surface}`, { instanceId });
    }
    await page.screenshot({ path: path.join(evidenceDir, "01-opened-surfaces.png") });

    const outerFrame = page.frameLocator('iframe[sandbox="allow-scripts"] >> visible=true').first();
    const innerFrame = outerFrame.frameLocator("iframe");
    try {
      await expect(innerFrame.locator('[data-testid="label"]').first()).toHaveText(
        "hello-from-e2e",
        { timeout: 60_000 },
      );
    } catch (assertionError) {
      const statusText = await outerFrame
        .locator("#status")
        .first()
        .textContent({ timeout: 2_000 })
        .catch((statusError: unknown) => `status unavailable: ${String(statusError)}`);
      record("iframe-dom-diagnostics", {
        statusText,
        consoleLog,
        messagesByFrame: await collectFrameDiagnostics(page),
      });
      throw assertionError;
    }
    record("iframe-dom", { label: "hello-from-e2e" });
    await page.screenshot({ path: path.join(evidenceDir, "02-component-rendered.png") });

    // Overlapping surfaces plus the template's continuous size reporting keep
    // Playwright's actionability checks from settling; the product path under
    // test is the declared-action dispatch, so click the control in-DOM.
    const componentFrame = await findComponentFrame(page);
    await componentFrame
      .locator('[data-testid="refresh"]')
      .first()
      .evaluate((element) => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    await expect(componentFrame.locator('[data-testid="result"]').first()).toHaveText(
      /renders:\d+/,
      { timeout: 60_000 },
    );
    const actionResult = await componentFrame
      .locator('[data-testid="result"]')
      .first()
      .textContent();
    record("action-result", { actionResult });
    await page.screenshot({ path: path.join(evidenceDir, "03-action-result.png") });

    // Module-target action: prove input object fidelity and the exact wire
    // envelope (UiActionResult, single layer) at the real click boundary.
    await componentFrame
      .locator('[data-testid="echo"]')
      .first()
      .evaluate((element) => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    await expect(componentFrame.locator('[data-testid="echo-result"]').first()).toHaveText(
      /^echo\|single\|object\|e2e-agent\|raw:/,
      { timeout: 60_000 },
    );
    const echoResult = await componentFrame
      .locator('[data-testid="echo-result"]')
      .first()
      .textContent();
    record("module-echo-wire-shape", { echoResult });

    // Entropy liveness probe: two samples inside the sandboxed component frame
    // must differ (refutes the "sandbox freezes Date.now/Math.random" claim).
    const sampleEntropy = async () => {
      await componentFrame
        .locator('[data-testid="entropy"]')
        .first()
        .evaluate((element) => {
          element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
      await expect(componentFrame.locator('[data-testid="entropy-result"]').first()).toHaveText(
        /^entropy\|\d+\|0\./,
        { timeout: 10_000 },
      );
      return componentFrame.locator('[data-testid="entropy-result"]').first().textContent();
    };
    const firstEntropy = await sampleEntropy();
    // Math.random alone guarantees distinct samples; no wall-clock wait needed.
    const secondEntropy = await sampleEntropy();
    expect(secondEntropy, "entropy must advance between clicks").not.toBe(firstEntropy);
    record("entropy-probe", { firstEntropy, secondEntropy });

    // Fullscreen end-to-end on ONE isolated instance: close every other
    // surface first so the panel instance is unambiguous — its own template,
    // its own component, its own state. Real Playwright click on the template
    // chrome control (actionable once the native dialog is gone), wire-level
    // capture of the ui/request-display-mode round trip, state proven on the
    // SAME component before/inside/after, and an honest Escape-from-child
    // measurement.
    for (const surface of SURFACES) {
      // eslint-disable-next-line no-await-in-loop -- closes are sequential lifecycle operations
      const closedRaw = await invoke(page, {
        ...SCOPE,
        capability: "ui.application.close",
        input: {
          extensionId: OWNER,
          applicationId: renderId,
          instanceId: instances[surface],
          idempotencyKey: `e2e-isolate-close-${surface}`,
        },
        idempotencyKey: `e2e-isolate-close-${surface}`,
      });
      unwrap(closedRaw, `isolate close ${surface}`);
    }
    // Close semantics receipt: after four instance-scoped closes, nothing is
    // open for this application (controller.close targets requireOwnedInstance,
    // never the whole application — asserted here with the public list).
    const afterCloses = unwrap(
      await invoke(page, {
        ...SCOPE,
        capability: "ui.application.list",
        input: { extensionId: OWNER, applicationId: renderId },
        idempotencyKey: "e2e-list-after-closes",
      }),
      "ui.application.list after closes",
    );
    const openInstances = pick(afterCloses, "output", "value", "instances");
    record("close-semantics", {
      remaining: Array.isArray(openInstances) ? openInstances.length : String(openInstances),
    });
    expect(Array.isArray(openInstances) ? openInstances.length : -1, "all instances closed").toBe(
      0,
    );
    // One freshly opened, unambiguous instance for the fullscreen case — no
    // overlapping surfaces, no dependence on sibling-close semantics.
    const probeOpened = unwrap(
      await invoke(page, {
        ...SCOPE,
        capability: "ui.application.open",
        input: {
          extensionId: OWNER,
          applicationId: renderId,
          surface: "panel",
          state: { origin: "e2e-fullscreen-probe" },
          idempotencyKey: "e2e-open-fullscreen-probe",
        },
        idempotencyKey: "e2e-open-fullscreen-probe",
      }),
      "ui.application.open fullscreen-probe",
    );
    const probeInstanceId = asText(
      pick(probeOpened, "output", "value", "instance", "instanceId") ||
        pick(probeOpened, "output", "instance", "instanceId"),
    );
    expect(probeInstanceId, "fullscreen probe instance").not.toBe("");
    // Exactly one instance is open, so exactly one template (chrome) frame
    // exists; identity is asserted below from the component's own
    // marshal-runtime meta (renderId), not from DOM ancestor attribution.
    const panelTemplate = await findSoleTemplateFrame(page);
    record("template-ancestor-chain", {
      chain: await panelTemplate.frameElement().then((element) =>
        element.evaluate((node) => {
          const chain: string[] = [];
          let current: Element | null = node instanceof Element ? node : null;
          for (let depth = 0; current && depth < 14; depth += 1) {
            chain.push(
              `${current.tagName.toLowerCase()}${
                current.getAttribute("data-testid")
                  ? `[${current.getAttribute("data-testid")}]`
                  : ""
              }${
                current.getAttribute("data-runtime-ui-surface")
                  ? `{surface=${current.getAttribute("data-runtime-ui-surface")}}`
                  : ""
              }`,
            );
            const root: Node = current.getRootNode();
            current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
          }
          return chain;
        }),
      ),
    });
    const panelComponent = requireComponentChild(panelTemplate);
    const runtimeMeta = await componentRuntimeMeta(panelComponent);
    record("fullscreen-frame-identity", { runtimeMeta });
    expect(pick(runtimeMeta, "renderId"), "component frame belongs to our render").toBe(renderId);
    const panelResult = panelComponent.locator('[data-testid="result"]').first();
    await panelComponent.locator('[data-testid="refresh"]').first().click();
    await expect(panelResult).toHaveText(/renders:\d+/, { timeout: 60_000 });
    const stateBefore = await panelResult.textContent();
    record("fullscreen-instance", {
      instanceId: probeInstanceId,
      renderId,
      stateBefore,
    });
    const modalState = () =>
      page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('[data-testid="runtime-ui-app-container"]')];
        const modal = dialogs.find((element) => element.matches(":modal"));
        const rect = modal?.getBoundingClientRect();
        return {
          active: modal !== undefined,
          width: rect?.width ?? 0,
          height: rect?.height ?? 0,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          background: modal ? getComputedStyle(modal).backgroundColor : "",
          backgroundAlpha: (() => {
            if (!modal) return -1;
            const value = getComputedStyle(modal).backgroundColor;
            const slash = /\/\s*([\d.]+)\s*\)\s*$/.exec(value);
            if (slash) return Number(slash[1]);
            const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(value);
            if (rgba) return Number(rgba[1]);
            return 1;
          })(),
        };
      });
    // host-11 template chrome: no idle status line, and the declared
    // Fullscreen control is present while NOT current.
    await expect(panelTemplate.locator('[data-chrome-key="fullscreen"]').first()).toBeVisible({
      timeout: 30_000,
    });
    const idleStatus = await panelTemplate.locator("#chrome-status").first().textContent();
    expect(idleStatus?.trim() ?? "", "no idle chrome status").toBe("");
    // The host never shows attachment chrome for apps that do not declare
    // wantsImages (this manifest does not).
    await expect(page.getByRole("button", { name: "Attach images" })).toHaveCount(0);
    await panelTemplate.locator('[data-chrome-key="fullscreen"]').first().click();
    await pollForModal(modalState, panelTemplate);
    const displayModeTraffic = await panelTemplate.evaluate(() => {
      const raw: unknown = Reflect.get(window, "__diagMessages");
      const messages = Array.isArray(raw) ? raw.map(String) : [];
      return messages.filter((entry) => entry.includes("marshal-react-chrome-mode"));
    });
    // Regression guard for the queued-close race: a close event from the
    // pre-promotion transition must not tear down the just-promoted modal.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
    const fullscreenState = await modalState();
    expect(fullscreenState.active, "modal survives the promotion transition").toBe(true);
    record("fullscreen-enter", { ...fullscreenState, displayModeTraffic });
    await page.screenshot({ path: path.join(evidenceDir, "05-fullscreen.png") });
    expect(fullscreenState.width, "top layer spans viewport width").toBe(
      fullscreenState.viewportWidth,
    );
    expect(fullscreenState.height, "top layer spans viewport height").toBe(
      fullscreenState.viewportHeight,
    );
    expect(fullscreenState.backgroundAlpha, "top layer background alpha").toBe(1);
    // Same-instance state survived the top-layer promotion (no remount).
    await expect(panelResult).toHaveText(stateBefore ?? "");
    // Still interactive INSIDE fullscreen: entropy click changes its output.
    await panelComponent.locator('[data-testid="entropy"]').first().click();
    await expect(panelComponent.locator('[data-testid="entropy-result"]').first()).toHaveText(
      /^entropy\|\d+\|0\./,
      { timeout: 10_000 },
    );
    // host-11: the current display mode's control is filtered from the chrome,
    // so no duplicate Fullscreen button remains inside fullscreen.
    await expect
      .poll(async () => panelTemplate.locator('[data-chrome-key="fullscreen"]:visible').count(), {
        timeout: 10_000,
      })
      .toBe(0);
    record("template-chrome-in-fullscreen", {
      fullscreenButtons: await panelTemplate
        .locator('[data-chrome-key="fullscreen"]:visible')
        .count(),
    });
    await page.screenshot({ path: path.join(evidenceDir, "05b-fullscreen-interactive.png") });
    // Put focus INSIDE the child document before pressing Escape.
    await panelComponent.locator('[data-testid="entropy"]').first().click();
    // Escape with focus inside the child iframe: record the ACTUAL outcome —
    // the key may be consumed by the nested browsing context.
    await exitFullscreenRecordingEscapeBehavior(page);
    // Same-instance state also survived the exit path.
    await expect(panelResult).toHaveText(stateBefore ?? "");
    await page.screenshot({ path: path.join(evidenceDir, "06-after-fullscreen-exit.png") });

    const notified = await invoke(page, {
      ...SCOPE,
      capability: "ui.notification.show",
      input: {
        extensionId: OWNER,
        applicationId: renderId,
        title: "Authored placement E2E",
        message: "Mid-script notification from the placement test.",
        idempotencyKey: "e2e-notify-1",
      },
      idempotencyKey: "e2e-notify-1",
    });
    record("notification", JSON.parse(JSON.stringify(notified)));

    const teardown = [
      { capability: "ui.application.update", extra: { state: { origin: "e2e-updated" } } },
      { capability: "ui.application.focus", extra: {} },
      { capability: "ui.application.close", extra: {} },
    ] as const;
    for (const step of teardown) {
      // eslint-disable-next-line no-await-in-loop -- update/focus/close are order-dependent lifecycle operations on one instance
      const stepRaw = await invoke(page, {
        ...SCOPE,
        capability: step.capability,
        input: {
          extensionId: OWNER,
          applicationId: renderId,
          instanceId: probeInstanceId,
          ...step.extra,
          idempotencyKey: `e2e-${step.capability}`,
        },
        idempotencyKey: `e2e-${step.capability}`,
      });
      const result = unwrap(stepRaw, step.capability);
      record(step.capability, pick(result, "output") ?? null);
    }
    await page.screenshot({ path: path.join(evidenceDir, "04-after-close.png") });

    // Clean inline-card capture: one fresh card, friendly title chrome only.
    const inlineOpened = unwrap(
      await invoke(page, {
        ...SCOPE,
        capability: "ui.chat.card.show",
        input: {
          extensionId: OWNER,
          applicationId: renderId,
          idempotencyKey: "e2e-inline-shot",
        },
        idempotencyKey: "e2e-inline-shot",
      }),
      "ui.chat.card.show inline shot",
    );
    record("inline-card", { receipt: pick(inlineOpened, "output", "value", "receipt") ?? null });
    await expect(page.getByText("Authored placement panel").first()).toBeVisible({
      timeout: 30_000,
    });
    // Capture only after the application actually rendered — the header alone
    // proves the title, not the absence of controls around live content.
    const inlineTemplate = await findSoleTemplateFrame(page);
    const inlineComponent = requireComponentChild(inlineTemplate);
    await expect(inlineComponent.locator('[data-testid="label"]').first()).toHaveText(
      "hello-from-e2e",
      { timeout: 60_000 },
    );
    await page.screenshot({ path: path.join(evidenceDir, "07-inline-card.png") });
  } finally {
    fs.writeFileSync(
      path.join(evidenceDir, "evidence.json"),
      JSON.stringify({ evidence }, null, 2),
    );
    await app.close();
  }
});
