import { describe, expect, it } from "vitest";

import type {
  RuntimeUiApplicationContent,
  RuntimeUiOwner,
  RuntimeUiResult,
} from "../../common/runtime-ui";
import { MarshalRuntimeUiController, type RuntimeUiControllerLimits } from "./ui-controller";

const owner: RuntimeUiOwner = {
  sessionId: "session-1",
  workspaceName: "workspace-1",
  extensionId: "extension.one",
  applicationId: "application.one",
};

function action(id: string, capability: string, risk: "read" | "write") {
  return {
    id,
    version: "1.0.0",
    target: { kind: "capability" as const, capability },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    allowedScopes: ["session" as const],
    requiredPermissions: [],
    risk,
    idempotency: "none" as const,
  };
}

const content = {
  kind: "application",
  renderId: "test-renderer",
  resource: { uri: "ui://test/application", mimeType: "text/html" },
  descriptor: {
    version: "1.0.0",
    presentationModes: ["inline"],
    actions: [action("poll", "demo.read", "read"), action("type", "demo.write", "write")],
    tools: [],
  },
} satisfies RuntimeUiApplicationContent;

function createHarness(limits: RuntimeUiControllerLimits) {
  let now = Date.parse("2026-09-29T08:00:00.000Z");
  const controller = new MarshalRuntimeUiController(
    () => now,
    (request) => ({ allowed: true, scope: request.scope }),
    { notification: () => {}, chatMessage: () => {}, chatCard: () => {} },
    limits,
  );
  const open = async (idempotencyKey: string): Promise<string> => {
    const result = await controller.open({
      ...owner,
      surface: "inline-card",
      content,
      idempotencyKey,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.instance!.instanceId;
  };
  const call = (instanceId: string, capability?: string) =>
    controller.resolveApplicationCall({ ...owner, instanceId, capability });
  return {
    controller,
    open,
    call,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function expectRateLimited(result: RuntimeUiResult<unknown>): void {
  expect(result).toMatchObject({
    ok: false,
    error: { code: "operation-failed", message: expect.stringContaining("wait a moment") },
  });
}

describe("Runtime UI application call budgets", () => {
  it("keeps application bridge calls off the session-wide ui.* command budget", async () => {
    const harness = createHarness({ maxCommandsPerWindow: 2 });
    const instanceId = await harness.open("card");
    for (let index = 0; index < 50; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- calls are consumed in order
      expect((await harness.call(instanceId, "demo.read")).ok).toBe(true);
      // eslint-disable-next-line no-await-in-loop -- calls are consumed in order
      expect((await harness.call(instanceId, "demo.write")).ok).toBe(true);
    }
    expect((await harness.controller.list(owner)).ok).toBe(true);
    expect(await harness.controller.list(owner)).toMatchObject({
      ok: false,
      error: { message: "Runtime UI command rate limit was exceeded." },
    });
  });

  it("budgets each instance separately so one chatty view cannot starve another", async () => {
    const harness = createHarness({ maxInstanceCallsPerWindow: 3, rateWindowMs: 1_000 });
    const chatty = await harness.open("chatty");
    const quiet = await harness.open("quiet");
    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- calls are consumed in order
      expect((await harness.call(chatty, "demo.write")).ok).toBe(true);
    }
    expectRateLimited(await harness.call(chatty, "demo.write"));
    expect((await harness.call(quiet, "demo.write")).ok).toBe(true);
    harness.advance(1_001);
    expect((await harness.call(chatty, "demo.write")).ok).toBe(true);
  });

  it("budgets read-risk actions and resource reads apart from writes", async () => {
    const harness = createHarness({
      maxInstanceCallsPerWindow: 2,
      maxInstanceReadsPerWindow: 4,
    });
    const instanceId = await harness.open("terminal");
    for (let index = 0; index < 2; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- calls are consumed in order
      expect((await harness.call(instanceId, "demo.read")).ok).toBe(true);
      // eslint-disable-next-line no-await-in-loop -- calls are consumed in order
      expect((await harness.call(instanceId)).ok).toBe(true);
    }
    expectRateLimited(await harness.call(instanceId, "demo.read"));
    expect((await harness.call(instanceId, "demo.write")).ok).toBe(true);
    expect((await harness.call(instanceId, "undeclared.capability")).ok).toBe(true);
    expectRateLimited(await harness.call(instanceId, "demo.write"));
  });

  it("returns not-found for instances outside the caller's owner scope", async () => {
    const harness = createHarness({});
    const instanceId = await harness.open("card");
    const result = await harness.controller.resolveApplicationCall({
      ...owner,
      sessionId: "session-2",
      instanceId,
      capability: "demo.read",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});
