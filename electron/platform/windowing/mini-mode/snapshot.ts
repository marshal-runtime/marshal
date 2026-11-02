import type { MiniModePermissionRequest, MiniModeSnapshot, MiniModeStatus } from "./contracts";

interface IndicatorVisibilityInput {
  destroyed: boolean;
  mainWindowVisible: boolean;
  miniModeEnabled: boolean;
}

interface ApprovalVisibilityInput {
  approvalDismissInFlight: boolean;
  indicatorVisible: boolean;
  pendingPermissionCount: number;
}

interface DesiredStatusInput {
  failureLatched: boolean;
  hasActiveWork: boolean;
  heartbeatLatched: boolean;
  partyLatched: boolean;
  pendingPermissionCount: number;
}

interface SnapshotInput {
  activePermissionId: string | null;
  pendingPermissions: Map<string, MiniModePermissionRequest>;
  status: MiniModeStatus;
}

export function hasActiveWork(
  heartbeatRunning: boolean,
  automationRunning: boolean,
  busySessionCount: number,
): boolean {
  return heartbeatRunning || automationRunning || busySessionCount > 0;
}

export function getDesiredStatus({
  failureLatched,
  hasActiveWork: activeWork,
  heartbeatLatched,
  partyLatched,
  pendingPermissionCount,
}: DesiredStatusInput): MiniModeStatus {
  if (pendingPermissionCount > 0) {
    return "monocle";
  }
  if (activeWork) {
    return "thinking";
  }
  if (failureLatched) {
    return "crying";
  }
  if (heartbeatLatched) {
    return "heartbeat";
  }
  if (partyLatched) {
    return "party";
  }
  return "sleeping";
}

export function getCurrentPermission(
  pendingPermissions: Map<string, MiniModePermissionRequest>,
  activePermissionId: string | null,
): MiniModePermissionRequest | null {
  if (!activePermissionId) {
    return null;
  }
  return pendingPermissions.get(activePermissionId) ?? null;
}

export function getCurrentPermissionIndex(
  pendingPermissions: Map<string, MiniModePermissionRequest>,
  activePermissionId: string | null,
): number {
  if (!activePermissionId) {
    return 0;
  }

  const permissionIds = Array.from(pendingPermissions.keys());
  const index = permissionIds.indexOf(activePermissionId);
  return index >= 0 ? index + 1 : 0;
}

export function getLastPendingPermissionId(
  pendingPermissions: Map<string, MiniModePermissionRequest>,
): string | null {
  const permissionIds = Array.from(pendingPermissions.keys());
  return permissionIds.at(-1) ?? null;
}

export function shouldShowIndicator({
  destroyed,
  mainWindowVisible,
  miniModeEnabled,
}: IndicatorVisibilityInput): boolean {
  return !destroyed && miniModeEnabled && !mainWindowVisible;
}

export function shouldShowApproval({
  approvalDismissInFlight,
  indicatorVisible,
  pendingPermissionCount,
}: ApprovalVisibilityInput): boolean {
  return indicatorVisible && (pendingPermissionCount > 0 || approvalDismissInFlight);
}

export function buildSnapshot({
  activePermissionId,
  pendingPermissions,
  status,
}: SnapshotInput): Omit<MiniModeSnapshot, "notification"> {
  const permission = getCurrentPermission(pendingPermissions, activePermissionId);
  return {
    status,
    permission,
    pendingPermissionCount: pendingPermissions.size,
    permissionIndex: getCurrentPermissionIndex(pendingPermissions, activePermissionId),
  };
}
