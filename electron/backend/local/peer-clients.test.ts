import { describe, expect, it, vi } from "vitest";

import { CODEX_RUNTIME_ID, CURSOR_RUNTIME_ID } from "../../../common/runtime-config";
import { flushMicrotasks, testDouble } from "../../testing/harness";
import type { RuntimeClient, RuntimeClientFactory, RuntimeModelInfo } from "../runtime-contract";
import { PeerRuntimeClients, type PeerClientFactoryResolver } from "./peer-clients";

const WORKSPACE_DIR = "/tmp/marshal-peer-workspace";
const LUNA_MODEL_ID = "gpt-5.6-luna";
const SESSION_ID = "session-1";

function fakeClient(modelIds: string[] = [LUNA_MODEL_ID]) {
  const stop = vi.fn<RuntimeClient["stop"]>(async () => []);
  const listModels = vi.fn<RuntimeClient["listModels"]>(async () =>
    modelIds.map((id) => testDouble<RuntimeModelInfo>({ id, name: id })),
  );
  return { client: testDouble<RuntimeClient>({ stop, listModels }), stop, listModels };
}

function cursorPeers(client: RuntimeClient) {
  const factory = vi.fn<RuntimeClientFactory>(async () => client);
  const peers = new PeerRuntimeClients(
    (runtimeId) => (runtimeId === CURSOR_RUNTIME_ID ? factory : null),
    WORKSPACE_DIR,
  );
  return { peers, factory };
}

describe("PeerRuntimeClients", () => {
  it("starts one client per runtime and matches the model case-insensitively", async () => {
    const { client, listModels } = fakeClient();
    const { peers, factory } = cursorPeers(client);

    await expect(
      peers.clientForModel({ runtimeId: CURSOR_RUNTIME_ID, model: LUNA_MODEL_ID.toUpperCase() }),
    ).resolves.toBe(client);
    await peers.clientForModel({ runtimeId: CURSOR_RUNTIME_ID, model: LUNA_MODEL_ID });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(WORKSPACE_DIR);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("rejects a model missing from the peer catalog", async () => {
    const { peers } = cursorPeers(fakeClient().client);

    await expect(
      peers.clientForModel({ runtimeId: CURSOR_RUNTIME_ID, model: "gpt-9" }),
    ).rejects.toThrow('Model "gpt-9" is not available in the cursor runtime.');
  });

  it("rejects a runtime the resolver cannot start", async () => {
    const { peers } = cursorPeers(fakeClient().client);

    await expect(
      peers.clientForModel({ runtimeId: CODEX_RUNTIME_ID, model: LUNA_MODEL_ID }),
    ).rejects.toThrow("The codex runtime cannot run sessions next to the active runtime.");
  });

  it("retries a client start that failed", async () => {
    const { client } = fakeClient();
    const factory = vi
      .fn<RuntimeClientFactory>()
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValue(client);
    const peers = new PeerRuntimeClients(() => factory, WORKSPACE_DIR);
    const target = { runtimeId: CURSOR_RUNTIME_ID, model: LUNA_MODEL_ID };

    await expect(peers.clientForModel(target)).rejects.toThrow("spawn failed");
    await expect(peers.clientForModel(target)).resolves.toBe(client);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("replaces a peer client whose process exited", async () => {
    let closed = false;
    const dead = testDouble<RuntimeClient>({
      isClosed: () => closed,
      listModels: async () => [testDouble<RuntimeModelInfo>({ id: LUNA_MODEL_ID })],
    });
    const { client: fresh } = fakeClient();
    const factory = vi
      .fn<RuntimeClientFactory>()
      .mockResolvedValueOnce(dead)
      .mockResolvedValue(fresh);
    const peers = new PeerRuntimeClients(() => factory, WORKSPACE_DIR);
    const target = { runtimeId: CURSOR_RUNTIME_ID, model: LUNA_MODEL_ID };

    await expect(peers.clientForModel(target)).resolves.toBe(dead);
    await flushMicrotasks();
    closed = true;

    await expect(peers.clientForModel(target)).resolves.toBe(fresh);
    await expect(peers.clientForModel(target)).resolves.toBe(fresh);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("tracks which peer runtime owns a session until it is released", () => {
    const { client } = fakeClient();
    const { peers } = cursorPeers(client);

    peers.bindSession(SESSION_ID, CURSOR_RUNTIME_ID, client);

    expect(peers.runtimeForSession(SESSION_ID)).toBe(CURSOR_RUNTIME_ID);
    expect(peers.releaseSession(SESSION_ID)).toBe(client);
    expect(peers.runtimeForSession(SESSION_ID)).toBeUndefined();
  });

  it("stops started clients, forgets their sessions, and starts fresh afterwards", async () => {
    const { client, stop } = fakeClient();
    const { peers, factory } = cursorPeers(client);
    await peers.clientForModel({ runtimeId: CURSOR_RUNTIME_ID, model: LUNA_MODEL_ID });
    peers.bindSession(SESSION_ID, CURSOR_RUNTIME_ID, client);

    await peers.stop();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(peers.runtimeForSession(SESSION_ID)).toBeUndefined();
    await peers.clientForModel({ runtimeId: CURSOR_RUNTIME_ID, model: LUNA_MODEL_ID });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("stops a process-less client when killed so its sessions can be resumed later", async () => {
    const { client, stop } = fakeClient();
    const { peers } = cursorPeers(client);
    await peers.clientForModel({ runtimeId: CURSOR_RUNTIME_ID, model: LUNA_MODEL_ID });

    peers.kill();
    await flushMicrotasks();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("starts one client per account and asks the resolver for that account", async () => {
    const work = fakeClient();
    const home = fakeClient();
    const resolver = vi.fn<PeerClientFactoryResolver>((_runtimeId, accountId) =>
      vi.fn<RuntimeClientFactory>(async () => (accountId === "home" ? home.client : work.client)),
    );
    const peers = new PeerRuntimeClients(resolver, WORKSPACE_DIR);

    await expect(
      peers.clientForModel({
        runtimeId: CURSOR_RUNTIME_ID,
        accountId: "work",
        model: LUNA_MODEL_ID,
      }),
    ).resolves.toBe(work.client);
    await expect(
      peers.clientForModel({
        runtimeId: CURSOR_RUNTIME_ID,
        accountId: "home",
        model: LUNA_MODEL_ID,
      }),
    ).resolves.toBe(home.client);
    await peers.clientForModel({
      runtimeId: CURSOR_RUNTIME_ID,
      accountId: "work",
      model: LUNA_MODEL_ID,
    });

    expect(resolver.mock.calls).toEqual([
      [CURSOR_RUNTIME_ID, "work"],
      [CURSOR_RUNTIME_ID, "home"],
    ]);
  });

  it("treats an explicit original account as the runtime's own client", async () => {
    const { client } = fakeClient();
    const resolver = vi.fn<PeerClientFactoryResolver>(() =>
      vi.fn<RuntimeClientFactory>(async () => client),
    );
    const peers = new PeerRuntimeClients(resolver, WORKSPACE_DIR);

    await peers.clientForModel({ runtimeId: CURSOR_RUNTIME_ID, model: LUNA_MODEL_ID });
    await peers.clientForModel({
      runtimeId: CURSOR_RUNTIME_ID,
      accountId: "default",
      model: LUNA_MODEL_ID,
    });

    expect(resolver.mock.calls).toEqual([[CURSOR_RUNTIME_ID, undefined]]);
  });

  it("drops an idle client whose catalog failed so the next start sees new credentials", async () => {
    const signedOut = fakeClient();
    signedOut.listModels.mockRejectedValue(new Error("not signed in"));
    const signedIn = fakeClient();
    const factory = vi
      .fn<RuntimeClientFactory>()
      .mockResolvedValueOnce(signedOut.client)
      .mockResolvedValue(signedIn.client);
    const peers = new PeerRuntimeClients(() => factory, WORKSPACE_DIR);
    const target = { runtimeId: CURSOR_RUNTIME_ID, accountId: "work", model: LUNA_MODEL_ID };

    await expect(peers.clientForModel(target)).rejects.toThrow("not signed in");
    await flushMicrotasks();

    expect(signedOut.stop).toHaveBeenCalledTimes(1);
    await expect(peers.clientForModel(target)).resolves.toBe(signedIn.client);
  });
});
