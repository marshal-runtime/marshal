import { APP_NAME } from "../common/marshal-constants";
import type { MarshalPromptFiles } from "./backend/ports";

export const MARSHAL_DEFAULT_BOOTSTRAP = `# Bootstrap

This app ships the Workspace 1.0 default content as trusted bundled configuration. Local workspace files are not read into the system prompt.
`;

// Capabilities are listed generically — enumerating them by name would leak
// disabled tools into the prompt; the dynamic capability list is authoritative.
export const MARSHAL_DEFAULT_TOOLS = `# Tools

${APP_NAME} exposes a curated set of runtime capabilities — file system, shell, browser automation, web search, and ${APP_NAME} self-control — gated per session by user settings and tenant policy. The "Current Runtime Capability Status" section below is the authoritative list of what is enabled in this session.

Use \`runtimeSearch\` as the entry point to the live ${APP_NAME} Runtime capability catalog, including extensions for brain and memory, attachment conversion, swarm orchestration, agentic browser, and debugging. Use \`runtimeInvoke\` to execute a capability returned by the catalog. Use \`runtimeExecuteTypeScript\` for inline brokered TypeScript and \`runtimeExecuteModule\` for workspace-file or artifact modules. React UI render tools are available through \`runtimeListRenderTools\` and \`runtimeInvokeRenderTool\`. Search the catalog before claiming that a capability is unavailable.
`;

export const MARSHAL_DEFAULT_MEMORY = `# Memory

Memory entries should be useful, accurate, and tied to user preferences, durable facts, decisions, or project context.

Do not store secrets, credentials, payment card numbers, health information, government identifiers, or other sensitive personal data as memory.
`;

export const MARSHAL_DEFAULT_IDENTITY = `# Identity

Workspace identity evidence has not been populated yet.
`;

export function getBundledMarshalPromptFiles(): MarshalPromptFiles {
  // soul omitted so the in-app soul picker stays in charge; a
  // backend-supplied SOUL.md wins simply by being present.
  return {
    tools: MARSHAL_DEFAULT_TOOLS.trim(),
    memory: MARSHAL_DEFAULT_MEMORY.trim(),
    identity: MARSHAL_DEFAULT_IDENTITY.trim(),
    bootstrap: MARSHAL_DEFAULT_BOOTSTRAP.trim(),
  };
}
