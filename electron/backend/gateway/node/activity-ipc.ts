import type { IpcEventMap, IpcHandler, IpcInvokeMap } from "../../../../common/marshal-ipc-contract";
import type { GatewayNodeActivityJournal } from "./activity-journal";

interface IpcHandle {
  <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>): void;
}

interface BroadcastFn {
  <C extends keyof IpcEventMap>(channel: C, payload: IpcEventMap[C]): void;
}

interface NodeActivityIpcDeps {
  ipcHandle: IpcHandle;
  broadcast: BroadcastFn;
  log: Readonly<Pick<GatewayNodeActivityJournal, "getAll" | "subscribe">>;
}

export function registerGatewayNodeActivityHandlers({
  ipcHandle,
  broadcast,
  log,
}: NodeActivityIpcDeps): () => void {
  ipcHandle("gatewayNode:getActivity", async () => ({
    success: true as const,
    entries: log.getAll(),
  }));

  return log.subscribe((entry) => {
    broadcast("gatewayNode:activity", entry);
  });
}
