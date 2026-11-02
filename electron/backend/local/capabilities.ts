import type { BackendCapabilities } from "../types";

export function createLocalRuntimeCapabilities(options?: {
  sessionCompaction?: boolean;
  busyTurnSteer?: boolean;
}): BackendCapabilities {
  return {
    taskList: false,
    cronExpressions: false,
    retryPolicy: false,
    policyEditor: false,
    heartbeatIsolated: false,
    modelFallback: false,
    connectionStatus: false,
    sessionCompaction: options?.sessionCompaction ?? false,
    busyTurnSteer: options?.busyTurnSteer ?? false,
    automations: {
      multiStep: true,
      workingDir: true,
      skills: true,
      perAutomationPermissions: true,
      conditionTrigger: true,
      heartbeat: true,
      heartbeatRunNow: true,
      bundleImport: true,
      exportImport: true,
      githubImport: true,
    },
    // Local runtimes do not use the DesktopCapabilities bridge; flags remain
    // false for interface symmetry per CLAUDE.md rule 3.
    desktopCapabilities: {
      localTools: false,
      notifications: false,
    },
  };
}
