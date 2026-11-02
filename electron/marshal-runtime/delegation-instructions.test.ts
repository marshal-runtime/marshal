import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { prepareDelegationInstructions } from "./delegation-instructions";

it.each(["swarm", "worker", "reviewer", "reconciler"] as const)(
  "preserves full oversized instructions for %s in a private immutable snapshot",
  async (role) => {
    const directory = await mkdtemp(path.join(tmpdir(), "delegation-instructions-"));
    try {
      const prompt = "Full constraint αβ\n".repeat(4000);
      const digest = createHash("sha256").update(prompt, "utf8").digest("hex");
      const target = path.join(directory, `${digest}.md`);
      const task = await prepareDelegationInstructions(prompt, role, directory);
      expect(task.length).toBeLessThanOrEqual(32768);
      expect(task).toContain(JSON.stringify(target));
      expect(task).toContain(digest);
      expect(task).toContain("read this entire file");
      expect(await readFile(target)).toEqual(Buffer.from(prompt, "utf8"));
      expect((await stat(target)).mode & 0o777).toBe(0o400);
      expect(await prepareDelegationInstructions(prompt, role, directory)).toBe(task);
      expect(await readdir(directory)).toEqual([`${digest}.md`]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("leaves ordinary prompts unchanged and rejects unreadable or unconfigured oversized handoffs", async () => {
  const normal = "a".repeat(32768);
  expect(await prepareDelegationInstructions(normal, "worker")).toBe(normal);
  await expect(prepareDelegationInstructions(`${normal}x`, "planner", "/unused")).rejects.toThrow(
    "file-read tools",
  );
  await expect(prepareDelegationInstructions(`${normal}x`, "worker")).rejects.toThrow(
    "snapshot directory",
  );
});
