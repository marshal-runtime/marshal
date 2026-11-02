import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Plus,
  Trash2,
} from "@/components/icons";
import { formatDate } from "@/shared/marshal-foundation/date";

import { type ChatSessionSummary, useWorkspaceSessionSummaries } from "./chatSessionDisplay";

interface WorkspaceSessionListProps {
  sessionIds: string[];
  activeSessionId: string | null;
  onSwitch: (sessionId: string) => void;
  onNew: () => void;
  onDelete: (sessionId: string) => void;
  onRename?: (sessionId: string, name: string) => void;
}

export function WorkspaceSessionList({
  sessionIds,
  activeSessionId,
  onSwitch,
  onNew,
  onDelete,
  onRename,
}: WorkspaceSessionListProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();

  const { data: sessions = [] } = useWorkspaceSessionSummaries(sessionIds, expanded ? 3000 : false);

  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    if (expandTimer.current) clearTimeout(expandTimer.current);
    expandTimer.current = setTimeout(() => setExpanded(true), 150);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (expandTimer.current) clearTimeout(expandTimer.current);
    collapseTimer.current = setTimeout(() => setExpanded(false), 500);
  }, []);

  useEffect(() => {
    return () => {
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
      if (expandTimer.current) clearTimeout(expandTimer.current);
    };
  }, []);

  const startRename = useCallback((id: string, currentName: string) => {
    setEditingId(id);
    setEditValue(currentName);
    setTimeout(() => editInputRef.current?.select(), 0);
  }, []);

  const commitRename = useCallback(() => {
    if (editingId && editValue.trim() && onRename) {
      onRename(editingId, editValue.trim());
      queryClient.setQueryData(
        ["workspace", "sessions", sessionIds],
        (old: ChatSessionSummary[] | undefined) =>
          old?.map((s) => (s.id === editingId ? { ...s, name: editValue.trim() } : s)) ?? [],
      );
    }
    setEditingId(null);
    setEditValue("");
  }, [editingId, editValue, onRename, queryClient, sessionIds]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const otherSessions = sessions.filter((s) => s.id !== activeSessionId);

  if (sessionIds.length === 0) return null;

  return (
    <div
      className="relative z-10"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      data-testid="workspace-session-drawer"
    >
      {/* Top bar: New Chat button + active session */}
      <div className="border-b border-border bg-accent/50 px-3 py-2">
        <button
          className="mb-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
          onClick={onNew}
          data-testid="workspace-new-chat-btn"
        >
          <Plus size={14} />
          New chat
        </button>
        <div className="flex items-center gap-2" data-testid="workspace-active-session">
          <MessageSquarePlus size={14} className="shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <span className="truncate text-sm font-medium text-foreground">
              {activeSession?.name ?? "No session"}
            </span>
            {activeSession?.lastMessage && (
              <p className="truncate text-xs text-muted-foreground" data-testid="session-preview">
                {activeSession.lastMessage}
              </p>
            )}
          </div>
          {activeSession?.isBusy && (
            <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
          )}
          {activeSession && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatDate(activeSession.updatedAt)}
            </span>
          )}
        </div>
      </div>

      {/* Expanded overlay: other sessions */}
      {otherSessions.length > 0 && (
        <div
          data-testid="workspace-session-list"
          className={`absolute inset-x-0 max-h-[33vh] overflow-y-auto border-b border-border bg-accent/95 pb-1 shadow-lg backdrop-blur-sm transition-all duration-200 ease-out ${
            expanded ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0"
          }`}
        >
          {otherSessions.map((session) => (
            <div
              key={session.id}
              className="group flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-foreground-secondary hover:bg-muted hover:text-foreground"
              onClick={() => onSwitch(session.id)}
              title={session.name}
              data-testid="workspace-session-item"
            >
              <MessageSquare size={14} className="shrink-0 text-muted-foreground" />

              {editingId === session.id ? (
                <input
                  ref={editInputRef}
                  className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-sm text-foreground outline-none"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") {
                      setEditingId(null);
                      setEditValue("");
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <span className="truncate text-sm">{session.name}</span>
                    {session.lastMessage && (
                      <p
                        className="truncate text-xs text-muted-foreground"
                        data-testid="session-preview"
                      >
                        {session.lastMessage}
                      </p>
                    )}
                  </div>
                  {session.isBusy && (
                    <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground group-hover:hidden">
                    {formatDate(session.updatedAt)}
                  </span>
                  <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                    {onRename && (
                      <button
                        className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(session.id, session.name);
                        }}
                        title="Rename"
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                    <button
                      className="rounded-sm p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(session.id);
                      }}
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
