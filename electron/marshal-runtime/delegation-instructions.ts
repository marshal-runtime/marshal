import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  isToolFreeRuntimeAgentRole,
  type SessionRuntimeAgentRole,
} from "../../common/marshal-ipc-contract";

const MAX_INLINE_TASK = 32_768;

/** Keep the native task envelope bounded without discarding any instruction bytes. */
export async function prepareDelegationInstructions(
  prompt: string,
  role: SessionRuntimeAgentRole,
  directory?: string,
): Promise<string> {
  if (prompt.length <= MAX_INLINE_TASK) return prompt;
  if (isToolFreeRuntimeAgentRole(role))
    throw new Error("Oversized delegation instructions require a role with file-read tools.");
  if (!directory)
    throw new Error(
      "Oversized delegation instructions require a configured instruction snapshot directory.",
    );
  const bytes = Buffer.from(prompt, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const root = path.resolve(directory);
  const target = path.join(root, `${digest}.md`);
  const task = [
    "The complete task and all constraints are in an immutable instruction snapshot.",
    `Absolute path: ${JSON.stringify(target)}`,
    `SHA-256 (UTF-8 bytes): ${digest}`,
    `Length: ${bytes.length} bytes.`,
    "Before any repository action, delegation, or completion, read this entire file with your file-read tool. If the tool pages or truncates output, continue reading until every section has been read. Treat its complete contents as this task's instructions, including scope, user constraints, acceptance criteria, sibling ownership, Field Guide, and response interface.",
    "If the file cannot be read completely, report that concrete blocker; do not guess, proceed with a partial task, or claim completion.",
  ].join("\n");
  if (task.length > MAX_INLINE_TASK)
    throw new Error("Instruction snapshot path exceeds the native task envelope.");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = path.join(root, `.instructions-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o400 });
  try {
    try {
      // Link publishes a fully written inode without replacing an existing snapshot.
      await link(temporary, target);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    if (!(await readFile(target)).equals(bytes))
      throw new Error("Instruction snapshot integrity mismatch.");
  } finally {
    await unlink(temporary);
  }
  return task;
}
