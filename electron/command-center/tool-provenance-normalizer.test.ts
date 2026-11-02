import { describe, expect, it } from "vitest";

import { normalizeToolProvenance, normalizeToolSnapshot } from "./tool-provenance-normalizer";

const options = { hashSalt: "test-salt" };

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function expectAbsent(json: string, forbidden: readonly string[]): void {
  for (const raw of forbidden) {
    expect(json).not.toContain(raw);
  }
}

describe("Command Center privacy normalizer", () => {
  it("falls back to generic unknown-tool metadata without raw args or results", () => {
    const event = normalizeToolProvenance(
      {
        toolCallId: "tc-unknown",
        toolName: "custom_secret_tool",
        serverName: "custom-server",
        args: { prompt: "summarize Project Falcon", customer: "Acme" },
        result: { body: "Private tool result body" },
        success: true,
        startedAtMs: 100,
        completedAtMs: 150,
      },
      options,
    );

    expect(event).toMatchObject({
      type: "command-center.tool-provenance",
      domain: "unknown",
      toolCallId: "tc-unknown",
      toolName: "custom_secret_tool",
      serverName: "custom-server",
      argKeys: ["customer", "prompt"],
      status: "succeeded",
      durationMs: 50,
    });
    expect(event.argsHash).toMatch(/^sha256:/);
    expect(event.resultHash).toMatch(/^sha256:/);
    expectAbsent(serialized(event), ["Project Falcon", "Acme", "Private tool result body"]);
  });

  it("normalizes filesystem paths and content to hashes plus extension metadata", () => {
    const event = normalizeToolProvenance(
      {
        toolCallId: "tc-file",
        toolName: "read_file",
        serverName: "filesystem",
        args: {
          path: "C:\\Users\\omerm\\Documents\\secret-roadmap.md",
        },
        result: {
          content: "The private file contents mention Project Falcon.",
        },
        success: true,
      },
      options,
    );

    expect(event.domain).toBe("filesystem");
    if (event.domain !== "filesystem") throw new Error("expected filesystem event");
    expect(event.file).toMatchObject({
      operation: "read",
      pathCount: 1,
      extensions: [".md"],
    });
    expect(event.file.pathHashes?.[0]).toMatch(/^sha256:/);
    expect(event.file.basenameHashes?.[0]).toMatch(/^sha256:/);
    expect(event.file.contentHash).toMatch(/^sha256:/);
    expectAbsent(serialized(event), [
      "C:\\Users\\omerm\\Documents\\secret-roadmap.md",
      "secret-roadmap",
      "Project Falcon",
      "private file contents",
    ]);
  });

  it("keeps query tools on unrecognized servers in the unknown domain without raw args", () => {
    const snapshot = normalizeToolSnapshot(
      [
        {
          toolCallId: "tc-query",
          toolName: "execute_query",
          serverName: "analytics-mcp",
          args: { query: "SensitiveTable | where Customer == 'Acme'" },
          result: { rows: [{ State: "TEXAS" }] },
          success: true,
        },
        {
          toolCallId: "tc-list",
          toolName: "list_items",
          args: { folder: "inbox", url: "https://example.com/private/item/42" },
          success: true,
        },
      ],
      options,
    );

    expect(snapshot.map((event) => event.domain)).toEqual(["unknown", "unknown"]);
    expect(snapshot[0].argsHash).toMatch(/^sha256:/);
    expectAbsent(serialized(snapshot), ["SensitiveTable", "Acme", "TEXAS", "/private/item"]);
  });

  it("normalizes shell and browser actions without command text, URL paths, snapshots, or screenshots", () => {
    const snapshot = normalizeToolSnapshot(
      [
        {
          toolCallId: "tc-shell",
          toolName: "powershell_exec",
          serverName: "shell",
          args: {
            command:
              "git diff -- C:\\Users\\omerm\\src\\private-file.ts; curl https://example.com/private?token=secret",
          },
          result: { stdout: "diff --git a/private b/private\n+secret" },
          success: true,
        },
        {
          toolCallId: "tc-browser",
          toolName: "browser_navigate",
          serverName: "playwright",
          args: {
            url: "https://acme.example.com/private/path?token=secret",
            snapshot: "button named Private Customer",
          },
          result: { screenshot: "base64-private-image", snapshot: "Private accessibility tree" },
          success: true,
        },
      ],
      options,
    );

    const shell = snapshot[0];
    const browser = snapshot[1];
    expect(shell.domain).toBe("shell");
    if (shell.domain !== "shell") throw new Error("expected shell event");
    expect(shell.shell.category).toBe("network");
    expect(shell.shell.commandHash).toMatch(/^sha256:/);
    expect(browser.domain).toBe("browser");
    if (browser.domain !== "browser") throw new Error("expected browser event");
    expect(browser.browser).toMatchObject({
      action: "navigate",
      urlScheme: "https",
    });
    expect(browser.browser.urlOriginHash).toMatch(/^sha256:/);
    expectAbsent(serialized(snapshot), [
      "git diff",
      "private-file.ts",
      "token=secret",
      "/private/path",
      "Private Customer",
      "base64-private-image",
      "accessibility tree",
      "diff --git",
    ]);
  });
});
