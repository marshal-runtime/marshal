import type { BrowserWindow } from "electron";

import type { AIInvestigatorEvent } from "../../../common/marshal-ipc-contract";

export function makeAIInvestigatorEmitter(getWindow: () => BrowserWindow | null) {
  return (event: AIInvestigatorEvent): void => {
    getWindow()?.webContents.send("aiInvestigator:event", event);
  };
}
