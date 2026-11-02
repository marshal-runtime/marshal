/* Mini-mode renderer script — runs inside the mini-mode BrowserWindow. */
/* global window, document, console, setTimeout, clearTimeout */

const button = document.getElementById("mini-button");
const icon = document.getElementById("mini-icon");
const fallback = document.getElementById("mini-fallback");
const approvalCard = document.getElementById("approval-card");
const kindEl = document.getElementById("permission-kind");
const titleEl = document.getElementById("permission-title");
const messageEl = document.getElementById("permission-message");
const detailEl = document.getElementById("permission-detail");
const detailFullEl = document.getElementById("permission-detail-full");
const detailExpandButton = document.getElementById("permission-detail-expand");
const detailOverlay = document.getElementById("permission-detail-overlay");
const detailCloseButton = document.getElementById("permission-detail-close");
const actionsEl = document.getElementById("permission-actions");
const countEl = document.getElementById("permission-count");
const approvalDismissBtn = document.getElementById("approval-dismiss");
const notificationToast = document.getElementById("notification-toast");
const notificationIcon = document.getElementById("notification-icon");
const notificationTitle = document.getElementById("notification-title");
const notificationBody = document.getElementById("notification-body");
const notificationDismissBtn = document.getElementById("notification-dismiss");
const notificationBadge = document.getElementById("notification-badge");
const notificationReadMore = document.getElementById("notification-read-more");

// Keep in sync with the approval-card transition in style.css.
const APPROVAL_DISMISS_TRANSITION_MS = 160;

const labels = {
  sleeping: "Marshal is sleeping",
  thinking: "Marshal is thinking",
  monocle: "Marshal needs your approval",
  party: "Marshal completed a task",
  crying: "Marshal hit an error",
  heartbeat: "Marshal found something urgent",
  "broken-heart": "Marshal heartbeat failed",
};

const fallbackEmoji = {
  sleeping: "\uD83D\uDCA4",
  thinking: "\uD83E\uDD14",
  monocle: "\uD83E\uDDD0",
  party: "\uD83E\uDD73",
  crying: "\uD83D\uDE2D",
  heartbeat: "\uD83D\uDC93",
  "broken-heart": "\uD83D\uDC94",
};

const permissionKindLabels = {
  shell: "\uD83D\uDCBB Command",
  write: "\uD83D\uDCDD File Edit",
  mcp: "\uD83E\uDDE9 MCP Tool",
  read: "\uD83D\uDCC4 File Read",
  url: "\uD83D\uDD17 URL Access",
  "custom-tool": "\uD83D\uDEE0\uFE0F Custom Tool",
  memory: "\uD83E\uDDE0 Memory",
  hook: "\uD83E\uDE9D Hook",
};

const assetCache = new Map();
let iconRequestId = 0;
let currentIconStatus = "";
let currentPermission = null;
let dismissTimer = null;

const notificationIcons = {
  "heartbeat-urgent": "⚠️",
  "heartbeat-error": "❌",
  "automation-complete": "✅",
  "automation-failed": "❌",
};

function applyTheme(theme) {
  if (!theme) {
    return;
  }

  const vars = {
    "--mini-window-background": theme.windowBackground,
    "--mini-surface-background": theme.surfaceBackground,
    "--mini-border-color": theme.borderColor,
    "--mini-text-primary": theme.textPrimary,
    "--mini-text-secondary": theme.textSecondary,
    "--mini-code-background": theme.codeBackground,
    "--mini-secondary-button-background": theme.secondaryButtonBackground,
    "--mini-secondary-button-text": theme.secondaryButtonText,
    "--mini-approval-kind-background": theme.approvalKindBackground,
    "--mini-approval-kind-text": theme.approvalKindText,
    "--mini-approval-kind-border-color": theme.approvalKindBorderColor,
    "--mini-count-background": theme.countBackground,
    "--mini-count-text": theme.countText,
    "--mini-link-color": theme.linkColor,
  };

  for (const [name, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(name, value);
  }
}

function showFallback(status) {
  icon.removeAttribute("src");
  icon.style.display = "none";
  fallback.textContent = fallbackEmoji[status] || fallbackEmoji.sleeping;
  fallback.style.display = "block";
  currentIconStatus = status;
}

icon.addEventListener("load", () => {
  icon.style.display = "block";
  fallback.style.display = "none";
});

icon.addEventListener("error", () => {
  showFallback(button.dataset.state || "sleeping");
});

async function updateIcon(status) {
  if (status === currentIconStatus && icon.getAttribute("src")) {
    return;
  }

  const requestId = ++iconRequestId;

  // If asset is cached, apply it immediately (no fallback flash)
  if (assetCache.has(status)) {
    const asset = assetCache.get(status);
    if (asset) {
      currentIconStatus = status;
      icon.src = asset;
    } else {
      showFallback(status);
    }
    return;
  }

  // Not cached — show fallback emoji while loading
  showFallback(status);
  try {
    const result = await window.miniModeAPI.getAsset(status);
    assetCache.set(status, result && result.success && result.asset ? result.asset : "");
  } catch {
    assetCache.set(status, "");
  }

  if (requestId !== iconRequestId) {
    return;
  }

  const asset = assetCache.get(status);
  if (!asset) {
    showFallback(status);
    return;
  }

  currentIconStatus = status;
  icon.src = asset;
}

function toAction(label) {
  switch (label) {
    case "Allow":
      return "allow";
    case "Allow for session":
      return "allow-session";
    case "Always allow":
      return "always-allow";
    case "Deny":
      return "deny";
    // Consent-card wording; mirrors
    // LABEL_TO_ACTION in src/features/chat/components/PermissionCard.tsx.
    case "Accept and continue":
      return "allow";
    case "Cancel":
      return "deny";
    // Legacy labels for old cards
    case "Always allow this":
    case "Auto-allow safe commands":
      return "allow-type";
    case "Allow all tools":
      return "allow-all";
    default:
      return null;
  }
}

// Display-only relabel — keep wire labels canonical (matched by toAction
// above and by `LABEL_TO_ACTION` in PermissionCard.tsx) but surface the
// friendlier verb-led name on the mini-mode card, matching the chat-card UI.
const DISPLAY_LABEL_OVERRIDES = {
  "Always allow": "Allow everywhere",
};

function getButtonRole(label) {
  if (label === "Allow") return "primary";
  if (label === "Deny") return "danger";
  return "secondary";
}

function closeDetailOverlay() {
  detailOverlay.hidden = true;
}

function clearDismissTimer() {
  if (dismissTimer) {
    window.clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

function finishPermissionDismiss() {
  clearDismissTimer();
  approvalCard.hidden = true;
  approvalCard.classList.remove("is-dismissing");
  titleEl.textContent = "Waiting for approval";
  messageEl.textContent = "";
  detailEl.textContent = "";
  detailFullEl.textContent = "";
  actionsEl.replaceChildren();
  kindEl.textContent = "Approval";
}

function dismissPermission() {
  if (!currentPermission || approvalCard.hidden) {
    finishPermissionDismiss();
    return;
  }

  closeDetailOverlay();
  for (const child of actionsEl.querySelectorAll("button")) {
    child.disabled = true;
  }
  approvalCard.hidden = false;
  approvalCard.classList.add("is-dismissing");
  clearDismissTimer();
  dismissTimer = window.setTimeout(() => {
    dismissTimer = null;
    if (currentPermission) {
      approvalCard.classList.remove("is-dismissing");
      return;
    }
    finishPermissionDismiss();
  }, APPROVAL_DISMISS_TRANSITION_MS);
}

function openDetailOverlay() {
  if (!currentPermission || !currentPermission.detail) {
    return;
  }
  detailOverlay.hidden = false;
}

function setPendingCount(index, count) {
  if (count > 0) {
    countEl.textContent = count + " approval" + (count === 1 ? "" : "s") + " needed in-app";
    countEl.style.display = "inline-flex";
  } else {
    countEl.textContent = "";
    countEl.style.display = "none";
  }
}

function renderPermission(payload) {
  const permission = payload && payload.permission ? payload.permission : null;
  const count = Number(
    payload && payload.pendingPermissionCount ? payload.pendingPermissionCount : 0,
  );
  const index = Number(payload && payload.permissionIndex ? payload.permissionIndex : 0);
  setPendingCount(index, count);

  if (!permission) {
    currentPermission = null;
    dismissPermission();
    return;
  }

  clearDismissTimer();
  currentPermission = permission;
  approvalCard.hidden = false;
  approvalCard.classList.remove("is-dismissing");
  closeDetailOverlay();
  kindEl.textContent = permissionKindLabels[permission.kind] || permission.kind;
  titleEl.textContent = permission.title;
  messageEl.textContent = permission.message;
  detailEl.textContent = permission.detail;
  detailFullEl.textContent = permission.detail;
  actionsEl.replaceChildren();

  for (const label of permission.buttons || []) {
    const action = toAction(label);
    if (!action) continue;
    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = "action-button";
    actionButton.textContent = DISPLAY_LABEL_OVERRIDES[label] || label;
    actionButton.dataset.role = getButtonRole(label);
    actionButton.addEventListener("click", async () => {
      if (!currentPermission) return;
      for (const child of actionsEl.querySelectorAll("button")) {
        child.disabled = true;
      }
      try {
        await window.miniModeAPI.respondPermission(currentPermission.id, action);
      } catch (error) {
        console.error("Failed to resolve permission", error);
        for (const child of actionsEl.querySelectorAll("button")) {
          child.disabled = false;
        }
      }
    });
    actionsEl.appendChild(actionButton);
  }
}

function applyState(payload) {
  const status = payload && payload.status ? payload.status : "sleeping";
  icon.alt = labels[status] || labels.sleeping;
  button.dataset.state = status;
  void updateIcon(status);
}

let activeNotificationSessionId = null;
let activeNotificationUrl = null;
let notificationDismissAnimTimer = null;

function renderNotificationToast(payload) {
  const notification = payload && payload.notification ? payload.notification : null;
  const queueCount = Number(payload && payload.queueCount ? payload.queueCount : 0);

  if (!notification) {
    activeNotificationSessionId = null;
    activeNotificationUrl = null;
    if (notificationToast.hidden) return;
    notificationToast.classList.add("is-dismissing");
    // Cancel any previous dismiss timer
    if (notificationDismissAnimTimer) clearTimeout(notificationDismissAnimTimer);
    notificationDismissAnimTimer = setTimeout(() => {
      notificationDismissAnimTimer = null;
      // Guard: only hide if still in dismissing state (new notification may have arrived)
      if (notificationToast.classList.contains("is-dismissing")) {
        notificationToast.hidden = true;
        notificationToast.classList.remove("is-dismissing");
      }
    }, 200);
    return;
  }

  // Cancel any in-flight dismiss animation so the new notification isn't hidden
  if (notificationDismissAnimTimer) {
    clearTimeout(notificationDismissAnimTimer);
    notificationDismissAnimTimer = null;
  }

  notificationIcon.textContent = notificationIcons[notification.type] || "ℹ️";
  notificationTitle.textContent = notification.title;
  // Set body text without destroying the "Read more…" child span
  notificationReadMore.hidden = true;
  Array.from(notificationBody.childNodes).forEach(function (n) {
    if (n !== notificationReadMore) notificationBody.removeChild(n);
  });
  notificationBody.insertBefore(document.createTextNode(notification.body), notificationReadMore);
  notificationReadMore.hidden = false;
  activeNotificationSessionId = notification.sessionId || null;
  activeNotificationUrl = notification.url || null;

  // Show queue badge if there are more notifications waiting
  if (queueCount > 0) {
    notificationBadge.textContent = "(" + queueCount + " more)";
    notificationBadge.style.display = "inline";
  } else {
    notificationBadge.textContent = "";
    notificationBadge.style.display = "none";
  }

  notificationToast.hidden = false;
  notificationToast.classList.remove("is-dismissing");
}

// --- Initialization ---

window.miniModeAPI
  .getState()
  .then((payload) => {
    applyState(payload);
    renderPermission(payload);
  })
  .catch(() => {
    applyState({ status: "sleeping" });
    renderPermission(null);
  });

window.miniModeAPI.onState(applyState);
window.miniModeAPI.onPermission(renderPermission);
window.miniModeAPI.onTheme(applyTheme);
window.miniModeAPI.onNotification(renderNotificationToast);

button.addEventListener("click", () => {
  void window.miniModeAPI.showMainWindow();
});
detailExpandButton.addEventListener("click", openDetailOverlay);
detailCloseButton.addEventListener("click", closeDetailOverlay);

notificationDismissBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  renderNotificationToast({ notification: null });
  void window.miniModeAPI.dismissNotification();
});

notificationToast.addEventListener("click", () => {
  if (activeNotificationUrl) {
    void window.miniModeAPI.openUrl(activeNotificationUrl);
  } else {
    void window.miniModeAPI.showMainWindow(activeNotificationSessionId || undefined);
  }
});

approvalDismissBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (currentPermission) {
    void window.miniModeAPI.dismissApproval(currentPermission.id);
  }
});

// --- Click-through forwarding ---
// The window defaults to setIgnoreMouseEvents(true, { forward: true }),
// making clicks pass through transparent areas. When the mouse enters an
// interactive element we toggle to accept clicks; on leave we revert.
// A short debounce on leave prevents rapid-fire IPC when moving between
// adjacent elements (e.g., approval card → indicator button).

let leaveTimer = null;
let lastMouseX = -1;
let lastMouseY = -1;

function onInteractiveEnter() {
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
  window.miniModeAPI.setInteractive(true);
}

function onInteractiveLeave() {
  if (leaveTimer) clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    leaveTimer = null;
    window.miniModeAPI.setInteractive(false);
  }, 16);
}

// Track mouse position so we can hit-test when elements appear under the cursor.
document.addEventListener("mousemove", (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
});

// If a notification/approval appears and the cursor is already over it,
// mouseenter won't fire. Do a one-time hit-test after state changes.
function checkCursorOverInteractive() {
  if (lastMouseX < 0) return;
  var el = document.elementFromPoint(lastMouseX, lastMouseY);
  if (
    el &&
    (el.closest(".mini-button") ||
      el.closest(".approval-card") ||
      el.closest(".notification-toast"))
  ) {
    onInteractiveEnter();
  }
}

button.addEventListener("mouseenter", onInteractiveEnter);
button.addEventListener("mouseleave", onInteractiveLeave);
approvalCard.addEventListener("mouseenter", onInteractiveEnter);
approvalCard.addEventListener("mouseleave", onInteractiveLeave);
notificationToast.addEventListener("mouseenter", onInteractiveEnter);
notificationToast.addEventListener("mouseleave", onInteractiveLeave);

window.miniModeAPI.onState(checkCursorOverInteractive);
window.miniModeAPI.onPermission(checkCursorOverInteractive);
window.miniModeAPI.onNotification(checkCursorOverInteractive);
