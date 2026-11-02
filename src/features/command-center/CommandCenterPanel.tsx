import { workspaceDisplayName } from "@common/workspace-display";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  Loader2,
  LoaderCircle,
  RefreshCw,
} from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/marshal-ui/marshal-collapsible";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SurfaceHeader } from "@/components/ui/surface-header";
import { SessionActivityPanel } from "@/features/create/SessionActivityPanel";
import { cn } from "@/lib/marshal-class-names";
import type { CommandCenterAPI, SessionMetadata } from "@/types/electron";

interface CommandCenterPanelProps {
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

interface CommandCenterContentProps {
  onOpenSession?: (sessionId: string) => void;
}

// Threshold for the "Recently completed" bucket. Anything older that has
// also stopped running falls into "Older" (collapsed by default).
const RECENT_WINDOW_MS = 8 * 60 * 60 * 1000;

type SessionBucket = "active" | "recent" | "older";

interface TreeNode {
  session: SessionMetadata;
  children: TreeNode[];
}

function getCommandCenterAPI(): CommandCenterAPI | undefined {
  return (window as Window & { commandCenterAPI?: CommandCenterAPI }).commandCenterAPI;
}

function parseUpdatedAt(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function bucketFor(session: SessionMetadata, now: number): SessionBucket {
  if (session.isBusy) return "active";
  const updated = parseUpdatedAt(session.updatedAt);
  if (updated > 0 && now - updated <= RECENT_WINDOW_MS) return "recent";
  return "older";
}

/**
 * Build a parent→child forest from a flat list of sessions, restricted to the
 * sessions in `sessions`. A session whose parent is not in the same scope is
 * promoted to a root so the user still sees it.
 */
function buildForest(sessions: SessionMetadata[]): TreeNode[] {
  const inScope = new Set(sessions.map((s) => s.id));
  const nodeById = new Map<string, TreeNode>();
  for (const session of sessions) {
    nodeById.set(session.id, { session, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const session of sessions) {
    const node = nodeById.get(session.id);
    if (!node) continue;
    const parentId = session.parentSessionId;
    if (parentId && parentId !== session.id && inScope.has(parentId)) {
      nodeById.get(parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortByUpdated = (a: TreeNode, b: TreeNode) =>
    parseUpdatedAt(b.session.updatedAt) - parseUpdatedAt(a.session.updatedAt);
  const sortRecursive = (nodes: TreeNode[]) => {
    nodes.sort(sortByUpdated);
    for (const node of nodes) sortRecursive(node.children);
  };
  sortRecursive(roots);
  return roots;
}

function sourceIcon(session: SessionMetadata) {
  switch (session.source) {
    case "subagent":
      return <Bot className="size-3 shrink-0 text-muted-foreground" aria-label="Subagent" />;
    case "automation":
      return (
        <RefreshCw className="size-3 shrink-0 text-muted-foreground" aria-label="Automation run" />
      );
    default:
      return null;
  }
}

function SessionRow({
  node,
  depth,
  selectedId,
  onSelect,
  hasSibling,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** True when this node is not the last child in its parent's list — used for
   *  drawing the vertical connector line. (Not currently used; kept for future
   *  styling.) */
  hasSibling?: boolean;
}) {
  void hasSibling;
  const { session, children } = node;
  const isSelected = selectedId === session.id;
  return (
    <li className="list-none">
      <button
        type="button"
        data-testid="command-center-session-row"
        data-session-id={session.id}
        data-depth={depth}
        aria-current={isSelected ? "true" : undefined}
        onClick={() => onSelect(session.id)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
          isSelected && "border-primary bg-active-subtle",
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {depth > 0 && (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
        )}
        {session.isBusy && (
          <LoaderCircle
            className="size-3 shrink-0 animate-spin text-primary"
            aria-label="Session is running"
          />
        )}
        {sourceIcon(session)}
        <span className="min-w-0 flex-1 truncate">{session.name}</span>
        {session.workspaceName && (
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            {workspaceDisplayName(session.workspaceName)}
          </span>
        )}
      </button>
      {children.length > 0 && (
        <ul
          className="ml-3 border-l border-border/50"
          data-testid="command-center-children"
          data-parent-id={session.id}
        >
          {children.map((child, idx) => (
            <SessionRow
              key={child.session.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              hasSibling={idx < children.length - 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function SessionSection({
  title,
  testId,
  sessions,
  selectedId,
  onSelect,
  defaultOpen,
  emptyMessage,
}: {
  title: string;
  testId: string;
  sessions: SessionMetadata[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  defaultOpen: boolean;
  emptyMessage: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const forest = useMemo(() => buildForest(sessions), [sessions]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={testId}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md p-1 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:bg-muted/50"
        >
          {open ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronRight className="size-3" aria-hidden />
          )}
          <span>{title}</span>
          <Badge variant="outline" className="ml-1 px-1.5 py-0 text-[10px] font-normal">
            {sessions.length}
          </Badge>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {forest.length === 0 ? (
          <div className="mt-2 rounded-2xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <ul
            className="mt-2 space-y-0.5 overflow-hidden rounded-2xl border border-border bg-card p-2"
            data-testid={`${testId}-list`}
          >
            {forest.map((node, idx) => (
              <SessionRow
                key={node.session.id}
                node={node}
                depth={0}
                selectedId={selectedId}
                onSelect={onSelect}
                hasSibling={idx < forest.length - 1}
              />
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function CommandCenterContent({ onOpenSession }: CommandCenterContentProps) {
  const api = getCommandCenterAPI();
  const sessionsAPI = window.sessionsAPI;
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(() => !sessionsAPI);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // `now` is captured at mount and refreshed periodically so the 8h window
  // moves with the clock while the panel stays open.
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!sessionsAPI) return undefined;

    let active = true;
    const load = () => {
      void sessionsAPI.listWithOptions({}).then((result) => {
        if (!active) return;
        if (result.success && result.sessions) {
          setSessions(result.sessions);
          setError(null);
        } else if (!result.success) {
          setError(result.error ?? "Could not load sessions.");
        }
        setSessionsLoaded(true);
      });
    };
    load();
    const unsubscribe = sessionsAPI.onListChanged?.(() => load());
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [sessionsAPI]);

  const buckets = useMemo(() => {
    const active: SessionMetadata[] = [];
    const recent: SessionMetadata[] = [];
    const older: SessionMetadata[] = [];
    for (const session of sessions) {
      const b = bucketFor(session, now);
      if (b === "active") active.push(session);
      else if (b === "recent") recent.push(session);
      else older.push(session);
    }
    return { active, recent, older };
  }, [sessions, now]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const handleOpenChat = useCallback(
    (sessionId: string) => {
      if (api?.openSession) {
        void api.openSession(sessionId);
        return;
      }
      onOpenSession?.(sessionId);
    },
    [api, onOpenSession],
  );

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  return (
    <div
      className="grid items-start gap-4 px-6 pb-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]"
      aria-label="Command Center"
    >
      <div className="space-y-5">
        {!sessionsLoaded && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading sessions
          </div>
        )}
        {error && (
          <Card className="border-destructive/20 bg-destructive/5">
            <CardContent className="flex items-start gap-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </CardContent>
          </Card>
        )}
        {sessionsLoaded && (
          <>
            <SessionSection
              title="Active"
              testId="command-center-section-active"
              sessions={buckets.active}
              selectedId={selectedId}
              onSelect={handleSelect}
              defaultOpen
              emptyMessage="No sessions are currently running."
            />
            <SessionSection
              title="Recently completed"
              testId="command-center-section-recent"
              sessions={buckets.recent}
              selectedId={selectedId}
              onSelect={handleSelect}
              defaultOpen
              emptyMessage="No sessions finished in the last 8 hours."
            />
            <SessionSection
              title="Older"
              testId="command-center-section-older"
              sessions={buckets.older}
              selectedId={selectedId}
              onSelect={handleSelect}
              defaultOpen={false}
              emptyMessage="No older sessions."
            />
          </>
        )}
      </div>
      <Card
        className="sticky top-4 flex h-[calc(100vh-14rem)] max-h-[640px] min-h-[420px] flex-col gap-0 overflow-hidden py-0"
        data-testid="command-center-detail"
      >
        {selectedSession ? (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Session
                </div>
                <h3 className="truncate text-sm font-semibold">{selectedSession.name}</h3>
              </div>
              <Button size="sm" onClick={() => handleOpenChat(selectedSession.id)}>
                Open chat
              </Button>
            </div>
            <div className="relative min-h-0 flex-1">
              <SessionActivityPanel sessionId={selectedSession.id} layout="rail" />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Select a session to see its progress and details.
          </div>
        )}
      </Card>
    </div>
  );
}

export function CommandCenterPanel({ onClose, onOpenSession }: CommandCenterPanelProps) {
  return (
    <section aria-label="Activity" className="flex size-full flex-col overflow-hidden bg-card">
      <SurfaceHeader title="Activity" onClose={onClose} />
      <ScrollArea className="flex-1 [&_[data-slot=scroll-area-viewport]>div]:block! [&_[data-slot=scroll-area-viewport]>div]:min-w-0!">
        <div className="pt-4">
          <CommandCenterContent onOpenSession={onOpenSession} />
        </div>
      </ScrollArea>
    </section>
  );
}
