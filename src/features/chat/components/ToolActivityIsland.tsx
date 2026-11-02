import type { MessageToolCall, PermissionCardData } from "@common/marshal-ipc-contract";
import {
  classifyToolActivityKind,
  getToolActivityCopy,
  humanizeActivityToolName,
  isTrustedCommandToolName,
  normalizeActivityToolName,
} from "@common/tool-activity";
import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";

import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Clock,
  LoaderCircle,
  Pause,
  Wrench,
} from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/marshal-ui/marshal-collapsible";
import { NoticeDismissButton } from "@/components/ui/dismissible-notice";
import { cn } from "@/lib/marshal-class-names";

import { toolNoticeKey } from "./tool-notice-key";

export interface ToolActivityItem extends Omit<MessageToolCall, "name"> {
  name?: string;
  running?: boolean;
}

interface ToolActivityIslandProps {
  tools: ToolActivityItem[];
  variant: "live" | "receipt";
  sessionId?: string | null;
  messageId?: string;
  /** Index of the first tool in this island within the message-wide tool list. */
  toolCallIndexOffset?: number;
  activePermissions?: PermissionCardData[];
  dismissedToolNoticeKeys?: ReadonlySet<string>;
  onToolNoticeDismiss?: (noticeKey: string) => void;
}

type ActivityState = "running" | "waiting" | "completed" | "failed" | "cancelled";
type ActivityCategory =
  | "file-read"
  | "search"
  | "file-edit"
  | "command"
  | "read"
  | "mutation"
  | "other";

interface ActivityEntry {
  key: string;
  state: ActivityState;
  category: ActivityCategory;
  description: string;
  tool?: ToolActivityItem;
  permission?: PermissionCardData;
  toolCallIndex?: number;
  noticeKey?: string;
}

const PERMISSION_ACTIONS: Record<PermissionCardData["kind"], string> = {
  shell: "run a command",
  write: "change files",
  mcp: "use a connected tool",
  read: "read files",
  url: "open a link",
  "custom-tool": "use a custom tool",
  memory: "save a memory",
  hook: "run a hook",
  settings: "change a setting",
};

const RECEIPT_LABELS: Partial<Record<ActivityCategory, string>> = {
  "file-read": "Read",
  search: "Completed",
  "file-edit": "Updated",
  command: "Ran",
  read: "Read",
  mutation: "Completed",
};

const ACTIVE_LABELS: Partial<Record<ActivityCategory, string>> = {
  "file-read": "Reading",
  search: "Searching",
  "file-edit": "Updating",
  command: "Running",
  read: "Reading",
  mutation: "Performing",
};

const GENERIC_ACTIVITY_DESCRIPTIONS = new Set([
  "cancelled",
  "completed",
  "completed action",
  "completed step",
  "done",
  "failed",
  "finished",
  "in progress",
  "performing an action",
  "ran command",
  "read information",
  "reading information",
  "running",
  "running a command",
  "waiting",
  "working",
  "working on the next step",
]);

function parseShellInput(input?: string): { description?: string; command?: string } {
  if (!input) return {};
  try {
    const parsed: unknown = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const descriptionValue = Reflect.get(parsed, "description");
    const commandValue = Reflect.get(parsed, "command");
    return {
      description:
        typeof descriptionValue === "string" ? descriptionValue.replace(/\s+/g, " ").trim() : "",
      command: typeof commandValue === "string" ? commandValue.replace(/\s+/g, " ").trim() : "",
    };
  } catch {
    return {};
  }
}

function hasTrustedCommandKind(tool: ToolActivityItem): boolean {
  return tool.activityKind !== undefined
    ? tool.activityKind === "command"
    : isTrustedCommandToolName(exactToolName(tool) ?? "");
}

function exactToolName(tool: ToolActivityItem): string | undefined {
  const name: unknown = tool.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function toolIdentityDescription(tool: ToolActivityItem): string | undefined {
  const name = exactToolName(tool);
  return name ? humanizeActivityToolName(name) || undefined : undefined;
}

function descriptionMatchesToolIdentity(tool: ToolActivityItem, description: string): boolean {
  const name = exactToolName(tool);
  const identity = toolIdentityDescription(tool);
  const candidates = [name, normalizeActivityToolName(name ?? ""), identity]
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .map((candidate) => candidate.toLowerCase());
  const normalizedDescription = description.toLowerCase();
  if (candidates.includes(normalizedDescription)) return true;
  const generated = /^(?:running|using|calling|executing)\s+(.+)$/i.exec(description);
  return generated ? candidates.includes(generated[1].trim().toLowerCase()) : false;
}

function hasMeaningfulDescription(tool: ToolActivityItem, description: string): boolean {
  if (!description) return false;
  if (GENERIC_ACTIVITY_DESCRIPTIONS.has(description.toLowerCase())) return false;
  if (/^using\b/i.test(description)) return false;
  if (descriptionMatchesToolIdentity(tool, description)) return false;
  return !(
    /^[a-z0-9_.:-]+$/i.test(description) &&
    (/[_:.]/.test(description) || /[a-z0-9][A-Z]/.test(description))
  );
}

function fallbackDescription(tool: ToolActivityItem): string {
  const toolName = exactToolName(tool);
  const name = toolName?.toLowerCase() ?? "";
  const activityCopy = toolName ? getToolActivityCopy(toolName) : undefined;
  if (activityCopy) return tool.running ? activityCopy.active : activityCopy.completed;
  if (/(^|_)(view|read|download|get_file)($|_)/.test(name)) return "Reading files";
  if (/(^|_)(rg|grep|search|find)($|_)/.test(name)) return "Searching the workspace";
  if (/(^|_)(edit|write|patch|move|upload)($|_)/.test(name)) return "Updating files";
  if (hasTrustedCommandKind(tool)) return toolIdentityDescription(tool) ?? "Running a command";
  const identity = toolIdentityDescription(tool);
  if (identity) return identity;
  const activityKind = tool.activityKind ?? classifyToolActivityKind(toolName ?? "");
  if (activityKind === "read") return "Reading information";
  if (activityKind === "mutation") return "Performing an action";
  if (activityKind === "command") return "Running a command";
  return "Working on the next step";
}

function activeToolDescription(tool: ToolActivityItem): string {
  const toolName = exactToolName(tool);
  const activityCopy = toolName ? getToolActivityCopy(toolName) : undefined;
  if (activityCopy) return activityCopy.active;

  const raw = tool.description.replace(/\s+/g, " ").trim();

  if (hasTrustedCommandKind(tool)) {
    const parsed = parseShellInput(tool.input);
    if (parsed.description) return parsed.description;
    if (parsed.command) {
      return `Running ${parsed.command.length > 80 ? `${parsed.command.slice(0, 77)}...` : parsed.command}`;
    }
    if (hasMeaningfulDescription(tool, raw)) return raw;
    return toolIdentityDescription(tool) ?? "Running a command";
  }

  return hasMeaningfulDescription(tool, raw) ? raw : fallbackDescription(tool);
}

function completedToolDescription(tool: ToolActivityItem): string {
  const toolName = exactToolName(tool);
  const activityCopy = toolName ? getToolActivityCopy(toolName) : undefined;
  if (activityCopy) return activityCopy.completed;

  const normalizedName = normalizeActivityToolName(toolName ?? "");
  const raw = tool.description.replace(/\s+/g, " ").trim();
  if (["view", "read", "read_file", "read_text_file"].includes(normalizedName)) {
    return /^Reading\b/i.test(raw) ? raw.replace(/^Reading\b/i, "Read") : "Read file";
  }
  if (["grep", "rg", "glob"].includes(normalizedName)) {
    if (/^Searching\b/i.test(raw)) return raw.replace(/^Searching\b/i, "Searched");
    if (/^Finding\b/i.test(raw)) return raw.replace(/^Finding\b/i, "Found");
    return "Completed search";
  }
  if (["edit", "write_file"].includes(normalizedName)) {
    return /^Editing\b/i.test(raw) ? raw.replace(/^Editing\b/i, "Edited") : "Updated file";
  }
  if (["create", "create_file"].includes(normalizedName)) {
    return /^Creating\b/i.test(raw) ? raw.replace(/^Creating\b/i, "Created") : "Created file";
  }
  if (isTrustedCommandToolName(toolName ?? "")) {
    const command = parseShellInput(tool.input).command;
    if (command) return `Ran ${command.length > 80 ? `${command.slice(0, 77)}...` : command}`;
    if (hasMeaningfulDescription(tool, raw) && !/^[a-z]+ing\b/i.test(raw)) return raw;
    return toolIdentityDescription(tool) ?? "Ran command";
  }
  if (hasMeaningfulDescription(tool, raw) && !/^[a-z]+ing\b/i.test(raw)) return raw;
  const identity = toolIdentityDescription(tool);
  if (identity) return identity;

  const activityKind = tool.activityKind ?? classifyToolActivityKind(normalizedName);
  if (activityKind === "read") return "Read information";
  if (activityKind === "mutation") return "Completed action";
  if (activityKind === "command") return "Ran command";
  return "Completed step";
}

function toolDescription(tool: ToolActivityItem, state: ActivityState): string {
  return state === "completed" ? completedToolDescription(tool) : activeToolDescription(tool);
}

const FILE_READ_TOOL_NAMES = new Set(["view", "read", "read_file", "read_text_file"]);
const SEARCH_TOOL_NAMES = new Set(["grep", "rg", "glob"]);

function readActivityCategory(normalizedName: string): ActivityCategory {
  if (FILE_READ_TOOL_NAMES.has(normalizedName)) return "file-read";
  if (SEARCH_TOOL_NAMES.has(normalizedName)) return "search";
  return "read";
}

function activityCategory(tool: ToolActivityItem): ActivityCategory {
  const normalizedName = normalizeActivityToolName(exactToolName(tool) ?? "");
  if (tool.activityKind) {
    if (tool.activityKind === "read") return readActivityCategory(normalizedName);
    if (tool.activityKind === "mutation") return "mutation";
    if (tool.activityKind === "command") return "command";
    return "other";
  }

  const classifiedKind = classifyToolActivityKind(normalizedName);
  if (classifiedKind === "read") return readActivityCategory(normalizedName);
  if (classifiedKind === "mutation") return "mutation";
  if (classifiedKind === "command") return "command";

  const text = `${normalizedName} ${tool.description}`.toLowerCase();
  if (/(^|[_\s])(view|read_file|read_text_file|get_file)([_\s]|$)/.test(text)) {
    return "file-read";
  }
  if (/(^|[_\s])(rg|grep|search|find)([_\s]|$)|\bsearching\b/.test(text)) return "search";
  if (/(^|[_\s])(edit|write|patch|move|upload)([_\s]|$)|\b(updating|editing)\b/.test(text)) {
    return "file-edit";
  }
  return "other";
}

function terminalState(tool: ToolActivityItem): ActivityState {
  if (tool.running) return "running";
  if (tool.cancelled) return "cancelled";
  if (tool.success === false || tool.error) {
    return /(cancel|abort|stopp?ed)/i.test(tool.error ?? "") ? "cancelled" : "failed";
  }
  return "completed";
}

function permissionDescription(permission: PermissionCardData): string {
  return `Waiting to ${PERMISSION_ACTIONS[permission.kind]}`;
}

function summarizeCurrent(entries: ActivityEntry[]): string {
  const waiting = entries.find((entry) => entry.state === "waiting");
  if (waiting) return waiting.description;
  if (entries.length === 1) return entries[0].description;

  const firstCategory = entries[0]?.category;
  if (firstCategory && entries.every((entry) => entry.category === firstCategory)) {
    const label = ACTIVE_LABELS[firstCategory];
    if (label) {
      const noun =
        firstCategory === "file-read" || firstCategory === "file-edit"
          ? "files"
          : firstCategory === "command"
            ? "commands"
            : firstCategory === "mutation"
              ? "actions"
              : "sources";
      return `${label} ${entries.length} ${noun}`;
    }
  }

  return entries[entries.length - 1].description;
}

function summarizeReceipt(entries: ActivityEntry[]): string {
  const failed = entries.filter((entry) => entry.state === "failed").length;
  const cancelled = entries.filter((entry) => entry.state === "cancelled").length;
  if (failed > 0) return `Finished with ${failed} issue${failed === 1 ? "" : "s"}`;
  if (cancelled > 0) {
    return `${cancelled} step${cancelled === 1 ? "" : "s"} cancelled`;
  }
  if (entries.length === 1) {
    return entries[0].category === "other" ? "Completed 1 step" : entries[0].description;
  }

  const firstCategory = entries[0]?.category;
  if (firstCategory && entries.every((entry) => entry.category === firstCategory)) {
    const label = RECEIPT_LABELS[firstCategory];
    if (label) {
      const noun =
        firstCategory === "file-read" || firstCategory === "file-edit"
          ? entries.length === 1
            ? "file"
            : "files"
          : firstCategory === "command"
            ? entries.length === 1
              ? "command"
              : "commands"
            : firstCategory === "search"
              ? entries.length === 1
                ? "search"
                : "searches"
              : firstCategory === "mutation"
                ? entries.length === 1
                  ? "action"
                  : "actions"
                : entries.length === 1
                  ? "source"
                  : "sources";
      return `${label} ${entries.length} ${noun}`;
    }
  }

  return `Completed ${entries.length} step${entries.length === 1 ? "" : "s"}`;
}

function buildEntries({
  tools,
  activePermissions,
  sessionId,
  messageId,
  toolCallIndexOffset = 0,
}: Pick<
  ToolActivityIslandProps,
  "tools" | "activePermissions" | "sessionId" | "messageId" | "toolCallIndexOffset"
>): ActivityEntry[] {
  const permissions = activePermissions ?? [];
  const pendingByToolCallId = new Map(
    permissions
      .filter((permission) => !permission.resolved && permission.toolCallId)
      .map((permission) => [permission.toolCallId!, permission]),
  );
  const matchedPermissionIds = new Set<string>();
  const toolEntries = tools.map((tool, index): ActivityEntry => {
    const permission = tool.id ? pendingByToolCallId.get(tool.id) : undefined;
    if (permission) matchedPermissionIds.add(permission.id);
    const state = permission ? "waiting" : terminalState(tool);
    const messageToolCallIndex = index + toolCallIndexOffset;
    const noticeKey = toolNoticeKey({
      sessionId,
      toolId: tool.id,
      messageId,
      toolCallIndex: messageId ? messageToolCallIndex : undefined,
      description: tool.description,
      error: tool.error,
    });
    return {
      key: tool.id ?? `${exactToolName(tool) ?? "tool"}-${index}`,
      state,
      category: activityCategory(tool),
      description: toolDescription(tool, state),
      tool,
      permission,
      toolCallIndex: messageToolCallIndex,
      noticeKey,
    };
  });
  const matchedToolIds = new Set(tools.map((tool) => tool.id).filter(Boolean));
  const permissionEntries = permissions
    .filter(
      (permission) =>
        !matchedPermissionIds.has(permission.id) &&
        (!permission.toolCallId || !matchedToolIds.has(permission.toolCallId)),
    )
    .map(
      (permission): ActivityEntry => ({
        key: `permission-${permission.id}`,
        state: permission.resolved === "allowed" ? "running" : "waiting",
        category:
          permission.kind === "shell"
            ? "command"
            : permission.kind === "write"
              ? "file-edit"
              : "other",
        description:
          permission.resolved === "allowed"
            ? permission.message || permission.title
            : permissionDescription(permission),
        permission,
      }),
    );
  return [...toolEntries, ...permissionEntries];
}

export function ToolActivityIsland({
  tools,
  variant,
  sessionId,
  messageId,
  toolCallIndexOffset,
  activePermissions,
  dismissedToolNoticeKeys,
  onToolNoticeDismiss,
}: ToolActivityIslandProps) {
  const [open, setOpen] = useState(false);
  const [locallyDismissed, setLocallyDismissed] = useState<Set<string>>(() => new Set());
  const dismissed = dismissedToolNoticeKeys ?? locallyDismissed;
  const entries = useMemo(
    () =>
      buildEntries({
        tools,
        activePermissions,
        sessionId,
        messageId,
        toolCallIndexOffset,
      }).filter((entry) => !entry.noticeKey || !dismissed.has(entry.noticeKey)),
    [activePermissions, dismissed, messageId, sessionId, toolCallIndexOffset, tools],
  );

  if (entries.length === 0) return null;

  const completed = entries.filter((entry) =>
    ["completed", "failed", "cancelled"].includes(entry.state),
  );
  const active = entries.filter((entry) => entry.state === "running" || entry.state === "waiting");
  const waiting = active.filter((entry) => entry.state === "waiting");
  const upNext = waiting.slice(1);
  const current = active.filter((entry) => !upNext.includes(entry));
  const isLive = variant === "live" && active.length > 0;
  const hasFailure = completed.some((entry) => entry.state === "failed");
  const hasCancellation = completed.some((entry) => entry.state === "cancelled");
  const headline = isLive ? summarizeCurrent(current) : summarizeReceipt(completed);
  const progress = isLive
    ? waiting.length > 0
      ? `${completed.length} of ${entries.length} complete · approval needed`
      : `${completed.length} of ${entries.length} complete`
    : `${completed.length} step${completed.length === 1 ? "" : "s"}`;
  const testId = variant === "live" ? "tool-status-indicator" : "committed-tool-calls";
  const toggleTestId = variant === "live" ? "tool-status-toggle" : "committed-tool-calls-toggle";

  const dismissEntry = (entry: ActivityEntry) => {
    if (!entry.noticeKey) return;
    if (onToolNoticeDismiss) {
      onToolNoticeDismiss(entry.noticeKey);
      return;
    }
    setLocallyDismissed((currentKeys) => new Set(currentKeys).add(entry.noticeKey!));
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="w-full max-w-[708px]"
      data-testid={testId}
      data-state-kind={isLive ? (waiting.length > 0 ? "waiting" : "running") : "complete"}
    >
      <div
        className={cn(
          "overflow-hidden rounded-2xl border bg-card/90 shadow-xs transition-colors",
          isLive && waiting.length === 0 && "border-primary/30",
          waiting.length > 0 && "border-status-warning-border",
          !isLive && hasFailure && "border-destructive/30",
        )}
      >
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            type="button"
            className="h-auto w-full justify-start gap-3 rounded-none px-3 py-2.5 text-left hover:bg-accent/60"
            aria-label={`${open ? "Collapse" : "Expand"} activity: ${headline}`}
            data-testid={toggleTestId}
          >
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-xl",
                isLive ? "bg-primary/10 text-primary" : "bg-muted text-foreground",
                waiting.length > 0 && "bg-status-warning-bg text-status-warning-fg",
                !isLive && hasFailure && "bg-destructive/10 text-destructive",
              )}
              aria-hidden
            >
              {isLive && waiting.length > 0 ? (
                <Pause className="size-4" />
              ) : isLive ? (
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              ) : hasFailure ? (
                <CircleX className="size-4" />
              ) : hasCancellation ? (
                <Clock className="size-4" />
              ) : (
                <CircleCheck className="size-4" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="block truncate text-sm font-medium text-foreground"
                aria-live="polite"
                aria-atomic="true"
              >
                {headline}
              </span>
              <span className="block truncate text-xs text-muted-foreground">{progress}</span>
            </span>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {completed.length}/{entries.length}
            </span>
            <ChevronDown
              className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
              aria-hidden
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div
            className="max-h-80 space-y-3 overflow-y-auto border-t border-border/70 p-3"
            data-testid={
              variant === "live" ? "tool-activity-queue" : "committed-tool-calls-content"
            }
          >
            <ActivityGroup
              title="Completed"
              entries={completed}
              variant={variant}
              sessionId={sessionId}
              messageId={messageId}
              onDismiss={dismissEntry}
            />
            <ActivityGroup
              title="Current"
              entries={current}
              variant={variant}
              sessionId={sessionId}
              messageId={messageId}
              onDismiss={dismissEntry}
            />
            <ActivityGroup
              title="Up next"
              entries={upNext}
              variant={variant}
              sessionId={sessionId}
              messageId={messageId}
              onDismiss={dismissEntry}
            />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function ActivityGroup({
  title,
  entries,
  variant,
  sessionId,
  messageId,
  onDismiss,
}: {
  title: string;
  entries: ActivityEntry[];
  variant: ToolActivityIslandProps["variant"];
  sessionId?: string | null;
  messageId?: string;
  onDismiss: (entry: ActivityEntry) => void;
}) {
  if (entries.length === 0) return null;
  const isRunning = entries.some((entry) => entry.state === "running");
  return (
    <section
      aria-label={`${title} activity`}
      data-testid={`tool-activity-group-${title.toLowerCase().replace(" ", "-")}`}
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {isRunning && (
          <LoaderCircle
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-label="Activity running"
            data-testid="tool-activity-group-spinner"
          />
        )}
        <span>{title}</span>
        <span className="h-px flex-1 bg-border/70" aria-hidden />
        <span>{entries.length}</span>
      </div>
      <div className="space-y-1">
        {entries.map((entry) => (
          <ActivityRow
            key={entry.key}
            entry={entry}
            variant={variant}
            sessionId={sessionId}
            messageId={messageId}
            onDismiss={() => onDismiss(entry)}
          />
        ))}
      </div>
    </section>
  );
}

function ActivityRow({
  entry,
  variant,
  sessionId,
  messageId,
  onDismiss,
}: {
  entry: ActivityEntry;
  variant: ToolActivityIslandProps["variant"];
  sessionId?: string | null;
  messageId?: string;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const generatedId = useId();
  const tool = entry.tool;
  const {
    data: fetchedToolCall,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["tool-call-details", sessionId, messageId, entry.toolCallIndex],
    queryFn: async () => {
      const result = await window.sessionsAPI.getToolCallDetails(
        sessionId!,
        messageId!,
        entry.toolCallIndex!,
      );
      if (!result.success || !result.toolCall) {
        throw new Error(result.error ?? "Tool details are unavailable");
      }
      return result.toolCall;
    },
    enabled:
      open &&
      tool?.detailsAvailable === true &&
      !!sessionId &&
      !!messageId &&
      entry.toolCallIndex !== undefined &&
      !!window.sessionsAPI?.getToolCallDetails,
    staleTime: Infinity,
  });
  const detailTool = fetchedToolCall ?? tool;
  const permission = entry.permission;
  const hasCapturedDetails = Boolean(
    detailTool?.input || detailTool?.output || detailTool?.error || permission?.detail,
  );
  const canLoadDetails = tool?.detailsAvailable === true;
  const hasDetails = hasCapturedDetails || canLoadDetails;
  const statusLabel =
    entry.state === "running"
      ? "In progress"
      : entry.state === "waiting"
        ? "Waiting"
        : entry.state === "failed"
          ? "Failed"
          : entry.state === "cancelled"
            ? "Cancelled"
            : "Done";
  const rawToolName = tool ? exactToolName(tool) : undefined;
  const rowAccessibleLabel = [
    entry.description,
    rawToolName ? `tool ${rawToolName}` : undefined,
    statusLabel,
  ]
    .filter(Boolean)
    .join(", ");
  const rowTitle = rawToolName ? `${entry.description} (${rawToolName})` : entry.description;
  const rowLabelId = `${generatedId}-label`;
  const rowDescriptionId = `${generatedId}-description`;
  const rowTestId = variant === "live" ? "tool-status-line" : "committed-tool-call-row";
  const toggleTestId = variant === "live" ? "tool-status-row-toggle" : "committed-tool-call-toggle";
  const rowContent = (
    <>
      <ActivityStateIcon state={entry.state} />
      <span
        id={rowLabelId}
        className="min-w-0 flex-1 truncate"
        data-testid={entry.state === "running" ? "tool-status-shimmer" : undefined}
        title={rowTitle}
      >
        {entry.description}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground" aria-hidden>
        {statusLabel}
      </span>
    </>
  );

  return (
    <div
      className="rounded-lg bg-muted/35"
      data-testid={rowTestId}
      role={hasDetails ? undefined : "group"}
      aria-labelledby={hasDetails ? undefined : rowLabelId}
      aria-describedby={hasDetails ? undefined : rowDescriptionId}
    >
      {!hasDetails && (
        <span id={rowDescriptionId} className="sr-only">
          {rawToolName ? `Tool ${rawToolName}. ` : ""}
          Status: {statusLabel}.
        </span>
      )}
      <div className="flex items-start gap-1">
        {hasDetails ? (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} technical details for ${rowAccessibleLabel}`}
            className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-lg px-2 py-1.5 text-left font-normal text-foreground-secondary hover:text-foreground"
            data-testid={toggleTestId}
          >
            {rowContent}
            <ChevronDown
              className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
              aria-hidden
            />
          </Button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm text-foreground-secondary">
            {rowContent}
          </div>
        )}
        {(entry.state === "failed" || entry.state === "cancelled") && entry.noticeKey && (
          <NoticeDismissButton aria-label="Dismiss tool error" onClick={onDismiss} />
        )}
      </div>
      {hasDetails && open && (
        <div
          className="space-y-2 border-t border-border/60 px-3 py-2"
          data-testid="tool-status-details"
        >
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading technical details...</p>
          ) : isError ? (
            <p className="text-xs text-muted-foreground">Technical details are unavailable.</p>
          ) : (
            <>
              {detailTool?.name && (
                <div className="flex min-w-0 items-baseline gap-2 text-xs">
                  <span className="font-medium text-muted-foreground">Tool</span>
                  <code className="truncate text-foreground">{detailTool.name}</code>
                </div>
              )}
              <ToolDetailBlock label="Input" value={detailTool?.input} variant={variant} />
              <ToolDetailBlock label="Output" value={detailTool?.output} variant={variant} />
              <ToolDetailBlock label="Error" value={detailTool?.error} variant={variant} />
              {permission?.detail && (
                <ToolDetailBlock label="Request" value={permission.detail} variant={variant} />
              )}
              {!detailTool?.input &&
                !detailTool?.output &&
                !detailTool?.error &&
                !permission?.detail && (
                  <p className="text-xs text-muted-foreground">No captured technical details.</p>
                )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityStateIcon({ state }: { state: ActivityState }) {
  if (state === "running") {
    return (
      <LoaderCircle
        className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
        aria-hidden
      />
    );
  }
  if (state === "waiting") {
    return <Pause className="size-4 shrink-0 text-status-warning-fg" aria-hidden />;
  }
  if (state === "failed") {
    return <CircleX className="size-4 shrink-0 text-destructive" aria-hidden />;
  }
  if (state === "cancelled") {
    return <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
  }
  if (state === "completed") {
    return <CircleCheck className="size-4 shrink-0 text-foreground" aria-hidden />;
  }
  return <Wrench className="size-4 shrink-0" aria-hidden />;
}

const TOOL_DETAIL_CHAR_CAP = 4000;

function ToolDetailBlock({
  label,
  value,
  variant,
}: {
  label: string;
  value?: string;
  variant: ToolActivityIslandProps["variant"];
}) {
  const [expanded, setExpanded] = useState(false);
  if (!value) return null;
  const isLong = value.length > TOOL_DETAIL_CHAR_CAP;
  const shown = isLong && !expanded ? value.slice(0, TOOL_DETAIL_CHAR_CAP) : value;
  const legacyPrefix = variant === "live" ? "live-tool-detail" : "tool-detail";
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-semibold text-muted-foreground">{label}</div>
      <pre
        className="max-h-52 overflow-auto rounded-md border border-border bg-background/70 p-2 font-mono text-xs wrap-break-word whitespace-pre-wrap text-foreground"
        data-testid={`${legacyPrefix}-${label.toLowerCase()}`}
      >
        {shown}
        {isLong && !expanded ? "\n... (truncated)" : ""}
      </pre>
      {isLong && (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-1 h-auto p-1 text-[11px] font-normal text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show less" : `Show full (${Math.round(value.length / 1024)} KB)`}
        </Button>
      )}
    </div>
  );
}
