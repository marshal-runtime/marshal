import type { InvocationContext } from "@marshal/runtime";
import { describe, expect, it, vi } from "vitest";

import type { AppRestartExecutor, AppRestartOutcome } from "../app-restart-executor";
import { testDouble } from "../testing/harness/test-double";
import { APP_RESTART_CAPABILITY, createAppLifecycleProvider } from "./app-lifecycle-provider";
import { MARSHAL_RUNTIME_PERMISSION } from "./contracts";

function context(sessionId?: string): InvocationContext {
  return testDouble<InvocationContext>({
    scope: sessionId ? testDouble({ sessionId }) : testDouble({}),
    metadata: { marshalWorkspaceName: "Engineering" },
  });
}

function executorDouble(outcome: AppRestartOutcome): {
  executor: AppRestartExecutor;
  requestRestart: ReturnType<typeof vi.fn>;
} {
  const requestRestart = vi.fn<AppRestartExecutor["requestRestart"]>().mockResolvedValue(outcome);
  return { executor: { requestRestart }, requestRestart };
}

const SCHEDULED: AppRestartOutcome = {
  status: "scheduled",
  delayMs: 2_000,
  ledgerEntryId: "ledger-1",
  overriddenBusySessions: [],
  message: "Restart scheduled in 2000ms. The app will relaunch and restore sessions.",
};

describe("createAppLifecycleProvider", () => {
  it("lists one marshal.app.restart descriptor with closed schemas and high risk", async () => {
    const { executor } = executorDouble(SCHEDULED);
    const provider = createAppLifecycleProvider(executor);
    const descriptors = await provider.list(context("sess-42"));
    expect(descriptors).toHaveLength(1);
    const descriptor = descriptors[0];
    expect(descriptor.name).toBe(APP_RESTART_CAPABILITY);
    expect(descriptor.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["reason"],
    });
    expect(descriptor.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(descriptor.permissions).toEqual([
      expect.objectContaining({ permission: MARSHAL_RUNTIME_PERMISSION.appRestart, risk: "high" }),
    ]);
    expect(await provider.get?.(APP_RESTART_CAPABILITY, context("sess-42"))).toBe(descriptor);
    expect(await provider.get?.("marshal.app.unknown", context("sess-42"))).toBeUndefined();
  });

  it("invokes the executor with the requester session id from context scope", async () => {
    const { executor, requestRestart } = executorDouble(SCHEDULED);
    const provider = createAppLifecycleProvider(executor);
    const result = await provider.invoke(
      APP_RESTART_CAPABILITY,
      { reason: "reload runtime packs", force: false, delayMs: 1_000 },
      context("sess-42"),
    );
    expect(requestRestart).toHaveBeenCalledWith({
      requesterSessionId: "sess-42",
      reason: "reload runtime packs",
      force: false,
      delayMs: 1_000,
    });
    expect(result.output).toEqual({
      status: "scheduled",
      delayMs: 2_000,
      ledgerEntryId: "ledger-1",
      overriddenBusySessions: [],
      message: SCHEDULED.message,
    });
  });

  it("returns a structured refusal listing busy sessions, omitting undefined labels", async () => {
    const { executor } = executorDouble({
      status: "refused",
      busySessions: [
        { sessionId: "other-1", label: "mobile lane" },
        { sessionId: "other-2", label: undefined },
      ],
      message: "Refused: other agent sessions are busy.",
    });
    const provider = createAppLifecycleProvider(executor);
    const result = await provider.invoke(
      APP_RESTART_CAPABILITY,
      { reason: "restart please" },
      context("sess-42"),
    );
    expect(result.output).toEqual({
      status: "refused",
      busySessions: [{ sessionId: "other-1", label: "mobile lane" }, { sessionId: "other-2" }],
      message: "Refused: other agent sessions are busy.",
    });
  });

  it("throws invalid_request when the executor reports invalid input", async () => {
    const { executor } = executorDouble({ status: "invalid", message: "reason required" });
    const provider = createAppLifecycleProvider(executor);
    await expect(
      provider.invoke(APP_RESTART_CAPABILITY, { reason: "x" }, context("sess-42")),
    ).rejects.toMatchObject({ code: "invalid_request", message: "reason required" });
  });

  it("rejects unknown input keys before reaching the executor", async () => {
    const { executor, requestRestart } = executorDouble(SCHEDULED);
    const provider = createAppLifecycleProvider(executor);
    await expect(
      provider.invoke(APP_RESTART_CAPABILITY, { reason: "ok", exitCode: 1 }, context("sess-42")),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it("rejects non-string reason and non-boolean force", async () => {
    const { executor, requestRestart } = executorDouble(SCHEDULED);
    const provider = createAppLifecycleProvider(executor);
    await expect(
      provider.invoke(APP_RESTART_CAPABILITY, { reason: 7 }, context("sess-42")),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      provider.invoke(APP_RESTART_CAPABILITY, { reason: "ok", force: "yes" }, context("sess-42")),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it("requires a session scope", async () => {
    const { executor, requestRestart } = executorDouble(SCHEDULED);
    const provider = createAppLifecycleProvider(executor);
    await expect(
      provider.invoke(APP_RESTART_CAPABILITY, { reason: "ok" }, context()),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it("throws not_found for an unknown capability name", async () => {
    const { executor } = executorDouble(SCHEDULED);
    const provider = createAppLifecycleProvider(executor);
    await expect(
      provider.invoke("marshal.app.shutdown", { reason: "ok" }, context("sess-42")),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
