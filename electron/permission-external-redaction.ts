import { APP_NAME } from "../common/marshal-constants";
import type { ApprovalRequest } from "./backend/types";

/** Relay-only button: points the user at the in-app card and resolves nothing. */
export const OPEN_IN_APP_BUTTON = `Open in ${APP_NAME}`;

export interface ExternalPermissionPrompt {
  readonly isForgetCompletely: boolean;
  readonly message: string;
  readonly detail: string;
  readonly buttons: string[];
}

/**
 * What a permission card may show outside the in-app card (relay mirrors).
 * The forget-completely card quotes the user's memory and approves an
 * irreversible erase, so relays get a generic line and no Allow: only
 * "Open in Marshal" or Deny.
 */
export function externalPermissionPrompt(
  request: ApprovalRequest,
  message: string,
  detail: string,
  buttons: string[],
): ExternalPermissionPrompt {
  const isForgetCompletely = request.kind === "settings" && !!request.diff?.forgetCompletely;
  if (isForgetCompletely) {
    return {
      isForgetCompletely,
      message: `${APP_NAME} wants to erase a memory permanently. Review it in ${APP_NAME}.`,
      detail: "",
      buttons: [OPEN_IN_APP_BUTTON, "Deny"],
    };
  }
  return { isForgetCompletely, message, detail, buttons };
}

/** OS notification body: never a memory being erased. */
export function permissionNotificationBody(prompt: {
  readonly message: string;
  readonly isForgetCompletely?: boolean;
}): string {
  if (prompt.isForgetCompletely) return `${APP_NAME} wants to erase a memory permanently`;
  return prompt.message;
}
