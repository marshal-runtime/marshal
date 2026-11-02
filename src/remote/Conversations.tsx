/* eslint-disable better-tailwindcss/no-unknown-classes -- Remote styles live in remote.css. */
import type { SessionMetadata } from "@common/marshal-ipc-contract";
import type { RuntimeUiPlacementApplication } from "@common/runtime-ui";
import {
  DEFAULT_SESSION_FILTERS,
  SESSION_FILTER_OPTIONS,
  isSessionFilter,
  matchesSessionFilter,
  type SessionFilter,
} from "@common/session-filters";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ChevronRight, ChevronDown, Folder, Plus } from "../components/icons";
import { RemoteAppsList, type RemoteAppOwner } from "./Apps";
import { RemoteNotificationSettings } from "./Notifications";

const FILTERS_KEY = "marshal.remote.session-filters";

function storedFilters(): Set<SessionFilter> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "null");
    if (Array.isArray(value)) return new Set(value.filter(isSessionFilter));
  } catch {
    /* Fall back to the desktop default. */
  }
  return new Set(DEFAULT_SESSION_FILTERS);
}

export function Conversations({
  sessions,
  workspaces,
  applications,
  selectedId,
  computerName,
  connected,
  creating,
  onSelect,
  onCreate,
  onOpenApp,
  onClose,
}: {
  sessions: SessionMetadata[];
  workspaces: string[];
  applications: readonly RuntimeUiPlacementApplication[];
  selectedId: string | null;
  computerName: string;
  connected: boolean;
  creating: boolean;
  onSelect: (id: string) => void;
  onCreate: (workspaceName?: string) => void;
  onOpenApp: (owner: RemoteAppOwner) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [pinning, setPinning] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem("marshal.remote.collapsed-projects") ?? "[]",
      );
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  });
  const toggleGroup = (name: string) => {
    setCollapsed((previous) => {
      const next = previous.includes(name)
        ? previous.filter((item) => item !== name)
        : [...previous, name];
      try {
        localStorage.setItem("marshal.remote.collapsed-projects", JSON.stringify(next));
      } catch {
        /* Keep in-memory preference. */
      }
      return next;
    });
  };
  const togglePin = async (session: SessionMetadata) => {
    setPinning(session.id);
    try {
      const result = await window.sessionsAPI.setPinned(session.id, !session.isPinned);
      if (!result.success) throw new Error(result.error ?? "Could not update pin");
      await queryClient.invalidateQueries({ queryKey: ["remote"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update pin");
    } finally {
      setPinning(null);
    }
  };
  const [menu, setMenu] = useState(false);
  const [section, setSection] = useState<"chats" | "projects" | "apps" | "connection">("chats");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const [filters, setFilters] = useState(storedFilters);
  const toggleFilter = (filter: SessionFilter) => {
    setFilters((previous) => {
      const next = new Set(previous);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      try {
        localStorage.setItem(FILTERS_KEY, JSON.stringify([...next]));
      } catch {
        /* Keep in-memory preference. */
      }
      return next;
    });
  };
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const search = useQuery({
    queryKey: ["remote", "search", debouncedQuery],
    enabled: connected && debouncedQuery.length > 0,
    queryFn: async () => {
      const result = await window.sessionsAPI.list(debouncedQuery);
      if (!result.success) throw new Error(result.error ?? "Search failed");
      return result.results ?? [];
    },
  });
  const visible = (debouncedQuery ? (search.data ?? []) : sessions)
    .filter((session) => !project || (session.workspaceName || "General") === project)
    // Pinned threads stay reachable regardless of the filter, matching the desktop sidebar.
    .filter((session) => session.isPinned || matchesSessionFilter(session, filters))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const groups = new Map<string, SessionMetadata[]>();
  for (const session of visible) {
    const name = session.isPinned && !project ? "Pinned" : session.workspaceName || "General";
    const group = groups.get(name) ?? [];
    group.push(session);
    groups.set(name, group);
  }
  const projects = [
    ...new Set([
      "General",
      ...workspaces,
      ...sessions.map((session) => session.workspaceName || "General"),
    ]),
  ].sort();
  if (!debouncedQuery) {
    for (const name of projects) {
      if ((!project || project === name) && !groups.has(name)) groups.set(name, []);
    }
  }
  const heading =
    section === "connection"
      ? "This computer"
      : section === "projects"
        ? "Projects"
        : section === "apps"
          ? "Apps"
          : project || "Chats";
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="Conversations"
      className="remote-conversations"
    >
      <header className="remote-header">
        <button aria-label="Open navigation" onClick={() => setMenu(true)}>
          ☰
        </button>
        <div>
          <h1>{heading}</h1>
          <small>
            <span className={connected ? "remote-online" : ""}>●</span> {computerName}
          </small>
        </div>
        <button aria-label="Close sessions" disabled={!selectedId} onClick={onClose}>
          ✕
        </button>
      </header>
      {section === "chats" && (
        <>
          <div className="remote-conversation-tools">
            <label className="remote-search">
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                aria-label="Search chats"
                placeholder="Search chats"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={500}
              />
            </label>
            <button
              className="remote-compose-new"
              aria-label="New conversation"
              disabled={!connected || creating}
              onClick={() => onCreate(project && project !== "General" ? project : undefined)}
            >
              {creating ? "…" : "＋"}
            </button>
          </div>
          <div className="remote-filter-chips" role="group" aria-label="Show conversation types">
            {SESSION_FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                aria-pressed={filters.has(option.value)}
                onClick={() => toggleFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {project && (
            <button className="remote-back-projects" onClick={() => setProject(null)}>
              ‹ All chats
            </button>
          )}
          <nav className="remote-conversation-list" aria-label="Chats by project">
            {query.trim() !== debouncedQuery || search.isFetching ? (
              <p className="remote-list-note" role="status">
                Searching…
              </p>
            ) : null}
            {search.error && (
              <p className="remote-list-note" role="alert">
                Search unavailable. Check your connection and try again.
              </p>
            )}
            {visible.length === 0 && !search.isFetching && (
              <p className="remote-list-note">
                {debouncedQuery
                  ? "No matching conversations"
                  : filters.size === 0
                    ? "Choose a conversation type above"
                    : "No conversations yet"}
              </p>
            )}
            {[...groups]
              .sort(([a], [b]) => (a === "Pinned" ? -1 : b === "Pinned" ? 1 : a.localeCompare(b)))
              .map(([name, items]) => (
                <section key={name} className="remote-project-group">
                  <div className="remote-project-heading">
                    <h2>
                      <button
                        className="remote-group-toggle"
                        aria-label={`${collapsed.includes(name) ? "Expand" : "Collapse"} ${name}`}
                        aria-expanded={!collapsed.includes(name)}
                        onClick={() => toggleGroup(name)}
                      >
                        {collapsed.includes(name) ? (
                          <ChevronRight size={16} />
                        ) : (
                          <ChevronDown size={16} />
                        )}
                        {name === "Pinned" ? (
                          <span aria-hidden="true">☆</span>
                        ) : (
                          <Folder size={18} />
                        )}{" "}
                        {name} <small>{items.length}</small>
                        {collapsed.includes(name) &&
                          items.some((session) => session.isBusy || session.hasRunningSubagent) && (
                            <span className="remote-running" aria-label="Running conversations" />
                          )}
                        {collapsed.includes(name) && items.some((session) => session.hasUnread) && (
                          <span className="remote-unread" aria-label="Unread conversations" />
                        )}
                      </button>
                    </h2>
                    {name !== "Pinned" && (
                      <button
                        className="remote-project-create"
                        aria-label={`New chat in ${name}`}
                        disabled={
                          !connected ||
                          creating ||
                          (name !== "General" && !workspaces.includes(name))
                        }
                        onClick={() => onCreate(name === "General" ? undefined : name)}
                      >
                        <Plus size={22} />
                      </button>
                    )}
                  </div>
                  {!collapsed.includes(name) &&
                    items.map((session) => (
                      <div
                        className="remote-session-row"
                        key={session.id}
                        data-session-id={session.id}
                      >
                        <button
                          className="remote-session-open"
                          aria-current={session.id === selectedId ? "page" : undefined}
                          onClick={() => onSelect(session.id)}
                        >
                          <strong>
                            <span className="remote-session-title">
                              {session.name || "Untitled conversation"}
                            </span>
                            {(session.isBusy || session.hasRunningSubagent) && (
                              <span className="remote-running" role="status" aria-label="Running" />
                            )}
                            {session.hasUnread && (
                              <span className="remote-unread" aria-label="Unread updates" />
                            )}
                          </strong>
                          <small>
                            {session.workspaceName || "General"}
                            {session.parentSessionId ? " · Agent thread" : ""} ·{" "}
                            {session.isBusy || session.hasRunningSubagent
                              ? "Running"
                              : session.hasUnread
                                ? "New updates"
                                : new Date(session.updatedAt).toLocaleDateString()}
                          </small>
                        </button>
                        <button
                          className="remote-session-pin"
                          aria-label={`${session.isPinned ? "Unpin" : "Pin"} ${session.name || "Untitled conversation"}`}
                          aria-pressed={!!session.isPinned}
                          disabled={!connected || pinning !== null}
                          onClick={() => void togglePin(session)}
                        >
                          {session.isPinned ? "★" : "☆"}
                        </button>
                      </div>
                    ))}
                </section>
              ))}
          </nav>
        </>
      )}
      {section === "projects" && (
        <nav className="remote-conversation-list" aria-label="Projects">
          {projects.map((name) => (
            <button
              key={name}
              className="remote-project-link"
              onClick={() => {
                setProject(name);
                setQuery("");
                setSection("chats");
              }}
            >
              <strong>▱ {name}</strong>
              <small>
                {
                  sessions.filter(
                    (session) =>
                      (session.workspaceName || "General") === name &&
                      (session.isPinned || matchesSessionFilter(session, filters)),
                  ).length
                }{" "}
                conversations
              </small>
            </button>
          ))}
        </nav>
      )}
      {section === "apps" && <RemoteAppsList applications={applications} onOpen={onOpenApp} />}
      {section === "connection" && (
        <div className="remote-connection-page">
          <h2>{computerName}</h2>
          <p>{connected ? "Connected" : "Reconnecting…"} · Everything runs on this computer.</p>
          <RemoteNotificationSettings connected={connected} />
          <h2>Add Marshal to your Home Screen</h2>
          <p>
            Open this address in Safari. Tap Share, then Add to Home Screen. Keep Open as Web App
            switched on and tap Add.
          </p>
          <p>
            Launch the Marshal icon for a full-screen app. If it asks for an access key, use the key
            in Marshal’s iPhone access settings on your Mac.
          </p>
          <p>Keep Marshal running and Tailscale connected on both devices.</p>
          <button
            className="remote-disconnect"
            onClick={() => {
              void fetch("/remote/logout", { method: "POST" }).then((response) => {
                if (response.ok) location.reload();
              });
            }}
          >
            Disconnect this device
          </button>
        </div>
      )}
      {menu && (
        <div className="remote-navigation-backdrop" onClick={() => setMenu(false)}>
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="remote-navigation"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="remote-drawer-heading">
              <h2>Marshal</h2>
              <button aria-label="Close navigation" onClick={() => setMenu(false)}>
                ✕
              </button>
            </div>
            <p className="remote-host-label">{computerName}</p>
            <nav aria-label="Mobile sections">
              <button
                aria-current={section === "chats" ? "page" : undefined}
                onClick={() => {
                  setSection("chats");
                  setProject(null);
                  setMenu(false);
                }}
              >
                Chats
              </button>
              <button
                aria-current={section === "projects" ? "page" : undefined}
                onClick={() => {
                  setSection("projects");
                  setMenu(false);
                }}
              >
                Projects
              </button>
              <button
                aria-current={section === "apps" ? "page" : undefined}
                onClick={() => {
                  setSection("apps");
                  setMenu(false);
                }}
              >
                Apps
              </button>
              <button
                aria-current={section === "connection" ? "page" : undefined}
                onClick={() => {
                  setSection("connection");
                  setMenu(false);
                }}
              >
                This computer & app setup
              </button>
            </nav>
          </aside>
        </div>
      )}
    </section>
  );
}
