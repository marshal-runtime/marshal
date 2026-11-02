import { isMockMode } from "./mock-mode";

export function shouldUseRealE2EHandler(channel: string): boolean {
  if (!isMockMode()) return false;
  if (process.env.MARSHAL_GOAL_HARNESS === "1" && channel.startsWith("goal:")) {
    return true;
  }
  return process.env.MARSHAL_E2E_WORKSPACE_FIXTURES === "1" && channel.startsWith("workspace:");
}
