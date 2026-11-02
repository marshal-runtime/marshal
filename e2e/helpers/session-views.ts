import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Locator, type Page } from "@playwright/test";

import { E2E_DATA_DIR } from "../../electron/mock-mode";

/** Helpers shared by the isolated session-view E2Es (dock, cards, phone). */
export const SESSION_SCOPE = { sessionId: "e2e-fresh", workspaceName: "marshal" } as const;
export const AUTHORED_OWNER = "marshal.react-ui";

export function requireRunRoot(): string {
  const runRoot = process.env.MARSHAL_PLACEMENT_RUN_ROOT?.trim();
  if (!runRoot || !path.isAbsolute(runRoot)) {
    throw new Error("MARSHAL_PLACEMENT_RUN_ROOT (absolute) is required.");
  }
  if (!os.tmpdir().startsWith(runRoot)) {
    throw new Error(`TMPDIR must live inside the run root (tmpdir=${os.tmpdir()}).`);
  }
  return runRoot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function pick(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** The string at a JSON path, or "" when it is missing or not a string. */
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export interface LayoutView {
  readonly instanceId: string;
  readonly placement: string;
  readonly title: string;
  readonly dock?: { readonly region: string; readonly active: boolean };
}

function isLayoutView(value: unknown): value is LayoutView {
  return (
    isRecord(value) &&
    typeof value.instanceId === "string" &&
    typeof value.placement === "string" &&
    typeof value.title === "string"
  );
}

/** The views `ui.layout.get` reports for the test session. */
export async function layoutViews(page: Page): Promise<readonly LayoutView[]> {
  const report = await invokeCapability(
    page,
    "ui.layout.get",
    {},
    `layout-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const views = pick(report, "views");
  return Array.isArray(views) ? views.filter(isLayoutView) : [];
}

export function requireView(views: readonly LayoutView[], titlePart: string): LayoutView {
  const view = views.find((candidate) => candidate.title.includes(titlePart));
  if (!view) throw new Error(`ui.layout.get has no view titled like ${titlePart}`);
  return view;
}

export async function requireBox(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no bounding box");
  return box;
}

/** Presses at `from`, moves to `to` in steps (so HTML5 drag starts), and releases. */
export async function dragMouse(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  beforeDrop?: () => Promise<void>,
): Promise<void> {
  const steps = 12;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    // eslint-disable-next-line no-await-in-loop -- the drag needs each move in order
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / steps,
      from.y + ((to.y - from.y) * step) / steps,
    );
  }
  await beforeDrop?.();
  await page.mouse.up();
}

/** Invokes a runtime capability through the acceptance bridge and unwraps its output. */
export async function invokeCapability(
  page: Page,
  capability: string,
  input: unknown,
  key: string,
  evidence?: Record<string, unknown>[],
): Promise<unknown> {
  const raw: unknown = await page.evaluate(
    async (request) => {
      const holder: unknown = Reflect.get(window, "runtimeAcceptanceAPI");
      if (typeof holder !== "object" || holder === null) throw new Error("no acceptance API");
      const operation: unknown = Reflect.get(holder, "invoke");
      if (typeof operation !== "function") throw new Error("invoke unavailable");
      return Reflect.apply(operation, holder, [request]) as unknown;
    },
    { ...SESSION_SCOPE, capability, input, idempotencyKey: key },
  );
  evidence?.push({ capability, key, raw: JSON.parse(JSON.stringify(raw ?? null)) });
  if (pick(raw, "success") === false) {
    throw new Error(`${capability} bridge failed: ${JSON.stringify(pick(raw, "error"))}`);
  }
  const inner = pick(raw, "value") ?? raw;
  if (pick(inner, "ok") === false) {
    throw new Error(`${capability} failed: ${JSON.stringify(pick(inner, "error"))}`);
  }
  const output = pick(inner, "value", "output") ?? pick(inner, "output");
  if (pick(output, "ok") === false) {
    throw new Error(`${capability} failed: ${JSON.stringify(pick(output, "error"))}`);
  }
  return pick(output, "value") ?? output;
}

export async function acceptanceWorkspaceRoot(page: Page): Promise<string> {
  const paths: unknown = await page.evaluate(async () => {
    const holder: unknown = Reflect.get(window, "runtimeAcceptanceAPI");
    const operation: unknown = holder ? Reflect.get(holder as object, "getPaths") : undefined;
    return typeof operation === "function"
      ? ((await Reflect.apply(operation, holder, [])) as unknown)
      : null;
  });
  const root = text(pick(paths, "value", "workspaceRoot"));
  expect(root, `acceptance paths: ${JSON.stringify(paths)}`).not.toBe("");
  return root;
}

/** Grants the portable-ui tools in the isolated test profile only. */
export function grantPortableUi(): void {
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
      "tool:runtime-portable-ui:ui.applications.list": true,
    },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

/** Gives the fresh session a short conversation with one `<!--ui:demo-->` slot. */
export function seedSlotConversation(): void {
  const file = path.join(E2E_DATA_DIR, "marshal-sessions", "e2e-fresh.json");
  const session: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(session)) throw new Error("Seeded session is not an object.");
  const base = Date.now() - 10 * 60_000;
  session.messages = [
    {
      id: "seed-user-1",
      role: "user",
      content: "Show me the status widget.",
      timestamp: new Date(base).toISOString(),
    },
    {
      id: "seed-assistant-1",
      role: "assistant",
      content: "Here is the widget:\n\n<!--ui:demo-->\n\nIt updates in place.",
      timestamp: new Date(base + 5_000).toISOString(),
    },
    {
      id: "seed-user-2",
      role: "user",
      content: "Thanks.",
      timestamp: new Date(base + 60_000).toISOString(),
    },
  ];
  fs.writeFileSync(file, JSON.stringify(session));
}

/** Compiles the card fixture into the scope workspace and returns a render factory. */
export async function cardRenderer(
  page: Page,
  evidence?: Record<string, unknown>[],
): Promise<(label: string) => Promise<string>> {
  const workspaceRoot = await acceptanceWorkspaceRoot(page);
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
  fs.copyFileSync(path.join(fixtures, "card-note.tsx"), path.join(workspaceRoot, "card-note.tsx"));
  const compiled = await invokeCapability(
    page,
    "ui.compile",
    { entryPath: "card-note.tsx", title: "Card note" },
    "compile-card-note",
    evidence,
  );
  const componentId = text(pick(compiled, "component", "id"));
  expect(componentId, "compiled component id").not.toBe("");
  return async (label) => {
    const rendered = await invokeCapability(
      page,
      "ui.render",
      { componentId, props: { label }, fallback: { summary: label } },
      `render-${label}`,
      evidence,
    );
    const renderId = text(pick(rendered, "render", "id"));
    expect(renderId, `render id for ${label}`).toMatch(/^[a-f0-9]{64}$/);
    return renderId;
  };
}
