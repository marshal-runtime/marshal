/**
 * The per-turn "views attached to this session" line. main.ts registers the
 * describer once the runtime UI controller exists; the session hook reads it
 * on every user turn (see buildUserPromptContext). A missing describer or a
 * failing one yields no line: the agent can still call ui.layout.get.
 */
import { createLogger } from "../common/marshal-logger";

type ViewsDescriber = (sessionId: string) => string | undefined;

const log = createLogger("RuntimeUiTurnContext");
let describer: ViewsDescriber | undefined;

export function setRuntimeUiViewsDescriber(next: ViewsDescriber | undefined): void {
  describer = next;
}

export function describeSessionViews(sessionId: string): string | undefined {
  try {
    return describer?.(sessionId) || undefined;
  } catch (error) {
    log.warn(`views summary failed: ${error instanceof Error ? error.name : "unknown"}`);
    return undefined;
  }
}
