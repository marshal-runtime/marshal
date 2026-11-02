/**
 * Typed IPC test helper. Replaces the per-test-file pattern of
 * `(await callHandler(...)) as { success: boolean; … }` casts with a
 * single generic that pulls argument and return types straight from
 * `IpcInvokeMap`. A channel rename surfaces as a compile error across
 * every test instead of a runtime "no handler for X" failure.
 *
 * Usage:
 *
 *   const handlers = new Map<string, (...args: unknown[]) => unknown>();
 *   // …register handlers via your fake ipcHandle…
 *   const result = await callIpc(handlers, "automations:list");
 *   //    ^ result is fully typed from IpcInvokeMap["automations:list"]
 *
 * The single internal cast is justified because IpcInvokeMap declares
 * `(event, ...args) => Promise<R>` shapes that the runtime preserves —
 * tests don't need to re-prove that contract per call site.
 */

import type { IpcInvokeMap } from "../../../common/marshal-ipc-contract";

export type TestIpcHandlers = Map<string, (...args: unknown[]) => unknown>;

export async function callIpc<K extends keyof IpcInvokeMap>(
  handlers: TestIpcHandlers,
  channel: K,
  ...args: Parameters<IpcInvokeMap[K]>
): Promise<Awaited<ReturnType<IpcInvokeMap[K]>>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`callIpc: no handler registered for ${channel}`);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- one boundary cast: handler runtime shape matches IpcInvokeMap[channel]; preserves typing for all call sites.
  return (await handler(undefined, ...args)) as Awaited<ReturnType<IpcInvokeMap[K]>>;
}
