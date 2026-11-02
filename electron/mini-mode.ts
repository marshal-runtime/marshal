import fs from "node:fs";
import path from "node:path";

import { app, screen } from "electron";

import { createLogger } from "../common/marshal-logger";
import { getMiniModePalette, getResolvedMiniModeTheme } from "./mini-mode/theme";
import { MiniModeIndicatorWindowController } from "./mini-mode/window";
import {
  APPROVAL_COLLAPSE_DELAY_MS,
  getMiniModeSizes,
  type MiniModeNotification,
  type MiniModePermissionRequest,
  type MiniModeSnapshot,
  type MiniModeStatus,
  type MiniModeThemeMode,
} from "./platform/windowing/mini-mode/contracts";
import { getIndicatorWindowLayout } from "./platform/windowing/mini-mode/layout";
import {
  buildSnapshot,
  getCurrentPermission,
  getCurrentPermissionIndex,
  getDesiredStatus,
  getLastPendingPermissionId,
  hasActiveWork,
  shouldShowApproval,
  shouldShowIndicator,
} from "./platform/windowing/mini-mode/snapshot";
import { resolveThemeMode } from "./theme";

const log = createLogger("MiniMode");

interface MiniModeManagerOptions {
  publicDir: string;
  getPreloadPath: () => string;
  getPagePath: () => string;
}

function fileToDataUrl(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = extension === ".webp" ? "image/webp" : "image/png";
  const buffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export class MiniModeManager {
  private readonly indicatorWindowController = new MiniModeIndicatorWindowController();
  private backgroundEnabled = false;
  private miniModeEnabled = false;
  private themeMode: MiniModeThemeMode = "system";
  private mainWindowVisible = true;
  private heartbeatRunning = false;
  private automationRunning = false;
  private busySessions = new Set<string>();
  private pendingPermissions = new Map<string, MiniModePermissionRequest>();
  private activePermissionId: string | null = null;
  private status: MiniModeStatus = "sleeping";
  private failureLatched = false;
  private partyLatched = false;
  private heartbeatLatched = false;
  private approvalDismissInFlight = false;
  private approvalDismissTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private displayListenersRegistered = false;
  private readonly assetPaths: Record<MiniModeStatus, string>;
  private readonly assets = new Map<MiniModeStatus, string>();
  private preloadPath: string | null = null;
  private activeNotification: MiniModeNotification | null = null;
  private notificationQueue: MiniModeNotification[] = [];
  private dismissedApprovalIds = new Set<string>();
  private readonly handleDisplayChange = () => {
    this.positionWindows();
  };

  constructor(private readonly options: MiniModeManagerOptions) {
    this.assetPaths = {
      sleeping: path.join(options.publicDir, "mini-mode", "marshal-sleeping.png"),
      thinking: path.join(options.publicDir, "mini-mode", "marshal-thinking.png"),
      monocle: path.join(options.publicDir, "mini-mode", "marshal-question.png"),
      party: path.join(options.publicDir, "mini-mode", "marshal-party.png"),
      crying: path.join(options.publicDir, "mini-mode", "marshal-crying.png"),
      heartbeat: path.join(options.publicDir, "mini-mode", "marshal-heartbeat.png"),
      "broken-heart": path.join(options.publicDir, "mini-mode", "marshal-broken-heart.png"),
    };
  }

  getSnapshot(): MiniModeSnapshot {
    const snapshot = {
      ...buildSnapshot({
        status: this.status,
        pendingPermissions: this.pendingPermissions,
        activePermissionId: this.activePermissionId,
      }),
      notification: this.activeNotification,
    };
    // Don't expose dismissed permissions in the snapshot
    if (snapshot.permission && this.dismissedApprovalIds.has(snapshot.permission.id)) {
      snapshot.permission = null;
    }
    return snapshot;
  }

  setBackgroundEnabled(enabled: boolean): void {
    if (this.backgroundEnabled === enabled) {
      return;
    }
    this.backgroundEnabled = enabled;
    this.syncWindows();
  }

  setMiniModeEnabled(enabled: boolean): void {
    this.miniModeEnabled = enabled;
    if (!enabled) {
      this.cancelApprovalDismiss();
    }
    this.syncWindows();
  }

  setTheme(theme?: string): void {
    const nextTheme = resolveThemeMode(theme);
    const nextMode = theme === "light" || theme === "dark" ? theme : "system";
    const currentTheme = getResolvedMiniModeTheme(this.themeMode);

    if (this.themeMode === nextMode && currentTheme === nextTheme) {
      return;
    }

    this.themeMode = nextMode;
    this.broadcastTheme();
  }

  refreshTheme(): void {
    if (this.themeMode !== "system") {
      return;
    }
    this.broadcastTheme();
  }

  setMainWindowVisible(visible: boolean): void {
    if (this.mainWindowVisible === visible) {
      return;
    }
    this.mainWindowVisible = visible;
    if (visible) {
      this.clearOutcomeState();
      this.cancelApprovalDismiss();
      // Dismiss any active notification — the user can see the full app now
      if (this.activeNotification) {
        this.activeNotification = null;
        this.broadcastNotification();
      }
      // Dismiss all approvals from mini-mode — the user can act on them in the main app
      for (const id of this.pendingPermissions.keys()) {
        this.dismissedApprovalIds.add(id);
      }
      // Clear the notification queue — the user can see everything in the main app
      if (this.notificationQueue.length > 0) {
        log.info(
          `Clearing ${this.notificationQueue.length} queued notification(s) — main window opened`,
        );
        this.notificationQueue.length = 0;
      }
    } else {
      // Prune dismissed IDs for permissions that are no longer pending
      for (const id of this.dismissedApprovalIds) {
        if (!this.pendingPermissions.has(id)) {
          this.dismissedApprovalIds.delete(id);
        }
      }
    }
    this.syncStatus();
  }

  markSessionBusy(sessionId: string): void {
    this.clearOutcomeState();
    this.busySessions.add(sessionId);
    this.syncStatus();
  }

  markSessionIdle(sessionId: string, celebrate = true): void {
    const wasBusy = this.busySessions.delete(sessionId);
    if (wasBusy && celebrate) {
      this.startPartyHold();
    } else if (wasBusy) {
      this.startFailureHold();
    }
    this.syncStatus();
  }

  /** Remove a session from busy tracking without triggering any outcome animation. */
  clearSession(sessionId: string): void {
    this.busySessions.delete(sessionId);
    this.syncStatus();
  }

  setHeartbeatRunning(running: boolean, celebrate = true): void {
    const wasRunning = this.heartbeatRunning;
    this.heartbeatRunning = running;
    if (running) {
      this.clearOutcomeState();
    } else if (wasRunning && celebrate) {
      this.startHeartbeatHold();
    } else if (wasRunning) {
      this.startFailureHold();
    }
    this.syncStatus();
  }

  setAutomationRunning(running: boolean, celebrate = true): void {
    const wasRunning = this.automationRunning;
    this.automationRunning = running;
    if (running) {
      this.clearOutcomeState();
    } else if (wasRunning && celebrate) {
      this.startPartyHold();
    } else if (wasRunning) {
      this.startFailureHold();
    }
    this.syncStatus();
  }

  showPermission(request: MiniModePermissionRequest): void {
    this.cancelApprovalDismiss();
    this.clearOutcomeState();
    this.dismissedApprovalIds.delete(request.id);
    this.pendingPermissions.set(request.id, request);
    this.activePermissionId = request.id;
    // Approval takes priority — re-queue any active notification so it shows after
    if (this.activeNotification) {
      this.notificationQueue.unshift(this.activeNotification);
      this.activeNotification = null;
      this.broadcastNotification();
    }
    this.syncStatus();
  }

  hidePermission(requestId?: string): void {
    if (!requestId) {
      this.pendingPermissions.clear();
      this.activePermissionId = null;
      this.dismissedApprovalIds.clear();
      if (this.shouldShowIndicator()) {
        this.startApprovalDismiss();
      } else {
        this.cancelApprovalDismiss();
      }
      this.syncStatus();
      return;
    }

    if (!this.pendingPermissions.delete(requestId)) {
      return;
    }

    this.dismissedApprovalIds.delete(requestId);

    if (this.activePermissionId === requestId) {
      this.activePermissionId = getLastPendingPermissionId(this.pendingPermissions);
    }

    if (this.pendingPermissions.size > 0) {
      this.cancelApprovalDismiss();
    } else if (this.shouldShowIndicator()) {
      this.startApprovalDismiss();
    } else {
      this.cancelApprovalDismiss();
    }

    this.syncStatus();
    this.drainNotificationQueue();
  }

  showNotification(notification: MiniModeNotification): void {
    if (this.shouldSuppressNotification()) return;

    // If the bubble is occupied, queue instead of dropping
    if (this.shouldShowApproval() || this.activeNotification) {
      if (this.notificationQueue.length < 10) {
        this.notificationQueue.push(notification);
      } else if (notification.type === "heartbeat-urgent") {
        // Urgent notifications displace the oldest non-urgent item in the queue
        const nonUrgentIdx = this.notificationQueue.findIndex((n) => n.type !== "heartbeat-urgent");
        if (nonUrgentIdx >= 0) {
          log.warn(
            `Queue full — displacing "${this.notificationQueue[nonUrgentIdx].title}" for urgent "${notification.title}"`,
          );
          this.notificationQueue.splice(nonUrgentIdx, 1);
          this.notificationQueue.push(notification);
        } else {
          log.warn(`Queue full (all urgent) — dropping: ${notification.title}`);
        }
      } else {
        log.warn(`Notification queue full — dropping: ${notification.title}`);
      }
      return;
    }

    this.activeNotification = notification;
    this.broadcastNotification();
    this.syncStatus();
  }

  hideNotification(): void {
    if (!this.activeNotification) return;

    // If there are more notifications queued, replace in-place (no intermediate collapse)
    if (this.notificationQueue.length > 0) {
      const next = this.notificationQueue.shift()!;
      this.activeNotification = next;
      // Update status for the new notification's statusOverride
      const nextStatus = this.getDesiredStatus();
      if (this.status !== nextStatus) {
        this.status = nextStatus;
      }
      // Single broadcast with both notification and state — no separate resize needed
      this.broadcastNotification();
      this.broadcastState();
      return;
    }

    // Queue empty — collapse the bubble
    this.activeNotification = null;
    this.broadcastNotification();
    this.clearOutcomeState();
    this.syncStatus();
  }

  dismissApprovalFromMiniMode(requestId: string): void {
    this.dismissedApprovalIds.add(requestId);
    this.syncStatus();
    this.drainNotificationQueue();
  }

  /** Toggle click-through on the indicator window (called from renderer mouse events). */
  setInteractive(interactive: boolean): void {
    this.indicatorWindowController.setInteractive(interactive);
  }

  destroy(): void {
    this.destroyed = true;
    this.clearOutcomeState();
    this.cancelApprovalDismiss();
    this.notificationQueue.length = 0;
    if (this.displayListenersRegistered) {
      screen.removeListener("display-added", this.handleDisplayChange);
      screen.removeListener("display-removed", this.handleDisplayChange);
      screen.removeListener("display-metrics-changed", this.handleDisplayChange);
      this.displayListenersRegistered = false;
    }
    this.destroyIndicatorWindow();
  }

  private clearOutcomeState(): void {
    this.failureLatched = false;
    this.partyLatched = false;
    this.heartbeatLatched = false;
  }

  /** Show the next queued notification if the bubble is free. */
  private drainNotificationQueue(): void {
    if (this.shouldShowApproval()) return;
    if (this.activeNotification) return;

    const next = this.notificationQueue.shift();
    if (next) {
      this.activeNotification = next;
      this.broadcastNotification();
      this.syncStatus();
    }
  }

  /** Stub for Focus Assist / DND detection. */
  private shouldSuppressNotification(): boolean {
    return false;
  }

  private broadcastNotification(): void {
    if (this.destroyed) return;
    this.indicatorWindowController.send("mini-mode:notification", {
      notification: this.activeNotification,
      queueCount: this.notificationQueue.length,
    });
  }

  private startPartyHold(): void {
    if (this.hasActiveWork() || this.pendingPermissions.size > 0) {
      return;
    }
    this.failureLatched = false;
    this.heartbeatLatched = false;
    this.partyLatched = !this.mainWindowVisible;
  }

  private startHeartbeatHold(): void {
    if (this.hasActiveWork() || this.pendingPermissions.size > 0) {
      return;
    }
    this.failureLatched = false;
    this.partyLatched = false;
    this.heartbeatLatched = !this.mainWindowVisible;
  }

  private startFailureHold(): void {
    if (this.hasActiveWork() || this.pendingPermissions.size > 0) {
      return;
    }
    this.partyLatched = false;
    this.heartbeatLatched = false;
    this.failureLatched = !this.mainWindowVisible;
  }

  private hasActiveWork(): boolean {
    return hasActiveWork(this.heartbeatRunning, this.automationRunning, this.busySessions.size);
  }

  private getDesiredStatus(): MiniModeStatus {
    // Active notification can override the indicator emoji, but not when work is in progress
    if (this.activeNotification?.statusOverride && !this.hasActiveWork()) {
      return this.activeNotification.statusOverride;
    }
    return getDesiredStatus({
      failureLatched: this.failureLatched,
      pendingPermissionCount: this.getVisiblePermissionCount(),
      hasActiveWork: this.hasActiveWork(),
      heartbeatLatched: this.heartbeatLatched,
      partyLatched: this.partyLatched,
    });
  }

  private getPreloadPath(): string {
    if (!this.preloadPath) {
      this.preloadPath = this.options.getPreloadPath();
    }
    return this.preloadPath;
  }

  private getCurrentPermission(): MiniModePermissionRequest | null {
    return getCurrentPermission(this.pendingPermissions, this.activePermissionId);
  }

  private getCurrentPermissionIndex(): number {
    return getCurrentPermissionIndex(this.pendingPermissions, this.activePermissionId);
  }

  private shouldShowIndicator(): boolean {
    return shouldShowIndicator({
      destroyed: this.destroyed,
      miniModeEnabled: this.miniModeEnabled,
      mainWindowVisible: this.mainWindowVisible,
    });
  }

  private getVisiblePermissionCount(): number {
    return Array.from(this.pendingPermissions.keys()).filter(
      (id) => !this.dismissedApprovalIds.has(id),
    ).length;
  }

  private shouldShowApproval(): boolean {
    return shouldShowApproval({
      indicatorVisible: this.shouldShowIndicator(),
      pendingPermissionCount: this.getVisiblePermissionCount(),
      approvalDismissInFlight: this.approvalDismissInFlight,
    });
  }

  private syncStatus(): void {
    const nextStatus = this.getDesiredStatus();
    if (this.status !== nextStatus) {
      this.status = nextStatus;
    }
    this.broadcastState();
    this.broadcastPermission();
    this.syncWindows();
  }

  private syncWindows(): void {
    if (!app.isReady()) {
      return;
    }

    this.ensureDisplayListeners();

    if (this.shouldShowIndicator()) {
      this.ensureIndicatorWindow();
      this.positionWindows();
      if (this.indicatorWindowController.isLoaded()) {
        this.showIndicatorWindow();
      }
    } else {
      this.hideIndicatorWindow();
    }
  }

  private ensureDisplayListeners(): void {
    if (this.displayListenersRegistered) {
      return;
    }

    screen.on("display-added", this.handleDisplayChange);
    screen.on("display-removed", this.handleDisplayChange);
    screen.on("display-metrics-changed", this.handleDisplayChange);
    this.displayListenersRegistered = true;
  }

  private positionWindows(): void {
    const workArea = screen.getPrimaryDisplay().workArea;
    // Window is always max size (approval height) — CSS controls content visibility
    const layout = getIndicatorWindowLayout({
      workArea,
      sizes: getMiniModeSizes(),
      bubbleType: "approval",
    });

    this.indicatorWindowController.setBounds(layout.bounds);
  }

  private ensureIndicatorWindow(): void {
    const layout = getIndicatorWindowLayout({
      workArea: screen.getPrimaryDisplay().workArea,
      sizes: getMiniModeSizes(),
      bubbleType: "approval",
    });
    this.indicatorWindowController.ensure({
      bounds: layout.bounds,
      pagePath: this.options.getPagePath(),
      onDidFinishLoad: () => {
        this.broadcastTheme();
        this.broadcastState();
        this.broadcastPermission();
        this.broadcastNotification();
        if (this.shouldShowIndicator()) {
          this.positionWindows();
          this.showIndicatorWindow();
        }
      },
      preloadPath: this.getPreloadPath(),
    });
  }

  private showIndicatorWindow(): void {
    this.indicatorWindowController.show();
  }

  private hideIndicatorWindow(): void {
    this.indicatorWindowController.hide();
  }

  private destroyIndicatorWindow(): void {
    this.indicatorWindowController.destroy();
  }

  private startApprovalDismiss(): void {
    if (this.pendingPermissions.size > 0 || !this.shouldShowIndicator()) {
      this.cancelApprovalDismiss();
      return;
    }

    if (this.approvalDismissTimer) {
      clearTimeout(this.approvalDismissTimer);
    }

    this.approvalDismissInFlight = true;
    this.approvalDismissTimer = setTimeout(() => {
      this.approvalDismissTimer = null;
      if (this.destroyed || !this.approvalDismissInFlight) {
        return;
      }
      this.approvalDismissInFlight = false;
      this.syncWindows();
    }, APPROVAL_COLLAPSE_DELAY_MS);
  }

  private cancelApprovalDismiss(): void {
    if (this.approvalDismissTimer) {
      clearTimeout(this.approvalDismissTimer);
      this.approvalDismissTimer = null;
    }
    if (!this.approvalDismissInFlight) {
      return;
    }
    this.approvalDismissInFlight = false;
  }

  private broadcastState(): void {
    const payload = {
      status: this.status,
      pendingPermissionCount: this.getVisiblePermissionCount(),
    };
    this.indicatorWindowController.send("mini-mode:state", payload);
  }

  private broadcastPermission(): void {
    const permission = this.getCurrentPermission();
    // Don't send dismissed permissions to the renderer
    const visiblePermission =
      permission && !this.dismissedApprovalIds.has(permission.id) ? permission : null;
    const payload = {
      permission: visiblePermission,
      pendingPermissionCount: this.getVisiblePermissionCount(),
      permissionIndex: this.getCurrentPermissionIndex(),
    };
    this.indicatorWindowController.send("mini-mode:permission", payload);
  }

  private broadcastTheme(): void {
    this.indicatorWindowController.send("mini-mode:theme", getMiniModePalette(this.themeMode));
  }

  getAsset(status: MiniModeStatus): string {
    const cached = this.assets.get(status);
    if (cached) {
      return cached;
    }

    const assetPath = this.assetPaths[status];
    try {
      const asset = fileToDataUrl(assetPath);
      this.assets.set(status, asset);
      return asset;
    } catch (error) {
      log.error(`Failed to load asset for ${status}:`, error);
      if (status !== "sleeping") {
        return this.getAsset("sleeping");
      }
      return "";
    }
  }
}
