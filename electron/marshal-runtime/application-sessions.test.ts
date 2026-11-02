import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApplicationSessionService,
  type ApplicationSessionOptions,
  type ReplyTargetFacts,
} from "./application-sessions";
import type { SelectedSessionOwner, SelectedSessionReceipt } from "./selected-session-delivery";

const userOwner: SelectedSessionOwner = {
  extensionId: "@example/inbox",
  applicationId: "inbox",
  applicationScope: "user",
  workspaceName: "marshal",
};
const workspaceOwner: SelectedSessionOwner = {
  extensionId: "@example/inbox",
  applicationId: "inbox",
  applicationScope: "workspace",
  workspaceName: "acme",
};
const otherApplication: SelectedSessionOwner = { ...userOwner, applicationId: "other" };
const sessionOwner = (sessionId: string): SelectedSessionOwner => ({
  extensionId: "@example/inbox",
  applicationId: "inbox",
  workspaceName: "acme",
  sessionId,
});
type Delivery = ApplicationSessionOptions["delivery"];
const TASK = "Prepare a local fix for the failing loop.\nEvidence follows.";
const CORRUPT_STORE = "{not json";
const GRANT_CAP = 16;
const REPLY_TARGETS: Record<string, ReplyTargetFacts> = {
  "chat-user": { sessionId: "chat-user", source: "user", permissionMode: "default" },
  "chat-legacy": { sessionId: "chat-legacy" },
  "backend-of-user": { sessionId: "chat-user", source: "user" },
  "chat-subagent": { sessionId: "chat-subagent", source: "subagent", parentSessionId: "chat-user" },
  "chat-automation": { sessionId: "chat-automation", source: "automation" },
  "chat-child": { sessionId: "chat-child", source: "user", parentSessionId: "chat-user" },
  "chat-allow-all": { sessionId: "chat-allow-all", source: "user", permissionMode: "allow-all" },
  "chat-grandchild": {
    sessionId: "chat-grandchild",
    source: "subagent",
    parentSessionId: "chat-subagent",
  },
  "chat-automation-child": {
    sessionId: "chat-automation-child",
    source: "subagent",
    parentSessionId: "chat-automation",
  },
  "chat-under-allow-all": {
    sessionId: "chat-under-allow-all",
    source: "subagent",
    parentSessionId: "chat-allow-all",
  },
  "chat-orphan": { sessionId: "chat-orphan", source: "subagent", parentSessionId: "chat-gone" },
};

function receipt(requestId: string, targetSessionId: string): SelectedSessionReceipt {
  return {
    requestId,
    messageId: `message-${requestId}`,
    targetSessionId,
    state: "accepted",
    response: "",
    responseTruncated: false,
    cursor: "0",
    reset: false,
    events: [],
  };
}

describe("ApplicationSessionService", () => {
  let directory: string;
  let file: string;
  let created: number;
  let granted: Map<string, string>;
  let options: ApplicationSessionOptions;
  const grant = vi.fn<Delivery["grant"]>();
  const send = vi.fn<Delivery["send"]>();
  const revokeGrant = vi.fn<Delivery["revokeGrant"]>();
  const createSession = vi.fn<ApplicationSessionOptions["createSession"]>();

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "application-sessions-"));
    file = path.join(directory, "application-sessions.json");
    created = 0;
    granted = new Map();
    grant.mockReset().mockImplementation(async (_owner, sessionId) => {
      const grantId = `grant-${granted.size + 1}`;
      granted.set(grantId, sessionId);
      return { grantId, targetSessionId: sessionId, expiresAt: "2026-09-30T20:00:00.000Z" };
    });
    send.mockReset().mockImplementation(async (_owner, request) => {
      const requestId = String(Reflect.get(Object(request), "requestId"));
      const grantId = String(Reflect.get(Object(request), "grantId"));
      return receipt(requestId, granted.get(grantId) ?? "");
    });
    revokeGrant.mockReset().mockResolvedValue(undefined);
    createSession.mockReset().mockImplementation(async () => `session-${++created}`);
    options = {
      file,
      delivery: { grant, send, revokeGrant },
      isOwnerActive: () => true,
      resolveWorkspace: (name) => (name === "acme" ? "acme" : undefined),
      createSession,
      describeSession: (sessionId) => REPLY_TARGETS[sessionId] ?? null,
    };
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  describe("start", () => {
    it("creates a default-permission session, queues the task and returns a delivery grant", async () => {
      const service = new ApplicationSessionService(options);
      const result = await service.start(userOwner, { requestId: "fix-1", task: TASK });
      expect(createSession).toHaveBeenCalledWith({
        name: "Prepare a local fix for the failing loop.",
      });
      expect(send).toHaveBeenCalledWith(userOwner, {
        grantId: "grant-1",
        requestId: "fix-1",
        message: TASK,
      });
      expect(result).toMatchObject({ sessionId: "session-1", grantId: "grant-1", created: true });
    });

    it("reuses the session when the same request is retried, including after a restart", async () => {
      await new ApplicationSessionService(options).start(userOwner, {
        requestId: "fix-1",
        task: TASK,
      });
      const again = await new ApplicationSessionService(options).start(userOwner, {
        requestId: "fix-1",
        task: TASK,
      });
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(again).toMatchObject({ sessionId: "session-1", created: false });
    });

    it("creates one session for concurrent starts with the same request", async () => {
      const service = new ApplicationSessionService(options);
      const results = await Promise.all([
        service.start(userOwner, { requestId: "fix-1", task: TASK }),
        service.start(userOwner, { requestId: "fix-1", task: TASK }),
      ]);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(results.map((result) => result.sessionId)).toEqual(["session-1", "session-1"]);
    });

    it("records every session when different requests start concurrently", async () => {
      const service = new ApplicationSessionService(options);
      await Promise.all([
        service.start(userOwner, { requestId: "fix-1", task: TASK }),
        service.start(userOwner, { requestId: "fix-2", task: TASK }),
      ]);
      const restarted = new ApplicationSessionService(options);
      await expect(restarted.resume(userOwner, { sessionId: "session-1" })).resolves.toBeDefined();
      await expect(restarted.resume(userOwner, { sessionId: "session-2" })).resolves.toBeDefined();
    });

    it("rejects a changed task under a request ID that was already used, even after a restart", async () => {
      await new ApplicationSessionService(options).start(userOwner, {
        requestId: "fix-1",
        task: TASK,
      });
      send.mockClear();
      await expect(
        new ApplicationSessionService(options).start(userOwner, {
          requestId: "fix-1",
          task: "Do something else.",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(send).not.toHaveBeenCalled();
    });

    it("rejects a concurrent start that reuses the request ID with a different task", async () => {
      const service = new ApplicationSessionService(options);
      const first = service.start(userOwner, { requestId: "fix-1", task: TASK });
      await expect(
        service.start(userOwner, { requestId: "fix-1", task: "Do something else." }),
      ).rejects.toMatchObject({ code: "conflict" });
      await first;
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it("keeps a session-scoped application's requests apart per originating session", async () => {
      const service = new ApplicationSessionService(options);
      const first = await service.start(sessionOwner("chat-1"), { requestId: "fix-1", task: TASK });
      const second = await service.start(sessionOwner("chat-2"), {
        requestId: "fix-1",
        task: "Do something else.",
      });
      expect([first.sessionId, second.sessionId]).toEqual(["session-1", "session-2"]);
      await expect(
        service.resume(sessionOwner("chat-2"), { sessionId: "session-1" }),
      ).rejects.toMatchObject({ code: "permission_denied" });
    });

    it("refuses to start and leaves the record untouched when the ownership record is unreadable", async () => {
      writeFileSync(file, CORRUPT_STORE);
      await expect(
        new ApplicationSessionService(options).start(userOwner, { requestId: "fix-1", task: TASK }),
      ).rejects.toMatchObject({ code: "permission_denied" });
      expect(createSession).not.toHaveBeenCalled();
      expect(readFileSync(file, "utf8")).toBe(CORRUPT_STORE);
    });

    it("revokes the owner's oldest grant once it holds the maximum number of live grants", async () => {
      const service = new ApplicationSessionService(options);
      await Array.from({ length: GRANT_CAP + 1 }, (_, index) => `fix-${index}`).reduce(
        (previous, requestId) =>
          previous.then(() => service.start(userOwner, { requestId, task: TASK })).then(() => {}),
        Promise.resolve(),
      );
      expect(revokeGrant.mock.calls).toEqual([[userOwner, "grant-1"]]);
    });

    it("lets a user-scope application choose any registered workspace by exact name", async () => {
      await new ApplicationSessionService(options).start(userOwner, {
        requestId: "fix-1",
        task: TASK,
        name: "loops: fix",
        workspaceName: "acme",
      });
      expect(createSession).toHaveBeenCalledWith({ name: "loops: fix", workspaceName: "acme" });
    });

    it("starts a workspace application's session in its own workspace", async () => {
      await new ApplicationSessionService(options).start(workspaceOwner, {
        requestId: "fix-1",
        task: TASK,
      });
      expect(createSession).toHaveBeenCalledWith({
        name: "Prepare a local fix for the failing loop.",
        workspaceName: "acme",
      });
    });

    it.each([
      ["an unknown workspace", userOwner, { workspaceName: "zy" }, "invalid_input"],
      [
        "another workspace from a workspace application",
        workspaceOwner,
        { workspaceName: "marshal" },
        "permission_denied",
      ],
      [
        "an unexpected field such as permissionMode",
        userOwner,
        { permissionMode: "allow-all" },
        "invalid_input",
      ],
      ["an empty task", userOwner, { task: " " }, "invalid_input"],
    ])("rejects %s without creating a session", async (_label, owner, extra, code) => {
      await expect(
        new ApplicationSessionService(options).start(owner, {
          requestId: "fix-1",
          task: TASK,
          ...extra,
        }),
      ).rejects.toMatchObject({ code });
      expect(createSession).not.toHaveBeenCalled();
    });

    it("rejects an inactive application", async () => {
      await expect(
        new ApplicationSessionService({ ...options, isOwnerActive: () => false }).start(userOwner, {
          requestId: "fix-1",
          task: TASK,
        }),
      ).rejects.toMatchObject({ code: "permission_denied" });
      expect(createSession).not.toHaveBeenCalled();
    });

    it("revokes the grant when the first message cannot be queued", async () => {
      send.mockRejectedValueOnce(new Error("outbox unavailable"));
      await expect(
        new ApplicationSessionService(options).start(userOwner, { requestId: "fix-1", task: TASK }),
      ).rejects.toThrow("outbox unavailable");
      expect(revokeGrant).toHaveBeenCalledWith(userOwner, "grant-1");
    });
  });

  describe("resume", () => {
    it("grants delivery to a session the same application started, after a restart", async () => {
      await new ApplicationSessionService(options).start(userOwner, {
        requestId: "fix-1",
        task: TASK,
      });
      const resumed = await new ApplicationSessionService(options).resume(userOwner, {
        sessionId: "session-1",
      });
      expect(resumed).toEqual({
        grantId: "grant-2",
        targetSessionId: "session-1",
        expiresAt: "2026-09-30T20:00:00.000Z",
      });
    });

    it("keeps one live grant per session when the application resumes repeatedly", async () => {
      const service = new ApplicationSessionService(options);
      await service.start(userOwner, { requestId: "fix-1", task: TASK });
      await service.resume(userOwner, { sessionId: "session-1" });
      await service.resume(userOwner, { sessionId: "session-1" });
      expect(revokeGrant.mock.calls).toEqual([
        [userOwner, "grant-1"],
        [userOwner, "grant-2"],
      ]);
    });

    it.each([
      ["another application's session", otherApplication, "session-1"],
      ["a session no application started", userOwner, "session-user-made"],
      ["the same application in a different scope", workspaceOwner, "session-1"],
    ])("denies %s", async (_label, owner, sessionId) => {
      const service = new ApplicationSessionService(options);
      await service.start(userOwner, { requestId: "fix-1", task: TASK });
      grant.mockClear();
      await expect(service.resume(owner, { sessionId })).rejects.toMatchObject({
        code: "permission_denied",
      });
      expect(grant).not.toHaveBeenCalled();
    });

    it("fails closed when the ownership record is unreadable", async () => {
      writeFileSync(file, CORRUPT_STORE);
      await expect(
        new ApplicationSessionService(options).resume(userOwner, { sessionId: "session-1" }),
      ).rejects.toMatchObject({ code: "permission_denied" });
    });
  });

  describe("reply", () => {
    it.each(["chat-user", "chat-legacy", "chat-subagent", "chat-child", "chat-grandchild"])(
      "grants delivery into the session %s of the user's own tree",
      async (sessionId) => {
        await expect(
          new ApplicationSessionService(options).reply(userOwner, { sessionId }),
        ).resolves.toEqual({
          grantId: "grant-1",
          targetSessionId: sessionId,
          expiresAt: "2026-09-30T20:00:00.000Z",
        });
      },
    );

    it("grants delivery to the Marshal session behind a backend session ID", async () => {
      await expect(
        new ApplicationSessionService(options).reply(userOwner, { sessionId: "backend-of-user" }),
      ).resolves.toMatchObject({ targetSessionId: "chat-user" });
      expect(grant).toHaveBeenCalledWith(userOwner, "chat-user");
    });

    it("keeps one live grant per session when the application replies repeatedly", async () => {
      const service = new ApplicationSessionService(options);
      await service.reply(userOwner, { sessionId: "chat-user" });
      await service.reply(userOwner, { sessionId: "chat-user" });
      expect(revokeGrant.mock.calls).toEqual([[userOwner, "grant-1"]]);
    });

    it.each([
      ["an automation session", "chat-automation"],
      ["a subagent of an automation", "chat-automation-child"],
      ["an allow-all session", "chat-allow-all"],
      ["a subagent under an allow-all session", "chat-under-allow-all"],
      ["a subagent whose parent is gone", "chat-orphan"],
      ["an unknown session", "chat-missing"],
    ])("denies %s", async (_label, sessionId) => {
      await expect(
        new ApplicationSessionService(options).reply(userOwner, { sessionId }),
      ).rejects.toMatchObject({ code: "permission_denied" });
      expect(grant).not.toHaveBeenCalled();
    });

    it("denies an inactive application", async () => {
      await expect(
        new ApplicationSessionService({ ...options, isOwnerActive: () => false }).reply(userOwner, {
          sessionId: "chat-user",
        }),
      ).rejects.toMatchObject({ code: "permission_denied" });
      expect(grant).not.toHaveBeenCalled();
    });

    it("rejects input with extra fields", async () => {
      await expect(
        new ApplicationSessionService(options).reply(userOwner, {
          sessionId: "chat-user",
          message: "hi",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });
});
