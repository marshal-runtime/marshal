import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Message } from "@bufbuild/protobuf";
import { JsonlLocalAgentStore, createAgentPlatform, Cursor } from "@cursor/sdk";
import { expect, it, vi } from "vitest";

import { CursorRuntimeClient } from "./client";
import { cursorConversationState } from "./conversation-state";
import { loadCursorSdk } from "./sdk-facade";

it("reads the saved protobuf compaction summary without starting or sending to Cursor", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "marshal-cursor-checkpoint-"));
  const store = new JsonlLocalAgentStore(path.join(cwd, "store"));
  const agentId = "agent-checkpoint";
  Cursor.configure({ local: { store } });
  try {
    await store.agents.create({
      agent: { agentId, cwd, status: "idle", createdAt: 1, updatedAt: 1 },
    });
    const platform = await createAgentPlatform({ localStore: store, workspaceRef: cwd });
    const empty = await platform.checkpointStore.getFullConversation(agentId);
    if (!(empty instanceof Message)) throw new Error("Expected native protobuf conversation");
    const native = empty.getType().fromJson({ summary: { summary: "Native retained decisions" } });
    const summary: unknown = Reflect.get(native, "summary");
    if (!(summary instanceof Message)) throw new Error("Expected native protobuf summary");
    const data = summary.toBinary();
    const blobId = createHash("sha256").update(data).digest("hex");
    await store.checkpoints.create({ agentId, blobId, data });
    await platform.checkpointStore.saveCheckpoint(agentId, { toBinary: () => new Uint8Array() });
    const emptyStructure = await platform.checkpointStore.loadLatest(agentId);
    if (!(emptyStructure instanceof Message))
      throw new Error("Expected native checkpoint structure");
    const structure = emptyStructure.getType().fromJson({
      summary: Buffer.from(blobId, "hex").toString("base64"),
      rootPromptMessagesJson: [
        Buffer.from('{"role":"system","content":"Do not export this root prompt"}').toString(
          "base64",
        ),
      ],
    });
    await platform.checkpointStore.saveCheckpoint(agentId, structure);
    const sdk = await loadCursorSdk({ localStore: store });
    sdk.createAgent = vi.fn<typeof sdk.createAgent>();
    sdk.resumeAgent = vi.fn<typeof sdk.resumeAgent>();
    sdk.listModels = vi.fn<typeof sdk.listModels>();
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: cwd,
      env: {},
      store: { load: async () => undefined, save: async () => {}, clear: async () => {} },
    });
    const expected = {
      version: 1,
      sourceRuntimeId: "cursor",
      summary: "Native retained decisions",
      messages: [],
    };
    await expect(
      client.readConversationState(agentId, cwd, { allowCompaction: true }),
    ).resolves.toEqual(expected);
    await expect(client.readConversationState(agentId, cwd)).resolves.toEqual(expected);
    expect(sdk.createAgent).not.toHaveBeenCalled();
    expect(sdk.resumeAgent).not.toHaveBeenCalled();
    expect(sdk.listModels).not.toHaveBeenCalled();
    expect((await store.runs.list()).items).toHaveLength(0);

    const withTurns = empty.getType().fromJson({
      summary: { summary: "Native retained decisions" },
      rootPromptMessagesJson: [Buffer.from("Old root prompt").toString("base64")],
      summaryArchives: [{ summary: "Old discarded summary" }],
      turns: [
        {
          agentConversationTurn: {
            userMessage: {
              text: "<marshal-instructions>\nOld Marshal prompt\n</marshal-instructions>\n\n<user-request>\nWhat remains?\n</user-request>",
            },
            steps: [{ assistantMessage: { text: "The migration is ready." } }],
          },
        },
      ],
    });
    expect(cursorConversationState(withTurns)).toEqual({
      ...expected,
      messages: [
        { role: "user", content: "What remains?" },
        { role: "assistant", content: "The migration is ready." },
      ],
    });
  } finally {
    Cursor.configure({ local: { store: null } });
    await rm(cwd, { recursive: true, force: true });
  }
});

it("exports tool and shell context while rejecting malformed turn lists", () => {
  expect(
    cursorConversationState({
      turns: [
        {
          agentConversationTurn: {
            userMessage: { text: "test" },
            steps: [{ toolCall: { name: "shell", result: "done" } }],
          },
        },
        {
          shellConversationTurn: {
            shellCommand: { command: "pwd" },
            shellOutput: { stdout: "/project" },
          },
        },
      ],
    }).messages,
  ).toHaveLength(3);
  expect(() => cursorConversationState({ turns: "invalid" })).toThrow(
    "invalid native conversation",
  );
});
