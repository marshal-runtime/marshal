import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { powerSaveBlocker } from "electron";
import { z } from "zod";

import type { PermissionCardData, SessionViewStatus } from "../../common/marshal-ipc-contract";
import type { RemoteAccessState } from "../../common/remote-access";
import { RemotePushPrefsSchema } from "../../common/remote-push";
import { isMockMode } from "../mock-mode";
import type { SessionViewIpcBroker } from "../session-view-ipc-broker";
import { RemotePushNotifier, type PushSessionInfo } from "./push-notifier";
import { RemoteAccessServer } from "./server";
import { invokeSharedHandler } from "./shared-handlers";

let server: RemoteAccessServer | undefined;
let blocker: number | undefined;
export const remoteTargets = () => server?.getTargets() ?? [];
export const broadcastRemote = (channel: string, ...args: unknown[]) =>
  server?.broadcast(channel, ...args);
export async function stopRemoteAccess() {
  if (blocker !== undefined) {
    powerSaveBlocker.stop(blocker);
    blocker = undefined;
  }
  const old = server;
  server = undefined;
  await old?.close();
}
export function createRemoteAccessController(deps: {
  userData: string;
  rendererDir: string;
  broker: SessionViewIpcBroker;
  mediaRoots: () => string[];
  getSession: (sessionId: string) => Promise<PushSessionInfo | null>;
}) {
  const configPath = path.join(deps.userData, "remote-access.json");
  // Socket ids of phones currently on screen (they report visibility changes).
  const visibleTargets = new Set<number>();
  let pushNotifier: RemotePushNotifier | undefined;
  const push = () =>
    (pushNotifier ??= new RemotePushNotifier({
      filePath: path.join(deps.userData, "remote-push.json"),
      subject: () => state.origin || "mailto:marshal-remote@users.noreply.github.com",
      getSession: deps.getSession,
      isViewingOnPhone: (sessionId) =>
        [...visibleTargets].some((id) => deps.broker.isSubscribed(id, sessionId)),
    }));
  let state: RemoteAccessState = {
    enabled: false,
    running: false,
    origin: "",
    port: isMockMode() ? 7332 : 7331,
    accessKey: randomBytes(32).toString("base64url"),
  };
  try {
    const saved = z
      .object({
        enabled: z.boolean(),
        accessKey: z.string().min(32),
        origin: z.string().optional(),
      })
      .parse(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
    if (
      typeof saved.enabled === "boolean" &&
      typeof saved.accessKey === "string" &&
      saved.accessKey.length >= 32
    ) {
      state = {
        ...state,
        enabled: saved.enabled,
        origin: typeof saved.origin === "string" ? saved.origin : "",
        accessKey: saved.accessKey,
      };
    }
  } catch {
    /* First run: disabled. */
  }
  const save = () => {
    mkdirSync(deps.userData, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        { enabled: state.enabled, origin: state.origin, accessKey: state.accessKey },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  };
  async function start() {
    await stopRemoteAccess();
    state.running = false;
    state.error = undefined;
    if (!state.enabled) return;
    try {
      const next = new RemoteAccessServer({
        port: state.port,
        origin: state.origin || undefined,
        secret: state.accessKey,
        rendererDir: deps.rendererDir,
        removeTarget: (id) => {
          visibleTargets.delete(id);
          deps.broker.removeTarget(id);
        },
        mediaRoots: deps.mediaRoots,
        uploadDir: path.join(deps.userData, "remote-uploads"),
        onConnect: (id) => visibleTargets.add(id),
        invoke: async (method, args, id, sender) => {
          if (method === "remote:presence") {
            if (args[0] === true) visibleTargets.add(id);
            else visibleTargets.delete(id);
            return { success: true };
          }
          if (method === "remote:push-status")
            return push().status(typeof args[0] === "string" ? args[0] : undefined);
          if (method === "remote:push-subscribe")
            return push().subscribe(
              z
                .object({
                  endpoint: z.string(),
                  keys: z.object({ p256dh: z.string(), auth: z.string() }),
                })
                .parse(args[0]),
              RemotePushPrefsSchema.parse(args[1]),
            );
          if (method === "remote:push-unsubscribe")
            return push().unsubscribe(z.string().parse(args[0]));
          const sessionId = typeof args[0] === "string" ? args[0] : "";
          if (method === "sessions:subscribeView")
            return { success: true, snapshot: deps.broker.subscribe(id, sessionId) };
          if (method === "sessions:unsubscribeView") {
            deps.broker.unsubscribe(id, sessionId);
            return { success: true };
          }
          if (method === "sessions:ackView")
            return {
              success: true,
              accepted: deps.broker.acknowledge(
                id,
                sessionId,
                z.string().parse(args[1]),
                z.number().parse(args[2]),
              ),
            };
          if (method === "sessions:resyncView")
            return { success: true, snapshot: deps.broker.resync(id, sessionId) };
          return invokeSharedHandler(method, args, sender);
        },
      });
      await next.start();
      server = next;
      state.running = true;
      blocker = powerSaveBlocker.start("prevent-app-suspension");
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Unable to start remote access";
    }
  }
  let update = Promise.resolve();
  return {
    start,
    getState: () => ({ ...state }),
    // Pushes go through the phone's push service, so they only make sense while
    // phone access is switched on.
    observeView: (sessionId: string, status: SessionViewStatus, error: string | null) => {
      if (state.enabled) push().observeView(sessionId, status, error);
    },
    observeCards: (sessionId: string, cards: PermissionCardData[]) => {
      if (state.enabled) push().observeCards(sessionId, cards);
    },
    notify: (delivery: Parameters<RemotePushNotifier["notify"]>[0]) => {
      if (state.enabled) push().notify(delivery);
    },
    configure: async (input: { enabled: boolean; origin: string; rotateKey?: boolean }) => {
      if (
        typeof input.enabled !== "boolean" ||
        typeof input.origin !== "string" ||
        input.origin.length > 200
      )
        throw new Error("Invalid remote configuration");
      const origin = input.origin.trim().replace(/\/$/, "");
      if (origin && !/^https:\/\/[a-z0-9.-]+\.ts\.net$/.test(origin))
        throw new Error("Enter the HTTPS .ts.net address from Tailscale Serve");
      update = update
        .catch(() => {})
        .then(async () => {
          state.enabled = input.enabled;
          state.origin = origin;
          if (input.rotateKey) state.accessKey = randomBytes(32).toString("base64url");
          save();
          await start();
        });
      await update;
      return { ...state };
    },
  };
}
