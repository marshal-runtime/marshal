import { APP_NAME, FORGET_COMPLETELY_CARD_TITLE } from "../common/marshal-constants";
import type { ApprovalRequest } from "./backend/types";
import { grantFolderForPath, isPathWithinDir } from "./permission-path-scope";

// When a read/write targets a path OUTSIDE the workspace, "Always allow" grants
// the whole containing folder (FOLDER_GRANT_RULE), so the card must name it.
function folderGrantDisclosure(
  scope: "read" | "write",
  filePath: string,
  workspaceDir: string | undefined,
): string {
  if (!workspaceDir || !filePath || filePath === "*") return "";
  if (isPathWithinDir(filePath, workspaceDir)) return "";
  const verb = scope === "write" ? "write" : "read";
  // grantFolderForPath does a sync stat; acceptable here — this only runs on the
  // interactive card-format path (broker callback), never on startup or per-tool.
  return `\n\nThis is outside your workspace. “Always allow” grants ${APP_NAME} ${verb} access to everything in this folder:\n${grantFolderForPath(filePath)}`;
}

// Static friendly descriptions for common shell commands
export function getShellDescription(command: string): string | null {
  const trimmed = command.trim();
  const cmd = trimmed.split(/[|;&]/)[0].trim();

  const patterns: Array<[RegExp, string]> = [
    // Unix/macOS
    [/^ls\b/, "List files in a folder"],
    [/^cat\b/, "Read a file"],
    [/^head\b/, "Read the beginning of a file"],
    [/^tail\b/, "Read the end of a file"],
    [/^find\b/, "Search for files"],
    [/^grep\b|^rg\b/, "Search for text in files"],
    [/^pwd\b/, "Show the current folder location"],
    [/^cd\b/, "Change to a different folder"],
    [/^mkdir\b/, "Create a new folder"],
    [/^rm\b/, "Delete a file or folder"],
    [/^cp\b/, "Copy a file"],
    [/^mv\b/, "Move or rename a file"],
    [/^echo\b/, "Display a message or write text"],
    [/^chmod\b/, "Change file permissions"],
    [/^chown\b/, "Change file ownership"],
    [/^ps\b/, "List running programs"],
    [/^kill\b/, "Stop a running program"],
    [/^whoami\b/, "Show your username"],
    [/^date\b/, "Show the current date and time"],
    [/^df\b/, "Show disk space usage"],
    [/^du\b/, "Show folder sizes"],
    [/^tar\b/, "Create or extract an archive"],
    [/^zip\b|^unzip\b/, "Compress or extract files"],
    [/^ssh\b/, "Connect to a remote computer"],
    [/^scp\b/, "Copy files to/from a remote computer"],
    // Windows / PowerShell
    [/^dir\b/, "List files in a folder"],
    [/^type\b/, "Read a file"],
    [/^del\b|^erase\b/, "Delete a file or folder"],
    [/^copy\b|^xcopy\b|^robocopy\b/, "Copy files"],
    [/^move\b|^ren\b/, "Move or rename a file"],
    [/^Get-ChildItem\b|^gci\b/, "List files in a folder"],
    [/^Get-Content\b|^gc\b/, "Read a file"],
    [/^Set-Content\b|^sc\b|^Out-File\b/, "Write to a file"],
    [/^New-Item\b|^ni\b/, "Create a new file or folder"],
    [/^Remove-Item\b|^ri\b/, "Delete a file or folder"],
    [/^Copy-Item\b|^cpi\b/, "Copy a file"],
    [/^Move-Item\b|^mi\b/, "Move or rename a file"],
    [/^Rename-Item\b/, "Rename a file or folder"],
    [/^Test-Path\b/, "Check if a file or folder exists"],
    [/^Select-String\b|^sls\b/, "Search for text in files"],
    [/^Get-Process\b|^gps\b/, "List running programs"],
    [/^Stop-Process\b|^spps\b/, "Stop a running program"],
    [/^Get-Service\b/, "List system services"],
    [/^Invoke-WebRequest\b|^iwr\b|^Invoke-RestMethod\b|^irm\b/, "Download from a URL"],
    [/^Get-Date\b/, "Show the current date and time"],
    [/^Get-Location\b|^gl\b/, "Show the current folder location"],
    [/^Set-Location\b|^sl\b/, "Change to a different folder"],
    [/^Write-Output\b|^Write-Host\b/, "Display a message"],
    [/^Start-Process\b|^saps\b/, "Start a program"],
    [/^Get-ItemProperty\b/, "Read file or registry properties"],
    [/^Compress-Archive\b/, "Create a zip file"],
    [/^Expand-Archive\b/, "Extract a zip file"],
    // Cross-platform tools
    [/^git status/, "Check which files have changed"],
    [/^git log/, "Show the history of changes"],
    [/^git diff/, "Show what changed in files"],
    [/^git show/, "Show details of a change"],
    [/^git branch/, "List or manage branches"],
    [/^git checkout/, "Switch to a different version"],
    [/^git pull/, "Download the latest changes"],
    [/^git push/, "Upload your changes"],
    [/^git clone/, "Download a project"],
    [/^git commit/, "Save a snapshot of changes"],
    [/^git add/, "Stage files for saving"],
    [/^npm install\b|^npm i\b/, "Install software packages"],
    [/^npm run\b/, "Run a project script"],
    [/^npm test/, "Run the project tests"],
    [/^npm list|^npm ls/, "List installed packages"],
    [/^pip install/, "Install Python packages"],
    [/^python|^python3/, "Run a Python script"],
    [/^node\b/, "Run a JavaScript script"],
    [/^curl\b|^wget\b/, "Download from a URL"],
  ];

  for (const [pattern, description] of patterns) {
    if (pattern.test(cmd)) {
      return description;
    }
  }

  return null;
}

interface TruncateOptions {
  head?: number; // graphemes to keep at start
  tail?: number; // graphemes to keep at end
  showOmittedCount?: boolean; // include number of omitted chars
  normalizeNewlines?: boolean; // convert CRLF -> LF
}

export function truncateMiddle(
  input: string,
  {
    head = 250,
    tail = 250,
    showOmittedCount = true,
    normalizeNewlines = true,
  }: TruncateOptions = {},
): string {
  if (!input) return input;

  let text = input;

  // Normalize Windows CRLF -> LF
  if (normalizeNewlines) {
    text = text.replace(/\r\n/g, "\n");
  }

  // Use grapheme segmentation (handles emoji + combined chars correctly)
  const segmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });

  const graphemes = Array.from(segmenter.segment(text), (s) => s.segment);

  // If short enough, return as-is
  if (graphemes.length <= head + tail) {
    return text;
  }

  const omittedCount = graphemes.length - head - tail;

  const start = graphemes.slice(0, head).join("");
  const end = graphemes.slice(-tail).join("");

  const marker = showOmittedCount
    ? `\n\n[… ${omittedCount.toLocaleString()} characters omitted …]\n\n`
    : `\n\n[…]\n\n`;

  return start + marker + end;
}

/** Extract the first sentence from a tool description, dropping internal details. */
function firstSentence(text: string): string {
  const match = text.match(/^[^.!?]*[.!?]/);
  return match ? match[0].trim() : text;
}

function formatArgSummary(args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) return "";
  return truncateMiddle(
    Object.entries(args)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n"),
  );
}

export async function formatPermissionDialog(
  request: ApprovalRequest,
  workspaceDir?: string,
): Promise<{
  title: string;
  message: string;
  detail: string;
}> {
  const toolName: string =
    request.kind === "mcp" || request.kind === "custom-tool" ? request.toolName : "";

  const _mcpArgs: Record<string, unknown> = request.kind === "mcp" ? request.toolArgs : {};

  if (toolName.includes("browser_press_key")) {
    const key = (typeof _mcpArgs.key === "string" ? _mcpArgs.key : undefined) ?? "a key";
    return {
      title: "⌨️ Keyboard Input",
      message: `${APP_NAME} wants to press "${key}" on the keyboard`,
      detail: `This simulates a key press in the browser, like pressing Enter to submit a form.`,
    };
  }

  if (toolName.includes("browser_file_upload")) {
    const paths = (Array.isArray(_mcpArgs.paths) ? _mcpArgs.paths : null) ?? [];
    return {
      title: "📁 File Upload",
      message: `${APP_NAME} wants to upload ${paths.length} file(s) to a website`,
      detail: `Files: ${paths.join(", ") || "No files specified"}\n\nThis will send files from your computer to the website ${APP_NAME} is browsing.`,
    };
  }

  if (toolName.includes("browser_handle_dialog")) {
    const accept = _mcpArgs.accept;
    return {
      title: "💬 Browser Dialog",
      message: accept
        ? `${APP_NAME} wants to click "OK" on a popup`
        : `${APP_NAME} wants to dismiss a popup`,
      detail: `A dialog box appeared in the browser and ${APP_NAME} wants to ${accept ? "accept" : "dismiss"} it.`,
    };
  }

  if (toolName.includes("browser_evaluate") || toolName.includes("browser_run_code")) {
    const code =
      (typeof _mcpArgs.code === "string" ? _mcpArgs.code : "") ||
      (typeof _mcpArgs.function === "string" ? _mcpArgs.function : "") ||
      "";
    return {
      title: "⚠️ Run Code in Browser",
      message: `${APP_NAME} wants to run a script on the webpage`,
      detail: `This executes custom code on the page to read or modify it.\n\nCode:\n${truncateMiddle(code)}`,
    };
  }

  if (request.kind === "settings") {
    const diff = request.diff;
    if (diff?.forgetCompletely) {
      return {
        title: FORGET_COMPLETELY_CARD_TITLE,
        message: `${APP_NAME} wants to permanently erase this memory. This is irreversible: the memory and all of its earlier revisions cannot be restored.\n\n“${truncateMiddle(diff.forgetCompletely.memoryText, { head: 200, tail: 100 })}”`,
        detail: `Memory to erase:\n${diff.forgetCompletely.memoryText}`,
      };
    }
    const lines: string[] = [];

    if (diff?.allow) {
      const added = diff.allow.to.filter((p) => !diff.allow!.from.includes(p));
      const removed = diff.allow.from.filter((p) => !diff.allow!.to.includes(p));
      if (added.length) lines.push(`Allow list — add: ${added.join(", ")}`);
      if (removed.length) lines.push(`Allow list — remove: ${removed.join(", ")}`);
    }
    if (diff?.autoApproveReadOnly !== undefined) {
      lines.push(
        `Auto-approve read-only: ${diff.autoApproveReadOnly.from} → ${diff.autoApproveReadOnly.to}`,
      );
    }
    if (diff?.tools) {
      for (const [key, change] of Object.entries(diff.tools.changed)) {
        lines.push(`Tool "${key}": ${change.from} → ${change.to}`);
      }
    }
    if (diff?.servers) {
      for (const [key, change] of Object.entries(diff.servers)) {
        lines.push(
          `Server "${key}" auto-approve: ${change.autoApprove.from} → ${change.autoApprove.to}`,
        );
      }
    }

    return {
      title: "Permission Change Request",
      message: `${APP_NAME} wants to update your permission settings`,
      detail: lines.join("\n") || "Review the proposed permission change.",
    };
  }

  // Generic MCP tools — skip browser_ tools so they get Playwright-specific
  // formatting above or fall through to the generic fallback below
  if (request.kind === "mcp" && toolName && !toolName.startsWith("browser_")) {
    const serverDisplay = request.serverName ?? "MCP server";
    const title = request.toolTitle ?? toolName;
    const description = request.toolDescription ?? "";
    return {
      title: `🔌 ${title}`,
      message:
        (description && firstSentence(description)) ||
        `${APP_NAME} wants to use "${title}" from ${serverDisplay}`,
      detail: formatArgSummary(_mcpArgs),
    };
  }

  // Custom tool operations
  if (request.kind === "custom-tool") {
    const ctToolName = toolName || "Unknown tool";
    const description = request.toolDescription ?? "";
    const args = request.toolArgs;

    // Automation creation — show full prompt without truncation so users
    // can review the complete instructions before approving.
    if (ctToolName === "createAutomation") {
      const strArg = (key: string): string | undefined => {
        const v = args[key];
        return typeof v === "string"
          ? v
          : typeof v === "number" || typeof v === "boolean"
            ? `${v}`
            : undefined;
      };
      const lines: string[] = [];
      const name = strArg("name");
      const desc = strArg("description");
      const schedule = strArg("schedule");
      const triggerType = strArg("triggerType");
      const condition = strArg("condition");
      const checkInterval = strArg("conditionCheckInterval");
      const prompt = strArg("prompt");

      if (name) lines.push(`Name: ${name}`);
      if (desc) lines.push(`Description: ${desc}`);
      if (schedule) lines.push(`Schedule: ${schedule}`);
      if (triggerType) lines.push(`Trigger: ${triggerType}`);
      if (condition) lines.push(`Condition: ${condition}`);
      if (checkInterval) lines.push(`Check interval: ${checkInterval} min`);
      if (typeof args.oneShot === "boolean") lines.push(`One-shot: ${args.oneShot ? "yes" : "no"}`);
      if (typeof args.enabled === "boolean") lines.push(`Enabled: ${args.enabled ? "yes" : "no"}`);
      if (prompt) {
        lines.push("");
        lines.push(`Prompt:\n${prompt}`);
      }
      return {
        title: "⚙️ Create Automation",
        message:
          (description && firstSentence(description)) ||
          `${APP_NAME} wants to create an automation`,
        detail: lines.join("\n"),
      };
    }

    const displayName = ctToolName
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c: string) => c.toUpperCase());
    return {
      title: `🛠️ ${displayName}`,
      message:
        (description && firstSentence(description)) ||
        `${APP_NAME} wants to use the ${displayName} tool`,
      detail: formatArgSummary(args),
    };
  }

  // File operations
  if (request.kind === "write") {
    const filePath = request.path || "unknown file";
    const intention = request.intention ?? "";
    return {
      title: "📝 Save File",
      message: intention || `${APP_NAME} wants to create or edit a file`,
      detail: `File: ${filePath}${folderGrantDisclosure("write", request.path, workspaceDir)}`,
    };
  }

  if (request.kind === "read") {
    const filePath = request.path || "unknown file";
    return {
      title: "📖 Read File",
      message: `${APP_NAME} wants to read a file`,
      detail: `File: ${filePath}${folderGrantDisclosure("read", request.path, workspaceDir)}`,
    };
  }

  // Shell commands — use friendly descriptions
  if (request.kind === "shell") {
    const command = request.command || "unknown command";
    const intention = request.intention ?? "";
    const friendly = getShellDescription(command);
    return {
      title: "💻 Run a Command",
      message: intention || friendly || `${APP_NAME} wants to run a terminal command`,
      detail:
        friendly && intention
          ? `${friendly}\n\nCommand: ${truncateMiddle(command)}`
          : `Command: ${truncateMiddle(command)}`,
    };
  }

  // URL access
  if (request.kind === "url") {
    const url = request.url || "unknown URL";
    return {
      title: "🌐 Open a Website",
      message: `${APP_NAME} wants to visit a webpage`,
      detail: `URL: ${url}`,
    };
  }

  // Generic fallback
  return {
    title: "🔐 Permission Needed",
    message: `${APP_NAME} wants to perform an action: ${request.kind}`,
    detail: "",
  };
}
