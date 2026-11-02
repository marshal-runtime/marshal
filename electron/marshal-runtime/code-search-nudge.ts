/**
 * Steers concept-style code searches to the workspace knowledge index. When the
 * session can reach `knowledge.search`, the first grep that reads like a
 * question (several words or alternatives) in a session or subagent that has
 * not searched the index yet is denied once, with a ready-to-run
 * `knowledge.search` call; later ones only get an advisory note. Exact-string
 * greps are never blocked. Subagents get the same rule when they start.
 */
import type { RuntimeSubagentStartContext, RuntimeToolCallHint } from "../backend/runtime-contract";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "./contracts";

const KNOWLEDGE_SEARCH = "knowledge.search";
const AVAILABILITY_TTL_MS = 60_000;
const AVAILABILITY_TIMEOUT_MS = 500;
const MAX_CACHED_SESSIONS = 200;
const MAX_TRACKED_AGENTS = 2_000;
const SEARCH_COMMAND = /(^|[\s|;&(])(grep|egrep|rg|ag|git\s+grep)\s/;
const QUOTED = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
const KNOWLEDGE_CALL = /knowledge\.(search|context|impact|lookup)/;
const PATTERN_FLAG = /\s-e\s+(\S+)/g;
const REGEX_SYNTAX = /\\[|bBsSwWdD]|[|()[\]{}^$*+?.\\]/g;
const DEFAULT_QUERY = "what you are looking for, in words";

const PLAIN_WORD = /^[A-Za-z][A-Za-z-]{2,}$/;
const FILE_ARG = /^[\w.~/-]*\.[A-Za-z0-9]{1,6}$/;
/** camelCase, snake_case, `a.b`, `a::b`, or a `\b` word boundary: a name the agent already knows. */
const IDENTIFIER = /[a-z][A-Z]|[A-Za-z0-9]_[A-Za-z0-9]|\w\\?\.\w|::|\\b/;

const namesIdentifier = (text: string): boolean =>
  text.split(/\s+/).some((token) => IDENTIFIER.test(token));

function conceptShaped(pattern: string): boolean {
  if (pattern.includes("|")) {
    const alternatives = pattern
      .split(/\\?\|/)
      .map((alternative) => alternative.trim())
      .filter(Boolean);
    return !alternatives.every(namesIdentifier);
  }
  if (namesIdentifier(pattern)) return false;
  return (
    pattern
      .trim()
      .split(/\s+/)
      .filter((token) => PLAIN_WORD.test(token)).length >= 2
  );
}

/**
 * Searches that lead a pipeline, with quoted arguments masked. A grep after
 * `|` filters another command's output, so it is not a code search.
 */
function leadingSearches(command: string): Array<{ masked: string; quoted: string[] }> {
  const quoted: string[] = [];
  const masked = command.replace(
    QUOTED,
    (_match, double: string | undefined, single: string | undefined) => {
      quoted.push(double ?? single ?? "");
      return `''`;
    },
  );
  let next = 0;
  return masked.split(/&&|\|\||;|\n/).flatMap((segment) => {
    const stages = segment.split("|");
    const counts = stages.map((stage) => (stage.match(/''/g) ?? []).length);
    const first = { masked: stages[0], quoted: quoted.slice(next, next + counts[0]) };
    next += counts.reduce((sum, count) => sum + count, 0);
    return SEARCH_COMMAND.test(` ${first.masked}`) ? [first] : [];
  });
}

/** A search aimed at named files is a lookup inside code the agent already found. */
function namesFiles(maskedStage: string): boolean {
  return maskedStage
    .trim()
    .split(/\s+/)
    .some((token) => !token.startsWith("-") && FILE_ARG.test(token));
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value: unknown = Reflect.get(input, key);
  return typeof value === "string" ? value : undefined;
}

/** True when a Grep call or a shell grep/rg searches for several words or alternatives. */
export function isConceptCodeSearch(toolName: string, toolInput: unknown): boolean {
  const name = toolName.toLowerCase();
  if (name === "grep") {
    const pattern = field(toolInput, "pattern");
    const searchPath = field(toolInput, "path");
    if (searchPath !== undefined && FILE_ARG.test(searchPath)) return false;
    return pattern !== undefined && conceptShaped(pattern);
  }
  if (name !== "bash") return false;
  const command = field(toolInput, "command");
  if (!command) return false;
  return leadingSearches(command).some(
    ({ masked, quoted }) =>
      !namesFiles(masked) &&
      ((masked.match(/\s-e\s/g) ?? []).length >= 2 || quoted.some(conceptShaped)),
  );
}

/** The words of a concept search, as a knowledge.search query. */
export function conceptQuery(toolName: string, toolInput: unknown): string {
  const patterns =
    toolName.toLowerCase() === "grep"
      ? [field(toolInput, "pattern") ?? ""]
      : leadingSearches(field(toolInput, "command") ?? "").flatMap(({ masked, quoted }) => [
          ...quoted.filter(conceptShaped),
          ...[...masked.matchAll(PATTERN_FLAG)]
            .map((match) => match[1])
            .filter((arg) => arg !== "''"),
        ]);
  const words = patterns.join(" ").replace(REGEX_SYNTAX, " ").replace(/\s+/g, " ").trim();
  return words || DEFAULT_QUERY;
}

function searchCall(query: string): string {
  return (
    `return (await context.runtime.invoke('knowledge.search', {query: ${JSON.stringify(query)}, limit: 10}))` +
    ".hits.map((hit) => [hit.node.name, hit.node.path, hit.node.id]);"
  );
}

export function codeSearchNudgeText(scriptingToolName: string): string {
  return (
    "This looks like a concept search. The workspace knowledge index answers where/how/who-calls " +
    `questions in one ranked call across code and memories. Run it in ${scriptingToolName}: ` +
    `\`${searchCall(DEFAULT_QUERY)}\` Grep stays right for an exact string you already know. ` +
    "The search is running as sent."
  );
}

export function codeSearchGateText(scriptingToolName: string, query: string): string {
  return (
    "Blocked once: this is a concept search, and this session has not searched the knowledge index yet. " +
    `Search the index first, in ${scriptingToolName}: \`${searchCall(query)}\` Then open the top hits. ` +
    "After that every grep runs: send this one again if the index did not answer it. " +
    "A grep for an exact string you already know is never blocked."
  );
}

export function brainFirstSubagentText(scriptingToolName: string): string {
  return (
    "Code questions: this workspace has a code knowledge index. Your first code lookup is knowledge.search " +
    `through ${scriptingToolName}, before Grep, Glob or a shell grep: \`${searchCall(DEFAULT_QUERY)}\` ` +
    "Write the query as the question in words, then open the files of the top hits. " +
    "Grep stays right for an exact string you already know."
  );
}

export interface CodeSearchNudgeOptions {
  readonly api: Pick<MarshalRuntimeApi, "search">;
  readonly resolveScope: (sessionId: string) => Promise<MarshalRuntimeScope | null>;
}

export interface CodeSearchGuide {
  readonly toolCallHint: RuntimeToolCallHint;
  readonly subagentStartContext: RuntimeSubagentStartContext;
}

export function createCodeSearchGuide(options: CodeSearchNudgeOptions): CodeSearchGuide {
  const availability = new Map<
    string,
    { readonly at: number; readonly available: Promise<boolean> }
  >();
  const searchedIndex = new Set<string>();
  const gated = new Set<string>();

  const lookUp = async (sessionId: string): Promise<boolean> => {
    try {
      const scope = await options.resolveScope(sessionId);
      if (!scope) return false;
      const result = await options.api.search({ ...scope, name: KNOWLEDGE_SEARCH, limit: 1 });
      return (
        result.ok &&
        result.value.matches.some((match) => match.capability?.name === KNOWLEDGE_SEARCH)
      );
    } catch {
      return false;
    }
  };

  const cachedAvailability = (sessionId: string): Promise<boolean> => {
    const cached = availability.get(sessionId);
    if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.available;
    if (availability.size >= MAX_CACHED_SESSIONS) availability.clear();
    const available = lookUp(sessionId);
    availability.set(sessionId, { at: Date.now(), available });
    return available;
  };

  const isAvailable = async (sessionId: string): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), AVAILABILITY_TIMEOUT_MS);
    });
    const available = await Promise.race([cachedAvailability(sessionId), timedOut]);
    clearTimeout(timer);
    return available;
  };

  const track = (keys: Set<string>, key: string): void => {
    if (keys.size >= MAX_TRACKED_AGENTS) keys.clear();
    keys.add(key);
  };

  const toolCallHint: RuntimeToolCallHint = async ({
    toolName,
    toolInput,
    sessionId,
    agentId,
    scriptingToolName,
  }) => {
    const agentKey = `${sessionId}\u0000${agentId ?? ""}`;
    if (toolName === scriptingToolName) {
      if (KNOWLEDGE_CALL.test(field(toolInput, "source") ?? "")) track(searchedIndex, agentKey);
      return undefined;
    }
    if (!isConceptCodeSearch(toolName, toolInput)) return undefined;
    if (!(await isAvailable(sessionId))) return undefined;
    if (searchedIndex.has(agentKey) || gated.has(agentKey)) {
      return codeSearchNudgeText(scriptingToolName);
    }
    track(gated, agentKey);
    return { denyReason: codeSearchGateText(scriptingToolName, conceptQuery(toolName, toolInput)) };
  };

  const subagentStartContext: RuntimeSubagentStartContext = async ({
    sessionId,
    scriptingToolName,
  }) => ((await isAvailable(sessionId)) ? brainFirstSubagentText(scriptingToolName) : undefined);

  return { toolCallHint, subagentStartContext };
}
