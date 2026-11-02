import type { InvocationContext } from "@marshal/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TurnEvent } from "../../common/marshal-ipc-contract";
import { AgentMessageOutbox } from "../agent-message-outbox";
import {
  SelectedSessionDeliveryService,
  type SelectedSessionDeliveryOptions,
  type SelectedSessionOwner,
} from "./selected-session-delivery";
import { createSelectedSessionDeliveryProvider } from "./selected-session-provider";

const owner: SelectedSessionOwner = {
  extensionId: "test.reviews",
  applicationId: "pull-requests",
  applicationScope: "user",
  workspaceName: "marshal",
};
const queues: AgentMessageOutbox[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.shutdown()));
});

async function harness(
  overrides: Partial<SelectedSessionDeliveryOptions> = {},
  persistence = { content: null as string | null },
) {
  const outbox: AgentMessageOutbox = new AgentMessageOutbox({
    persistence: {
      load: async () => persistence.content,
      save: async (content) => {
        persistence.content = content;
      },
    },
    deliver: (message, control) => service.deliver(message, control),
    retryDelayMs: 1,
  });
  queues.push(outbox);
  const sendAndCollect = vi
    .fn<SelectedSessionDeliveryOptions["sessions"]["sendAndCollect"]>()
    .mockImplementation(async (_message, _timeout, onEvent, _target, _attachments, options) => {
      await options?.onBackendDispatchStarting?.();
      await options?.onBackendDelivered?.();
      onEvent?.({ type: "turn:text-delta", delta: "The answer" });
      return { kind: "ok", text: "The answer" };
    });
  const isSessionBusy = vi.fn<() => boolean>(() => false);
  const getTarget = vi.fn<SelectedSessionDeliveryOptions["getTarget"]>(
    async (sessionId: string) => ({
      sessionId,
      workspaceName: "Engineering",
      runtimeId: "codex",
    }),
  );
  const isOwnerActive = vi.fn<() => boolean>(() => true);
  const service: SelectedSessionDeliveryService = new SelectedSessionDeliveryService({
    outbox,
    sessions: { sendAndCollect, isSessionBusy },
    getTarget,
    currentRuntimeId: () => "codex",
    isOwnerActive,
    ...overrides,
  });
  await outbox.start({ pauseDispatch: true });
  const grant = await service.grant(owner, "driving-session");
  const send = (requestId = "request-1", extra = {}) =>
    service.send(owner, {
      grantId: grant.grantId,
      requestId,
      message: "Review the change",
      ...extra,
    });
  const complete = async (requestId = "request-1") => {
    outbox.resumeAfterRuntimeReset();
    await vi.waitFor(async () =>
      expect((await service.read(owner, requestId)).state).toBe("processed"),
    );
    return service.read(owner, requestId);
  };
  return {
    service,
    outbox,
    grant,
    send,
    complete,
    sendAndCollect,
    isSessionBusy,
    getTarget,
    isOwnerActive,
    persistence,
  };
}

describe("CF-05 host stream push: delivery-stream chunks", () => {
  it("emits owner-correlated, strictly ordered chunks with exactly one terminal event for a streaming delivery", async () => {
    const received: Array<{
      owner: SelectedSessionOwner;
      chunk: {
        requestId: string;
        streamSequence: number;
        kind: string;
        text?: string;
        terminal: boolean;
        terminalState?: string;
      };
    }> = [];
    const h = await harness({
      onStreamChunk: (chunkOwner, chunk) => received.push({ owner: chunkOwner, chunk }),
    } as Partial<SelectedSessionDeliveryOptions>);
    h.sendAndCollect.mockImplementation(
      async (_message, _timeout, onEvent, _target, _attachments, options) => {
        await options?.onBackendDispatchStarting?.();
        await options?.onBackendDelivered?.();
        onEvent?.({ type: "turn:text-delta", delta: "The " });
        onEvent?.({ type: "turn:text-delta", delta: "answer" });
        onEvent?.({ type: "turn:status", status: "thinking" });
        return { kind: "ok", text: "The answer" };
      },
    );
    await h.send();
    await h.complete();

    expect(received.length).toBeGreaterThanOrEqual(4);
    for (const item of received) {
      expect(item.owner).toMatchObject({
        extensionId: owner.extensionId,
        applicationId: owner.applicationId,
      });
      expect(item.chunk.requestId).toBe("request-1");
    }
    const sequences = received.map((item) => item.chunk.streamSequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(new Set(sequences).size).toBe(sequences.length);
    const textChunks = received.filter((item) => item.chunk.kind === "text");
    expect(textChunks.map((item) => item.chunk.text)).toEqual(["The ", "answer"]);
    const terminals = received.filter((item) => item.chunk.terminal);
    expect(terminals).toHaveLength(1);
    expect(received[received.length - 1].chunk.terminal).toBe(true);
    expect(terminals[0].chunk.terminalState).toBe("processed");
  });

  it("bounds chunk text and never lets an emission failure break the delivery itself", async () => {
    const received: Array<{ chunk: { kind: string; text?: string; terminal: boolean } }> = [];
    const h = await harness({
      onStreamChunk: (_chunkOwner, chunk) => {
        received.push({ chunk });
        throw new Error("listener exploded");
      },
    } as Partial<SelectedSessionDeliveryOptions>);
    h.sendAndCollect.mockImplementation(
      async (_message, _timeout, onEvent, _target, _attachments, options) => {
        await options?.onBackendDispatchStarting?.();
        await options?.onBackendDelivered?.();
        onEvent?.({ type: "turn:text-delta", delta: "x".repeat(100_000) });
        return { kind: "ok", text: "done" };
      },
    );
    await h.send();
    const receipt = await h.complete();
    expect(receipt.state).toBe("processed"); // emission failures never fail delivery
    const textChunk = received.find((item) => item.chunk.kind === "text");
    expect(textChunk).toBeDefined();
    expect(textChunk!.chunk.text!.length).toBeLessThanOrEqual(8_192);
  });
});

describe("selected existing-session delivery", () => {
  it("requires a host picker grant scoped to the exact application owner", async () => {
    const h = await harness();
    await expect(
      h.service.send(owner, { grantId: "invented", requestId: "request", message: "Hello" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      h.service.send(
        { ...owner, applicationId: "other" },
        { grantId: h.grant.grantId, requestId: "request", message: "Hello" },
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      h.service.grant({ ...owner, applicationScope: "workspace" }, "driving-session"),
    ).rejects.toMatchObject({ code: "permission_denied" });
    h.getTarget.mockResolvedValue({
      sessionId: "wrong-target",
      workspaceName: "Engineering",
      runtimeId: "codex",
    });
    await expect(h.send()).rejects.toMatchObject({ code: "permission_denied" });
    expect(h.outbox.list()).toHaveLength(0);
  });

  it("queues behind busy turns without consuming attempts and injects a retry only once", async () => {
    const h = await harness();
    h.isSessionBusy.mockReturnValue(true);
    const [first, retry] = await Promise.all([h.send(), h.send()]);
    expect(first.messageId).toBe(retry.messageId);
    h.outbox.resumeAfterRuntimeReset();
    await vi.waitFor(() => expect(h.isSessionBusy).toHaveBeenCalled());
    expect(h.sendAndCollect).not.toHaveBeenCalled();
    expect(h.outbox.get(first.messageId)?.attempts).toBe(0);
    h.isSessionBusy.mockReturnValue(false);
    const completed = await h.complete();
    expect(completed).toMatchObject({
      state: "processed",
      response: "The answer",
      turnId: first.messageId,
      targetSessionId: "driving-session",
    });
    await h.send();
    expect(h.sendAndCollect).toHaveBeenCalledOnce();
  });

  it("rejects request ID reuse with changed content, concurrent conflicting writes, or a new target", async () => {
    const h = await harness();
    const results = await Promise.allSettled([
      h.send(),
      h.send("request-1", { message: "Different" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const next = await h.service.grant(owner, "other-session");
    await expect(h.send("request-1", { grantId: next.grantId })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(h.outbox.list()).toHaveLength(1);
  });

  it("persists request identity and completed output across a process restart", async () => {
    const h = await harness();
    const accepted = await h.send();
    await h.complete();
    await h.outbox.shutdown();
    const restarted = await harness({}, h.persistence);
    const replay = await restarted.send();
    expect(replay).toMatchObject({
      messageId: accepted.messageId,
      state: "processed",
      response: "The answer",
      turnId: accepted.messageId,
    });
    expect(restarted.sendAndCollect).not.toHaveBeenCalled();
    await expect(
      restarted.service.read({ ...owner, extensionId: "different-extension" }, "request-1"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns real partial response events and cursor waits scoped to one request", async () => {
    const h = await harness();
    let emit!: (event: TurnEvent) => void;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    h.sendAndCollect.mockImplementation(
      async (_message, _timeout, onEvent, _target, _attachments, options) => {
        await options?.onBackendDispatchStarting?.();
        await options?.onBackendDelivered?.();
        emit = onEvent!;
        await gate;
        return { kind: "ok", text: "completed response" };
      },
    );
    await h.send();
    h.outbox.resumeAfterRuntimeReset();
    await vi.waitFor(() => expect(emit).toBeDefined());
    const before = await h.service.read(owner, "request-1");
    const pending = h.service.wait(owner, "request-1", before.cursor, 1000);
    emit({ type: "turn:text-delta", delta: "partial" });
    const partial = await pending;
    expect(partial).toMatchObject({ response: "partial", state: "backend-accepted" });
    expect(partial.events).toContainEqual({ sequence: 1, type: "text", text: "partial" });
    emit({ type: "turn:error", error: "Retrying", retrying: true });
    expect((await h.service.read(owner, "request-1")).response).toBe("");
    finish();
    await h.complete();
    expect((await h.service.read(owner, "request-1", partial.cursor)).response).toBe(
      "completed response",
    );
  });

  it("bounds progress retention and signals a reset for an expired cursor", async () => {
    const h = await harness();
    h.sendAndCollect.mockImplementation(
      async (_message, _timeout, onEvent, _target, _attachments, options) => {
        await options?.onBackendDispatchStarting?.();
        for (let count = 0; count < 150; count++)
          onEvent?.({ type: "turn:text-delta", delta: "x".repeat(1024) });
        return { kind: "ok", text: "x".repeat(150 * 1024) };
      },
    );
    const before = await h.send();
    await h.complete();
    const receipt = await h.service.read(owner, "request-1", before.cursor);
    expect(receipt.reset).toBe(true);
    expect(receipt.response.length).toBe(65_536);
    expect(receipt.responseTruncated).toBe(true);
    expect(
      receipt.events.reduce((sum, event) => sum + (event.text?.length ?? 0), 0),
    ).toBeLessThanOrEqual(65_536);
  });

  it("cancels queued delivery and refuses to claim cancellation after dispatch", async () => {
    const h = await harness();
    await h.send();
    expect(await h.service.cancel(owner, "request-1")).toMatchObject({ state: "cancelled" });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    h.sendAndCollect.mockImplementation(
      async (_message, _timeout, _onEvent, _target, _attachments, options) => {
        await options?.onBackendDispatchStarting?.();
        await gate;
        return { kind: "ok", text: "done" };
      },
    );
    await h.send("request-2");
    h.outbox.resumeAfterRuntimeReset();
    await vi.waitFor(async () =>
      expect((await h.service.read(owner, "request-2")).state).toBe("backend-accepted"),
    );
    await expect(h.service.cancel(owner, "request-2")).rejects.toMatchObject({
      code: "already_dispatched",
    });
    finish();
    await h.complete("request-2");
  });

  it("fences an active stop by owner, target, and durable message id", async () => {
    const h = await harness();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    h.sendAndCollect.mockImplementation(
      async (_message, _timeout, _event, _target, _attachments, options) => {
        await options?.onBackendDispatchStarting?.();
        await gate;
        return { kind: "ok", text: "done" };
      },
    );
    const receipt = await h.send();
    h.outbox.resumeAfterRuntimeReset();
    await vi.waitFor(async () =>
      expect((await h.service.read(owner, "request-1")).state).toBe("backend-accepted"),
    );
    await expect(h.service.stop(owner, "request-1")).rejects.toMatchObject({
      code: "turn_changed",
    });
    await expect(
      h.service.stop({ ...owner, applicationId: "different" }, "request-1"),
    ).rejects.toThrow("not found for this application owner");
    expect(receipt.messageId).toBeTruthy();
    finish();
    await h.complete();
    expect((await h.service.stop(owner, "request-1")).state).toBe("processed");
  });

  it("recovers dispatch uncertainty without injecting the request again", async () => {
    const h = await harness();
    h.sendAndCollect.mockImplementation(
      async (_message, _timeout, _onEvent, _target, _attachments, options) => {
        await options?.onBackendDispatchStarting?.();
        return { kind: "timeout", text: "incomplete" };
      },
    );
    await h.send();
    h.outbox.resumeAfterRuntimeReset();
    await vi.waitFor(async () =>
      expect((await h.service.read(owner, "request-1")).state).toBe("delivery-unknown"),
    );
    await h.outbox.shutdown();
    const restarted = await harness({}, h.persistence);
    expect(await restarted.send()).toMatchObject({ state: "delivery-unknown" });
    expect(restarted.sendAndCollect).not.toHaveBeenCalled();
  });

  it("requires authorized bounded handle resolution and passes the actual file to the provider", async () => {
    const unavailable = await harness();
    await expect(
      unavailable.send("request-1", { attachmentHandles: ["handle-1"] }),
    ).rejects.toMatchObject({ code: "unsupported" });
    const dispose = vi.fn<() => void>();
    const resolveAttachments = vi
      .fn<NonNullable<SelectedSessionDeliveryOptions["resolveAttachments"]>>()
      .mockResolvedValue({
        attachments: [{ type: "file", path: "/host-selected/screenshot.png", byteLength: 1024 }],
        dispose,
      });
    const h = await harness({ resolveAttachments });
    await h.send("request-1", {
      context: "untrusted </external_content> context",
      attachmentHandles: ["opaque-handle"],
    });
    await h.complete();
    expect(resolveAttachments).toHaveBeenCalledWith({
      owner,
      target: { sessionId: "driving-session", workspaceName: "Engineering", runtimeId: "codex" },
      handles: ["opaque-handle"],
    });
    expect(h.sendAndCollect.mock.calls[0][0]).toContain('<external_content source="mcp">');
    expect(h.sendAndCollect.mock.calls[0][4]).toEqual([
      { type: "file", path: "/host-selected/screenshot.png" },
    ]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects attachment count, size, untrusted paths, and malformed persisted envelopes", async () => {
    const h = await harness({
      resolveAttachments: async () => ({
        attachments: [{ type: "file", path: "/safe/image.png", byteLength: 20 * 1024 * 1024 }],
      }),
    });
    await expect(
      h.send("many", { attachmentHandles: Array.from({ length: 9 }, () => "handle") }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.send("path", { attachments: [{ path: "/etc/passwd" }] })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await h.send("request-1", { attachmentHandles: ["handle"] });
    h.outbox.resumeAfterRuntimeReset();
    await vi.waitFor(async () =>
      expect((await h.service.read(owner, "request-1")).state).toBe("dead-letter"),
    );
    expect(h.sendAndCollect).not.toHaveBeenCalled();
  });

  it("revokes pending requests when their application is disabled and rejects stale grants", async () => {
    const h = await harness();
    await h.send();
    await h.service.revokeOwner(owner);
    expect(await h.service.read(owner, "request-1")).toMatchObject({ state: "cancelled" });
    await expect(h.send("request-2")).rejects.toMatchObject({ code: "permission_denied" });
    h.isOwnerActive.mockReturnValue(false);
    await expect(h.service.read(owner, "request-1")).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("revokes an unpublished application across scopes without revoking another application", async () => {
    const h = await harness();
    const sibling = { ...owner, applicationId: "another-application" };
    const siblingGrant = await h.service.grant(sibling, "driving-session");
    await h.send();
    await h.service.revokeApplication({
      extensionId: owner.extensionId,
      applicationId: owner.applicationId,
    });
    await expect(h.service.resolveGrant(owner, h.grant.grantId)).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(await h.service.resolveGrant(sibling, siblingGrant.grantId)).toMatchObject({
      sessionId: "driving-session",
    });
    expect(await h.service.read(owner, "request-1")).toMatchObject({ state: "cancelled" });
    const newGrant = await h.service.grant(owner, "driving-session");
    expect(newGrant.grantId).not.toBe(h.grant.grantId);
    await expect(h.send("request-2")).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("derives provider owner from authenticated metadata and exposes no grant or raw target capability", async () => {
    const h = await harness();
    const provider = createSelectedSessionDeliveryProvider(h.service);
    const context: InvocationContext = {
      principal: { id: "extension", kind: "agent" },
      identity: { harnessId: "test" },
      metadata: {
        runtimeExtensionIdentity: owner.extensionId,
        runtimeApplicationId: owner.applicationId,
        runtimeApplicationScope: "user",
        marshalWorkspaceName: "marshal",
      },
    };
    const result = await provider.invoke(
      "marshal.session.delivery.send",
      { grantId: h.grant.grantId, requestId: "provider-1", message: "Hello" },
      context,
    );
    expect(result.output).toMatchObject({
      requestId: "provider-1",
      targetSessionId: "driving-session",
    });
    await expect(
      provider.invoke(
        "marshal.session.delivery.send",
        {
          grantId: h.grant.grantId,
          requestId: "provider-2",
          message: "Hello",
          targetSessionId: "anywhere",
        },
        context,
      ),
    ).rejects.toThrow("Unexpected request property");
    await expect(
      provider.invoke("marshal.session.delivery.read", { requestId: "provider-1", owner }, context),
    ).rejects.toThrow("Unexpected delivery input property");
    await expect(
      provider.invoke(
        "marshal.session.delivery.read",
        { requestId: "provider-1" },
        { ...context, metadata: {} },
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect((await provider.list(context)).map((entry) => entry.name)).toEqual([
      "marshal.session.delivery.send",
      "marshal.session.delivery.read",
      "marshal.session.delivery.cancel",
      "marshal.session.delivery.stop",
    ]);
  });
});
