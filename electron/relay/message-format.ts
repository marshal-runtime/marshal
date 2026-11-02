import type { SessionSource } from "../../common/marshal-ipc-contract";
import { makeQuickTitle } from "../../common/marshal-quick-title";

export interface RelayMessageSession {
  id: string;
  name?: string;
  source?: SessionSource;
  aiGeneratedTitle?: string;
}

const FALLBACK_TITLE = "Marshal session";
const MAX_RELAY_CHAT_TITLE_CHARS = 80;

function normalizeTitle(value: string | undefined): string {
  const cleaned = (value ?? "")
    .trim()
    .replace(/^(?:Teams|Relay):\s*/i, "")
    .replace(/\s+/g, " ");
  const quickTitle = makeQuickTitle(cleaned);
  if (!quickTitle) return FALLBACK_TITLE;
  if (quickTitle.length <= MAX_RELAY_CHAT_TITLE_CHARS) return quickTitle;
  return `${quickTitle.slice(0, MAX_RELAY_CHAT_TITLE_CHARS).trimEnd()}...`;
}

export function getRelayChatTitle(
  session?: Pick<RelayMessageSession, "name" | "aiGeneratedTitle">,
): string {
  return normalizeTitle(session?.aiGeneratedTitle || session?.name);
}

export function formatRelayRoute(routeId: string): string {
  return `/route:${routeId.trim()}`;
}

function formatRouteInstruction(routeId: string): string {
  return `Route: reply \`${formatRelayRoute(routeId)}\` before your message to continue with this chat.`;
}

export function formatRelaySessionDetails(
  session: RelayMessageSession,
  options?: { routeId?: string },
): string {
  const lines = [`Chat: **${getRelayChatTitle(session)}**`];
  if (options?.routeId) lines.push(formatRouteInstruction(options.routeId));
  return lines.join("\n");
}

export function formatRelaySessionHeader(
  session?: RelayMessageSession | null,
  options?: { routeId?: string },
): string {
  if (!session?.id) return "📋 **Marshal notification**";
  const kind = session.source === "subagent" ? "Subagent" : "Agent";
  const lines = [`📋 **${kind}: ${getRelayChatTitle(session)}**`];
  if (options?.routeId) lines.push(formatRouteInstruction(options.routeId));
  return lines.join("\n");
}

export function formatRelaySessionMessage(
  content: string,
  session?: RelayMessageSession | null,
  options?: { routeId?: string },
): string {
  return `${formatRelaySessionHeader(session, options)}\n\n---\n\n${content.trim()}`;
}
