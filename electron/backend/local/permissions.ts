import { DEFAULT_PERMISSIONS } from "../../../common/marshal-default-settings";
import type {
  MSettings,
  PermissionsConfig,
  PermissionsEnvelope,
} from "../../../common/marshal-ipc-contract";
import type { IPermissionsBackend, PermissionsOperationResult } from "../types";

interface ISettingsManagerForPermissions {
  get(): MSettings;
  update(patch: Partial<MSettings>): void;
}

const LOCAL_CONTROLLABLE: import("../../../common/marshal-ipc-contract").PermissionsControllableMap = {
  tools: { enabled: true },
  autopilotMode: { enabled: true },
  autoApproveReadOnly: { enabled: true },
  shellAllow: { enabled: true },
  shellDeny: { enabled: true },
  serverEnabled: { enabled: true },
  serverAutoApprove: { enabled: true },
  perHeartbeatScope: { enabled: true },
};

export class LocalPermissionsBackend implements IPermissionsBackend {
  private sm: ISettingsManagerForPermissions | null = null;

  setSettingsManager(sm: ISettingsManagerForPermissions): void {
    this.sm = sm;
  }

  private requireSM(): ISettingsManagerForPermissions {
    if (!this.sm) throw new Error("LocalPermissionsBackend: SettingsManager not wired yet");
    return this.sm;
  }

  async getPermissions(): Promise<PermissionsEnvelope> {
    const settings = this.requireSM().get();
    return {
      supported: true,
      permissions: settings.permissions ?? DEFAULT_PERMISSIONS,
      controllable: LOCAL_CONTROLLABLE,
    };
  }

  async updatePermissions(patch: Partial<PermissionsConfig>): Promise<PermissionsOperationResult> {
    const sm = this.requireSM();
    const current = sm.get().permissions ?? DEFAULT_PERMISSIONS;
    const next: PermissionsConfig = { ...current, ...patch };
    sm.update({ permissions: next });
    return { ok: true };
  }
}
