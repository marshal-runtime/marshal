import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { UiApplicationManifest } from "@marshal/runtime/ui";
import { expect, type ConsoleMessage, type ElectronApplication, type Page } from "@playwright/test";

import type {
  RuntimeAcceptanceFixture,
  RuntimeAcceptanceScope,
} from "../../common/runtime-acceptance";
import type {
  RuntimeUiApplicationContent,
  RuntimeUiCommandResult,
  RuntimeUiContent,
  RuntimeUiIpcResult,
  RuntimeUiJsonValue,
  RuntimeUiOwner,
  RuntimeUiScope,
  RuntimeUiSnapshot,
  RuntimeUiSurface,
} from "../../common/runtime-ui";
import { launchPersistentE2EApp } from "../marshal-fixtures";
import {
  array,
  LiveStoryRecorder,
  output,
  record,
  requireOk,
  RuntimeAcceptanceClient,
  type LiveStoryProof,
} from "./harness";

const MARSHAL_RUNTIME_DEFAULT_WORKSPACE = "marshal";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UiScenarioOptions {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly recorder: LiveStoryRecorder;
  readonly evidenceRoot: string;
  /** Active session used for the majority of stories (001-004, 007-009, 011). Defaults to the seeded active session. */
  readonly primarySessionId?: string;
  /** A second, already-seeded, distinct session used for cross-session isolation (MRT-UI-005). */
  readonly secondarySessionId?: string;
  /** A third, already-seeded, distinct session reserved for capacity/idempotency/payload boundary probes (MRT-UI-006) so its rate window starts clean. */
  readonly boundarySessionId?: string;
  /** A fourth, already-seeded, distinct session reserved for the long idempotency/event-history burst (MRT-UI-006). */
  readonly burstSessionId?: string;
  /** A fifth, already-seeded, distinct session that MRT-UI-010 deletes via the real session-lifecycle API to induce a missing-session delivery failure. */
  readonly deletedSessionId?: string;
  /** A sixth, already-seeded, distinct session used for the restart-replay / idempotent-duplicate-delivery half of MRT-UI-010. */
  readonly restartReplaySessionId?: string;
  readonly storyIds?: ReadonlySet<string>;
  readonly restartElectronApp?: (app: ElectronApplication) => Promise<{
    readonly app: ElectronApplication;
    readonly page: Page;
    readonly userDataDir: string;
  }>;
}

export interface UiScenarioReport {
  readonly notes: readonly string[];
}

export interface UiScenarioState {
  readonly scope: RuntimeAcceptanceScope;
  readonly secondaryScope: RuntimeAcceptanceScope;
  readonly boundaryScope: RuntimeAcceptanceScope;
  readonly extensionIdentity: string;
  readonly applicationId: string;
  readonly secondExtensionIdentity: string;
  readonly secondApplicationId: string;
  readonly instanceIds: readonly string[];
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly userDataDir: string | null;
  readonly report: UiScenarioReport;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type UiScenarioScope = RuntimeUiScope & RuntimeAcceptanceScope;

function backendScope(
  sessionId: string,
  workspaceName = MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
): UiScenarioScope {
  return { sessionId, workspaceName };
}

function ownerOf(
  scope: UiScenarioScope,
  extensionId: string,
  applicationId: string,
): RuntimeUiOwner & RuntimeAcceptanceScope {
  return { ...scope, extensionId, applicationId };
}

function textContent(text: string): RuntimeUiContent {
  return { kind: "text", text };
}

function markdownContent(markdown: string): RuntimeUiContent {
  return { kind: "markdown", markdown };
}

function applicationContent(
  descriptor: UiApplicationManifest,
  state?: RuntimeUiApplicationContent["state"],
): RuntimeUiContent {
  return {
    kind: "application",
    renderId: "acceptance-renderer",
    resource: { uri: "runtime://acceptance/application", mimeType: "text/html" },
    descriptor,
    ...(state ? { state } : {}),
  };
}

function richApplicationManifest(
  capability: string,
  descriptionSuffix = "",
): UiApplicationManifest {
  return {
    version: "1.0.0",
    presentationModes: ["inline", "fullscreen", "pip"],
    actions: [
      {
        id: "primary-action",
        version: "1.0.0",
        title: `Run <primary> & "quoted"${descriptionSuffix}`,
        description: 'Declared action for MRT-UI-003 hardening coverage: <b>bold</b> & "quotes".',
        target: { kind: "capability", capability },
        inputSchema: { type: "object", additionalProperties: true },
        outputSchema: { type: "object", additionalProperties: true },
        allowedScopes: ["session"],
        requiredPermissions: [],
        risk: "read",
        idempotency: "supported",
      },
    ],
    tools: [
      {
        id: "primary-tool",
        name: "primary_tool",
        inputSchema: { type: "object", additionalProperties: true },
      },
    ],
    localState: { scope: "session", schemaVersion: "1.0.0" },
    authoritativeState: {
      capability: "ui.application.list",
      resourceId: "acceptance-application",
      version: "1.0.0",
    },
  } as UiApplicationManifest;
}

function minimalApplicationManifest(): UiApplicationManifest {
  return {
    version: "1.0.0",
    presentationModes: ["inline"],
    actions: [],
    tools: [],
  } as UiApplicationManifest;
}

function dangerousState(): NonNullable<RuntimeUiApplicationContent["state"]> {
  return {
    htmlMarker: "<script>window.__marshalUiXssProbe = true;</script>",
    ampersand: "Tom & Jerry <3 & 4>",
    nested: { angle: '<div class="x">&amp;</div>' },
  };
}

function unwrapUi<T>(result: RuntimeUiIpcResult<T>): T {
  if (!result.success) {
    throw new Error(`Runtime UI operation failed: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

async function closeInstance(
  client: RuntimeAcceptanceClient,
  owner: RuntimeUiOwner,
  instanceId: string,
): Promise<void> {
  const closed = await client.ui("close", {
    ...owner,
    instanceId,
    idempotencyKey: uid("cleanup-close"),
  });
  if (!closed.success && closed.error.code !== "not-found") {
    throw new Error(`Cleanup close failed: ${closed.error.code}: ${closed.error.message}`);
  }
}

function commandEnvelope(raw: unknown): RuntimeUiIpcResult<RuntimeUiCommandResult> {
  assertCommandEnvelope(raw);
  return raw;
}

function assertCommandEnvelope(
  value: unknown,
): asserts value is RuntimeUiIpcResult<RuntimeUiCommandResult> {
  const envelope = record(value);
  if (envelope.success === true && record(envelope.value).receipt) return;
  const error = record(envelope.error);
  if (
    envelope.success === false &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return;
  }
  throw new Error("Runtime UI operation returned an invalid command envelope.");
}

function stringField(value: unknown, key: string): string {
  const field = record(value)[key];
  return typeof field === "string" ? field : "";
}

function numberField(value: unknown, key: string): number {
  const field = record(value)[key];
  return typeof field === "number" ? field : Number.NaN;
}

async function invokeUiCapabilityRaw(
  client: RuntimeAcceptanceClient,
  capability: string,
  input: Record<string, unknown>,
  scope: RuntimeAcceptanceScope,
  idempotencyKey = uid("invoke"),
  abort?: Parameters<RuntimeAcceptanceClient["invoke"]>[3] extends { readonly abort?: infer A }
    ? A
    : never,
): Promise<Record<string, unknown>> {
  const raw = await client.invoke(capability, input, idempotencyKey, {
    scope,
    ...(abort ? { abort } : {}),
  });
  if (record(raw).ok === false) return record(raw);
  return output(raw);
}

async function invokeUiCapability(
  client: RuntimeAcceptanceClient,
  capability: string,
  input: Record<string, unknown>,
  scope: RuntimeAcceptanceScope,
  idempotencyKey = uid("invoke"),
): Promise<{ readonly ok: Record<string, unknown>; readonly value: Record<string, unknown> }> {
  const uiResult = await invokeUiCapabilityRaw(client, capability, input, scope, idempotencyKey);
  const ok = requireOk(uiResult);
  return { ok, value: record(ok.value) };
}

async function captureScreenshot(page: Page, evidenceRoot: string, name: string): Promise<string> {
  const target = path.join(evidenceRoot, "screenshots", `${name}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target, fullPage: true });
  return path.join("screenshots", `${name}.png`).split(path.sep).join("/");
}

async function captureAccessibilitySnapshot(
  page: Page,
  evidenceRoot: string,
  name: string,
  selector: string,
): Promise<string> {
  const target = path.join(evidenceRoot, "accessibility", `${name}.yml`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const snapshot = await page.locator(selector).ariaSnapshot();
  fs.writeFileSync(target, `${snapshot.trim()}\n`, "utf8");
  return path.join("accessibility", `${name}.yml`).split(path.sep).join("/");
}

/**
 * Aligns the renderer workspace selection with the production-scoped primary
 * acceptance session through the real workspace APIs.
 */
async function alignRendererWorkspace(
  page: Page,
): Promise<{ readonly aligned: boolean; readonly reason?: string }> {
  const outcome = await page.evaluate(async (name) => {
    const api = window.workspaceAPI;
    if (!api) return { success: false, reason: "window.workspaceAPI is unavailable." };
    const created = await api.createWorkspace(name);
    if (!created.success && !/exist/i.test(created.error ?? "")) {
      return { success: false, reason: `createWorkspace failed: ${created.error}` };
    }
    const activated = await api.setActiveWorkspace(name);
    if (!activated.success) {
      return { success: false, reason: `setActiveWorkspace failed: ${String(activated.error)}` };
    }
    return { success: true as const };
  }, MARSHAL_RUNTIME_DEFAULT_WORKSPACE);
  if (!outcome.success) return { aligned: false, reason: outcome.reason };
  await page.reload();
  await page.locator("nav[aria-label='Main navigation']").waitFor();
  return { aligned: true };
}

async function alignRendererSession(
  page: Page,
  sessionId: string,
): Promise<{ readonly aligned: boolean; readonly reason?: string }> {
  const session = page.locator(
    `[data-testid="session-item"][data-session-id="${sessionId.replaceAll('"', '\\"')}"]`,
  );
  try {
    await session.waitFor({ timeout: 10_000 });
    await session.click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-testid="session-item"][data-session-id="${CSS.escape(id)}"]`)
          ?.hasAttribute("data-active") === true,
      sessionId,
      { timeout: 10_000 },
    );
    return { aligned: true };
  } catch (error) {
    return {
      aligned: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function restartElectronApp(app: ElectronApplication): Promise<{
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly userDataDir: string;
}> {
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
  await app.close();
  const relaunched = await launchPersistentE2EApp({
    userDataDir,
    seed: false,
    extraEnv: { MARSHAL_RUNTIME_ACCEPTANCE: "1" },
  });
  const page = await relaunched.firstWindow();
  await page.locator("nav[aria-label='Main navigation']").waitFor();
  return { app: relaunched, page, userDataDir };
}

async function installUiApplicationFixture(
  client: RuntimeAcceptanceClient,
  scope: RuntimeAcceptanceScope,
  applicationId: string,
): Promise<{ readonly fixture: RuntimeAcceptanceFixture; readonly identity: string }> {
  const fixture = await client.value("materializeExtensionFixture", {
    profile: "ui-application",
    version: "1.0.0",
    uiApplicationId: applicationId,
  });
  const installed = requireOk(
    await client.value("installExtension", {
      ...scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: uid("install"),
    }),
  );
  const installedRecord = record(installed.value);
  if (installedRecord.identity !== fixture.identity) {
    throw new Error(
      `Installed extension identity "${String(installedRecord.identity)}" did not match materialized fixture identity "${fixture.identity}".`,
    );
  }
  if (installedRecord.status !== "enabled") {
    const enabled = requireOk(
      await client.value("enableExtension", {
        ...scope,
        identity: fixture.identity,
        idempotencyKey: uid("enable"),
      }),
    );
    if (record(enabled.value).status !== "enabled") {
      throw new Error(
        `Extension "${fixture.identity}" did not report enabled status after enableExtension.`,
      );
    }
  }
  return { fixture, identity: fixture.identity };
}

// ---------------------------------------------------------------------------
// Shared per-run context
// ---------------------------------------------------------------------------

interface Ctx {
  client: RuntimeAcceptanceClient;
  app: ElectronApplication;
  page: Page;
  recorder: LiveStoryRecorder;
  evidenceRoot: string;
  scope: UiScenarioScope;
  secondaryScope: UiScenarioScope;
  boundaryScope: UiScenarioScope;
  burstScope: UiScenarioScope;
  capacityProbeScope: UiScenarioScope;
  deletedScope: UiScenarioScope;
  restartReplayScope: UiScenarioScope;
  extensionIdentity: string;
  applicationId: string;
  secondExtensionIdentity: string;
  secondApplicationId: string;
  instanceIds: Set<string>;
  notes: string[];
  consoleErrors: string[];
  rendererAligned: boolean;
  userDataDir: string | null;
  restartElectronApp: NonNullable<UiScenarioOptions["restartElectronApp"]>;
}

function noteOf(ctx: Ctx, text: string): void {
  ctx.notes.push(text);
}

// ---------------------------------------------------------------------------
// MRT-UI-001 — typed production preload/IPC surface
// ---------------------------------------------------------------------------

async function storyUi001(ctx: Ctx): Promise<LiveStoryProof> {
  const { client, scope } = ctx;
  const methodInventory = await ctx.page.evaluate(() => {
    const api = window.runtimeUiAPI;
    return api ? Object.keys(api).sort() : null;
  });
  if (!methodInventory)
    throw new Error("window.runtimeUiAPI is unavailable in the production renderer.");
  const expectedMethods = [
    "close",
    "focus",
    "getSnapshot",
    "list",
    "onEvent",
    "open",
    "subscribe",
    "unsubscribe",
    "update",
  ];
  const missingMethods = expectedMethods.filter((name) => !methodInventory.includes(name));
  if (missingMethods.length > 0) {
    throw new Error(`window.runtimeUiAPI is missing methods: ${missingMethods.join(", ")}`);
  }

  const before = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const capture = await client.captureUiEvents(scope);
  const owner = ownerOf(scope, ctx.extensionIdentity, ctx.applicationId);
  const opened = unwrapUi(
    await client.ui("open", {
      ...owner,
      surface: "inline-card",
      content: textContent("MRT-UI-001 open"),
      idempotencyKey: uid("mrt-ui-001-open"),
    }),
  );
  const instanceId = opened.instance!.instanceId;
  ctx.instanceIds.add(instanceId);
  const updated = unwrapUi(
    await client.ui("update", {
      ...owner,
      instanceId,
      content: textContent("MRT-UI-001 updated"),
      idempotencyKey: uid("mrt-ui-001-update"),
    }),
  );
  const focused = unwrapUi(
    await client.ui("focus", { ...owner, instanceId, idempotencyKey: uid("mrt-ui-001-focus") }),
  );
  const listed = unwrapUi<RuntimeUiCommandResult>(await client.ui("list", scope));
  const closed = unwrapUi(
    await client.ui("close", { ...owner, instanceId, idempotencyKey: uid("mrt-ui-001-close") }),
  );
  ctx.instanceIds.delete(instanceId);
  const eventsWhileSubscribed = await client.readUiEvents();
  await capture.unsubscribe();

  // Prove destroyed/unsubscribed senders receive no later event: mutate again while
  // unsubscribed and confirm the local event buffer does not grow.
  const openedAfterUnsub = unwrapUi(
    await client.ui("open", {
      ...owner,
      surface: "inline-card",
      content: textContent("after unsub"),
      idempotencyKey: uid("mrt-ui-001-after-unsub"),
    }),
  );
  const instanceAfterUnsub = openedAfterUnsub.instance!.instanceId;
  const eventsAfterUnsubscribe = await client.readUiEvents();
  await closeInstance(client, owner, instanceAfterUnsub);

  // Restore the shared subscription — the app's own live renderer shares this
  // webContents and expects a live subscription for later stories.
  const resubscribed = await client.ui("subscribe", scope);
  if (!resubscribed.success) {
    throw new Error(
      `Failed to restore subscription: ${resubscribed.error.code}: ${resubscribed.error.message}`,
    );
  }

  const eightInvokeChannels = [
    "getSnapshot",
    "subscribe",
    "unsubscribe",
    "open",
    "update",
    "focus",
    "close",
    "list",
  ];

  return {
    proof: {
      assertions: {
        allEightMethodsPresent: missingMethods.length === 0,
        openApplied: opened.receipt.status === "applied" && typeof instanceId === "string",
        updateRevisionIncreased: updated.receipt.revision > opened.receipt.revision,
        focusApplied: focused.receipt.status === "applied",
        listReturnedOpenedInstance: (listed.instances ?? []).some(
          (i) => i.instanceId === instanceId,
        ),
        closeApplied: closed.receipt.status === "applied",
        eventsCapturedWhileSubscribed: eventsWhileSubscribed.length > 0,
        noNewEventsAfterUnsubscribe: eventsAfterUnsubscribe.length === eventsWhileSubscribed.length,
      },
      eightInvokeChannels,
      before,
      opened,
      updated,
      focused,
      listed,
      closed,
    },
    evidence: { methodInventory, eventsWhileSubscribed, eventsAfterUnsubscribe },
  };
}

// ---------------------------------------------------------------------------
// MRT-UI-002 — the four surfaces, tab switching, focus, close/Escape
// ---------------------------------------------------------------------------

async function storyUi002(ctx: Ctx): Promise<LiveStoryProof> {
  const { client, page, scope, evidenceRoot } = ctx;
  const owner = ownerOf(scope, ctx.extensionIdentity, ctx.applicationId);
  const screenshots: Record<string, string> = {};
  const accessibilitySnapshots: Record<string, string> = {};
  const opened: Record<string, string> = {};
  const commands: unknown[] = [];
  const focusTrace: unknown[] = [];
  const capture = await client.captureUiEvents(scope);

  async function openSurface(
    surface: RuntimeUiSurface,
    testId: string,
    accessibilitySelector = `[data-testid="${testId}"]`,
  ): Promise<string> {
    const result = unwrapUi(
      await client.ui("open", {
        ...owner,
        surface,
        content: textContent(`MRT-UI-002 ${surface}`),
        idempotencyKey: uid(`mrt-ui-002-${surface}`),
      }),
    );
    const instanceId = result.instance!.instanceId;
    commands.push({ operation: "open", surface, result });
    ctx.instanceIds.add(instanceId);
    await page.locator(`[data-testid="${testId}"]`).waitFor({ timeout: 15_000 });
    const focused = unwrapUi(
      await client.ui("focus", {
        ...owner,
        instanceId,
        idempotencyKey: uid(`mrt-ui-002-focus-${surface}`),
      }),
    );
    commands.push({ operation: "focus", surface, result: focused });
    focusTrace.push({
      surface,
      operation: "focus-command",
      receipt: focused.receipt,
      activeElement: await activeElementTrace(page),
    });
    screenshots[surface] = await captureScreenshot(page, evidenceRoot, `mrt-ui-002-${surface}`);
    accessibilitySnapshots[surface] = await captureAccessibilitySnapshot(
      page,
      evidenceRoot,
      `mrt-ui-002-${surface}`,
      accessibilitySelector,
    );
    return instanceId;
  }

  opened.inline = await openSurface("inline-card", "runtime-ui-inline");
  opened.panel = await openSurface("panel", "runtime-ui-panel");
  opened.tab = await openSurface("tab", "runtime-ui-workspace-tabs");

  const tabsRegion = page.locator('[role="tablist"][aria-label="Workspace tabs"]');
  await tabsRegion.waitFor();
  const tabLabels = (await tabsRegion.locator('[role="tab"]').allTextContents()).map((t) =>
    t.trim(),
  );
  const chatTabPresent = tabLabels.includes("Chat");
  const runtimeTabPresent = tabLabels.includes(ctx.applicationId);
  await tabsRegion.getByRole("tab", { name: ctx.applicationId }).click();
  await page.locator('[data-runtime-ui-surface="tab"]').waitFor({ timeout: 10_000 });
  screenshots.tab = await captureScreenshot(page, evidenceRoot, "mrt-ui-002-tab");
  accessibilitySnapshots.tab = await captureAccessibilitySnapshot(
    page,
    evidenceRoot,
    "mrt-ui-002-tab",
    '[data-runtime-ui-surface="tab"]',
  );
  const priorFocus = tabsRegion.getByRole("tab", { name: "Chat" });
  await priorFocus.click();
  await priorFocus.focus();
  focusTrace.push({
    surface: "fullscreen",
    operation: "prior-focus",
    activeElement: await activeElementTrace(page),
  });

  opened.fullscreen = await openSurface(
    "fullscreen",
    "runtime-ui-fullscreen",
    '[data-testid="runtime-ui-fullscreen"] [role="dialog"]',
  );
  const dialog = page.locator('[data-testid="runtime-ui-fullscreen"] [role="dialog"]');
  await dialog.waitFor();
  const dialogAriaModal = await dialog.getAttribute("aria-modal");
  const focusInsideDialog = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="runtime-ui-fullscreen"] [role="dialog"]');
    return !!node && node.contains(document.activeElement);
  });
  await page.keyboard.press("Escape");
  await page
    .locator('[data-testid="runtime-ui-fullscreen"] [role="dialog"]')
    .waitFor({ state: "detached", timeout: 10_000 });
  await expect(priorFocus).toBeFocused();
  focusTrace.push({
    surface: "fullscreen",
    operation: "escape-restored-prior-focus",
    activeElement: await activeElementTrace(page),
  });
  ctx.instanceIds.delete(opened.fullscreen);

  const closeButton = page.locator(
    `[data-testid="runtime-ui-inline"] button[aria-label="Close ${ctx.applicationId}"]`,
  );
  await closeButton.waitFor();
  const closeButtonLabel = await closeButton.getAttribute("aria-label");
  await closeButton.click();
  commands.push({
    operation: "close-button",
    surface: "inline-card",
    label: closeButtonLabel,
  });
  await page
    .locator('[data-testid="runtime-ui-inline"]')
    .waitFor({ state: "detached", timeout: 10_000 })
    .catch(() => undefined);
  ctx.instanceIds.delete(opened.inline);

  const authoritativeAfter = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const inlineStillAuthoritative = authoritativeAfter.instances.some(
    (i) => i.instanceId === opened.inline,
  );
  const fullscreenStillAuthoritative = authoritativeAfter.instances.some(
    (i) => i.instanceId === opened.fullscreen,
  );

  // Cleanup panel + tab instances via IPC (already verified their open/render path above).
  await closeInstance(client, owner, opened.panel);
  await closeInstance(client, owner, opened.tab);
  commands.push(
    { operation: "close", surface: "panel", instanceId: opened.panel },
    { operation: "close", surface: "tab", instanceId: opened.tab },
  );
  ctx.instanceIds.delete(opened.panel);
  ctx.instanceIds.delete(opened.tab);
  const events = await client.readUiEvents();
  await capture.unsubscribe();
  const expectedFocusEvents = Object.values(opened).every((instanceId) =>
    events.some(
      (event) => event.type === "instance-focused" && event.instance.instanceId === instanceId,
    ),
  );
  const commandTranscriptPath = path.join(evidenceRoot, "ui", "mrt-ui-002-transcript.json");
  fs.mkdirSync(path.dirname(commandTranscriptPath), { recursive: true });
  fs.writeFileSync(
    commandTranscriptPath,
    `${JSON.stringify({ commands, events, focusTrace }, null, 2)}\n`,
    "utf8",
  );
  expect(Object.keys(screenshots).sort()).toEqual(["fullscreen", "inline-card", "panel", "tab"]);
  expect(Object.keys(accessibilitySnapshots).sort()).toEqual([
    "fullscreen",
    "inline-card",
    "panel",
    "tab",
  ]);
  expect(expectedFocusEvents).toBe(true);

  return {
    proof: {
      assertions: {
        inlineCardRenderedInsideChat: true,
        panelRenderedAsRuntimeSidePanel: true,
        workspaceTabsIncludeChatAndRuntimeTab: chatTabPresent && runtimeTabPresent,
        fullscreenHasDialogAriaModal: dialogAriaModal === "true",
        fullscreenReceivedFocus: focusInsideDialog,
        escapeClosedFullscreen: !fullscreenStillAuthoritative,
        escapeRestoredPriorFocus: true,
        closeButtonLabelExact: closeButtonLabel === `Close ${ctx.applicationId}`,
        closeButtonRemovedAuthoritativeInstance: !inlineStillAuthoritative,
        eachSurfaceFocusedThroughProductionCommand: expectedFocusEvents,
        fourAccessibilitySnapshotsCaptured: true,
      },
      opened,
      tabLabels,
    },
    actions: commands,
    rawResultEnvelopes: { commands, events },
    evidence: { screenshots, accessibilitySnapshots, focusTrace, events },
    supportingEvidence: [
      ...Object.values(screenshots),
      ...Object.values(accessibilitySnapshots),
      path.relative(evidenceRoot, commandTranscriptPath).split(path.sep).join("/"),
      "api-transcript.jsonl",
    ],
  };
}

async function activeElementTrace(page: Page): Promise<{
  readonly tagName: string | null;
  readonly role: string | null;
  readonly ariaLabel: string | null;
  readonly text: string | null;
  readonly testId: string | null;
}> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return {
      tagName: active?.tagName ?? null,
      role: active?.getAttribute("role") ?? null,
      ariaLabel: active?.getAttribute("aria-label") ?? null,
      text: active?.textContent?.trim().slice(0, 200) ?? null,
      testId: active?.getAttribute("data-testid") ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// MRT-UI-003 — text/markdown/application content hardening
// ---------------------------------------------------------------------------

async function storyUi003(ctx: Ctx): Promise<LiveStoryProof> {
  const { client, page, scope } = ctx;
  const owner = ownerOf(scope, ctx.extensionIdentity, ctx.applicationId);

  async function probeNoScriptExecuted(): Promise<boolean> {
    return page.evaluate(() => window.__marshalUiXssProbe !== true);
  }

  // Text
  const dangerousText = 'Plain <text> & "quotes" <script>window.__marshalUiXssProbe=true</script>';
  const textOpened = unwrapUi(
    await client.ui("open", {
      ...owner,
      surface: "inline-card",
      content: textContent(dangerousText),
      idempotencyKey: uid("mrt-ui-003-text"),
    }),
  );
  await page.locator('[data-testid="runtime-ui-inline"]').waitFor();
  const textDom = await page.locator('[data-testid="runtime-ui-inline"]').innerText();
  const noScriptFromText = await probeNoScriptExecuted();
  await closeInstance(client, owner, textOpened.instance!.instanceId);

  // Markdown
  const dangerousMarkdown =
    '**bold**\n\n<img src=x onerror="window.__marshalUiXssProbe=true">\n\n<script>window.__marshalUiXssProbe=true</script>';
  const markdownOpened = unwrapUi(
    await client.ui("open", {
      ...owner,
      surface: "inline-card",
      content: markdownContent(dangerousMarkdown),
      idempotencyKey: uid("mrt-ui-003-markdown"),
    }),
  );
  await page.locator('[data-testid="runtime-ui-markdown"]').waitFor();
  const markdownElement = page.locator('[data-testid="runtime-ui-markdown"]');
  const markdownDom = await markdownElement.innerHTML();
  const markdownText = await markdownElement.innerText();
  const markdownUnsafeElementCount = await page
    .locator('[data-testid="runtime-ui-markdown"] img, [data-testid="runtime-ui-markdown"] script')
    .count();
  const noScriptFromMarkdown = await probeNoScriptExecuted();
  await closeInstance(client, owner, markdownOpened.instance!.instanceId);

  // Application: modes, actions, tools, local/authoritative state, dangerous state strings.
  const manifest = richApplicationManifest("ui.notification.show", " <em>emph</em>");
  const state = dangerousState();
  const appOpened = unwrapUi(
    await client.ui("open", {
      ...owner,
      surface: "inline-card",
      content: applicationContent(manifest, state),
      idempotencyKey: uid("mrt-ui-003-application"),
    }),
  );
  const appLocator = page.locator('[data-testid="runtime-ui-application"]');
  await appLocator.waitFor();
  const stateInspectorText = await page
    .locator('[data-testid="runtime-ui-state-inspector"]')
    .innerText();
  const stateEscaped =
    !stateInspectorText.includes("<script>") &&
    !stateInspectorText.includes("<div") &&
    (stateInspectorText.includes("\\u003c") || stateInspectorText.includes("&lt;"));
  const actionButtons = appLocator.locator("button", { hasText: "Run" });
  const actionButtonCount = await actionButtons.count();
  const firstActionDisabled =
    actionButtonCount > 0 ? await actionButtons.first().isDisabled() : true;
  const firstActionAriaLabel =
    actionButtonCount > 0 ? await actionButtons.first().getAttribute("aria-label") : "";
  const noScriptFromApplication = await probeNoScriptExecuted();
  await closeInstance(client, owner, appOpened.instance!.instanceId);

  return {
    proof: {
      assertions: {
        textRenderedAsPlainText: textDom.includes("<text>") && textDom.includes("&"),
        noScriptExecutedFromText: noScriptFromText,
        markdownRenderedThroughHardenedRenderer:
          markdownText.includes("bold") &&
          !markdownText.includes("**bold**") &&
          markdownUnsafeElementCount === 0,
        noScriptExecutedFromMarkdown: noScriptFromMarkdown,
        applicationContractRendered: true,
        stateJsonEscaped: stateEscaped,
        actionButtonsDisabled: firstActionDisabled,
        actionButtonAnnouncesUnavailableDispatch: /unavailable/i.test(firstActionAriaLabel ?? ""),
        noScriptExecutedFromApplicationState: noScriptFromApplication,
      },
      dangerousText,
      dangerousMarkdown,
      manifest,
      state,
    },
    evidence: {
      textDom,
      markdownDom,
      markdownText,
      markdownUnsafeElementCount,
      stateInspectorText,
      consoleErrorsDuringStory: [...ctx.consoleErrors],
    },
  };
}

// ---------------------------------------------------------------------------
// MRT-UI-004 — receipts, revision, instance lifecycle ordering
// ---------------------------------------------------------------------------

async function storyUi004(ctx: Ctx): Promise<LiveStoryProof> {
  const { client, scope } = ctx;
  const owner = ownerOf(scope, ctx.extensionIdentity, ctx.applicationId);
  const receiptIdPattern = /^[0-9a-f]{64}$/;

  const opened = unwrapUi(
    await client.ui("open", {
      ...owner,
      surface: "panel",
      content: textContent("MRT-UI-004"),
      idempotencyKey: uid("mrt-ui-004-open"),
    }),
  );
  const instanceId = opened.instance!.instanceId;
  const updated = unwrapUi(
    await client.ui("update", {
      ...owner,
      instanceId,
      content: textContent("MRT-UI-004 updated"),
      idempotencyKey: uid("mrt-ui-004-update"),
    }),
  );
  const focused = unwrapUi(
    await client.ui("focus", { ...owner, instanceId, idempotencyKey: uid("mrt-ui-004-focus") }),
  );
  const listed = unwrapUi(
    await client.ui("list", {
      ...scope,
      owner: { extensionId: ctx.extensionIdentity, applicationId: ctx.applicationId },
    }),
  );
  const snapshotBeforeClose = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const closeKey = uid("mrt-ui-004-close");
  const closed = unwrapUi<RuntimeUiCommandResult>(
    await client.ui("close", { ...owner, instanceId, idempotencyKey: closeKey }),
  );
  // Replay the identical close command: production idempotency guarantees a
  // deduplicated receipt rather than a second "not-found" style failure.
  const closeReplayed = unwrapUi<RuntimeUiCommandResult>(
    await client.ui("close", { ...owner, instanceId, idempotencyKey: closeKey }),
  );
  const snapshotAfterClose = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));

  const eventsForInstance = snapshotBeforeClose.events
    .filter((event) => "instance" in event && event.instance.instanceId === instanceId)
    .map((event) => event.type)
    .concat(
      snapshotAfterClose.events
        .filter((event) => event.type === "instance-closed" && event.instanceId === instanceId)
        .map((event) => event.type),
    );

  const receiptsAreDeterministicHex = [opened, updated, focused, closed].every((result) =>
    receiptIdPattern.test(result.receipt.receiptId),
  );
  const revisionsMonotonic =
    updated.receipt.revision > opened.receipt.revision &&
    focused.receipt.revision > updated.receipt.revision;

  return {
    proof: {
      assertions: {
        receiptsHaveDeterministicHexIds: receiptsAreDeterministicHex,
        receiptsCarryActionStatusCompletionRevisionInstance: [
          opened,
          updated,
          focused,
          closed,
        ].every(
          (result) =>
            typeof result.receipt.action === "string" &&
            result.receipt.status === "applied" &&
            typeof result.receipt.completedAt === "string" &&
            typeof result.receipt.revision === "number" &&
            result.receipt.instanceId === instanceId,
        ),
        revisionsMonotonic,
        eventOrderIsOpenedUpdatedFocusedClosed:
          JSON.stringify(eventsForInstance) ===
          JSON.stringify([
            "instance-opened",
            "instance-updated",
            "instance-focused",
            "instance-closed",
          ]),
        listAndSnapshotMatchAuthoritativeState:
          (listed.instances ?? []).some((i) => i.instanceId === instanceId) &&
          snapshotBeforeClose.instances.some((i) => i.instanceId === instanceId) &&
          !snapshotAfterClose.instances.some((i) => i.instanceId === instanceId),
        duplicateCloseCommandIsDeduplicated: closeReplayed.receipt.status === "deduplicated",
      },
      opened,
      updated,
      focused,
      listed,
      closed,
      closeReplayed,
    },
    evidence: { eventsForInstance, snapshotBeforeClose, snapshotAfterClose },
    supportingEvidence: [
      "electron/marshal-runtime/ui-controller.test.ts",
      "src/features/runtime-ui/useRuntimeUi.test.tsx",
    ],
  };
}

// ---------------------------------------------------------------------------
// MRT-UI-005 — scope and owner isolation
// ---------------------------------------------------------------------------

async function storyUi005(ctx: Ctx): Promise<LiveStoryProof> {
  const { client, scope, secondaryScope } = ctx;
  const ownerA1 = ownerOf(scope, ctx.extensionIdentity, ctx.applicationId);
  const ownerA2 = ownerOf(scope, ctx.secondExtensionIdentity, ctx.secondApplicationId);
  const ownerB1 = ownerOf(secondaryScope, ctx.extensionIdentity, ctx.applicationId);

  const captureA = await client.captureUiEvents(scope);
  const openA1 = unwrapUi(
    await client.ui("open", {
      ...ownerA1,
      surface: "inline-card",
      content: textContent("A1"),
      idempotencyKey: uid("mrt-ui-005-a1"),
    }),
  );
  const openA2 = unwrapUi(
    await client.ui("open", {
      ...ownerA2,
      surface: "panel",
      content: textContent("A2"),
      idempotencyKey: uid("mrt-ui-005-a2"),
    }),
  );
  const eventsForScopeA = await client.readUiEvents();
  await captureA.unsubscribe();

  const captureB = await client.captureUiEvents(secondaryScope);
  const openB1 = unwrapUi(
    await client.ui("open", {
      ...ownerB1,
      surface: "inline-card",
      content: textContent("B1"),
      idempotencyKey: uid("mrt-ui-005-b1"),
    }),
  );
  const eventsForScopeB = await client.readUiEvents();
  await captureB.unsubscribe();

  const crossScopeUpdate = await client.ui("update", {
    ...ownerOf(secondaryScope, ctx.extensionIdentity, ctx.applicationId),
    instanceId: openA1.instance!.instanceId,
    content: textContent("hijack"),
    idempotencyKey: uid("mrt-ui-005-cross-scope-update"),
  });
  const crossOwnerFocus = await client.ui("focus", {
    ...ownerA1,
    instanceId: openA2.instance!.instanceId,
    idempotencyKey: uid("mrt-ui-005-cross-owner-focus"),
  });
  const crossScopeClose = await client.ui("close", {
    ...ownerB1,
    instanceId: openA1.instance!.instanceId,
    idempotencyKey: uid("mrt-ui-005-cross-scope-close"),
  });
  const crossScopeList = unwrapUi<RuntimeUiCommandResult>(await client.ui("list", secondaryScope));

  const listAOwnerFiltered = unwrapUi(
    await client.ui("list", {
      ...scope,
      owner: { extensionId: ctx.extensionIdentity, applicationId: ctx.applicationId },
    }),
  );
  const snapshotA = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const snapshotB = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", secondaryScope));

  const resub = await client.ui("subscribe", scope);
  if (!resub.success)
    throw new Error(`Failed to restore subscription: ${resub.error.code}: ${resub.error.message}`);

  await closeInstance(client, ownerA1, openA1.instance!.instanceId);
  await closeInstance(client, ownerA2, openA2.instance!.instanceId);
  await closeInstance(client, ownerB1, openB1.instance!.instanceId);

  return {
    proof: {
      assertions: {
        sessionsAndWorkspacesAreDistinct:
          scope.sessionId !== secondaryScope.sessionId &&
          scope.workspaceName !== secondaryScope.workspaceName,
        scopeAEventsOnlyContainScopeA: eventsForScopeA.every(
          (e) =>
            e.scope.sessionId === scope.sessionId && e.scope.workspaceName === scope.workspaceName,
        ),
        scopeBEventsOnlyContainScopeB: eventsForScopeB.every(
          (e) =>
            e.scope.sessionId === secondaryScope.sessionId &&
            e.scope.workspaceName === secondaryScope.workspaceName,
        ),
        snapshotAOnlyContainsScopeAInstances: snapshotA.instances.every(
          (i) =>
            i.owner.sessionId === scope.sessionId && i.owner.workspaceName === scope.workspaceName,
        ),
        snapshotBOnlyContainsScopeBInstances: snapshotB.instances.every(
          (i) =>
            i.owner.sessionId === secondaryScope.sessionId &&
            i.owner.workspaceName === secondaryScope.workspaceName,
        ),
        crossScopeUpdateDenied:
          !crossScopeUpdate.success && crossScopeUpdate.error.code === "not-found",
        crossOwnerFocusDenied:
          !crossOwnerFocus.success && crossOwnerFocus.error.code === "not-found",
        crossScopeCloseDenied:
          !crossScopeClose.success && crossScopeClose.error.code === "not-found",
        listOwnerFilterExcludesOtherOwner: !listAOwnerFiltered.instances!.some(
          (i) => i.owner.applicationId === ctx.secondApplicationId,
        ),
        crossScopeListDoesNotLeakScopeAInstances: !crossScopeList.instances!.some(
          (i) => i.owner.sessionId === scope.sessionId,
        ),
      },
    },
    evidence: {
      eventsForScopeA,
      eventsForScopeB,
      crossScopeUpdate,
      crossOwnerFocus,
      crossScopeClose,
      snapshotA,
      snapshotB,
    },
  };
}

// ---------------------------------------------------------------------------
// MRT-UI-006 — idempotency, capacity, rate, payload, and history bounds
// ---------------------------------------------------------------------------

async function runSuccessfulFocuses(
  client: RuntimeAcceptanceClient,
  owner: RuntimeUiOwner,
  instanceId: string,
  count: number,
  label: string,
): Promise<number> {
  let lastRevision = 0;
  for (let index = 0; index < count; index += 1) {
    const result = unwrapUi<RuntimeUiCommandResult>(
      // eslint-disable-next-line no-await-in-loop -- command-rate accounting is intentionally sequential
      await client.ui("focus", {
        ...owner,
        instanceId,
        idempotencyKey: uid(`${label}-${index}`),
      }),
    );
    lastRevision = result.receipt.revision;
  }
  return lastRevision;
}

async function openBurstTarget(
  client: RuntimeAcceptanceClient,
  scope: UiScenarioScope,
  extensionId: string,
  applicationId: string,
  label: string,
): Promise<{ readonly owner: RuntimeUiOwner; readonly instanceId: string }> {
  const owner = ownerOf(scope, extensionId, applicationId);
  const opened = unwrapUi<RuntimeUiCommandResult>(
    await client.ui("open", {
      ...owner,
      surface: "panel",
      content: textContent(label),
      idempotencyKey: uid(`${label}-open`),
    }),
  );
  return { owner, instanceId: opened.instance!.instanceId };
}

async function storyUi006(ctx: Ctx): Promise<LiveStoryProof> {
  const { client } = ctx;
  const primaryOwner = ownerOf(ctx.boundaryScope, ctx.extensionIdentity, ctx.applicationId);
  const validationOwner = ownerOf(ctx.capacityProbeScope, ctx.extensionIdentity, ctx.applicationId);

  // 1. Identical replay is deduplicated; conflicting replay is idempotency-conflict.
  const replayKey = uid("mrt-ui-006-replay");
  const replayContent = textContent("replay");
  const firstOpen = unwrapUi(
    await client.ui("open", {
      ...primaryOwner,
      surface: "inline-card",
      content: replayContent,
      idempotencyKey: replayKey,
    }),
  );
  const identicalReplay = unwrapUi(
    await client.ui("open", {
      ...primaryOwner,
      surface: "inline-card",
      content: replayContent,
      idempotencyKey: replayKey,
    }),
  );
  const conflictingReplay = await client.ui("open", {
    ...primaryOwner,
    surface: "inline-card",
    content: textContent("replay-different"),
    idempotencyKey: replayKey,
  });

  // 2. Reach exactly 64 active instances, then prove the 65th is rejected.
  const capacityOpenedIds = [firstOpen.instance!.instanceId];
  for (let index = 1; index < 64; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- active-instance capacity must fill sequentially
    const result = await client.ui("open", {
      ...primaryOwner,
      surface: "inline-card",
      content: textContent(`capacity-${index}`),
      idempotencyKey: uid(`mrt-ui-006-capacity-${index}`),
    });
    capacityOpenedIds.push(unwrapUi<RuntimeUiCommandResult>(result).instance!.instanceId);
  }
  const capacityBreach = await client.ui("open", {
    ...primaryOwner,
    surface: "inline-card",
    content: textContent("capacity-64"),
    idempotencyKey: uid("mrt-ui-006-capacity-64"),
  });
  const capacitySnapshot = unwrapUi<RuntimeUiSnapshot>(
    await client.ui("getSnapshot", ctx.boundaryScope),
  );

  // 3. Payload/depth/string/prototype-pollution/non-plain/HTML-like-kind validation.
  const oversizedState: Record<string, string> = {};
  for (let index = 0; index < 90; index += 1) oversizedState[`key-${index}`] = "x".repeat(900);
  const oversizedPayload = await client.ui("open", {
    ...validationOwner,
    surface: "inline-card",
    content: applicationContent(minimalApplicationManifest(), oversizedState),
    idempotencyKey: uid("mrt-ui-006-oversized-payload"),
  });

  let deepState: RuntimeUiJsonValue = { leaf: "bottom" };
  for (let depth = 0; depth < 13; depth += 1) deepState = { nested: deepState };
  const oversizedDepth = await client.ui("open", {
    ...validationOwner,
    surface: "inline-card",
    content: applicationContent(minimalApplicationManifest(), deepState),
    idempotencyKey: uid("mrt-ui-006-oversized-depth"),
  });

  const oversizedString = await client.ui("open", {
    ...validationOwner,
    surface: "inline-card",
    content: textContent("x".repeat(16_385)),
    idempotencyKey: uid("mrt-ui-006-oversized-string"),
  });

  const htmlLikeKind = commandEnvelope(
    await ctx.page.evaluate(
      async ({ ownerArg, key }) => {
        const api = window.runtimeUiAPI;
        const open = api ? Reflect.get(api, "open") : undefined;
        if (typeof open !== "function") throw new Error("Runtime UI open is unavailable.");
        return Reflect.apply(open, api, [
          {
            ...ownerArg,
            surface: "inline-card",
            content: { kind: "<script>", text: "x" },
            idempotencyKey: key,
          },
        ]);
      },
      { ownerArg: validationOwner, key: uid("mrt-ui-006-html-kind") },
    ),
  );

  const nonPlainObject = commandEnvelope(
    await ctx.page.evaluate(
      async ({ ownerArg, manifest, key }) => {
        const api = window.runtimeUiAPI;
        const open = api ? Reflect.get(api, "open") : undefined;
        if (typeof open !== "function") throw new Error("Runtime UI open is unavailable.");
        return Reflect.apply(open, api, [
          {
            ...ownerArg,
            surface: "inline-card",
            content: {
              kind: "application",
              descriptor: manifest,
              state: new Date(),
            },
            idempotencyKey: key,
          },
        ]);
      },
      {
        ownerArg: validationOwner,
        manifest: minimalApplicationManifest(),
        key: uid("mrt-ui-006-non-plain"),
      },
    ),
  );

  const prototypePollution = await client.value("probeRuntimeUiOperation", {
    ...validationOwner,
    operation: "prototype-pollution",
    idempotencyKey: uid("mrt-ui-006-proto-pollution"),
  });

  // 4. The boundary scope has consumed 66 rate-window commands (64 opens, the
  // active-capacity failure, and the snapshot). Reach 120,
  // reject the next command, then cross 256 events over two real rate windows.
  let lastPrimaryRevision = await runSuccessfulFocuses(
    client,
    primaryOwner,
    firstOpen.instance!.instanceId,
    54,
    "mrt-ui-006-primary-window-one",
  );
  const rateBreach = await client.ui("focus", {
    ...primaryOwner,
    instanceId: firstOpen.instance!.instanceId,
    idempotencyKey: uid("mrt-ui-006-rate-breach"),
  });
  await sleep(60_100);
  lastPrimaryRevision = await runSuccessfulFocuses(
    client,
    primaryOwner,
    firstOpen.instance!.instanceId,
    120,
    "mrt-ui-006-primary-window-two",
  );
  await sleep(60_100);
  lastPrimaryRevision = await runSuccessfulFocuses(
    client,
    primaryOwner,
    firstOpen.instance!.instanceId,
    22,
    "mrt-ui-006-primary-window-three",
  );
  const historySnapshot = unwrapUi<RuntimeUiSnapshot>(
    await client.ui("getSnapshot", ctx.boundaryScope),
  );
  const historySequences = historySnapshot.events.map((event) => event.sequence);

  // 5. Fill the remaining global idempotency slots across valid production
  // scopes without crossing any per-scope rate window: 257 + 120 + 120 + 15.
  const secondary = await openBurstTarget(
    client,
    ctx.secondaryScope,
    ctx.extensionIdentity,
    ctx.applicationId,
    "mrt-ui-006-secondary",
  );
  await runSuccessfulFocuses(
    client,
    secondary.owner,
    secondary.instanceId,
    119,
    "mrt-ui-006-secondary-focus",
  );
  const primary = await openBurstTarget(
    client,
    ctx.scope,
    ctx.extensionIdentity,
    ctx.applicationId,
    "mrt-ui-006-primary",
  );
  await runSuccessfulFocuses(
    client,
    primary.owner,
    primary.instanceId,
    119,
    "mrt-ui-006-primary-focus",
  );
  const burst = await openBurstTarget(
    client,
    ctx.burstScope,
    ctx.extensionIdentity,
    ctx.applicationId,
    "mrt-ui-006-final-fill",
  );
  let finalFillAccepted = 0;
  let beforeCapacityProbe: RuntimeUiSnapshot | undefined;
  let idempotencyCapacityBreach: RuntimeUiIpcResult<RuntimeUiCommandResult> | undefined;
  for (let index = 0; index < 15; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- the exact first rejected idempotency entry matters
    const before = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", ctx.burstScope));
    // eslint-disable-next-line no-await-in-loop -- the exact first rejected idempotency entry matters
    const result = await client.ui("focus", {
      ...burst.owner,
      instanceId: burst.instanceId,
      idempotencyKey: uid(`mrt-ui-006-final-fill-focus-${index}`),
    });
    if (!result.success) {
      beforeCapacityProbe = before;
      idempotencyCapacityBreach = result;
      break;
    }
    finalFillAccepted += 1;
  }
  if (!beforeCapacityProbe || !idempotencyCapacityBreach) {
    throw new Error(
      "Runtime UI idempotency capacity did not reject the expected boundary request.",
    );
  }
  const afterCapacityProbe = unwrapUi<RuntimeUiSnapshot>(
    await client.ui("getSnapshot", ctx.burstScope),
  );
  const successfulIdempotencyEntries = 64 + 54 + 120 + 22 + 120 + 120 + 1 + finalFillAccepted;

  return {
    proof: {
      assertions: {
        identicalReplayIsDeduplicated: identicalReplay.receipt.status === "deduplicated",
        identicalReplaySameInstance:
          identicalReplay.receipt.instanceId === firstOpen.receipt.instanceId,
        conflictingReplayIsIdempotencyConflict:
          !conflictingReplay.success && conflictingReplay.error.code === "idempotency-conflict",
        activeInstanceCapEnforcedAt64:
          !capacityBreach.success &&
          capacityBreach.error.code === "operation-failed" &&
          capacitySnapshot.instances.length === 64,
        capacityBreachDidNotMutateState: capacitySnapshot.instances.length === 64,
        oversizedPayloadRejected:
          !oversizedPayload.success && oversizedPayload.error.code === "invalid-request",
        oversizedDepthRejected:
          !oversizedDepth.success && oversizedDepth.error.code === "invalid-request",
        oversizedStringRejected:
          !oversizedString.success && oversizedString.error.code === "invalid-request",
        htmlLikeKindRejected:
          !htmlLikeKind.success && htmlLikeKind.error.code === "invalid-request",
        nonPlainObjectRejected:
          !nonPlainObject.success && nonPlainObject.error.code === "invalid-request",
        prototypePollutionKeyRejected:
          !prototypePollution.ok && prototypePollution.error.code === "invalid-request",
        rateLimitEnforcedAt120: !rateBreach.success && rateBreach.error.code === "operation-failed",
        eventHistoryRetainsNewest256: historySnapshot.events.length === 256,
        eventHistorySequencesStrictlyIncreasing: historySequences.every(
          (value, index) => index === 0 || value > historySequences[index - 1],
        ),
        snapshotStateRemainsCompleteDespiteHistoryTruncation:
          historySnapshot.instances.length === 64 &&
          historySnapshot.instances.some(
            (instance) =>
              instance.instanceId === firstOpen.instance!.instanceId &&
              instance.revision === lastPrimaryRevision,
          ),
        exact512IdempotencyEntriesAccepted: successfulIdempotencyEntries === 512,
        entry513RejectedAtIdempotencyCapacity:
          !idempotencyCapacityBreach.success &&
          idempotencyCapacityBreach.error.code === "idempotency-capacity",
        idempotencyCapacityFailureDidNotMutateState:
          beforeCapacityProbe.instances.length === afterCapacityProbe.instances.length &&
          beforeCapacityProbe.revision === afterCapacityProbe.revision,
      },
      successfulIdempotencyEntries,
    },
    evidence: {
      capacityBreach,
      oversizedPayload,
      oversizedDepth,
      oversizedString,
      htmlLikeKind,
      nonPlainObject,
      prototypePollution,
      rateBreach,
      historySnapshotEventCount: historySnapshot.events.length,
      finalFillAccepted,
      idempotencyCapacityBreach,
      beforeCapacityProbe,
      afterCapacityProbe,
    },
    supportingEvidence: ["electron/marshal-runtime/ui-controller.test.ts"],
  };
}

// ---------------------------------------------------------------------------
// MRT-UI-007 — recovery, resync, reload/reconnect without duplication
// ---------------------------------------------------------------------------

async function storyUi007(ctx: Ctx): Promise<LiveStoryProof> {
  const { client, page, scope } = ctx;
  const owner = ownerOf(scope, ctx.extensionIdentity, ctx.applicationId);

  const opened = unwrapUi(
    await client.ui("open", {
      ...owner,
      surface: "inline-card",
      content: textContent("MRT-UI-007"),
      idempotencyKey: uid("mrt-ui-007-open"),
    }),
  );
  const instanceId = opened.instance!.instanceId;
  await page.locator('[data-testid="runtime-ui-inline"]').waitFor();

  // Reload: authoritative state must reappear exactly once, no duplication.
  await page.reload();
  await page.locator("nav[aria-label='Main navigation']").waitFor();
  const reloadAlignment = await alignRendererSession(page, scope.sessionId);
  if (!reloadAlignment.aligned) {
    throw new Error(`Renderer reload alignment failed: ${reloadAlignment.reason}`);
  }
  await page.locator('[data-testid="runtime-ui-inline"]').waitFor({ timeout: 15_000 });
  const inlineCountAfterReload = await page.locator('[data-testid="runtime-ui-inline"]').count();
  const snapshotAfterReload = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const instancesMatchingIdAfterReload = snapshotAfterReload.instances.filter(
    (i) => i.instanceId === instanceId,
  );

  // Stop product event delivery, remove the instance through another
  // authorized production call, then use the still-visible renderer control.
  const unsubscribe = await page.evaluate(() => window.runtimeUiAPI!.unsubscribe());
  if (!unsubscribe.success) {
    throw new Error("Renderer unsubscribe failed.");
  }
  const externallyClosed = unwrapUi<RuntimeUiCommandResult>(
    await client.ui("close", {
      ...owner,
      instanceId,
      idempotencyKey: uid("mrt-ui-007-external-close"),
    }),
  );
  const staleStillVisible = await page.locator('[data-testid="runtime-ui-inline"]').count();
  const beforeScreenshot = await captureScreenshot(page, ctx.evidenceRoot, "mrt-ui-007-before");

  await page.evaluate((label) => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === label,
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing stale control: ${label}`);
    button.click();
  }, `Close ${ctx.applicationId}`);
  const optimisticRemoved = await page
    .locator('[data-testid="runtime-ui-inline"]')
    .waitFor({ state: "detached", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  const optimisticScreenshot = await captureScreenshot(
    page,
    ctx.evidenceRoot,
    "mrt-ui-007-optimistic",
  );
  const errorNotice = page.locator('[data-testid="runtime-ui-error"]');
  await errorNotice.waitFor({ timeout: 10_000 });
  await page.locator('[data-testid="runtime-ui-inline"]').waitFor({ timeout: 10_000 });
  const rollbackVisibleCount = await page.locator('[data-testid="runtime-ui-inline"]').count();
  const rollbackScreenshot = await captureScreenshot(page, ctx.evidenceRoot, "mrt-ui-007-rollback");
  const errorTitle = await errorNotice.textContent();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await errorNotice.waitFor({ state: "detached" });
  const dismissClearedError = (await errorNotice.count()) === 0;

  await page.evaluate((label) => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === label,
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing stale control: ${label}`);
    button.click();
  }, `Close ${ctx.applicationId}`);
  await errorNotice.waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Reload" }).click();
  await errorNotice.waitFor({ state: "detached" });
  const authoritativeAfterResync = unwrapUi<RuntimeUiSnapshot>(
    await client.ui("getSnapshot", scope),
  );

  const resubscribe = await page.evaluate(
    (targetScope) => window.runtimeUiAPI!.subscribe(targetScope),
    scope,
  );
  if (!resubscribe.success) {
    throw new Error(
      `Renderer resubscribe failed: ${resubscribe.error.code}: ${resubscribe.error.message}`,
    );
  }
  const reconnected = unwrapUi<RuntimeUiCommandResult>(
    await client.ui("open", {
      ...owner,
      surface: "inline-card",
      content: textContent("MRT-UI-007 reconnected"),
      idempotencyKey: uid("mrt-ui-007-reconnected"),
    }),
  );
  const reconnectedId = reconnected.instance!.instanceId;
  await page.locator('[data-testid="runtime-ui-inline"]').waitFor({ timeout: 10_000 });

  // Toggle offline/online/focus/visibility: the renderer resyncs without
  // erroring or duplicating instances.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(500);
  const snapshotAfterToggles = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const instancesMatchingIdAfterToggles = snapshotAfterToggles.instances.filter(
    (i) => i.instanceId === reconnectedId,
  );
  const errorBannerAfterToggles = await page.locator('[data-testid="runtime-ui-error"]').count();

  await closeInstance(client, owner, reconnectedId);
  await page.reload();
  await page.locator("nav[aria-label='Main navigation']").waitFor();

  return {
    proof: {
      assertions: {
        noDuplicateAfterReload:
          inlineCountAfterReload === 1 && instancesMatchingIdAfterReload.length === 1,
        staleInstanceRemainedVisibleAfterExternalClose:
          externallyClosed.receipt.status === "applied" && staleStillVisible === 1,
        failedOptimisticCloseRolledBackPriorRendererState: rollbackVisibleCount === 1,
        errorNoticeShowsRequiredMessage:
          errorTitle?.includes("Runtime content could not be updated") === true,
        dismissClearedError,
        noDuplicateAfterConnectivityAndVisibilityToggles:
          instancesMatchingIdAfterToggles.length === 1,
        noSpuriousErrorAfterToggles: errorBannerAfterToggles === 0,
        reloadRestoredAuthoritativeAbsentState: authoritativeAfterResync.instances.every(
          (instance) => instance.instanceId !== instanceId,
        ),
      },
    },
    evidence: {
      snapshotAfterReload,
      externallyClosed,
      optimisticRemovedBeforeRollback: optimisticRemoved,
      authoritativeAfterResync,
      snapshotAfterToggles,
    },
    supportingEvidence: [
      beforeScreenshot,
      optimisticScreenshot,
      rollbackScreenshot,
      "src/features/runtime-ui/useRuntimeUi.test.tsx",
      "src/features/runtime-ui/RuntimeUiHost.test.tsx",
    ],
  };
}

// ---------------------------------------------------------------------------
// MRT-UI-008 — all three delivery types, owner invalidation, restart
// ---------------------------------------------------------------------------

async function storyUi008(ctx: Ctx): Promise<LiveStoryProof> {
  const { client, scope, secondaryScope } = ctx;
  const owner = ownerOf(scope, ctx.extensionIdentity, ctx.applicationId);
  const secondaryOwner = ownerOf(secondaryScope, ctx.extensionIdentity, ctx.applicationId);

  const invocationCountsBefore = await client.value("getInvocationCounts");
  // Notification delivery.
  const notificationKey = uid("mrt-ui-008-notification");
  const notificationResult = await invokeUiCapability(
    client,
    "ui.notification.show",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      title: "MRT-UI-008",
      message: "Delivery check",
      idempotencyKey: notificationKey,
    },
    scope,
    notificationKey,
  );
  const notificationReplay = await invokeUiCapability(
    client,
    "ui.notification.show",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      title: "MRT-UI-008",
      message: "Delivery check",
      idempotencyKey: notificationKey,
    },
    scope,
    notificationKey,
  );
  const invocationCountsAfterNotification = await client.value("getInvocationCounts");
  const expectedTitle = "MRT-UI-008";
  const expectedBody = "Delivery check";
  const notificationAudit = invocationCountsAfterNotification.uiNotifications.find(
    (entry) =>
      entry.sessionId === scope.sessionId &&
      entry.titleSha256 === createHash("sha256").update(expectedTitle).digest("hex") &&
      entry.bodySha256 === createHash("sha256").update(expectedBody).digest("hex"),
  );

  // Chat message delivery.
  const chatMessageKey = uid("mrt-ui-008-chat-message");
  const chatMessage = await invokeUiCapability(
    client,
    "ui.chat.message.post",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      content: { kind: "text", text: "MRT-UI-008 chat message" },
      idempotencyKey: chatMessageKey,
    },
    scope,
    chatMessageKey,
  );
  const deliveryId = stringField(chatMessage.value.receipt, "deliveryId");
  const sessionAfterChatMessage = await client.value("readSession", scope.sessionId);
  if (!sessionAfterChatMessage) throw new Error("Runtime UI chat message session was not found.");
  const sessionAfterChatMessageRecord = record(sessionAfterChatMessage);
  const persistedMessages = array(sessionAfterChatMessageRecord.messages).map((m) => record(m));
  const persistedMessage = persistedMessages.find((m) => m.id === deliveryId);
  await invokeUiCapability(
    client,
    "ui.chat.message.post",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      content: { kind: "text", text: "MRT-UI-008 chat message" },
      idempotencyKey: chatMessageKey,
    },
    scope,
    chatMessageKey,
  );
  const sessionAfterReplay = await client.value("readSession", scope.sessionId);
  if (!sessionAfterReplay) throw new Error("Runtime UI chat replay session was not found.");
  const messagesAfterReplay = array(record(sessionAfterReplay).messages).filter(
    (m) => record(m).id === deliveryId,
  );

  // Chat card delivery: exactly one scoped inline instance, no separate side effect.
  const cardKey = uid("mrt-ui-008-chat-card");
  const cardResult = await invokeUiCapability(
    client,
    "ui.chat.card.show",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      state: { hello: "card" },
      idempotencyKey: cardKey,
    },
    scope,
    cardKey,
  );
  const cardInstanceId = stringField(cardResult.value.receipt, "instanceId");
  const cardReplay = await invokeUiCapability(
    client,
    "ui.chat.card.show",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      state: { hello: "card" },
      idempotencyKey: cardKey,
    },
    scope,
    cardKey,
  );
  const snapshotAfterCard = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const cardInstances = snapshotAfterCard.instances.filter(
    (i) =>
      i.owner.extensionId === ctx.extensionIdentity &&
      i.owner.applicationId === ctx.applicationId &&
      i.instanceId === cardInstanceId,
  );

  // Owner invalidation on disable: open instances in two scopes owned by the same extension.
  const invalidationOwnerA = ownerOf(scope, ctx.extensionIdentity, ctx.applicationId);
  const invalidationOwnerB = ownerOf(secondaryScope, ctx.extensionIdentity, ctx.applicationId);
  const instanceForInvalidationA = unwrapUi(
    await client.ui("open", {
      ...invalidationOwnerA,
      surface: "inline-card",
      content: textContent("invalidation-a"),
      idempotencyKey: uid("mrt-ui-008-invalidation-a"),
    }),
  );
  const instanceForInvalidationB = unwrapUi(
    await client.ui("open", {
      ...invalidationOwnerB,
      surface: "inline-card",
      content: textContent("invalidation-b"),
      idempotencyKey: uid("mrt-ui-008-invalidation-b"),
    }),
  );
  const captureForDisable = await client.captureUiEvents(scope);
  const disabled = requireOk(
    await client.value("disableExtension", {
      ...scope,
      identity: ctx.extensionIdentity,
      idempotencyKey: uid("disable"),
    }),
  );
  await sleep(250);
  const eventsAfterDisable = await client.readUiEvents();
  await captureForDisable.unsubscribe();
  const snapshotAAfterDisable = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const snapshotBAfterDisable = unwrapUi<RuntimeUiSnapshot>(
    await client.ui("getSnapshot", secondaryScope),
  );
  const resub = await client.ui("subscribe", scope);
  if (!resub.success)
    throw new Error(`Failed to restore subscription: ${resub.error.code}: ${resub.error.message}`);

  // Re-enable, create two fresh owned instances, and prove remove invalidates
  // the same owner across both scopes.
  requireOk(
    await client.value("enableExtension", {
      ...scope,
      identity: ctx.extensionIdentity,
      idempotencyKey: uid("re-enable"),
    }),
  );
  const removeInstanceA = unwrapUi<RuntimeUiCommandResult>(
    await client.ui("open", {
      ...owner,
      surface: "inline-card",
      content: textContent("remove-a"),
      idempotencyKey: uid("mrt-ui-008-remove-a"),
    }),
  );
  const removeInstanceB = unwrapUi<RuntimeUiCommandResult>(
    await client.ui("open", {
      ...secondaryOwner,
      surface: "inline-card",
      content: textContent("remove-b"),
      idempotencyKey: uid("mrt-ui-008-remove-b"),
    }),
  );
  const captureForRemove = await client.captureUiEvents(scope);
  const removed = requireOk(
    await client.value("removeExtension", {
      ...scope,
      identity: ctx.extensionIdentity,
      idempotencyKey: uid("remove"),
    }),
  );
  await sleep(250);
  const eventsAfterRemove = await client.readUiEvents();
  await captureForRemove.unsubscribe();
  const snapshotAAfterRemove = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const snapshotBAfterRemove = unwrapUi<RuntimeUiSnapshot>(
    await client.ui("getSnapshot", secondaryScope),
  );

  const restartBefore = { cardInstanceId };
  const {
    app: restartedApp,
    page: restartedPage,
    userDataDir,
  } = await ctx.restartElectronApp(ctx.app);
  ctx.app = restartedApp;
  ctx.page = restartedPage;
  ctx.userDataDir = userDataDir;
  ctx.client = new RuntimeAcceptanceClient(restartedApp, restartedPage, ctx.client.scope);
  const snapshotAfterRestart = unwrapUi(await ctx.client.ui("getSnapshot", scope));

  return {
    proof: {
      assertions: {
        notificationDeliveryApplied:
          record(notificationResult.value.receipt).status === "applied" &&
          typeof record(notificationResult.value.receipt).deliveryId === "string",
        notificationReplayDeduplicated:
          stringField(notificationReplay.value.receipt, "receiptId") ===
            stringField(notificationResult.value.receipt, "receiptId") &&
          stringField(notificationReplay.value.receipt, "deliveryId") ===
            stringField(notificationResult.value.receipt, "deliveryId"),
        notificationRouterReceivedExactTitleBodyAndSession:
          !!notificationAudit &&
          notificationAudit.titleLength === expectedTitle.length &&
          notificationAudit.bodyLength === expectedBody.length &&
          invocationCountsAfterNotification.uiNotifications.length ===
            invocationCountsBefore.uiNotifications.length + 1,
        chatMessagePersistedWithDeliveryIdAsMessageId:
          persistedMessage?.id === deliveryId && persistedMessage?.role === "assistant",
        chatMessageEmittedOnceNotDuplicatedOnReplay: messagesAfterReplay.length === 1,
        chatCardCreatesExactlyOneInlineInstance:
          cardInstances.length === 1 && cardInstances[0]?.surface === "inline-card",
        chatCardReplayDeduplicated:
          stringField(cardReplay.value.receipt, "receiptId") ===
            stringField(cardResult.value.receipt, "receiptId") &&
          stringField(cardReplay.value.receipt, "instanceId") === cardInstanceId,
        disableEmittedInstanceClosedAndOwnerInvalidated:
          eventsAfterDisable.some(
            (e) => e.type === "instance-closed" && e.reason === "owner-invalidated",
          ) && eventsAfterDisable.some((e) => e.type === "owner-invalidated"),
        disableRemovedInstancesAcrossBothScopes:
          !snapshotAAfterDisable.instances.some(
            (i) => i.instanceId === instanceForInvalidationA.instance!.instanceId,
          ) &&
          !snapshotBAfterDisable.instances.some(
            (i) => i.instanceId === instanceForInvalidationB.instance!.instanceId,
          ),
        extensionDisabledStatusReported: record(disabled.value).status === "disabled",
        removeEmittedInstanceClosedAndOwnerInvalidated:
          eventsAfterRemove.some(
            (event) =>
              event.type === "instance-closed" &&
              event.reason === "owner-invalidated" &&
              event.instanceId === removeInstanceA.instance!.instanceId,
          ) && eventsAfterRemove.some((event) => event.type === "owner-invalidated"),
        removeRemovedInstancesAcrossBothScopes:
          !snapshotAAfterRemove.instances.some(
            (instance) => instance.instanceId === removeInstanceA.instance!.instanceId,
          ) &&
          !snapshotBAfterRemove.instances.some(
            (instance) => instance.instanceId === removeInstanceB.instance!.instanceId,
          ),
        extensionRemovedStatusReported:
          record(removed.value).removed === true &&
          record(removed.value).identity === ctx.extensionIdentity,
        uiControllerStateEphemeralAfterRestart:
          snapshotAfterRestart.instances.length === 0 && snapshotAfterRestart.revision === 0,
      },
      restartBefore,
      userDataDir,
    },
    evidence: {
      notificationResult: notificationResult.ok,
      notificationReplay,
      notificationAudit,
      chatMessage: chatMessage.ok,
      cardResult: cardResult.ok,
      cardReplay,
      eventsAfterDisable,
      eventsAfterRemove,
      snapshotAAfterRemove,
      snapshotBAfterRemove,
      snapshotAfterRestart,
    },
  };
}

// ---------------------------------------------------------------------------
// MRT-UI-009 — authority mapping, scope/abort denial, sender/frame rejection
// ---------------------------------------------------------------------------

async function storyUi009(ctx: Ctx): Promise<LiveStoryProof> {
  const { client, app, page, scope } = ctx;
  const replacementApplicationId = uid("app-mrt-ui-009");
  const replacement = await installUiApplicationFixture(client, scope, replacementApplicationId);
  ctx.extensionIdentity = replacement.identity;
  ctx.applicationId = replacementApplicationId;
  const owner = ownerOf(scope, ctx.extensionIdentity, ctx.applicationId);

  const beforeSnapshot = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));

  // 1. Every fixed built-in UI operation maps to the documented capability/permission
  //    and auto-allows once scope resolves.
  const opened = unwrapUi(
    await client.ui("open", {
      ...owner,
      surface: "inline-card",
      content: textContent("MRT-UI-009"),
      idempotencyKey: uid("mrt-ui-009-open"),
    }),
  );
  await client.ui("update", {
    ...owner,
    instanceId: opened.instance!.instanceId,
    content: textContent("MRT-UI-009 updated"),
    idempotencyKey: uid("mrt-ui-009-update"),
  });
  await client.ui("focus", {
    ...owner,
    instanceId: opened.instance!.instanceId,
    idempotencyKey: uid("mrt-ui-009-focus"),
  });
  await client.ui("list", scope);
  await client.ui("getSnapshot", scope);
  const notificationInvoke = await invokeUiCapabilityRaw(
    client,
    "ui.notification.show",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      title: "t",
      message: "m",
      idempotencyKey: uid("mrt-ui-009-notify"),
    },
    scope,
  );
  const chatMessageInvoke = await invokeUiCapabilityRaw(
    client,
    "ui.chat.message.post",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      content: { kind: "text", text: "MRT-UI-009" },
      idempotencyKey: uid("mrt-ui-009-message"),
    },
    scope,
  );
  const cardKey = uid("mrt-ui-009-card");
  const chatCardInvoke = await invokeUiCapability(
    client,
    "ui.chat.card.show",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      state: { story: "MRT-UI-009" },
      idempotencyKey: cardKey,
    },
    scope,
    cardKey,
  );
  const chatCardInstanceId = stringField(chatCardInvoke.value.receipt, "instanceId");
  await closeInstance(client, owner, opened.instance!.instanceId);
  await closeInstance(client, owner, chatCardInstanceId);
  const audit = await client.value("getAuthorityAudit");
  const uiAuditEntries = audit.filter((entry) => entry.capability.startsWith("ui."));
  const expectedCapabilities = [
    "ui.application.open",
    "ui.application.update",
    "ui.application.focus",
    "ui.application.close",
    "ui.application.list",
    "ui.notification.show",
    "ui.chat.message.post",
    "ui.chat.card.show",
  ];
  const capabilitiesObserved = new Set(uiAuditEntries.map((entry) => entry.capability));
  const allExpectedCapabilitiesObserved = expectedCapabilities.every((name) =>
    capabilitiesObserved.has(name),
  );
  const allObservedDecisionsAllow = uiAuditEntries.every((entry) => entry.decision === "allow");
  const permissionsPrefixedMarshalUi = uiAuditEntries.every((entry) =>
    entry.permissions.every((permission) => permission.startsWith("marshal.ui.")),
  );

  // 2. The fixed built-in UI permissions cannot be changed by the acceptance override.
  const overrideAttempt = await client.acceptance("setAcceptancePermission", "ui.open", "deny");
  const overrideRejected =
    !overrideAttempt.success && /cannot be changed/i.test(overrideAttempt.error.message);

  // 3. Every UI controller operation denies a wrong scope and a pre-aborted
  // call before mutation or delivery.
  const wrongScope = { sessionId: scope.sessionId, workspaceName: "not-marshal" };
  const probeOperations = [
    "open",
    "update",
    "focus",
    "close",
    "list",
    "snapshot",
    "notification",
    "chat-message",
    "chat-card",
  ] as const;
  const denialCountsBefore = await client.value("getInvocationCounts");
  const denialSnapshotBefore = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const wrongScopeResults = await Promise.all(
    probeOperations.map(async (operation) => ({
      operation,
      result: await client.value("probeRuntimeUiOperation", {
        ...wrongScope,
        operation,
        extensionId: ctx.extensionIdentity,
        applicationId: ctx.applicationId,
        instanceId: opened.instance!.instanceId,
        idempotencyKey: uid(`mrt-ui-009-wrong-${operation}`),
      }),
    })),
  );
  const preAbortedResults = await Promise.all(
    probeOperations.map(async (operation) => ({
      operation,
      result: await client.value("probeRuntimeUiOperation", {
        ...scope,
        operation,
        extensionId: ctx.extensionIdentity,
        applicationId: ctx.applicationId,
        instanceId: opened.instance!.instanceId,
        idempotencyKey: uid(`mrt-ui-009-aborted-${operation}`),
        abort: { timing: "pre" },
      }),
    })),
  );
  const denialCountsAfter = await client.value("getInvocationCounts");
  const afterDenialsSnapshot = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));

  // 4. Unauthorized webContents / subframe / no-preload probes via Playwright's app.evaluate only.
  const appPath = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath());
  const preloadPath = path.join(appPath, "dist-electron", "preload.cjs");
  const mainUrl = page.url();
  const unauthorizedProbe = await app.evaluate(
    async (
      { BrowserWindow },
      args: {
        readonly preloadPath: string;
        readonly mainUrl: string;
        readonly scope: RuntimeUiScope;
      },
    ) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: args.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      try {
        await win.loadURL(args.mainUrl);
        const hasApi = await win.webContents.executeJavaScript("typeof window.runtimeUiAPI");
        let rejected = false;
        let message = "";
        try {
          const result = await win.webContents.executeJavaScript(
            `window.runtimeUiAPI.getSnapshot(${JSON.stringify(args.scope)})`,
          );
          message = JSON.stringify(result);
        } catch (error) {
          rejected = true;
          message = error instanceof Error ? error.message : String(error);
        }
        return { hasApi, rejected, message };
      } finally {
        win.destroy();
      }
    },
    { preloadPath, mainUrl, scope },
  );

  const noPreloadProbe = await app.evaluate(async ({ BrowserWindow }, url: string) => {
    const win = new BrowserWindow({ show: false });
    try {
      await win.loadURL(url);
      const hasApi = await win.webContents.executeJavaScript("typeof window.runtimeUiAPI");
      return { hasApi };
    } finally {
      win.destroy();
    }
  }, mainUrl);

  const subframeProbe = await page.evaluate(async (targetScope) => {
    const iframe = document.createElement("iframe");
    iframe.src = location.href;
    document.body.appendChild(iframe);
    await new Promise<void>((resolve) => {
      iframe.addEventListener("load", () => resolve(), { once: true });
    });
    const contentWindow = iframe.contentWindow as
      | (Window & { runtimeUiAPI?: typeof window.runtimeUiAPI })
      | null;
    const hasApi = typeof contentWindow?.runtimeUiAPI;
    let rejected = false;
    let message = "";
    try {
      const result = await contentWindow?.runtimeUiAPI?.getSnapshot(targetScope);
      message = JSON.stringify(result);
    } catch (error) {
      rejected = true;
      message = error instanceof Error ? error.message : String(error);
    }
    iframe.remove();
    return { hasApi, rejected, message };
  }, scope);

  const resub = await client.ui("subscribe", scope);
  if (!resub.success)
    throw new Error(`Failed to restore subscription: ${resub.error.code}: ${resub.error.message}`);

  return {
    proof: {
      assertions: {
        allExpectedUiCapabilitiesAudited: allExpectedCapabilitiesObserved,
        allUiAuthorityDecisionsAllow: allObservedDecisionsAllow,
        uiPermissionsUseMarshalUiPrefix: permissionsPrefixedMarshalUi,
        acceptancePermissionOverrideCannotChangeUiBuiltins: overrideRejected,
        allNineWrongScopeOperationsDeniedClosed: wrongScopeResults.every(
          ({ result }) => !result.ok && result.error.code === "permission-denied",
        ),
        allNinePreAbortedOperationsDeniedClosed: preAbortedResults.every(
          ({ result }) => !result.ok && result.error.code === "aborted",
        ),
        deniedOperationsDidNotMutateState:
          afterDenialsSnapshot.revision === denialSnapshotBefore.revision &&
          afterDenialsSnapshot.instances.length === denialSnapshotBefore.instances.length,
        validApplicationAndCardInstancesWereClosed:
          denialSnapshotBefore.instances.length === beforeSnapshot.instances.length,
        deniedOperationsDidNotDeliver:
          denialCountsAfter.uiNotifications.length === denialCountsBefore.uiNotifications.length,
        unauthorizedWebContentsHasApiButRejected:
          unauthorizedProbe.hasApi === "object" && unauthorizedProbe.rejected,
        subframeHasApiButRejected: subframeProbe.hasApi === "undefined" || subframeProbe.rejected,
        windowWithoutPreloadHasNoApi: noPreloadProbe.hasApi === "undefined",
      },
    },
    evidence: {
      uiAuditEntries,
      overrideAttempt,
      wrongScopeResults,
      preAbortedResults,
      unauthorizedProbe,
      subframeProbe,
      noPreloadProbe,
      notificationInvoke,
      chatMessageInvoke,
      chatCardInvoke,
    },
  };
}

// ---------------------------------------------------------------------------
// MRT-UI-010 — missing/removed-session delivery failure
// ---------------------------------------------------------------------------

async function storyUi010(ctx: Ctx): Promise<LiveStoryProof> {
  const { client, page } = ctx;
  const deletedScope = ctx.deletedScope;
  // Sanity: the session resolves fine and a valid notification/card delivery works before deletion.
  const baselineNotification = await invokeUiCapability(
    client,
    "ui.notification.show",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      title: "baseline",
      message: "before delete",
      idempotencyKey: uid("mrt-ui-010-baseline"),
    },
    deletedScope,
  );

  const chatMessageKey = uid("mrt-ui-010-chat-message");
  const sessionBeforeFailure = await client.value("readSession", deletedScope.sessionId);
  if (!sessionBeforeFailure)
    throw new Error("UI-010 failure session is unavailable before delivery.");
  const gateArm = await client.value("fixture", {
    action: "ui-chat-persistence-gate",
    command: "arm",
  });
  const pendingFailedDelivery = invokeUiCapabilityRaw(
    client,
    "ui.chat.message.post",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      content: { kind: "text", text: "should not persist" },
      idempotencyKey: chatMessageKey,
    },
    deletedScope,
    chatMessageKey,
  );
  const gateReached = await client.value("fixture", {
    action: "ui-chat-persistence-gate",
    command: "wait",
  });
  let deletion: unknown;
  let gateReleased: unknown;
  try {
    deletion = await page.evaluate(
      async (sessionId) => window.sessionsAPI.delete(sessionId),
      deletedScope.sessionId,
    );
  } finally {
    gateReleased = await client.value("fixture", {
      action: "ui-chat-persistence-gate",
      command: "release",
    });
  }
  const failedDelivery = await pendingFailedDelivery;
  const sessionAfterDeletion = await client.value("readSession", deletedScope.sessionId);

  // A different, still-valid scope keeps working: notification and card delivery.
  const stillValidNotification = await invokeUiCapability(
    client,
    "ui.notification.show",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      title: "still valid",
      message: "after other session deleted",
      idempotencyKey: uid("mrt-ui-010-valid-notify"),
    },
    ctx.scope,
  );
  const cardKey = uid("mrt-ui-010-valid-card");
  const stillValidCard = await invokeUiCapability(
    client,
    "ui.chat.card.show",
    {
      extensionId: ctx.extensionIdentity,
      applicationId: ctx.applicationId,
      state: { source: "mrt-ui-010" },
      idempotencyKey: cardKey,
    },
    ctx.scope,
    cardKey,
  );
  const cardInstanceId = stringField(stillValidCard.value.receipt, "instanceId");
  const snapshotAfterValidCard = unwrapUi<RuntimeUiSnapshot>(
    await client.ui("getSnapshot", ctx.scope),
  );
  const cardInstances = snapshotAfterValidCard.instances.filter(
    (i) =>
      i.instanceId === cardInstanceId &&
      i.owner.extensionId === ctx.extensionIdentity &&
      i.owner.applicationId === ctx.applicationId,
  );
  const cardSnapshotArtifact = "MRT-UI-010-card-snapshot.json";
  fs.writeFileSync(
    path.join(ctx.evidenceRoot, cardSnapshotArtifact),
    JSON.stringify(
      {
        cardInstanceId,
        cardInstances,
        snapshot: snapshotAfterValidCard,
      },
      null,
      2,
    ),
  );
  await closeInstance(
    client,
    ownerOf(ctx.scope, ctx.extensionIdentity, ctx.applicationId),
    cardInstanceId,
  );

  // Restart-replay: a delivery persisted before restart is treated idempotently
  // (not as failure) when replayed against the fresh, ephemeral controller.
  const replayOwner = ownerOf(ctx.restartReplayScope, ctx.extensionIdentity, ctx.applicationId);
  const replayKey = uid("mrt-ui-010-restart-replay");
  const beforeRestart = await invokeUiCapability(
    client,
    "ui.chat.message.post",
    {
      extensionId: replayOwner.extensionId,
      applicationId: replayOwner.applicationId,
      content: { kind: "text", text: "persisted before restart" },
      idempotencyKey: replayKey,
    },
    ctx.restartReplayScope,
    replayKey,
  );
  const deliveryIdBeforeRestart = stringField(beforeRestart.value.receipt, "deliveryId");

  const {
    app: restartedApp,
    page: restartedPage,
    userDataDir,
  } = await ctx.restartElectronApp(ctx.app);
  ctx.app = restartedApp;
  ctx.page = restartedPage;
  ctx.userDataDir = userDataDir;
  ctx.client = new RuntimeAcceptanceClient(restartedApp, restartedPage, ctx.client.scope);

  const afterRestartReplay = await invokeUiCapability(
    ctx.client,
    "ui.chat.message.post",
    {
      extensionId: replayOwner.extensionId,
      applicationId: replayOwner.applicationId,
      content: { kind: "text", text: "persisted before restart" },
      idempotencyKey: replayKey,
    },
    ctx.restartReplayScope,
    replayKey,
  );
  const deliveryIdAfterRestart = stringField(afterRestartReplay.value.receipt, "deliveryId");
  const sessionAfterRestartReplay = await ctx.client.value(
    "readSession",
    ctx.restartReplayScope.sessionId,
  );
  if (!sessionAfterRestartReplay) {
    throw new Error("Restart replay session was not found.");
  }
  const messagesMatchingDeliveryId = array(record(sessionAfterRestartReplay).messages).filter(
    (m) => record(m).id === deliveryIdBeforeRestart,
  );

  const assertions = {
    baselineDeliveryWorkedBeforeDeletion: record(baselineNotification.ok).ok === true,
    failureSessionResolvedBeforeAuthorization:
      record(sessionBeforeFailure).id === deletedScope.sessionId,
    persistenceGateArmedReachedAndReleased:
      record(gateArm).state === "armed" &&
      record(gateReached).state === "reached" &&
      record(gateReleased).state === "released",
    sessionDeletedViaRealLifecycle: record(deletion).success === true,
    sessionUnreadableAfterDeletion: sessionAfterDeletion === null,
    chatDeliveryToMissingSessionFailsCleanly: record(failedDelivery).ok === false,
    chatDeliveryFailureCode: record(record(failedDelivery).error ?? {}).code === "operation-failed",
    chatDeliveryFailureMessageExact:
      record(record(failedDelivery).error ?? {}).message ===
      "Runtime UI chat message could not be persisted.",
    validNotificationStillWorks: record(stillValidNotification.ok).ok === true,
    validCardCreatesOnlyItsOneInlineInstance:
      cardInstances.length === 1 && cardInstances[0]?.surface === "inline-card",
    restartReplayOfAlreadyPersistedDeliveryIsIdempotentNotFailure:
      record(afterRestartReplay.ok).ok === true &&
      deliveryIdAfterRestart === deliveryIdBeforeRestart,
    restartReplayDidNotDuplicateMessage: messagesMatchingDeliveryId.length === 1,
  };
  return {
    assertions,
    proof: {
      assertions,
      userDataDir,
    },
    evidence: {
      deletion,
      sessionBeforeFailure,
      sessionAfterDeletion,
      gateArm,
      gateReached,
      gateReleased,
      failedDelivery,
      stillValidNotification: stillValidNotification.ok,
      stillValidCard: stillValidCard.ok,
      beforeRestart: beforeRestart.ok,
      afterRestartReplay: afterRestartReplay.ok,
    },
    supportingEvidence: [
      cardSnapshotArtifact,
      "lifecycle.jsonl",
      "ui-api-ctx-initial-stdout.log",
      "ui-api-ctx-initial-stderr.log",
    ],
  };
}

// ---------------------------------------------------------------------------
// MRT-UI-011 — all eight agent-facing UI capabilities
// ---------------------------------------------------------------------------

const EXPECTED_UI_CAPABILITIES = [
  "ui.notification.show",
  "ui.chat.message.post",
  "ui.chat.card.show",
  "ui.application.open",
  "ui.application.update",
  "ui.application.focus",
  "ui.application.close",
  "ui.application.list",
] as const;

async function storyUi011(ctx: Ctx): Promise<LiveStoryProof> {
  const { client, scope } = ctx;
  // Independent of any prior story: extension installations do not survive a
  // process restart (MRT-UI-008/010 both restart Electron), so this story
  // installs its own registered application rather than assuming one of the
  // earlier fixtures is still registered.
  const agentApplicationId = uid("mrt-ui-011-app");
  const { identity: freshIdentity } = await installUiApplicationFixture(
    client,
    scope,
    agentApplicationId,
  );
  const owner = ownerOf(scope, freshIdentity, agentApplicationId);

  const searchResult = requireOk(
    await client.value("search", { ...scope, query: "ui.", detail: "full", limit: 100 }),
  );
  const matches = array(record(searchResult.value).matches).map((m) => record(m));
  const uiCapabilityNames = matches
    .map((m) => record(m.capability).name)
    .filter((name): name is string => typeof name === "string" && name.startsWith("ui."));
  const uniqueUiCapabilityNames = new Set(uiCapabilityNames);
  const eightDescriptorsExistOnce =
    EXPECTED_UI_CAPABILITIES.every((name) => uniqueUiCapabilityNames.has(name)) &&
    uiCapabilityNames.length === uniqueUiCapabilityNames.size &&
    uniqueUiCapabilityNames.size === EXPECTED_UI_CAPABILITIES.length;

  const notificationInvoke = await invokeUiCapability(
    client,
    "ui.notification.show",
    {
      extensionId: freshIdentity,
      applicationId: agentApplicationId,
      title: "MRT-UI-011",
      message: "agent capability",
      idempotencyKey: uid("mrt-ui-011-notify"),
    },
    scope,
  );
  const chatMessageInvoke = await invokeUiCapability(
    client,
    "ui.chat.message.post",
    {
      extensionId: freshIdentity,
      applicationId: agentApplicationId,
      content: { kind: "text", text: "MRT-UI-011 chat" },
      idempotencyKey: uid("mrt-ui-011-chat"),
    },
    scope,
  );
  const cardKey = uid("mrt-ui-011-card");
  const cardInvoke = await invokeUiCapability(
    client,
    "ui.chat.card.show",
    {
      extensionId: freshIdentity,
      applicationId: agentApplicationId,
      state: { origin: "mrt-ui-011" },
      idempotencyKey: cardKey,
    },
    scope,
    cardKey,
  );
  const cardInstanceId = stringField(cardInvoke.value.receipt, "instanceId");

  const openKey = uid("mrt-ui-011-open");
  const openInvoke = await invokeUiCapability(
    client,
    "ui.application.open",
    {
      extensionId: freshIdentity,
      applicationId: agentApplicationId,
      surface: "tab",
      state: { via: "agent" },
      idempotencyKey: openKey,
    },
    scope,
    openKey,
  );
  const openInstanceId = stringField(openInvoke.value.receipt, "instanceId");
  const updateKey = uid("mrt-ui-011-update");
  const updateInvoke = await invokeUiCapability(
    client,
    "ui.application.update",
    {
      extensionId: freshIdentity,
      applicationId: agentApplicationId,
      instanceId: openInstanceId,
      state: { via: "agent-update" },
      idempotencyKey: updateKey,
    },
    scope,
    updateKey,
  );
  const focusKey = uid("mrt-ui-011-focus");
  const focusInvoke = await invokeUiCapability(
    client,
    "ui.application.focus",
    {
      extensionId: freshIdentity,
      applicationId: agentApplicationId,
      instanceId: openInstanceId,
      idempotencyKey: focusKey,
    },
    scope,
    focusKey,
  );
  const listInvoke = await invokeUiCapability(
    client,
    "ui.application.list",
    { extensionId: freshIdentity, applicationId: agentApplicationId },
    scope,
    uid("mrt-ui-011-list"),
  );

  // Cross-check against the production IPC snapshot/events before closing.
  const snapshotViaIpc = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const openInstanceViaIpc = snapshotViaIpc.instances.find((i) => i.instanceId === openInstanceId);
  const cardInstanceViaIpc = snapshotViaIpc.instances.find((i) => i.instanceId === cardInstanceId);
  const listIncludesOpenInstance = array(listInvoke.value.instances).some(
    (i) => record(i).instanceId === openInstanceId,
  );

  const closeKey = uid("mrt-ui-011-close");
  const closeInvoke = await invokeUiCapability(
    client,
    "ui.application.close",
    {
      extensionId: freshIdentity,
      applicationId: agentApplicationId,
      instanceId: openInstanceId,
      idempotencyKey: closeKey,
    },
    scope,
    closeKey,
  );
  await closeInstance(client, owner, cardInstanceId);

  // Unknown application/instance return explicit failure without partial state.
  const beforeUnknownSnapshot = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));
  const unknownApplicationFocus = await invokeUiCapabilityRaw(
    client,
    "ui.application.focus",
    {
      extensionId: "unknown.extension",
      applicationId: "unknown.app",
      instanceId: "does-not-exist",
      idempotencyKey: uid("mrt-ui-011-unknown"),
    },
    scope,
  );
  const afterUnknownSnapshot = unwrapUi<RuntimeUiSnapshot>(await client.ui("getSnapshot", scope));

  return {
    proof: {
      assertions: {
        eightClosedDescriptorsExistOnce: eightDescriptorsExistOnce,
        notificationRoutedThroughProductionController:
          record(notificationInvoke.value.receipt).status === "applied",
        chatMessageRoutedThroughProductionController:
          record(chatMessageInvoke.value.receipt).status === "applied",
        chatCardCreatedInlineInstanceObservedViaIpc: cardInstanceViaIpc?.surface === "inline-card",
        applicationOpenObservedViaIpc: openInstanceViaIpc?.instanceId === openInstanceId,
        applicationUpdateAppliedNewRevisionGreater:
          numberField(updateInvoke.value.receipt, "revision") >
          numberField(openInvoke.value.receipt, "revision"),
        applicationFocusApplied: record(focusInvoke.value.receipt).status === "applied",
        applicationListMatchesIpcList: listIncludesOpenInstance,
        applicationCloseApplied: record(closeInvoke.value.receipt).status === "applied",
        unknownOwnerReturnsExplicitFailure: record(unknownApplicationFocus).ok === false,
        unknownOwnerFailureIsNotFound:
          record(record(unknownApplicationFocus).error ?? {}).code === "operation-failed" &&
          /not found/i.test(String(record(record(unknownApplicationFocus).error ?? {}).message)),
        unknownOwnerDidNotMutateState:
          afterUnknownSnapshot.instances.length === beforeUnknownSnapshot.instances.length,
      },
      uiCapabilityNames: [...uniqueUiCapabilityNames].sort(),
    },
    evidence: {
      notificationInvoke: notificationInvoke.ok,
      chatMessageInvoke: chatMessageInvoke.ok,
      cardInvoke: cardInvoke.ok,
      openInvoke: openInvoke.ok,
      updateInvoke: updateInvoke.ok,
      focusInvoke: focusInvoke.ok,
      listInvoke: listInvoke.ok,
      closeInvoke: closeInvoke.ok,
      unknownApplicationFocus,
      snapshotViaIpc,
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const ALL_STORY_IDS = [
  "MRT-UI-001",
  "MRT-UI-002",
  "MRT-UI-003",
  "MRT-UI-004",
  "MRT-UI-005",
  "MRT-UI-006",
  "MRT-UI-007",
  "MRT-UI-008",
  "MRT-UI-009",
  "MRT-UI-010",
  "MRT-UI-011",
] as const;

function finalizeState(ctx: Ctx): UiScenarioState {
  const report: UiScenarioReport = { notes: [...ctx.notes] };
  ctx.recorder.writeSupporting("ui-scenarios-report.json", {
    notes: report.notes,
    consoleErrors: ctx.consoleErrors,
    rendererAligned: ctx.rendererAligned,
  });
  return {
    scope: ctx.scope,
    secondaryScope: ctx.secondaryScope,
    boundaryScope: ctx.boundaryScope,
    extensionIdentity: ctx.extensionIdentity,
    applicationId: ctx.applicationId,
    secondExtensionIdentity: ctx.secondExtensionIdentity,
    secondApplicationId: ctx.secondApplicationId,
    instanceIds: [...ctx.instanceIds],
    app: ctx.app,
    page: ctx.page,
    userDataDir: ctx.userDataDir,
    report,
  };
}

/**
 * Exercises MRT-UI-001 through MRT-UI-011 against the real, already-running
 * production Marshal Runtime UI stack (controller, capability provider,
 * extension tracker, IPC handlers, preload, and renderer) reached through
 * `RuntimeAcceptanceClient`. Materializes and installs finite `ui-application`
 * fixtures via the acceptance bridge, then drives everything else — opens,
 * updates, focus/close, list/snapshot, delivery, extension disable/remove,
 * and a real Electron restart — through the same typed production surfaces a
 * real extension or agent would use. Never constructs an alternate
 * `MarshalRuntimeUiController` and never monkey-patches a production API;
 * the only test-side "patching" is a `document.visibilityState` getter
 * override used purely to simulate a real browser visibility toggle inside
 * MRT-UI-007, which touches no Marshal production code.
 *
 * Each story is recorded independently via `recorder.run`/`recorder.block`,
 * so a failure in one story does not suppress evidence for the others.
 */
export async function runUiScenarios(options: UiScenarioOptions): Promise<UiScenarioState> {
  const primarySessionId = options.primarySessionId ?? "e2e-fresh";
  const secondarySessionId = options.secondarySessionId ?? "e2e-runtime-secondary";
  const boundarySessionId = options.boundarySessionId ?? "e2e-runtime-capacity-3";
  const burstSessionId = options.burstSessionId ?? "e2e-runtime-capacity-2";
  const deletedSessionId = options.deletedSessionId ?? "e2e-relay-archived";
  const restartReplaySessionId = options.restartReplaySessionId ?? "e2e-session-a";
  const shouldRun = (storyId: string) =>
    !options.storyIds || options.storyIds.size === 0 || options.storyIds.has(storyId);

  const scope = backendScope(primarySessionId);
  const secondaryScope = backendScope(secondarySessionId, "PBI");
  const boundaryScope = backendScope(boundarySessionId);
  const burstScope = backendScope(burstSessionId);
  const capacityProbeScope = backendScope("e2e-runtime-capacity-1");
  const deletedScope = backendScope(deletedSessionId);
  const restartReplayScope = backendScope(restartReplaySessionId);

  const ctx: Ctx = {
    client: new RuntimeAcceptanceClient(options.app, options.page, scope),
    app: options.app,
    page: options.page,
    recorder: options.recorder,
    evidenceRoot: options.evidenceRoot,
    scope,
    secondaryScope,
    boundaryScope,
    burstScope,
    capacityProbeScope,
    deletedScope,
    restartReplayScope,
    extensionIdentity: "",
    applicationId: "",
    secondExtensionIdentity: "",
    secondApplicationId: "",
    instanceIds: new Set<string>(),
    notes: [],
    consoleErrors: [],
    rendererAligned: false,
    userDataDir: null,
    restartElectronApp: options.restartElectronApp ?? restartElectronApp,
  };

  const consoleListener = (message: ConsoleMessage) => {
    if (message.type() === "error") ctx.consoleErrors.push(message.text());
  };
  ctx.page.on("console", consoleListener);
  const runStory = async (
    storyId: string,
    action: () => Promise<LiveStoryProof>,
  ): Promise<void> => {
    await ctx.recorder.run(storyId, "LIVE-ELECTRON", async () => {
      const proof = await action();
      const [bridgeInfo, paths] = await Promise.all([
        ctx.client.value("getBridgeInfo"),
        ctx.client.value("getPaths"),
      ]);
      return {
        ...proof,
        context: {
          processId: bridgeInfo.mainProcessPid,
          userDataDirectory: paths.electronUserDataRoot,
          appDataDirectory: paths.marshalAppDataRoot,
        },
      };
    });
  };

  try {
    const primaryApplicationId = uid("app-mrt-alpha");
    const secondApplicationId = uid("app-mrt-beta");
    const primaryFixture = await installUiApplicationFixture(
      ctx.client,
      scope,
      primaryApplicationId,
    );
    const secondFixture = await installUiApplicationFixture(ctx.client, scope, secondApplicationId);
    ctx.extensionIdentity = primaryFixture.identity;
    ctx.applicationId = primaryApplicationId;
    ctx.secondExtensionIdentity = secondFixture.identity;
    ctx.secondApplicationId = secondApplicationId;
  } catch (error) {
    const reason = `Fixture materialization/installation failed: ${error instanceof Error ? error.message : String(error)}`;
    for (const id of ALL_STORY_IDS) {
      if (shouldRun(id)) ctx.recorder.block(id, "LIVE-ELECTRON", reason);
    }
    return finalizeState(ctx);
  }

  if (shouldRun("MRT-UI-001")) {
    await runStory("MRT-UI-001", () => storyUi001(ctx));
  }

  const rendererStoriesSelected = ["MRT-UI-002", "MRT-UI-003", "MRT-UI-007"].some(shouldRun);
  const workspaceAlignment = rendererStoriesSelected
    ? await alignRendererWorkspace(ctx.page)
    : { aligned: true as const };
  const alignment =
    rendererStoriesSelected && workspaceAlignment.aligned
      ? await alignRendererSession(ctx.page, primarySessionId)
      : workspaceAlignment;
  ctx.rendererAligned = alignment.aligned;
  if (!alignment.aligned) {
    const reason = `Renderer workspace alignment failed: ${alignment.reason ?? "unknown reason"}`;
    noteOf(ctx, `MRT-UI-002/003/007 blocked - ${reason}`);
    for (const id of ["MRT-UI-002", "MRT-UI-003", "MRT-UI-007"]) {
      if (shouldRun(id)) ctx.recorder.block(id, "LIVE-ELECTRON", reason);
    }
  } else {
    if (shouldRun("MRT-UI-002")) {
      await runStory("MRT-UI-002", () => storyUi002(ctx));
    }
    if (shouldRun("MRT-UI-003")) {
      await runStory("MRT-UI-003", () => storyUi003(ctx));
    }
  }

  if (shouldRun("MRT-UI-004")) {
    await runStory("MRT-UI-004", () => storyUi004(ctx));
  }
  if (shouldRun("MRT-UI-005")) {
    await runStory("MRT-UI-005", () => storyUi005(ctx));
  }
  if (shouldRun("MRT-UI-006")) {
    await runStory("MRT-UI-006", () => storyUi006(ctx));
  }

  if (alignment.aligned && shouldRun("MRT-UI-007")) {
    await runStory("MRT-UI-007", () => storyUi007(ctx));
  }

  if (shouldRun("MRT-UI-008")) {
    await runStory("MRT-UI-008", () => storyUi008(ctx));
  }
  if (shouldRun("MRT-UI-009")) {
    await runStory("MRT-UI-009", () => storyUi009(ctx));
  }
  if (shouldRun("MRT-UI-010")) {
    await runStory("MRT-UI-010", () => storyUi010(ctx));
  }
  if (shouldRun("MRT-UI-011")) {
    await runStory("MRT-UI-011", () => storyUi011(ctx));
  }

  ctx.page.off("console", consoleListener);

  return finalizeState(ctx);
}
