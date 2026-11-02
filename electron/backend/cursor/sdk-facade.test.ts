import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SDKAgent } from "@cursor/sdk";
import { expect, it, vi } from "vitest";

import { CursorRuntimeClient } from "./client";
import { loadCursorSdk } from "./sdk-facade";

it.each(["running", "queued"] as const)(
  "recovers a legacy handoff with a %s orphan beyond the first real SDK history page",
  async (orphanStatus) => {
    const { Agent, Cursor, JsonlLocalAgentStore, createAgentPlatform } =
      await import("@cursor/sdk");
    const cwd = await mkdtemp(path.join(tmpdir(), "marshal-cursor-recovery-"));
    const store = new JsonlLocalAgentStore(path.join(cwd, "store"));
    const agentId = "agent-legacy";
    const orphanId = "run-100";
    Cursor.configure({ local: { store } });
    try {
      await store.agents.create({
        agent: {
          agentId,
          cwd,
          status: "running",
          activeRunId: orphanId,
          createdAt: 1,
          updatedAt: 101,
          latestCheckpoint: { schemaVersion: 1, rootBlobId: "preserved-checkpoint" },
        },
      });
      await Promise.all(
        Array.from({ length: 101 }, (_, i) =>
          store.runs.create({
            run: {
              agentId,
              runId: `run-${String(i).padStart(3, "0")}`,
              turnNumber: i + 1,
              status: i === 100 ? orphanStatus : "finished",
              createdAt: i,
              updatedAt: i,
            },
          }),
        ),
      );
      const page = await Agent.listRuns(agentId, { runtime: "local", cwd, limit: 100 });
      expect(page.nextCursor).toBeTruthy();
      expect(page.items.some((run) => run.id === orphanId)).toBe(false);
      const platform = await createAgentPlatform({ localStore: store, workspaceRef: cwd });
      await expect(platform.store.createFollowUpRun(agentId, {})).rejects.toThrow(
        "already has active run",
      );

    const sdk = await loadCursorSdk();
    sdk.getConversation = undefined;
      // Native storage and cancellation are real; only model generation is replaced.
      sdk.resumeAgent = vi.fn<typeof sdk.resumeAgent>(async () => ({
        agentId,
        model: { id: "composer-2.5" },
        send: vi.fn<SDKAgent["send"]>(async (_prompt, options) => {
          const followup = await platform.store.createFollowUpRun(agentId, {});
          await options?.onDelta?.({
            update: { type: "summary", summary: "Retained legacy decisions" },
          });
          await platform.store.markRunTerminal(agentId, followup.runId, { status: "FINISHED" });
          return platform.getRun(followup.runId);
        }),
        close: vi.fn<SDKAgent["close"]>(),
        reload: vi.fn<SDKAgent["reload"]>(),
        [Symbol.asyncDispose]: vi.fn<SDKAgent[typeof Symbol.asyncDispose]>(),
        listArtifacts: vi.fn<SDKAgent["listArtifacts"]>(),
        downloadArtifact: vi.fn<SDKAgent["downloadArtifact"]>(),
        getUsage: vi.fn<SDKAgent["getUsage"]>(),
      }));
      // Avoid a model-catalog network request in this local persistence regression.
      sdk.listModels = vi.fn<typeof sdk.listModels>(async () => [
        { id: "composer-2.5", displayName: "Composer 2.5" },
      ]);
      const client = new CursorRuntimeClient(sdk, {
        workspaceDir: cwd,
        env: { CURSOR_API_KEY: "test-key" },
        store: { load: async () => undefined, save: async () => {}, clear: async () => {} },
      });
      await expect(
        client.readConversationState(agentId, cwd, { allowCompaction: true }),
      ).resolves.toMatchObject({ summary: "Retained legacy decisions" });
      expect((await store.runs.get({ agentId, runId: orphanId }))?.status).toBe("cancelled");
      expect((await store.agents.get({ agentId }))?.latestCheckpoint?.rootBlobId).toBe(
        "preserved-checkpoint",
      );
      await expect(
        client.readConversationState(agentId, cwd, { allowCompaction: true }),
      ).resolves.toMatchObject({ summary: "Retained legacy decisions" });
      await client.stop();
    } finally {
      Cursor.configure({ local: { store: null } });
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15000,
);
