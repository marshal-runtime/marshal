import type { IpcHandler, IpcInvokeMap } from "../../../../common/marshal-ipc-contract";
import type { GatewayAuthController } from "./contracts";

interface IpcRegistrar {
  ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
}

export function registerGatewayAuthHandlers(
  { ipcHandle }: IpcRegistrar,
  controller: GatewayAuthController,
) {
  ipcHandle("gatewayAuth:getState", async () => ({
    success: true as const,
    state: controller.getState(),
  }));
  ipcHandle("gatewayAuth:signIn", async (_event, cred) => controller.signIn(cred));
  ipcHandle("gatewayAuth:signOut", async () => controller.signOut());
  ipcHandle("gatewayAuth:cancelPairing", async () => controller.cancelPairing());
  ipcHandle("gatewayAuth:listPendingDevices", async () => controller.listPendingDevices());
  ipcHandle("gatewayAuth:approveDevice", async (_event, requestId) =>
    controller.approveDevice(requestId),
  );
}
