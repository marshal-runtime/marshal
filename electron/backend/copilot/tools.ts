import { LocalToolBackend } from "../local/tools";
import type { ICopilotProviderForTools } from "./internal";

const COPILOT_PREFERRED_DEFAULT_IDS = [
  "gpt-5.6-sol",
  "gpt-5.5",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "gpt-5.4",
] as const;

export class CopilotToolBackend extends LocalToolBackend {
  constructor(backend: ICopilotProviderForTools) {
    super(backend, COPILOT_PREFERRED_DEFAULT_IDS);
  }
}
