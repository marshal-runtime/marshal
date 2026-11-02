import { describe, expect, it, vi } from "vitest";

import { CLAUDE_RUNTIME_ID, CURSOR_RUNTIME_ID } from "../../../common/runtime-config";
import { testDouble } from "../../testing/harness";
import type { RuntimeClient, RuntimeClientFactory, RuntimeModelInfo } from "../runtime-contract";
import type { LocalClientSubset } from "./internal";
import { PeerRuntimeClients, type PeerClientFactoryResolver } from "./peer-clients";
import {
  modelForSessionSwitch,
  selectSessionClient,
  type SessionClientSource,
} from "./session-client";

const WORKSPACE_DIR = "/tmp/marshal-session-client";
const OPUS_MODEL_ID = "claude-opus-5-5[1m]";
const LUNA_MODEL_ID = "gpt-5.6-luna";
const QUALIFIED_LUNA = `${CURSOR_RUNTIME_ID}:${LUNA_MODEL_ID}`;
const QUALIFIED_OPUS = `${CLAUDE_RUNTIME_ID}:${OPUS_MODEL_ID}`;
const PEER_SESSION_ID = "peer-session";
const ACTIVE_SESSION_ID = "active-session";

function fakeClient(modelIds: string[]): RuntimeClient {
  return testDouble<RuntimeClient>({
    stop: vi.fn<RuntimeClient["stop"]>(async () => []),
    listModels: vi.fn<RuntimeClient["listModels"]>(async () =>
      modelIds.map((id) => testDouble<RuntimeModelInfo>({ id, name: id })),
    ),
  });
}

function claudeBackend(options: { withPeers?: boolean; startsClient?: boolean } = {}) {
  const activeClient = fakeClient([OPUS_MODEL_ID]);
  const cursorClient = fakeClient([LUNA_MODEL_ID]);
  const cursorFactory = vi.fn<RuntimeClientFactory>(async () => cursorClient);
  const peers = new PeerRuntimeClients(
    (runtimeId) => (runtimeId === CURSOR_RUNTIME_ID ? cursorFactory : null),
    WORKSPACE_DIR,
  );
  let client: LocalClientSubset | null = null;
  const initClient = vi.fn<SessionClientSource["initClient"]>(async () => {
    if (options.startsClient !== false) client = activeClient;
  });
  const backend: SessionClientSource = {
    getClient: () => client,
    initClient,
    getRuntimeId: () => CLAUDE_RUNTIME_ID,
    getRuntimeDisplayName: () => "Claude",
    getPeerClients: options.withPeers === false ? undefined : () => peers,
  };
  return { backend, activeClient, cursorClient, peers, initClient };
}

describe("selectSessionClient", () => {
  it("starts the active runtime client for a plain model", async () => {
    const { backend, activeClient, initClient } = claudeBackend();

    await expect(selectSessionClient(backend, OPUS_MODEL_ID)).resolves.toEqual({
      client: activeClient,
      model: OPUS_MODEL_ID,
    });
    expect(initClient).toHaveBeenCalledTimes(1);
  });

  it("strips a qualifier that names the active runtime", async () => {
    const { backend, activeClient } = claudeBackend();

    await expect(selectSessionClient(backend, QUALIFIED_OPUS)).resolves.toEqual({
      client: activeClient,
      model: OPUS_MODEL_ID,
    });
  });

  it("routes a peer-qualified model to the peer runtime client", async () => {
    const { backend, cursorClient, initClient } = claudeBackend();

    await expect(selectSessionClient(backend, QUALIFIED_LUNA)).resolves.toEqual({
      client: cursorClient,
      model: LUNA_MODEL_ID,
      peerRuntimeId: CURSOR_RUNTIME_ID,
    });
    expect(initClient).not.toHaveBeenCalled();
  });

  it("rejects a peer-qualified model when the backend has no peer runtimes", async () => {
    const { backend } = claudeBackend({ withPeers: false });

    await expect(selectSessionClient(backend, QUALIFIED_LUNA)).rejects.toThrow(
      `Model "${QUALIFIED_LUNA}" needs the cursor runtime, which cannot run next to claude.`,
    );
  });

  it("runs another account of the active runtime on that account's peer client", async () => {
    const workClient = fakeClient([OPUS_MODEL_ID]);
    const resolver = vi.fn<PeerClientFactoryResolver>((runtimeId, accountId) =>
      runtimeId === CLAUDE_RUNTIME_ID && accountId === "work"
        ? vi.fn<RuntimeClientFactory>(async () => workClient)
        : null,
    );
    const peers = new PeerRuntimeClients(resolver, WORKSPACE_DIR);
    const { backend, initClient } = claudeBackend();
    backend.getPeerClients = () => peers;

    await expect(
      selectSessionClient(backend, `${CLAUDE_RUNTIME_ID}@work:${OPUS_MODEL_ID}`),
    ).resolves.toEqual({
      client: workClient,
      model: OPUS_MODEL_ID,
      peerRuntimeId: `${CLAUDE_RUNTIME_ID}@work`,
    });
    expect(initClient).not.toHaveBeenCalled();
  });

  it("runs an explicit original account on the active client", async () => {
    const { backend, activeClient } = claudeBackend();

    await expect(
      selectSessionClient(backend, `${CLAUDE_RUNTIME_ID}@default:${OPUS_MODEL_ID}`),
    ).resolves.toEqual({ client: activeClient, model: OPUS_MODEL_ID });
  });

  it("keeps the uninitialized-client error when the active runtime cannot start", async () => {
    const { backend } = claudeBackend({ startsClient: false });

    await expect(selectSessionClient(backend, OPUS_MODEL_ID)).rejects.toThrow(
      "Claude client not initialized",
    );
  });
});

describe("modelForSessionSwitch", () => {
  it("unqualifies a switch that stays on the session runtime", () => {
    const { backend, peers, cursorClient } = claudeBackend();
    peers.bindSession(PEER_SESSION_ID, CURSOR_RUNTIME_ID, cursorClient);

    expect(modelForSessionSwitch(backend, ACTIVE_SESSION_ID, OPUS_MODEL_ID)).toBe(OPUS_MODEL_ID);
    expect(modelForSessionSwitch(backend, ACTIVE_SESSION_ID, QUALIFIED_OPUS)).toBe(OPUS_MODEL_ID);
    expect(modelForSessionSwitch(backend, PEER_SESSION_ID, QUALIFIED_LUNA)).toBe(LUNA_MODEL_ID);
  });

  it("rejects a switch that would move a session to another runtime", () => {
    const { backend, peers, cursorClient } = claudeBackend();
    peers.bindSession(PEER_SESSION_ID, CURSOR_RUNTIME_ID, cursorClient);

    expect(() => modelForSessionSwitch(backend, ACTIVE_SESSION_ID, QUALIFIED_LUNA)).toThrow(
      `This session runs on the claude runtime; "${QUALIFIED_LUNA}" needs a session restart on its runtime, not an in-place switch.`,
    );
    expect(() => modelForSessionSwitch(backend, PEER_SESSION_ID, OPUS_MODEL_ID)).toThrow(
      `This session runs on the cursor runtime; "${OPUS_MODEL_ID}" needs a session restart on its runtime, not an in-place switch.`,
    );
  });

  it("switches in place within an account and rejects moving to another account", () => {
    const { backend, peers, activeClient } = claudeBackend();
    peers.bindSession(PEER_SESSION_ID, `${CLAUDE_RUNTIME_ID}@work`, activeClient);

    expect(
      modelForSessionSwitch(backend, PEER_SESSION_ID, `${CLAUDE_RUNTIME_ID}@work:sonnet`),
    ).toBe("sonnet");
    expect(() =>
      modelForSessionSwitch(backend, PEER_SESSION_ID, `${CLAUDE_RUNTIME_ID}@home:sonnet`),
    ).toThrow("This session runs on the claude@work runtime");
    expect(() =>
      modelForSessionSwitch(backend, ACTIVE_SESSION_ID, `${CLAUDE_RUNTIME_ID}@work:sonnet`),
    ).toThrow("This session runs on the claude runtime");
  });
});
