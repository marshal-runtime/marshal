/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Type-erased dispatch is checked by IpcInvokeMap at registration and remoteSchemas at the network boundary. */
import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { shouldUseRealE2EHandler } from "../e2e-stub-routing";
import { isMockMode } from "../mock-mode";

type Register = <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
// Only handlers explicitly opted in here can be reached by the remote server.
const handlers = new Map<string, (...args: never[]) => unknown>();

/**
 * The subset of Electron's WebContents surface that sender-scoped shared
 * handlers touch. The remote server materializes one per authenticated socket
 * (negative ids, so they never collide with renderer WebContents ids) and
 * fires "destroyed" when the socket closes.
 */
export interface RemoteEventSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

// Handlers that key state on event.sender (subscriptions, in-flight capability
// invocations). Desktop registration passes the real IpcMainInvokeEvent; the
// remote path substitutes a socket-backed sender so the same scoping,
// idempotency-keying, and teardown logic runs for both surfaces.
const senderHandlers = new Map<string, (event: never, ...args: never[]) => unknown>();

export function sharedIpcHandle(register: Register) {
  return <C extends keyof IpcInvokeMap>(
    channel: C,
    handler: (
      ...args: Parameters<IpcInvokeMap[C]>
    ) => ReturnType<IpcInvokeMap[C]> | Awaited<ReturnType<IpcInvokeMap[C]>>,
  ) => {
    handlers.set(channel, handler as (...args: never[]) => unknown);
    register(channel, ((_event: unknown, ...args: Parameters<IpcInvokeMap[C]>) =>
      handler(...args)) as IpcHandler<C>);
  };
}

/**
 * Share a handler that reads event.sender. The identical handler serves the
 * desktop IPC registration and the remote dispatch; remotely it receives a
 * synthetic event whose sender is the socket-backed RemoteEventSender.
 */
export function sharedIpcHandleWithSender(register: Register) {
  return <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => {
    senderHandlers.set(channel, handler as (event: never, ...args: never[]) => unknown);
    register(channel, handler);
  };
}

export async function invokeSharedHandler(
  channel: string,
  args: unknown[],
  sender?: RemoteEventSender,
): Promise<unknown> {
  if (isMockMode() && !shouldUseRealE2EHandler(channel)) {
    const { E2E_STUBS, E2E_DYNAMIC_STUBS } = await import("../e2e-stubs");
    if (channel in E2E_DYNAMIC_STUBS) {
      const value = E2E_DYNAMIC_STUBS[channel](...args);
      if (value !== undefined) return value;
    } else if (channel in E2E_STUBS) return E2E_STUBS[channel];
  }
  const senderHandler = senderHandlers.get(channel);
  if (senderHandler) {
    if (!sender) throw new Error(`Remote operation requires a connected device: ${channel}`);
    return senderHandler({ sender } as never, ...(args as never[]));
  }
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Unavailable remote operation: ${channel}`);
  return handler(...(args as never[]));
}
