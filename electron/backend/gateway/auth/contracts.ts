import type {
  GatewayAuthIdentity,
  GatewayAuthState,
  PairedDevice,
  PendingDeviceRequest,
} from "../../../../common/marshal-ipc-contract";
import type { GatewayAuthCred } from "../../../auth/gateway-auth-store";

export interface AuthBackend {
  login(credentials: GatewayAuthIdentity): Promise<unknown>;
  signOut(): Promise<void>;
  setPairingStatusCallback(callback: ((requestId: string) => void) | null): void;
  cancelPairing(): void;
  isLocalGateway(): boolean;
  listPendingDevices(): Promise<{
    pending: PendingDeviceRequest[];
    paired: PairedDevice[];
  }>;
  approveDevice(requestId: string): Promise<void>;
}

export interface AuthStore {
  load(): GatewayAuthCred | null;
  save(cred: GatewayAuthCred): void;
  clear(): void;
}

export type Broadcaster = (state: GatewayAuthState) => void;

export interface ControllerDeps {
  backend: AuthBackend;
  store: AuthStore;
  broadcaster: Broadcaster;
  onSignOut?: () => void | Promise<void>;
  onSignedIn?: (identity: GatewayAuthIdentity) => void | Promise<void>;
}

export interface GatewayAuthController {
  getState(): GatewayAuthState;
  signIn(cred: GatewayAuthIdentity): Promise<{ success: boolean; error?: string }>;
  signOut(): Promise<{ success: boolean; error?: string }>;
  cancelPairing(): Promise<{ success: boolean; error?: string }>;
  tryAutoSignIn(): Promise<void>;
  setReconnecting(reconnecting: boolean): void;
  listPendingDevices(): Promise<{
    success: boolean;
    pending?: PendingDeviceRequest[];
    paired?: PairedDevice[];
    error?: string;
  }>;
  approveDevice(requestId: unknown): Promise<{ success: boolean; error?: string }>;
}
