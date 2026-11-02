import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeUiApplicationContent,
  RuntimeUiAuthorityDecision,
  RuntimeUiAuthorityRequest,
  RuntimeUiEvent,
  RuntimeUiOpenCommand,
  RuntimeUiOwner,
  RuntimeUiResult,
  RuntimeUiSurface,
} from "../../common/runtime-ui";
import {
  MarshalRuntimeUiController,
  runtimeUiInstanceId,
  type RuntimeUiAuthority,
  type RuntimeUiDeliveryPorts,
} from "./ui-controller";

const owner: RuntimeUiOwner = {
  sessionId: "session-1",
  workspaceName: "workspace-1",
  extensionId: "extension.one",
  applicationId: "application.one",
};

const textContent = { kind: "text" as const, text: "Hello" };
const markdownContent = { kind: "markdown" as const, markdown: "**Hello**" };

function createHarness(options?: {
  readonly authority?: RuntimeUiAuthority;
  readonly limits?: ConstructorParameters<typeof MarshalRuntimeUiController>[3];
  readonly issueDocumentAccess?: ConstructorParameters<typeof MarshalRuntimeUiController>[4];
}) {
  let now = Date.parse("2026-08-14T08:00:00.000Z");
  const authority =
    options?.authority ??
    vi.fn<RuntimeUiAuthority>(
      (request: RuntimeUiAuthorityRequest): RuntimeUiAuthorityDecision => ({
        allowed: true,
        scope: request.scope,
      }),
    );
  const delivery: RuntimeUiDeliveryPorts = {
    notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
    chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
    chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
  };
  const controller = new MarshalRuntimeUiController(
    () => now,
    authority,
    delivery,
    options?.limits,
    options?.issueDocumentAccess,
  );
  return {
    authority,
    controller,
    delivery,
    advance(milliseconds = 1_000) {
      now += milliseconds;
    },
  };
}

function openCommand(
  surface: RuntimeUiSurface,
  idempotencyKey = `open-${surface}`,
): RuntimeUiOpenCommand {
  return {
    ...owner,
    surface,
    content: textContent,
    idempotencyKey,
  };
}

function expectError(result: RuntimeUiResult<unknown>, code: string): void {
  expect(result).toMatchObject({ ok: false, error: { code } });
}

describe("CF-05 host stream push: transient delivery-stream events", () => {
  it("notifies subscribers with an enriched owner-scoped event without polluting snapshot history", async () => {
    const { controller } = createHarness();
    const events: RuntimeUiEvent[] = [];
    controller.subscribe((event) => events.push(event));

    controller.publishDeliveryStream(owner, {
      requestId: "codereview:pr-8:ask-1",
      streamSequence: 1,
      chunk: { kind: "text", text: "The " },
      terminal: false,
    });
    controller.publishDeliveryStream(owner, {
      requestId: "codereview:pr-8:ask-1",
      streamSequence: 2,
      chunk: { kind: "status", text: "processed" },
      terminal: true,
      terminalState: "processed",
    });

    expect(events).toHaveLength(2);
    const streamEvents = events.filter(
      (event): event is Extract<RuntimeUiEvent, { type: "delivery-stream" }> =>
        event.type === "delivery-stream",
    );
    const [first, second] = streamEvents;
    if (!first || !second) throw new Error("Expected two delivery-stream events");
    expect(first.type).toBe("delivery-stream");
    expect(first.owner).toMatchObject({
      extensionId: owner.extensionId,
      applicationId: owner.applicationId,
    });
    expect(first.scope).toMatchObject({
      sessionId: owner.sessionId,
      workspaceName: owner.workspaceName,
    });
    expect(first.requestId).toBe("codereview:pr-8:ask-1");
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(typeof first.occurredAt).toBe("string");
    expect(second.terminal).toBe(true);

    // Transient: stream chunks are push-only and never replayed from snapshots.
    const snapshot = await controller.snapshot(owner);
    if (!snapshot.ok) throw new Error("snapshot failed");
    expect(snapshot.value.events.filter((event) => event.type === "delivery-stream")).toHaveLength(
      0,
    );
  });
});

describe("MarshalRuntimeUiController", () => {
  it("keeps persistent user/workspace applications separate from session ownership and invalidates only their extension", async () => {
    const { controller } = createHarness();
    const persistentOwner: RuntimeUiOwner = {
      applicationScope: "user",
      workspaceName: "marshal",
      extensionId: "extension.one",
      applicationId: "navigation.one",
    };
    const first = await controller.open({
      ...persistentOwner,
      surface: "tab",
      content: textContent,
      idempotencyKey: "navigation-open",
    });
    const secondOwner = { ...persistentOwner, extensionId: "extension.two" };
    const second = await controller.open({
      ...secondOwner,
      surface: "tab",
      content: markdownContent,
      idempotencyKey: "navigation-open",
    });
    expect(first.ok && first.value.instance?.owner).toEqual(persistentOwner);
    expect(second.ok).toBe(true);
    const sessionSnapshot = await controller.snapshot({
      sessionId: "session-1",
      workspaceName: "marshal",
    });
    expect(sessionSnapshot.ok && sessionSnapshot.value.instances).toHaveLength(0);
    const workspaceSnapshot = await controller.snapshot({
      applicationScope: "workspace",
      workspaceName: "marshal",
    });
    expect(workspaceSnapshot.ok && workspaceSnapshot.value.instances).toHaveLength(0);
    const userSnapshot = await controller.snapshot(persistentOwner);
    expect(userSnapshot.ok && userSnapshot.value.instances).toHaveLength(2);
    controller.invalidateOwner(persistentOwner);
    const afterDisable = await controller.snapshot(persistentOwner);
    expect(
      afterDisable.ok && afterDisable.value.instances.map((instance) => instance.owner.extensionId),
    ).toEqual(["extension.two"]);
    const restored = await controller.open({
      ...persistentOwner,
      surface: "tab",
      content: textContent,
      idempotencyKey: "navigation-reenable",
    });
    expect(restored.ok).toBe(true);
    const afterRestore = await controller.snapshot(persistentOwner);
    expect(afterRestore.ok && afterRestore.value.instances).toHaveLength(2);
  });

  it("rejects mixed persistent/session owners and chat delivery without an actual session", async () => {
    const { controller, delivery } = createHarness();
    const mixed = await controller.open({ ...openCommand("tab"), applicationScope: "user" });
    expectError(mixed, "invalid-request");
    const persistentOwner: RuntimeUiOwner = {
      applicationScope: "user",
      workspaceName: "marshal",
      extensionId: "extension.one",
      applicationId: "navigation.one",
    };
    expectError(
      await controller.postChatMessage({
        ...persistentOwner,
        content: textContent,
        idempotencyKey: "message",
      }),
      "invalid-request",
    );
    expectError(
      await controller.showChatCard({
        ...persistentOwner,
        content: textContent,
        idempotencyKey: "card",
      }),
      "invalid-request",
    );
    expect(delivery.chatMessage).not.toHaveBeenCalled();
    expect(delivery.chatCard).not.toHaveBeenCalled();
  });

  it("mints document read capabilities instead of trusting caller-supplied values", async () => {
    const issueDocumentAccess = vi.fn<(filePath: string) => string>(
      (filePath) => `read:${filePath}`,
    );
    const { controller } = createHarness({ issueDocumentAccess });

    const opened = await controller.open({
      ...openCommand("panel"),
      content: {
        kind: "file",
        path: "/tmp/report.md",
        readCapability: "caller-supplied",
      },
    });

    expect(issueDocumentAccess).toHaveBeenCalledWith("/tmp/report.md");
    expect(opened.ok && opened.value.instance?.content).toEqual({
      kind: "file",
      path: "/tmp/report.md",
      readCapability: "read:/tmp/report.md",
    });
  });

  it("opens, updates, focuses, lists, and closes every surface with immutable events", async () => {
    const { advance, controller } = createHarness();
    const events: unknown[] = [];
    controller.subscribe((event) => events.push(event));

    const surfaces = ["inline-card", "fullscreen", "tab", "panel"] as const;
    const openedSurfaces = await Promise.all(
      surfaces.map((surface) => controller.open(openCommand(surface))),
    );
    openedSurfaces.forEach((opened, index) => {
      const surface = surfaces[index];
      expect(opened.ok && opened.value.instance?.surface).toBe(surface);
      expect(opened.ok && Object.isFrozen(opened.value.instance)).toBe(true);
    });
    const listed = await controller.list(owner);
    expect(listed.ok && listed.value.instances).toHaveLength(4);

    const first = listed.ok ? listed.value.instances?.[0] : undefined;
    expect(first).toBeDefined();
    advance();
    const updated = await controller.update({
      ...owner,
      instanceId: first!.instanceId,
      content: markdownContent,
      idempotencyKey: "update-1",
    });
    expect(updated.ok && updated.value.instance?.content).toEqual(markdownContent);
    advance();
    const focused = await controller.focus({
      ...owner,
      instanceId: first!.instanceId,
      idempotencyKey: "focus-1",
    });
    expect(focused.ok && focused.value.instance?.focusedAt).not.toBe(first!.focusedAt);
    const closed = await controller.close({
      ...owner,
      instanceId: first!.instanceId,
      idempotencyKey: "close-1",
    });
    expect(closed.ok).toBe(true);
    expect(events).toHaveLength(7);
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it("moves an open instance to another surface through focus, keeping its identity", async () => {
    const { controller } = createHarness();
    const opened = await controller.open(openCommand("inline-card", "move-me"));
    const instanceId = opened.ok ? opened.value.instance!.instanceId : "";

    const moved = await controller.focus({
      ...owner,
      instanceId,
      surface: "bottom-panel",
      idempotencyKey: "move-1",
    });
    expect(moved.ok && moved.value.instance).toMatchObject({ instanceId, surface: "bottom-panel" });

    const bogusMove = { ...owner, instanceId, idempotencyKey: "move-2" };
    Reflect.set(bogusMove, "surface", "sidebar");
    const bogus = await controller.focus(bogusMove);
    expect(bogus.ok).toBe(false);
  });

  it("derives stable collision-resistant IDs from exact owner scope and idempotency key", async () => {
    const firstHarness = createHarness();
    const secondHarness = createHarness();
    const command = openCommand("panel", "stable-key");
    const expected = runtimeUiInstanceId(command);
    const first = await firstHarness.controller.open(command);
    const second = await secondHarness.controller.open(command);

    expect(first.ok && first.value.instance?.instanceId).toBe(expected);
    expect(second.ok && second.value.instance?.instanceId).toBe(expected);
    expect(expected).toMatch(/^rui_[a-f0-9]{64}$/);
    expect(runtimeUiInstanceId({ ...command, workspaceName: "workspace-2" })).not.toBe(expected);
    expect(runtimeUiInstanceId({ ...command, extensionId: "extension.two" })).not.toBe(expected);
    expect(runtimeUiInstanceId({ ...command, applicationId: "application.two" })).not.toBe(
      expected,
    );
    expect(runtimeUiInstanceId({ ...command, idempotencyKey: "other" })).not.toBe(expected);
  });

  it("deduplicates identical commands and rejects conflicting idempotency reuse", async () => {
    const { controller } = createHarness();
    const command = openCommand("tab", "same-key");
    const first = await controller.open(command);
    const replay = await controller.open(command);
    const conflict = await controller.open({
      ...command,
      content: markdownContent,
    });

    expect(first.ok && first.value.receipt.status).toBe("applied");
    expect(replay.ok && replay.value.receipt.status).toBe("deduplicated");
    expect(replay.ok && replay.value.instance?.instanceId).toBe(
      first.ok ? first.value.instance?.instanceId : undefined,
    );
    expectError(conflict, "idempotency-conflict");
  });

  it("produces reconnect-complete scoped immutable serializable snapshots", async () => {
    const { controller } = createHarness();
    await controller.open(openCommand("panel"));
    await controller.open({
      ...openCommand("tab", "other-scope"),
      sessionId: "session-2",
    });
    const snapshot = await controller.snapshot(owner);

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.instances).toHaveLength(1);
    expect(snapshot.value.events).toHaveLength(1);
    expect(snapshot.value.instances[0].content).toEqual(textContent);
    expect(Object.isFrozen(snapshot.value)).toBe(true);
    expect(Object.isFrozen(snapshot.value.instances)).toBe(true);
    expect(() => JSON.stringify(snapshot.value)).not.toThrow();
  });

  it("enforces exact scope, ownership, denial, and cancellation", async () => {
    const mismatched = createHarness({
      authority: (request) => ({
        allowed: true,
        scope: { ...request.scope, workspaceName: "other" },
      }),
    });
    expectError(await mismatched.controller.open(openCommand("panel")), "permission-denied");

    const denied = createHarness({
      authority: () => ({ allowed: false, reason: "blocked" }),
    });
    expectError(await denied.controller.open(openCommand("panel")), "permission-denied");

    const { controller } = createHarness();
    const opened = await controller.open(openCommand("panel"));
    const instanceId = opened.ok ? opened.value.instance!.instanceId : "";
    const wrongScope = await controller.update({
      ...owner,
      workspaceName: "wrong",
      instanceId,
      content: markdownContent,
      idempotencyKey: "wrong-scope",
    });
    expectError(wrongScope, "not-found");
    const wrongOwner = await controller.focus({
      ...owner,
      extensionId: "extension.two",
      instanceId,
      idempotencyKey: "wrong-owner",
    });
    expectError(wrongOwner, "not-found");

    const aborted = new AbortController();
    aborted.abort();
    expectError(await controller.open(openCommand("tab", "aborted"), aborted.signal), "aborted");
  });

  it("rejects HTML-like kinds, prototype pollution, non-plain values, depth, bytes, and strings", async () => {
    const { controller } = createHarness({
      limits: {
        maxPayloadBytes: 256,
        maxPayloadDepth: 3,
        maxStringLength: 32,
      },
    });
    const htmlContent = { kind: "text" as const, text: "safe" };
    Reflect.set(htmlContent, "kind", "html");
    Reflect.set(htmlContent, "html", "<b>unsafe</b>");
    const invalidKind = await controller.open({
      ...openCommand("panel", "html"),
      content: htmlContent,
    });
    expectError(invalidKind, "invalid-request");

    const polluted = { kind: "text" as const, text: "safe" };
    Object.defineProperty(polluted, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    expectError(
      await controller.open({
        ...openCommand("panel", "polluted"),
        content: polluted,
      }),
      "invalid-request",
    );
    const nonPlain = { kind: "text" as const, text: "safe" };
    Object.setPrototypeOf(nonPlain, { inherited: true });
    expectError(
      await controller.open({
        ...openCommand("panel", "date"),
        content: nonPlain,
      }),
      "invalid-request",
    );
    const deep = { kind: "text" as const, text: "safe" };
    Reflect.set(deep, "extra", { a: { b: { c: { d: true } } } });
    expectError(
      await controller.open({
        ...openCommand("panel", "depth"),
        content: deep,
      }),
      "invalid-request",
    );
    const invalidDescriptor = { kind: "text" as const, text: "safe" };
    Reflect.set(invalidDescriptor, "kind", "application");
    Reflect.set(invalidDescriptor, "descriptor", {});
    Reflect.deleteProperty(invalidDescriptor, "text");
    expectError(
      await controller.open({
        ...openCommand("panel", "descriptor"),
        content: invalidDescriptor,
      }),
      "invalid-request",
    );
    expectError(
      await controller.open({
        ...openCommand("panel", "string"),
        content: { kind: "text", text: "x".repeat(33) },
      }),
      "invalid-request",
    );
    expectError(
      await controller.open({
        ...openCommand("panel", "bytes"),
        content: { kind: "text", text: "é".repeat(32) },
      }),
      "invalid-request",
    );
  });

  it("accepts application descriptors and preserves declarative application state", async () => {
    const { controller } = createHarness();
    const content = {
      kind: "application",
      renderId: "test-renderer",
      resource: { uri: "ui://test/application", mimeType: "text/html" },
      descriptor: {
        version: "1.0.0",
        presentationModes: ["inline"],
        actions: [],
        tools: [],
      },
      state: { count: 1, values: ["one", true, null] },
    } satisfies RuntimeUiApplicationContent;
    const result = await controller.open({
      ...openCommand("fullscreen", "application"),
      content,
    });

    expect(result.ok && result.value.instance?.content).toEqual(content);
  });

  it("does not cap active instances per session", async () => {
    const { controller } = createHarness({ limits: { maxCommandsPerWindow: 1_000 } });
    const opened = await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        controller.open(openCommand("panel", `instance-${index}`)),
      ),
    );
    expect(opened.every((result) => result.ok)).toBe(true);
  });

  it("bounds event history, command rate, and idempotency storage", async () => {
    const history = createHarness({
      limits: { maxEventHistory: 2, maxCommandsPerWindow: 10 },
    });
    const historyOpen = await history.controller.open(openCommand("panel", "history"));
    const historyInstanceId = historyOpen.ok ? historyOpen.value.instance!.instanceId : "";
    await history.controller.update({
      ...owner,
      instanceId: historyInstanceId,
      content: markdownContent,
      idempotencyKey: "history-update",
    });
    await history.controller.focus({
      ...owner,
      instanceId: historyInstanceId,
      idempotencyKey: "history-focus",
    });
    const historySnapshot = await history.controller.snapshot(owner);
    expect(historySnapshot.ok && historySnapshot.value.events).toHaveLength(2);
    expect(historySnapshot.ok && historySnapshot.value.events.map((event) => event.type)).toEqual([
      "instance-updated",
      "instance-focused",
    ]);

    const rate = createHarness({
      limits: { maxCommandsPerWindow: 1, rateWindowMs: 1_000 },
    });
    expect((await rate.controller.open(openCommand("panel", "rate-one"))).ok).toBe(true);
    expectError(await rate.controller.open(openCommand("tab", "rate-two")), "operation-failed");
    rate.advance(1_001);
    expect((await rate.controller.open(openCommand("tab", "rate-three"))).ok).toBe(true);

    const idempotency = createHarness({
      limits: { maxIdempotencyEntries: 1 },
    });
    expect((await idempotency.controller.open(openCommand("panel", "entry-one"))).ok).toBe(true);
    expectError(
      await idempotency.controller.open(openCommand("tab", "entry-two")),
      "idempotency-capacity",
    );
  });

  it("accepts exactly 512 idempotency entries and rejects entry 513 without delivery", async () => {
    const { controller, delivery } = createHarness({
      limits: { maxCommandsPerWindow: 1_000 },
    });
    for (let index = 0; index < 512; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- the boundary must be admitted sequentially
      const result = await controller.showNotification({
        ...owner,
        title: "Title",
        message: "Body",
        idempotencyKey: `capacity-${index}`,
      });
      expect(result.ok).toBe(true);
    }

    expectError(
      await controller.showNotification({
        ...owner,
        title: "Title",
        message: "Body",
        idempotencyKey: "capacity-512",
      }),
      "idempotency-capacity",
    );
    expect(delivery.notification).toHaveBeenCalledTimes(512);
  });

  it("invalidates all matching owner instances across scopes and emits stale cleanup events", async () => {
    const { controller } = createHarness();
    const observed: string[] = [];
    controller.subscribe((event) => observed.push(event.type));
    await controller.open(openCommand("panel", "scope-one"));
    await controller.open({
      ...openCommand("tab", "scope-two"),
      sessionId: "session-2",
    });
    await controller.open({
      ...openCommand("fullscreen", "other-owner"),
      applicationId: "other",
    });

    const invalidated = controller.invalidateOwner({
      extensionId: owner.extensionId,
      applicationId: owner.applicationId,
    });
    expect(invalidated.ok && invalidated.value).toHaveLength(2);
    const first = await controller.snapshot(owner);
    const second = await controller.snapshot({ ...owner, sessionId: "session-2" });
    expect(first.ok && first.value.instances).toHaveLength(1);
    expect(second.ok && second.value.instances).toHaveLength(0);
    expect(observed.filter((type) => type === "instance-closed")).toHaveLength(2);
    expect(observed.filter((type) => type === "owner-invalidated")).toHaveLength(2);
  });

  it("delivers notifications, chat messages, and chat cards only after authorization", async () => {
    const { controller, delivery } = createHarness();
    const notification = await controller.showNotification({
      ...owner,
      title: "Title",
      message: "Body",
      idempotencyKey: "notify",
    });
    const message = await controller.postChatMessage({
      ...owner,
      content: markdownContent,
      idempotencyKey: "message",
    });
    const card = await controller.showChatCard({
      ...owner,
      content: textContent,
      idempotencyKey: "card",
    });

    expect(notification.ok && notification.value.receipt.deliveryId).toBeTruthy();
    expect(message.ok && message.value.receipt.deliveryId).toBeTruthy();
    expect(card.ok && card.value.receipt.deliveryId).toBeTruthy();
    expect(card.ok && card.value.receipt.instanceId).toBe(
      card.ok && card.value.instance?.instanceId,
    );
    expect(card.ok && card.value.instance?.surface).toBe("inline-card");
    expect(delivery.notification).toHaveBeenCalledOnce();
    expect(delivery.chatMessage).toHaveBeenCalledOnce();
    expect(delivery.chatCard).toHaveBeenCalledOnce();
    const snapshot = await controller.snapshot(owner);
    expect(snapshot.ok && snapshot.value.instances).toEqual(card.ok ? [card.value.instance] : []);
    expect(
      snapshot.ok && snapshot.value.events.filter((event) => event.type === "delivery-succeeded"),
    ).toHaveLength(3);
  });

  it("recovers chat cards from authoritative snapshots and deduplicates their receipt", async () => {
    const { controller, delivery } = createHarness();
    const command = {
      ...owner,
      content: markdownContent,
      idempotencyKey: "recoverable-card",
    };
    const first = await controller.showChatCard(command);
    const replay = await controller.showChatCard(command);
    const snapshot = await controller.snapshot(owner);

    expect(first.ok && first.value.instance).toMatchObject({
      surface: "inline-card",
      content: markdownContent,
    });
    expect(replay.ok && replay.value.receipt.status).toBe("deduplicated");
    expect(replay.ok && replay.value.receipt.receiptId).toBe(
      first.ok ? first.value.receipt.receiptId : undefined,
    );
    expect(snapshot.ok && snapshot.value.instances).toEqual(first.ok ? [first.value.instance] : []);
    expect(delivery.chatCard).toHaveBeenCalledOnce();
  });

  it("returns delivery failures without recording or deduplicating fake success", async () => {
    const { controller, delivery } = createHarness();
    vi.mocked(delivery.notification).mockRejectedValueOnce(new Error("offline"));
    const command = {
      ...owner,
      title: "Title",
      message: "Body",
      idempotencyKey: "retryable",
    };
    const failed = await controller.showNotification(command);
    expect(failed.ok).toBe(false);

    const afterFailure = await controller.snapshot(owner);
    expect(
      afterFailure.ok &&
        afterFailure.value.events.some((event) => event.type === "delivery-succeeded"),
    ).toBe(false);
    const retried = await controller.showNotification(command);
    expect(retried.ok && retried.value.receipt.status).toBe("applied");
    expect(delivery.notification).toHaveBeenCalledTimes(2);
  });

  it("clears state and subscribers on disposal and rejects future mutations", async () => {
    const { controller } = createHarness();
    const subscriber = vi.fn<(event: RuntimeUiEvent) => void>();
    controller.subscribe(subscriber);
    await controller.open(openCommand("panel"));
    controller.dispose();
    controller.dispose();

    expectError(await controller.open(openCommand("tab", "after-dispose")), "runtime-unavailable");
    expect(controller.invalidateOwner(owner)).toEqual({
      ok: false,
      error: {
        code: "runtime-unavailable",
        message: "Runtime UI controller is disposed.",
      },
    });
    expect(() => controller.subscribe(subscriber)).toThrow("disposed");
    expect(subscriber).toHaveBeenCalledOnce();
  });
});
