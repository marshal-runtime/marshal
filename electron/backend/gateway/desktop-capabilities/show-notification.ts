/**
 * DesktopCapabilities RPC #5 — `showNotification`.
 *
 * Wraps the synchronous `sendOSNotification` (electron/platform/notifications.ts) into
 * the spec's async signature. When the cloud supplies an `onClickAction` of
 * type `openSession`, the click is wired to a deps-injected callback the
 * bridge (dispatch 4) routes to the renderer's active-session switch.
 *
 * Spec: docs/specs/gateway-automations-phase-2b-design.md §5.1 (RPC #5).
 */

import { createLogger } from "../../../../common/marshal-logger";
import { sendOSNotification } from "../../../platform/notifications";
import type { NotificationRequest } from "../../types";

const log = createLogger("desktop-capabilities:show-notification");

export interface ShowNotificationDeps {
  /** Test/Bridge override. Defaults to the real `sendOSNotification`. */
  sendOSNotification?: (title: string, body: string, onClick?: () => void) => void;
  /**
   * Invoked when the user clicks a notification whose `onClickAction.type` is
   * `openSession`. Wired by the bridge to switch the renderer's active session.
   * Absent → click is silently ignored (still safe; native notification dismisses).
   */
  onSessionOpenRequested?: (sessionId: string) => void;
}

export function makeShowNotificationHandler(deps: ShowNotificationDeps = {}) {
  const send = deps.sendOSNotification ?? sendOSNotification;
  const onSessionOpenRequested = deps.onSessionOpenRequested;

  return async function showNotification(request: NotificationRequest): Promise<void> {
    let onClick: (() => void) | undefined;
    const action = request.onClickAction;
    if (action) {
      switch (action.type) {
        case "openSession":
          onClick = onSessionOpenRequested
            ? () => onSessionOpenRequested(action.sessionId)
            : undefined;
          break;
        default: {
          // Exhaustive-check: a future `NotificationClickAction` variant
          // added without updating this handler would silently swallow user
          // clicks. The compiler flags this branch as `never` if all cases
          // are handled; a runtime miss logs a warn so it surfaces in logs.
          const _exhaustive: never = action.type;
          log.warn("Unhandled onClickAction variant — click ignored", {
            type: String(_exhaustive),
          });
        }
      }
    }
    send(request.title, request.body, onClick);
  };
}
