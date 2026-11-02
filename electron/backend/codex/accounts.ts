import os from "node:os";
import path from "node:path";

import { isRuntimeAccountId } from "../../../common/runtime-accounts";

/** `CODEX_HOME` of an extra Codex account; the original account keeps `defaultCodexHome()`. */
export function codexAccountHome(accountId: string, homeDir: string = os.homedir()): string {
  if (!isRuntimeAccountId(accountId)) throw new Error("Invalid Codex account id");
  return path.join(homeDir, ".marshal", "marshal-codex-accounts", accountId);
}
