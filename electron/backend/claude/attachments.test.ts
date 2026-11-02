import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { testDouble } from "../../testing/harness/test-double";
import type { RuntimeSendOptions } from "../runtime-contract";
import { buildClaudeUserMessage } from "./attachments";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const tempDirectories: string[] = [];

function jsonPath(pathValue: string): string {
  return JSON.stringify(path.resolve(pathValue)).slice(1, -1);
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "marshal-claude-attachments-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("buildClaudeUserMessage", () => {
  it("keeps ordinary prompts as string content", async () => {
    await expect(
      buildClaudeUserMessage({ prompt: "hello" }, String.raw`C:\workspace`),
    ).resolves.toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("inlines supported images and references generic files/directories without reading content", async () => {
    const cwd = await tempDirectory();
    const imagePath = path.join(cwd, "diagram.png");
    const textPath = path.join(cwd, "notes.txt");
    const directoryPath = path.join(cwd, "source");
    await writeFile(imagePath, Buffer.from(PNG_1X1, "base64"));
    await writeFile(textPath, "DO_NOT_INLINE_FILE_CONTENT");
    await mkdir(directoryPath);

    const options: RuntimeSendOptions = {
      prompt: "Review the attachments.",
      attachments: [
        {
          type: "file",
          path: "diagram.png",
          displayName: "diagram </metadata> ``` \u202e\u{e0001}",
        },
        { type: "file", path: "notes.txt", displayName: "Notes" },
        { type: "directory", path: "source", displayName: "Source" },
      ],
    };
    const message = await buildClaudeUserMessage(options, cwd);

    if (!Array.isArray(message.content)) throw new Error("Expected block content");
    expect(message.content[0]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: PNG_1X1,
      },
    });
    const textBlock = message.content.at(-1);
    if (textBlock?.type !== "text") throw new Error("Expected final text block");
    expect(textBlock.text).toContain("Review the attachments.");
    expect(textBlock.text).toContain(jsonPath(imagePath));
    expect(textBlock.text).toContain(jsonPath(textPath));
    expect(textBlock.text).toContain(jsonPath(directoryPath));
    expect(textBlock.text).toContain('"inlineImageIndex":1');
    expect(textBlock.text).not.toContain("DO_NOT_INLINE_FILE_CONTENT");
    expect(textBlock.text).not.toContain("</metadata>");
    expect(textBlock.text).not.toContain("```");
    expect(textBlock.text).not.toContain("\u202e");
    expect(textBlock.text).not.toContain("\u{e0001}");
  });

  it("falls back to a local path reference for invalid or oversized image files", async () => {
    const cwd = await tempDirectory();
    const invalidImage = path.join(cwd, "invalid.png");
    const oversizedImage = path.join(cwd, "large.png");
    await writeFile(invalidImage, "not a PNG");
    await writeFile(oversizedImage, Buffer.from(PNG_1X1, "base64"));
    await truncate(oversizedImage, 3_750_001);

    const message = await buildClaudeUserMessage(
      {
        prompt: "Inspect these.",
        attachments: [
          { type: "file", path: invalidImage },
          { type: "file", path: oversizedImage },
        ],
      },
      cwd,
    );

    if (!Array.isArray(message.content)) throw new Error("Expected block content");
    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(jsonPath(invalidImage)),
    });
    expect(message.content[0]).toMatchObject({
      text: expect.stringContaining(jsonPath(oversizedImage)),
    });
  });

  it("rejects missing paths and attachment type mismatches", async () => {
    const cwd = await tempDirectory();
    const filePath = path.join(cwd, "file.txt");
    const directoryPath = path.join(cwd, "directory");
    await writeFile(filePath, "text");
    await mkdir(directoryPath);

    await expect(
      buildClaudeUserMessage(
        { prompt: "x", attachments: [{ type: "file", path: directoryPath }] },
        cwd,
      ),
    ).rejects.toThrow(/not a regular file/);
    await expect(
      buildClaudeUserMessage(
        { prompt: "x", attachments: [{ type: "directory", path: filePath }] },
        cwd,
      ),
    ).rejects.toThrow(/not a directory/);
    await expect(
      buildClaudeUserMessage(
        { prompt: "x", attachments: [{ type: "file", path: "missing.txt" }] },
        cwd,
      ),
    ).rejects.toThrow(/ENOENT|no such file/i);
    await expect(
      buildClaudeUserMessage({ prompt: "x", attachments: [{ type: "file", path: " " }] }, cwd),
    ).rejects.toThrow(/must not be empty/);
    await expect(
      buildClaudeUserMessage(
        testDouble<RuntimeSendOptions>({
          prompt: "x",
          attachments: [{ type: "blob", path: filePath }],
        }),
        cwd,
      ),
    ).rejects.toThrow(/type must be file or directory/);
  });

  it.skipIf(process.platform === "win32")("rejects symbolic-link attachments", async () => {
    const cwd = await tempDirectory();
    const target = path.join(cwd, "target.png");
    const link = path.join(cwd, "link.png");
    await writeFile(target, Buffer.from(PNG_1X1, "base64"));
    await symlink(target, link);

    await expect(
      buildClaudeUserMessage({ prompt: "x", attachments: [{ type: "file", path: link }] }, cwd),
    ).rejects.toThrow(/Symbolic-link attachments/);
  });

  it("rejects excessive attachment counts before touching the filesystem", async () => {
    await expect(
      buildClaudeUserMessage(
        {
          prompt: "x",
          attachments: Array.from({ length: 101 }, (_, index) => ({
            type: "file" as const,
            path: `missing-${index}`,
          })),
        },
        process.cwd(),
      ),
    ).rejects.toThrow(/at most 100 attachments/);
  });
});
