/**
 * Slash commands surfaced in the Context Picker's Skills tab.
 *
 * Built-in commands (for example `/goal`) are Marshal-owned. Runtime extensions
 * inject additional commands through the chat slash-command placement.
 */

export interface SlashCommand {
  /** Command keyword typed after the slash, e.g. "goal" for `/goal`. */
  name: string;
  /** One-line description shown under the command in the picker. */
  description: string;
  readonly extensionId?: string;
  readonly applicationId?: string;
}

export const SLASH_PREFIX = "/";
export const SLASH_FRESH_FLAG = "--fresh";
export const SLASH_PLACEMENT_ARGUMENT_KEY = "argument";
export const SLASH_PLACEMENT_FRESH_KEY = "fresh";
export const SLASH_PLACEMENT_IDEMPOTENCY_PREFIX = "slash";
export const SLASH_INVOCATION_PATTERN = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i;

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "goal",
    description: "Set a long-term goal the agent autonomously pursues until it's complete",
  },
];

export interface SlashInvocation {
  readonly name: string;
  readonly argument: string;
  readonly fresh: boolean;
}

/** Parse a composer `/command [--fresh] argument` invocation. */
export function parseSlashInvocation(text: string): SlashInvocation | null {
  const match = SLASH_INVOCATION_PATTERN.exec(text.trim());
  if (!match) return null;
  const name = match[1]?.toLowerCase();
  if (!name) return null;
  const rest = match[2]?.trim() ?? "";
  const fresh = rest === SLASH_FRESH_FLAG || rest.startsWith(`${SLASH_FRESH_FLAG} `);
  const argument = fresh ? rest.slice(SLASH_FRESH_FLAG.length).trim() : rest;
  return { name, argument, fresh };
}

/** Stable cmdk/listbox id for a command row (namespaced so it can't collide
 *  with skill ids). */
export function commandValue(command: SlashCommand): string {
  return `command:${command.name}`;
}

/** Filter slash commands by the current slash query (case-insensitive
 *  prefix/substring match on the command name), mirroring skill filtering. */
export function filterCommandsByQuery(
  query: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const q = query.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().includes(q));
}

/** Map a Runtime UI slash-command placement application onto a picker command. */
export function slashCommandFromPlacement(application: {
  readonly extensionId: string;
  readonly applicationId: string;
  readonly title: string;
  readonly description: string;
}): SlashCommand {
  return {
    name: application.applicationId,
    description: application.description || application.title,
    extensionId: application.extensionId,
    applicationId: application.applicationId,
  };
}

/** Merge built-in and extension-injected commands, keeping the first name. */
export function mergeSlashCommands(
  builtIn: readonly SlashCommand[],
  injected: readonly SlashCommand[],
): SlashCommand[] {
  const seen = new Set(builtIn.map((command) => command.name.toLowerCase()));
  return [
    ...builtIn,
    ...injected.filter((command) => {
      const name = command.name.toLowerCase();
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    }),
  ];
}
