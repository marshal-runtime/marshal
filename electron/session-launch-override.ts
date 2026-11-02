import { lstat } from "node:fs/promises";
import path from "node:path";

/** Longest system prompt that a launch can supply. */
export const MAX_LAUNCH_SYSTEM_PROMPT_CHARS = 65_536;
/** Most files that a launch can attach to its first message. */
export const MAX_LAUNCH_ATTACHMENTS = 20;
/** Longest attachment path that a launch can supply. */
export const MAX_LAUNCH_ATTACHMENT_PATH_CHARS = 4_096;

const LAUNCH_MESSAGE_ID_PREFIX = "subagent-launch:";

/** A launch attachment in the shape that a session send accepts. */
export interface LaunchFileAttachment {
  type: "file";
  path: string;
}

/** Rejects a launch whose attachments are not absolute paths of regular files. */
export async function assertLaunchAttachments(paths: readonly string[]): Promise<void> {
  if (paths.length > MAX_LAUNCH_ATTACHMENTS) {
    throw new RangeError(`A launch can attach at most ${MAX_LAUNCH_ATTACHMENTS} files.`);
  }
  await Promise.all(
    paths.map(async (filePath) => {
      if (filePath.length > MAX_LAUNCH_ATTACHMENT_PATH_CHARS || !path.isAbsolute(filePath)) {
        throw new TypeError(`A launch attachment must be an absolute file path: ${filePath}`);
      }
      const stats = await lstat(filePath).catch(() => undefined);
      if (!stats?.isFile()) {
        throw new TypeError(`A launch attachment is not a regular file: ${filePath}`);
      }
    }),
  );
}

/** Rejects a launch system prompt that is empty or too long. */
export function assertLaunchSystemPrompt(systemPrompt: string): void {
  if (!systemPrompt.trim() || systemPrompt.length > MAX_LAUNCH_SYSTEM_PROMPT_CHARS) {
    throw new RangeError(
      `A launch system prompt must have 1 to ${MAX_LAUNCH_SYSTEM_PROMPT_CHARS} characters.`,
    );
  }
}

/** Outbox message ID of the first message of a subagent that has launch attachments. */
export function subagentLaunchMessageId(sessionId: string): string {
  return `${LAUNCH_MESSAGE_ID_PREFIX}${sessionId}`;
}

/** Converts launch attachment paths to session send attachments. */
export function launchFileAttachments(
  paths: readonly string[] | undefined,
): LaunchFileAttachment[] | undefined {
  return paths?.length ? paths.map((filePath) => ({ type: "file", path: filePath })) : undefined;
}

/** System message of a session whose launch replaced Marshal's prompt. */
export function launchOverrideSystemMessage(
  systemPrompt: string,
  conversationContext: string,
): { content: string; mode: "replace" } {
  return { content: `${systemPrompt}${conversationContext}`, mode: "replace" };
}
