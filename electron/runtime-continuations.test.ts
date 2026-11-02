import { expect, it, vi } from "vitest";

import type { AgentMessageRecord } from "./agent-message-outbox";
import { RuntimeContinuations } from "./runtime-continuations";
import { testDouble } from "./testing/harness";

it("fences enqueue racing pause, preserves unrelated messages, and permits later resume", async () => {
  let finishEnqueue = (): void => {};
  const gate = new Promise<void>((resolve) => {
    finishEnqueue = resolve;
  });
  const messages: AgentMessageRecord[] = [
    testDouble({
      messageId: "runtime-continuation:persisted",
      source: "owner",
      target: "child",
      state: "pending",
    }),
    testDouble({ messageId: "user-message", source: "owner", target: "child", state: "pending" }),
    testDouble({
      messageId: "runtime-continuation:other-owner",
      source: "other",
      target: "child",
      state: "pending",
    }),
    testDouble({
      messageId: "runtime-continuation:other-child",
      source: "owner",
      target: "other",
      state: "pending",
    }),
  ];
  const waitAccepted = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
  const controller = new RuntimeContinuations({
    enqueue: async (source, target, _prompt, messageId) => {
      await gate;
      messages.push(testDouble({ messageId, source, target, state: "pending" }));
    },
    waitAccepted,
    list: () => messages,
    cancelPending: async (id) => {
      const message = messages.find((entry) => entry.messageId === id);
      if (message) message.state = "cancelled";
    },
  });
  const sending = controller.send(
    "owner",
    "child",
    "automatic",
    controller.epoch("owner", "child"),
  );
  const pausing = controller.cancel("owner", "child");
  finishEnqueue();
  await pausing;
  await expect(sending).resolves.toBeUndefined();
  expect(waitAccepted).not.toHaveBeenCalled();
  expect(messages.map((message) => message.state)).toEqual([
    "cancelled",
    "pending",
    "pending",
    "pending",
    "cancelled",
  ]);
  await expect(
    controller.send("owner", "child", "resumed", controller.epoch("owner", "child")),
  ).resolves.toMatch(/^runtime-continuation:/);
  expect(waitAccepted).toHaveBeenCalledOnce();
});

it("cancels persisted owned pending messages after controller recreation", async () => {
  const cancelPending = vi
    .fn<(id: string, source: string, target: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const controller = new RuntimeContinuations({
    enqueue: async () => {},
    waitAccepted: async () => {},
    cancelPending,
    list: () => [
      testDouble({
        messageId: "runtime-continuation:old",
        source: "owner",
        target: "child",
        state: "pending",
      }),
    ],
  });
  await controller.cancel("owner", "child");
  expect(cancelPending).toHaveBeenCalledExactlyOnceWith(
    "runtime-continuation:old",
    "owner",
    "child",
  );
});

it("fences direct adopted-owner dispatch before pause and waits for dispatch already started", async () => {
  const controller = new RuntimeContinuations({
    enqueue: async () => {},
    waitAccepted: async () => {},
    cancelPending: async () => {},
    list: () => [],
  });
  const dispatch = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const sending = controller.sendDirect(
    "owner",
    "owner",
    controller.epoch("owner", "owner"),
    dispatch,
  );
  await controller.cancel("owner", "owner");
  await expect(sending).resolves.toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
  await expect(
    controller.sendDirect("owner", "owner", controller.epoch("owner", "owner"), dispatch),
  ).resolves.toBe(true);
  expect(dispatch).toHaveBeenCalledOnce();
});

it("preserves another owner's in-flight acceptance to the same target", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancelPending = vi
    .fn<(id: string, source: string, target: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const controller = new RuntimeContinuations({
    enqueue: async () => gate,
    waitAccepted: async () => {},
    cancelPending,
    list: () => [],
  });
  const sending = controller.send(
    "other-owner",
    "child",
    "automatic",
    controller.epoch("other-owner", "child"),
  );
  await controller.cancel("owner", "child");
  release();
  await expect(sending).resolves.toMatch(/^runtime-continuation:/);
  expect(cancelPending).not.toHaveBeenCalled();
});

it("pause waits for an already-started direct send before the caller interrupts", async () => {
  let entered = (): void => {};
  let release = (): void => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new RuntimeContinuations({
    enqueue: async () => {},
    waitAccepted: async () => {},
    cancelPending: async () => {},
    list: () => [],
  });
  const sending = controller.sendDirect(
    "owner",
    "owner",
    controller.epoch("owner", "owner"),
    async () => {
      entered();
      await gate;
    },
  );
  await started;
  let paused = false;
  const pausing = controller.cancel("owner", "owner").then(() => {
    paused = true;
  });
  await Promise.resolve();
  expect(paused).toBe(false);
  release();
  await sending;
  await pausing;
  expect(paused).toBe(true);
});
