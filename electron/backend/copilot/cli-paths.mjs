import os from "node:os";
import path from "node:path";

/** Paths owned by the GitHub Copilot CLI, not by Marshal. */
export function getCopilotCliRoot(homeDir = os.homedir()) {
  return path.join(homeDir, ".copilot");
}

export function getCopilotCliConfigPath(homeDir = os.homedir()) {
  return path.join(getCopilotCliRoot(homeDir), "config.json");
}

export function getCopilotCliLogsDir(homeDir = os.homedir()) {
  return path.join(getCopilotCliRoot(homeDir), "logs");
}
