import path from "node:path";

import { isRuntimeAccountId } from "../../../common/runtime-accounts";
import { CURSOR_SDK_AUTH_RELATIVE_PATH } from "./constants";

export function marshalCursorCredentialStorePath(appDataDir: string, accountId?: string): string {
  if (!accountId) return path.join(appDataDir, CURSOR_SDK_AUTH_RELATIVE_PATH);
  if (!isRuntimeAccountId(accountId)) throw new Error("Invalid Cursor account id");
  return path.join(appDataDir, "cursor-accounts", accountId, CURSOR_SDK_AUTH_RELATIVE_PATH);
}
