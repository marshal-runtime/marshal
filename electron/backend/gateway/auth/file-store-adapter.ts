import {
  clearGatewayAuthCred,
  loadGatewayAuthCred,
  saveGatewayAuthCred,
} from "../../../auth/gateway-auth-store";
import type { AuthStore } from "./contracts";

export function createFileStoreAdapter(): AuthStore {
  return {
    load: () => loadGatewayAuthCred(),
    save: (cred) => saveGatewayAuthCred(cred),
    clear: () => clearGatewayAuthCred(),
  };
}
