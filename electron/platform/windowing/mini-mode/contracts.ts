import type { PermissionKind } from "../../../../common/marshal-ipc-contract";
import type { ResolvedTheme } from "../../../theme";

const MINI_MODE_STATUSES = [
  "sleeping",
  "thinking",
  "monocle",
  "party",
  "crying",
  "heartbeat",
  "broken-heart",
] as const;

export type MiniModeStatus = (typeof MINI_MODE_STATUSES)[number];
export type MiniModeThemeMode = "system" | ResolvedTheme;

export interface MiniModePermissionRequest {
  id: string;
  toolCallId?: string;
  kind: PermissionKind;
  title: string;
  message: string;
  detail: string;
  buttons: string[];
}

export interface MiniModeNotification {
  id: string;
  type: "heartbeat-urgent" | "heartbeat-error" | "automation-complete" | "automation-failed";
  title: string;
  body: string;
  sessionId?: string;
  url?: string;
  /** Override the indicator emoji while this notification is active. */
  statusOverride?: MiniModeStatus;
}

export interface MiniModeSnapshot {
  status: MiniModeStatus;
  permission: MiniModePermissionRequest | null;
  pendingPermissionCount: number;
  permissionIndex: number;
  notification: MiniModeNotification | null;
}

export interface MiniModePalette {
  theme: ResolvedTheme;
  windowBackground: string;
  surfaceBackground: string;
  borderColor: string;
  textPrimary: string;
  textSecondary: string;
  codeBackground: string;
  secondaryButtonBackground: string;
  secondaryButtonText: string;
  approvalKindBackground: string;
  approvalKindText: string;
  approvalKindBorderColor: string;
  countBackground: string;
  countText: string;
  warningBadgeBackground: string;
  warningBadgeText: string;
  linkColor: string;
}

export interface MiniModeSizes {
  indicatorSize: number;
  miniMargin: number;
  approvalWidth: number;
  approvalHeight: number;
}

export interface MiniModeWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MiniModeWindowLayout {
  bounds: MiniModeWindowBounds;
  indicatorSize: number;
  bubbleType: "none" | "notification" | "approval";
}

const MINI_SIZE = 64;
const MINI_MARGIN = 16;
const APPROVAL_GAP = 12;
const APPROVAL_WIDTH = 432;
const APPROVAL_HEIGHT = 344;
export const APPROVAL_COLLAPSE_DELAY_MS = 200;

export function getMiniModeSizes(): MiniModeSizes {
  return {
    indicatorSize: MINI_SIZE,
    miniMargin: MINI_MARGIN,
    approvalWidth: APPROVAL_WIDTH,
    approvalHeight: APPROVAL_HEIGHT,
  };
}

export function getIndicatorWindowWidth(
  _bubbleType: "none" | "notification" | "approval",
  sizes: MiniModeSizes,
): number {
  // Always use full width — CSS controls content visibility
  return sizes.approvalWidth;
}

export function getIndicatorWindowHeight(
  _bubbleType: "none" | "notification" | "approval",
  sizes: MiniModeSizes,
): number {
  // Always use max height (approval is tallest) — CSS controls content visibility
  return sizes.approvalHeight + APPROVAL_GAP + sizes.indicatorSize;
}
