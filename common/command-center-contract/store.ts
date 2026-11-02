import type { CommandCenterEvent, CommandCenterEventInput } from "./events";
import type { CommandCenterSnapshot } from "./snapshot";

export interface CommandCenterAppendResult {
  event: CommandCenterEvent;
  snapshot: CommandCenterSnapshot;
}

export interface CommandCenterStore {
  append(input: CommandCenterEventInput): Promise<CommandCenterAppendResult>;
  rebuild(): CommandCenterSnapshot;
  getSnapshot(): CommandCenterSnapshot;
}
