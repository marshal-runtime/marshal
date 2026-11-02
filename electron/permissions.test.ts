import { describe, it, expect } from "vitest";

import type { ApprovalRequest } from "./backend/types";
import { getShellDescription, formatPermissionDialog, truncateMiddle } from "./permissions";
import { makeRequest as makeReq } from "./policy-rules/test-helpers";

describe("getShellDescription", () => {
  describe("Unix/macOS commands", () => {
    it.each([
      ["ls -la", "List files in a folder"],
      ["cat README.md", "Read a file"],
      ["head -n 10 file.txt", "Read the beginning of a file"],
      ["tail -f log.txt", "Read the end of a file"],
      ['find . -name "*.ts"', "Search for files"],
      ['grep -r "TODO" src/', "Search for text in files"],
      ["rg pattern", "Search for text in files"],
      ["pwd", "Show the current folder location"],
      ["cd /home/user", "Change to a different folder"],
      ["mkdir -p new-dir", "Create a new folder"],
      ["rm -rf temp/", "Delete a file or folder"],
      ["cp file.txt backup.txt", "Copy a file"],
      ["mv old.txt new.txt", "Move or rename a file"],
      ['echo "hello"', "Display a message or write text"],
      ["chmod 755 script.sh", "Change file permissions"],
      ["ps aux", "List running programs"],
      ["kill 1234", "Stop a running program"],
      ["whoami", "Show your username"],
      ["ssh user@host", "Connect to a remote computer"],
      ["tar -xzf archive.tar.gz", "Create or extract an archive"],
      ["curl https://example.com", "Download from a URL"],
    ])('"%s" → "%s"', (command, expected) => {
      expect(getShellDescription(command)).toBe(expected);
    });
  });

  describe("Windows/PowerShell commands", () => {
    it.each([
      ["dir C:\\Users", "List files in a folder"],
      ["type file.txt", "Read a file"],
      ["del temp.txt", "Delete a file or folder"],
      ["copy file.txt backup.txt", "Copy files"],
      ["robocopy src dest", "Copy files"],
      ["move old.txt new.txt", "Move or rename a file"],
      ["Get-ChildItem -Path C:\\Users", "List files in a folder"],
      ["gci -Recurse", "List files in a folder"],
      ["Get-Content log.txt", "Read a file"],
      ['Set-Content -Path out.txt -Value "hello"', "Write to a file"],
      ["New-Item -ItemType File test.txt", "Create a new file or folder"],
      ["Remove-Item temp/", "Delete a file or folder"],
      ["Copy-Item src.txt dest.txt", "Copy a file"],
      ["Move-Item old.txt new.txt", "Move or rename a file"],
      ["Rename-Item old.txt new.txt", "Rename a file or folder"],
      ["Test-Path C:\\file.txt", "Check if a file or folder exists"],
      ['Select-String -Pattern "error" log.txt', "Search for text in files"],
      ["Get-Process", "List running programs"],
      ["Stop-Process -Id 1234", "Stop a running program"],
      ["Invoke-WebRequest https://example.com", "Download from a URL"],
      ["iwr https://example.com", "Download from a URL"],
      ["Get-Date", "Show the current date and time"],
      ["Compress-Archive -Path src -DestinationPath out.zip", "Create a zip file"],
      ["Expand-Archive out.zip", "Extract a zip file"],
    ])('"%s" → "%s"', (command, expected) => {
      expect(getShellDescription(command)).toBe(expected);
    });
  });

  describe("cross-platform tools", () => {
    it.each([
      ["git status", "Check which files have changed"],
      ["git log --oneline", "Show the history of changes"],
      ["git diff HEAD~1", "Show what changed in files"],
      ["git push origin main", "Upload your changes"],
      ["git clone https://github.com/repo", "Download a project"],
      ["npm install express", "Install software packages"],
      ["npm i -D vitest", "Install software packages"],
      ["npm run build", "Run a project script"],
      ["npm test", "Run the project tests"],
      ["pip install requests", "Install Python packages"],
      ["python script.py", "Run a Python script"],
      ["node index.js", "Run a JavaScript script"],
    ])('"%s" → "%s"', (command, expected) => {
      expect(getShellDescription(command)).toBe(expected);
    });
  });

  it("handles piped commands by matching the first segment", async () => {
    expect(getShellDescription("ls -la | grep test")).toBe("List files in a folder");
    expect(getShellDescription("Get-ChildItem | Select-Object Name")).toBe(
      "List files in a folder",
    );
  });

  it("returns null for unknown commands", async () => {
    expect(getShellDescription("some-custom-tool --flag")).toBeNull();
    expect(getShellDescription("mycli run")).toBeNull();
  });

  it("handles whitespace", async () => {
    expect(getShellDescription("  ls -la  ")).toBe("List files in a folder");
    expect(getShellDescription("  Get-ChildItem  ")).toBe("List files in a folder");
  });
});

describe("formatPermissionDialog", () => {
  describe("shell commands", () => {
    it("uses SDK intention when available", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "shell",
          sessionId: "s1",
          command: "Get-ChildItem -Recurse",
          intention: "List all files in Documents folder",
          warning: undefined,
          commandIdentifiers: [],
          serverName: "",
        }),
      );
      expect(result.title).toBe("💻 Run a Command");
      expect(result.message).toBe("List all files in Documents folder");
      expect(result.detail).toContain("Get-ChildItem -Recurse");
    });

    it("falls back to static description when no intention", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "shell",
          sessionId: "s1",
          command: "git status",
          intention: undefined,
          warning: undefined,
          commandIdentifiers: [],
          serverName: "",
        }),
      );
      expect(result.message).toBe("Check which files have changed");
    });

    it("falls back to generic message for unknown commands", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "shell",
          sessionId: "s1",
          command: "my-custom-tool --do-stuff",
          intention: undefined,
          warning: undefined,
          commandIdentifiers: [],
          serverName: "",
        }),
      );
      expect(result.message).toBe("Marshal wants to run a terminal command");
      expect(result.detail).toContain("my-custom-tool --do-stuff");
    });
  });

  describe("forget completely", () => {
    it("says the erase is irreversible and shows the memory text", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "settings",
          sessionId: "s1",
          diff: { forgetCompletely: { memoryText: "Omer prefers tabs" } },
        }),
      );
      expect(result.title).toBe("Forget Memory Completely");
      expect(result.message).toContain("irreversible");
      expect(result.message).toContain("Omer prefers tabs");
      expect(result.detail).toContain("Omer prefers tabs");
    });

    it("truncates a long memory in the visible message but keeps it whole in detail", async () => {
      const memoryText = `start-${"x".repeat(2_000)}-end`;
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "settings",
          sessionId: "s1",
          diff: { forgetCompletely: { memoryText } },
        }),
      );
      expect(result.message).toContain("irreversible");
      expect(result.message).toContain("start-");
      expect(result.message).toContain("-end");
      expect(result.message.length).toBeLessThan(600);
      expect(result.detail).toContain(memoryText);
    });
  });

  describe("file operations", () => {
    it("formats write requests", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "write",
          sessionId: "s1",
          path: "/tmp/output.txt",
          intention: "Save results",
          diff: null,
          origin: "synthesized-browser",
        }),
      );
      expect(result.title).toBe("📝 Save File");
      expect(result.message).toBe("Save results");
      expect(result.detail).toContain("/tmp/output.txt");
    });

    it("uses default message when no intention", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "write",
          sessionId: "s1",
          path: "/tmp/output.txt",
          intention: undefined,
          diff: null,
          origin: "synthesized-browser",
        }),
      );
      expect(result.message).toBe("Marshal wants to create or edit a file");
    });

    it("formats read requests with the file path", async () => {
      const result = await formatPermissionDialog(
        makeReq({ id: "r1", kind: "read", sessionId: "s1", path: "/ws/src/index.ts" }),
        "/ws",
      );
      expect(result.title).toBe("📖 Read File");
      expect(result.detail).toContain("/ws/src/index.ts");
      // In-workspace → no folder-grant disclosure.
      expect(result.detail).not.toContain("outside your workspace");
    });

    it("discloses the granted folder for an out-of-workspace read", async () => {
      const result = await formatPermissionDialog(
        makeReq({ id: "r2", kind: "read", sessionId: "s1", path: "/home/me/Downloads/x.txt" }),
        "/ws",
      );
      expect(result.detail).toContain("outside your workspace");
      expect(result.detail).toContain("read access");
      expect(result.detail).toContain("/home/me/Downloads");
    });

    it("discloses the granted folder for an out-of-workspace write", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "w3",
          kind: "write",
          sessionId: "s1",
          path: "/home/me/Downloads/new.txt",
          intention: undefined,
          diff: null,
          origin: "sdk",
        }),
        "/ws",
      );
      expect(result.detail).toContain("outside your workspace");
      expect(result.detail).toContain("write access");
      expect(result.detail).toContain("/home/me/Downloads");
    });

    it("omits the disclosure when no workspaceDir is provided", async () => {
      const result = await formatPermissionDialog(
        makeReq({ id: "r4", kind: "read", sessionId: "s1", path: "/home/me/Downloads/x.txt" }),
      );
      expect(result.detail).not.toContain("outside your workspace");
    });
  });

  describe("browser tools", () => {
    it("formats keyboard input", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "mcp",
          sessionId: "s1",
          toolName: "browser_press_key",
          toolArgs: { key: "Enter" },
          serverName: undefined,
          toolTitle: undefined,
          toolDescription: undefined,
          readOnly: false,
        }),
      );
      expect(result.title).toBe("⌨️ Keyboard Input");
      expect(result.message).toContain("Enter");
    });

    it("formats file upload", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "mcp",
          sessionId: "s1",
          toolName: "browser_file_upload",
          toolArgs: { paths: ["photo.jpg"] },
          serverName: undefined,
          toolTitle: undefined,
          toolDescription: undefined,
          readOnly: false,
        }),
      );
      expect(result.title).toBe("📁 File Upload");
      expect(result.message).toContain("1 file(s)");
    });

    it("formats dialog accept", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "mcp",
          sessionId: "s1",
          toolName: "browser_handle_dialog",
          toolArgs: { accept: true },
          serverName: undefined,
          toolTitle: undefined,
          toolDescription: undefined,
          readOnly: false,
        }),
      );
      expect(result.message).toContain("OK");
    });

    it("formats dialog dismiss", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "mcp",
          sessionId: "s1",
          toolName: "browser_handle_dialog",
          toolArgs: { accept: false },
          serverName: undefined,
          toolTitle: undefined,
          toolDescription: undefined,
          readOnly: false,
        }),
      );
      expect(result.message).toContain("dismiss");
    });

    it("formats code execution", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "mcp",
          sessionId: "s1",
          toolName: "browser_evaluate",
          toolArgs: { code: "document.title" },
          serverName: undefined,
          toolTitle: undefined,
          toolDescription: undefined,
          readOnly: false,
        }),
      );
      expect(result.title).toBe("⚠️ Run Code in Browser");
      expect(result.detail).toContain("document.title");
    });
  });

  describe("custom tools", () => {
    it("formats custom tool with friendly name", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "custom-tool",
          sessionId: "s1",
          toolName: "listSkills",
          toolDescription: "List available skills",
          toolArgs: {},
          intention: undefined,
          warning: undefined,
          commandIdentifiers: [],
        }),
      );
      expect(result.title).toBe("🛠️ List Skills");
      expect(result.message).toBe("List available skills");
    });

    it("truncates multi-sentence descriptions to first sentence", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "custom-tool",
          sessionId: "s1",
          toolName: "createSkill",
          toolDescription:
            "Create a new skill. Provide a name and instructions. To edit an existing skill, use updateSkill instead.",
          toolArgs: {},
          intention: undefined,
          warning: undefined,
          commandIdentifiers: [],
        }),
      );
      expect(result.message).toBe("Create a new skill.");
    });

    it("falls back to generic message when no description", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "custom-tool",
          sessionId: "s1",
          toolName: "search_files",
          toolDescription: undefined,
          toolArgs: {},
          intention: undefined,
          warning: undefined,
          commandIdentifiers: [],
        }),
      );
      expect(result.title).toBe("🛠️ Search Files");
      expect(result.message).toContain("Search Files");
    });

    it("includes compact args summary", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "custom-tool",
          sessionId: "s1",
          toolName: "sendNotification",
          toolDescription: "Send a notification",
          toolArgs: { to: "user@example.com", subject: "Hello" },
          intention: undefined,
          warning: undefined,
          commandIdentifiers: [],
        }),
      );
      expect(result.detail).toContain("to:");
      expect(result.detail).toContain("subject:");
    });
  });

  describe("MCP tools (non-Playwright)", () => {
    it("formats generic MCP tool with server name", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "mcp",
          sessionId: "s1",
          toolName: "read_file",
          serverName: "filesystem",
          toolDescription: "Read a file from disk",
          toolTitle: undefined,
          toolArgs: {},
          readOnly: false,
        }),
      );
      expect(result.title).toBe("🔌 read_file");
      expect(result.message).toBe("Read a file from disk");
    });

    it("uses toolTitle when available", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "mcp",
          sessionId: "s1",
          toolName: "read_file",
          toolTitle: "Read File",
          serverName: "filesystem",
          toolDescription: undefined,
          toolArgs: {},
          readOnly: false,
        }),
      );
      expect(result.title).toBe("🔌 Read File");
      expect(result.message).toContain("Read File");
      expect(result.message).toContain("filesystem");
    });

    it("still uses Playwright-specific formatting for browser tools", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "mcp",
          sessionId: "s1",
          toolName: "browser_press_key",
          toolArgs: { key: "Tab" },
          serverName: undefined,
          toolTitle: undefined,
          toolDescription: undefined,
          readOnly: false,
        }),
      );
      expect(result.title).toBe("⌨️ Keyboard Input");
    });
  });

  describe("URL access", () => {
    it("formats URL requests", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "url",
          sessionId: "s1",
          url: "https://example.com",
          toolName: "",
        }),
      );
      expect(result.title).toBe("🌐 Open a Website");
      expect(result.detail).toContain("https://example.com");
    });
  });

  describe("generic fallback", () => {
    it("handles unknown permission kinds", async () => {
      const result = await formatPermissionDialog(
        makeReq({
          id: "test-id",
          kind: "something-new" as ApprovalRequest["kind"], // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- intentionally testing unknown kind
          sessionId: "s1",
        }),
      );
      expect(result.title).toBe("🔐 Permission Needed");
      expect(result.message).toContain("something-new");
    });
  });
});

describe("truncateMiddle", () => {
  it("returns short strings unchanged", async () => {
    expect(truncateMiddle("hello")).toBe("hello");
  });

  it("returns empty string unchanged", async () => {
    expect(truncateMiddle("")).toBe("");
  });

  it("truncates long strings with omitted count", async () => {
    const input = "a".repeat(600);
    const result = truncateMiddle(input);
    expect(result).toContain("[…");
    expect(result).toContain("characters omitted");
    expect(result.length).toBeLessThan(input.length);
  });

  it("preserves start and end of input", async () => {
    const input = "START" + "x".repeat(600) + "END";
    const result = truncateMiddle(input);
    expect(result.startsWith("START")).toBe(true);
    expect(result.endsWith("END")).toBe(true);
  });

  it("respects custom head/tail sizes", async () => {
    const input = "a".repeat(100);
    const result = truncateMiddle(input, { head: 10, tail: 10 });
    expect(result).toContain("characters omitted");
    expect(result.startsWith("a".repeat(10))).toBe(true);
    expect(result.endsWith("a".repeat(10))).toBe(true);
  });

  it("hides count when showOmittedCount is false", async () => {
    const input = "x".repeat(600);
    const result = truncateMiddle(input, { showOmittedCount: false });
    expect(result).toContain("[…]");
    expect(result).not.toContain("characters omitted");
  });

  it("normalizes CRLF to LF by default", async () => {
    const input = "line1\r\nline2\r\n" + "x".repeat(600);
    const result = truncateMiddle(input);
    expect(result).not.toContain("\r\n");
  });

  it("preserves CRLF when normalizeNewlines is false", async () => {
    const input = "line1\r\n" + "x".repeat(600);
    const result = truncateMiddle(input, { normalizeNewlines: false });
    expect(result).toContain("\r\n");
  });

  it("handles emoji without splitting grapheme clusters", async () => {
    // Family emoji is a single grapheme but multiple code points
    const emoji = "👨‍👩‍👧‍👦";
    const input = emoji.repeat(300);
    const result = truncateMiddle(input, { head: 10, tail: 10 });
    // Should not produce broken surrogate pairs or partial ZWJ sequences
    expect(result).toContain("[…");
    expect(result.startsWith(emoji.repeat(10))).toBe(true);
    expect(result.endsWith(emoji.repeat(10))).toBe(true);
  });
});

function makeCustomTool(
  toolName: string,
  toolArgs: Record<string, unknown> = {},
  toolDescription?: string,
): ApprovalRequest {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test helper; typed fields
  return makeReq({
    id: "p1",
    sessionId: "s1",
    kind: "custom-tool",
    toolName,
    toolArgs,
    toolDescription,
    intention: undefined,
    warning: undefined,
    commandIdentifiers: [],
  });
}

describe("formatPermissionDialog — automation creation", () => {
  it("shows full prompt without truncation for createAutomation", async () => {
    const longPrompt = "Check for updates. ".repeat(100); // ~1900 chars
    const result = await formatPermissionDialog(
      makeCustomTool("createAutomation", {
        name: "Daily Update",
        description: "Check for new releases",
        schedule: "every day at 9am",
        prompt: longPrompt,
        enabled: true,
      }),
    );
    expect(result.title).toBe("⚙️ Create Automation");
    expect(result.detail).toContain("Name: Daily Update");
    expect(result.detail).toContain("Schedule: every day at 9am");
    expect(result.detail).toContain("Prompt:\n" + longPrompt);
    expect(result.detail).not.toContain("[…");
    expect(result.detail).not.toContain("omitted");
  });

  it("renders all automation fields when provided", async () => {
    const result = await formatPermissionDialog(
      makeCustomTool("createAutomation", {
        name: "Condition Bot",
        prompt: "check inbox",
        triggerType: "condition",
        condition: "new email from boss",
        conditionCheckInterval: 5,
        oneShot: true,
        enabled: false,
      }),
    );
    expect(result.detail).toContain("Name: Condition Bot");
    expect(result.detail).toContain("Trigger: condition");
    expect(result.detail).toContain("Condition: new email from boss");
    expect(result.detail).toContain("Check interval: 5 min");
    expect(result.detail).toContain("One-shot: yes");
    expect(result.detail).toContain("Enabled: no");
  });

  it("preserves newlines in prompt", async () => {
    const result = await formatPermissionDialog(
      makeCustomTool("createAutomation", {
        name: "Test",
        prompt: "Step 1: do this\nStep 2: do that\nStep 3: report",
      }),
    );
    expect(result.detail).toContain("Step 1: do this\nStep 2: do that");
  });

  it("other custom tools still truncate normally", async () => {
    const longText = "x".repeat(1000);
    const result = await formatPermissionDialog(
      makeCustomTool("sendNotification", { message: longText }),
    );
    expect(result.detail).toContain("[…");
  });

  it("handles empty args gracefully", async () => {
    const result = await formatPermissionDialog(makeCustomTool("createAutomation"));
    expect(result.title).toBe("⚙️ Create Automation");
    expect(result.detail).toBe("");
  });
});
