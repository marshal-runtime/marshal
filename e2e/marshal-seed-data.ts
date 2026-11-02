/**
 * E2E test seed data — session, automation, and history fixtures.
 *
 * Extracted from marshal-fixtures.ts for readability. These are imported by seedTestData()
 * and written to the E2E temp dir before each test run.
 */

import type { SessionMessage } from "../common/marshal-ipc-contract";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Anchor at yesterday 00:00 UTC so `at(N, "HH:MM:SS.sss")` is always in the
// past. Keeps fixtures inside the 90-day retention window enforced by
// `SessionManager.purgeExpiredSessions`. `MAX_DAYS_BACK` is 88 (90-day window
// minus 1 day for the yesterday anchor minus 1 day of safety margin) so
// adding a near-boundary fixture fails loudly at module load instead of
// silently aging out on the next boot.
const MAX_DAYS_BACK = 88;
const ANCHOR_DAY_MS = (() => {
  const d = new Date(Date.now() - 86_400_000);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
})();
const at = (daysBack: number, time: string): string => {
  if (daysBack > MAX_DAYS_BACK) {
    throw new Error(`seed-data: daysBack=${daysBack} exceeds retention safe-cap ${MAX_DAYS_BACK}`);
  }
  return `${new Date(ANCHOR_DAY_MS - daysBack * 86_400_000).toISOString().slice(0, 10)}T${time}Z`;
};
const atMs = (daysBack: number, time: string): number => Date.parse(at(daysBack, time));

function msg(role: SessionMessage["role"], content: string, ts: string): SessionMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    content,
    timestamp: ts,
  };
}

// ---------------------------------------------------------------------------
// Automations + history
// ---------------------------------------------------------------------------

export const SAMPLE_AUTOMATIONS = [
  {
    id: "wf-1",
    name: "Morning Email Summary",
    description: "Summarize overnight emails and flag urgent items",
    steps: [
      { id: "s1", label: "Check emails", prompt: "Check my unread emails from overnight" },
      { id: "s2", label: "Summarize", prompt: "Summarize the key items and flag anything urgent" },
    ],
    schedule: { naturalLanguage: "weekdays at 8am", days: [1, 2, 3, 4, 5], hour: 8, minute: 0 },
    enabled: true,
    createdAt: "2026-02-28T08:00:00Z",
    updatedAt: "2026-03-01T08:00:00Z",
  },
  {
    id: "wf-2",
    name: "Weekly Status Report",
    description: "Generate a weekly status report from chat and email activity",
    steps: [
      { id: "s1", label: "Gather data", prompt: "Look at my chat messages and emails this week" },
      { id: "s2", label: "Draft report", prompt: "Write a brief status report based on the data" },
      { id: "s3", label: "Send", prompt: "Send the report to my relay chat" },
    ],
    schedule: { naturalLanguage: "Fridays at 4pm", days: [5], hour: 16, minute: 0 },
    enabled: false,
    createdAt: "2026-02-20T16:00:00Z",
    updatedAt: "2026-02-27T16:00:00Z",
  },
  {
    id: "wf-3",
    name: "Prepare Monday Presentation",
    description: "One-time task: create the Q1 presentation",
    steps: [{ id: "s1", label: "Create slides", prompt: "Draft the Q1 review presentation" }],
    schedule: { naturalLanguage: "every monday at 9am", days: [1], hour: 9, minute: 0 },
    enabled: true,
    oneShot: true,
    createdAt: "2026-03-01T09:00:00Z",
    updatedAt: "2026-03-01T09:00:00Z",
  },
];

export const SAMPLE_HISTORY = [
  {
    id: "run-1",
    automationId: "wf-1",
    automationName: "Morning Email Summary",
    startedAt: new Date(Date.now() - 86400000).toISOString(),
    completedAt: new Date(Date.now() - 86400000 + 30000).toISOString(),
    status: "completed",
    stepResults: [
      { stepId: "s1", status: "completed", output: "Found 12 unread emails." },
      {
        stepId: "s2",
        status: "completed",
        output: "3 emails flagged as urgent:\n- Budget approval\n- Client escalation\n- PR review",
      },
    ],
    finalOutput: "Morning summary sent to relay.",
    sessionId: "deleted-session-abc123",
  },
];

// ---------------------------------------------------------------------------
// Sessions with messages and permission cards
// ---------------------------------------------------------------------------

export interface PermissionCard {
  id: string;
  toolCallId: string;
  sessionId?: string;
  kind: string;
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  resolved?: string;
  output?: string;
  createdAt: number;
}

export interface SeededSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt?: string;
  source?: string;
  messages?: SessionMessage[];
  permissionCards?: PermissionCard[];
}

const chatControlsMessages = Array.from<unknown, SessionMessage>({ length: 60 }, (_, index) => ({
  id: `chat-controls-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content:
    index === 59
      ? "Current bottom message 59"
      : `${index % 2 === 0 ? "Human" : "Assistant"} history message ${index}`,
  timestamp: new Date(Date.parse(at(1, "10:00:00.000")) + index * 60_000).toISOString(),
}));
chatControlsMessages[44] = {
  id: "chat-controls-goal",
  role: "system",
  content: "Goal started: Make chat controls discoverable",
  timestamp: new Date(Date.parse(at(1, "10:00:00.000")) + 44 * 60_000).toISOString(),
  goalTimelineEvent: {
    type: "goal.declared",
    fence: {
      goalId: "chat-controls-goal",
      epoch: 1,
    },
    objective: "Make chat controls discoverable",
  },
};
chatControlsMessages[45] = {
  id: "chat-controls-researcher",
  role: "user",
  content: "Message from subagent Research helper (chat-controls-researcher):\n\nMapped the UI.",
  timestamp: new Date(Date.parse(at(1, "10:00:00.000")) + 45 * 60_000).toISOString(),
  agentMessage: {
    source: "chat-controls-researcher",
    sourceLabel: "Research helper",
    kind: "parent",
    deliveryMode: "queue",
    sequence: 1,
    sourceSessionSource: "subagent",
  },
};
chatControlsMessages[46] = {
  id: "chat-controls-reviewer",
  role: "user",
  content:
    "Message from subagent Accessibility reviewer (chat-controls-reviewer):\n\nThe persistent controls are reachable.",
  timestamp: new Date(Date.parse(at(1, "10:00:00.000")) + 46 * 60_000).toISOString(),
  agentMessage: {
    source: "chat-controls-reviewer",
    sourceLabel: "Accessibility reviewer",
    kind: "review-feedback",
    deliveryMode: "queue",
    sequence: 1,
  },
};

export const CHAT_CONTROLS_SESSION: SeededSession = {
  id: "e2e-chat-controls",
  name: "Legacy long chat",
  createdAt: at(1, "10:00:00.000"),
  updatedAt: at(0, "23:59:00.000"),
  messages: chatControlsMessages,
};

export const CHAT_CONTROLS_SHORT_SESSION: SeededSession = {
  id: "e2e-chat-controls-short",
  name: "Legacy short chat",
  createdAt: at(1, "09:00:00.000"),
  updatedAt: at(0, "22:59:00.000"),
  messages: [
    {
      id: "legacy-short-user",
      role: "user",
      content: "A source-less legacy prompt",
      timestamp: at(1, "09:00:00.000"),
    },
    {
      id: "legacy-short-assistant",
      role: "assistant",
      content: "A source-less legacy answer",
      timestamp: at(1, "09:01:00.000"),
    },
  ],
};

export const SEEDED_SESSIONS: SeededSession[] = [
  {
    id: "e2e-fresh",
    name: "New Chat",
    createdAt: at(2, "09:00:00.000"),
    updatedAt: at(0, "00:00:00.000"),
  },
  {
    id: "e2e-python",
    name: "Python debugging session",
    createdAt: at(3, "14:00:00.000"),
    messages: [
      msg("user", "My Python script crashes with a KeyError on line 42", at(3, "14:00:00.000")),
      msg(
        "assistant",
        "The KeyError means the dictionary key doesn't exist. Can you share the traceback?",
        at(3, "14:00:05.000"),
      ),
    ],
  },
  {
    id: "e2e-api",
    name: "API design review",
    createdAt: at(4, "10:00:00.000"),
    messages: [
      msg("user", "Review our REST API endpoints for the user service", at(4, "10:00:00.000")),
      msg(
        "assistant",
        "I'll analyze the endpoint structure. The /users resource looks well-designed.",
        at(4, "10:00:05.000"),
      ),
    ],
  },
  {
    id: "e2e-history",
    name: "Disk Cleanup",
    createdAt: at(2, "10:00:00.000"),
    updatedAt: at(2, "10:03:04.000"),
    messages: [
      // Turn 1: two grouped shell cards (both allowed)
      {
        id: "m1",
        role: "user",
        content: "Check disk usage and list large files",
        timestamp: at(2, "10:00:00.000"),
      },
      {
        id: "m2",
        role: "assistant",
        content: "I'll check your disk usage. Let me run a couple of commands.",
        timestamp: at(2, "10:00:02.000"),
      },
      {
        id: "m3",
        role: "assistant",
        content: "Your disk is 72% full. The largest files are in ~/Downloads.",
        timestamp: at(2, "10:00:06.000"),
      },
      // Turn 2: mixed-kind group (write allowed + shell denied)
      {
        id: "m4",
        role: "user",
        content: "Clean up the temp files and save a summary",
        timestamp: at(2, "10:01:00.000"),
      },
      {
        id: "m5",
        role: "assistant",
        content: "I'll write a cleanup script and save a summary file.",
        timestamp: at(2, "10:01:02.000"),
      },
      {
        id: "m6",
        role: "assistant",
        content: "Saved the summary. The dangerous command was blocked.",
        timestamp: at(2, "10:01:06.000"),
      },
      // Turn 3: single standalone MCP card (failed)
      {
        id: "m7",
        role: "user",
        content: "Try fetching the report from the intranet",
        timestamp: at(2, "10:02:00.000"),
      },
      {
        id: "m8",
        role: "assistant",
        content: "Let me connect to the intranet.",
        timestamp: at(2, "10:02:02.000"),
      },
      {
        id: "m9",
        role: "assistant",
        content: "The the intranet request failed. Please check your permissions.",
        timestamp: at(2, "10:02:06.000"),
      },
      // Turn 4: URL card (allowed) + pending card (unresolved)
      {
        id: "m10",
        role: "user",
        content: "Open the team dashboard and check build status",
        timestamp: at(2, "10:03:00.000"),
      },
      {
        id: "m11",
        role: "assistant",
        content: "I'll open the dashboard URL and then check the CI pipeline.",
        timestamp: at(2, "10:03:02.000"),
      },
    ],
    permissionCards: [
      {
        id: "perm-1",
        toolCallId: "tc-1",
        kind: "shell",
        title: "Run command",
        message: "Check disk usage",
        detail: "du -sh ~/*",
        buttons: ["Allow", "Deny"],
        resolved: "allowed",
        output: "4.2G\t~/Documents\n12G\t~/Downloads\n800M\t~/Desktop",
        createdAt: atMs(2, "10:00:03.000"),
      },
      {
        id: "perm-2",
        toolCallId: "tc-2",
        kind: "shell",
        title: "Run command",
        message: "List large files",
        detail: "find ~/Downloads -size +100M",
        buttons: ["Allow", "Deny"],
        resolved: "allowed",
        output: "/Users/test/Downloads/big-archive.zip\n/Users/test/Downloads/video.mp4",
        createdAt: atMs(2, "10:00:04.000"),
      },
      {
        id: "perm-3",
        toolCallId: "tc-3",
        kind: "write",
        title: "Write file",
        message: "Save cleanup summary",
        detail: "~/cleanup-summary.txt",
        buttons: ["Allow", "Deny"],
        resolved: "allowed",
        output: "File written (245 bytes)",
        createdAt: atMs(2, "10:01:03.000"),
      },
      {
        id: "perm-4",
        toolCallId: "tc-4",
        kind: "shell",
        title: "Run command",
        message: "Remove temp files",
        detail: "rm -rf ~/tmp/*",
        buttons: ["Allow", "Deny"],
        resolved: "denied",
        createdAt: atMs(2, "10:01:04.000"),
      },
      {
        id: "perm-5",
        toolCallId: "tc-5",
        kind: "mcp",
        title: "ExampleMcp",
        message: "Fetch the intranet report",
        detail: "GET /sites/reports/Q1-summary.xlsx",
        buttons: ["Allow", "Deny"],
        resolved: "failed",
        output: "Error: 403 Forbidden — insufficient permissions",
        createdAt: atMs(2, "10:02:03.000"),
      },
      {
        id: "perm-6",
        toolCallId: "tc-6",
        kind: "url",
        title: "Open URL",
        message: "Open team dashboard",
        detail: "https://ci.example.com/myorg/myproject/builds",
        buttons: ["Allow", "Deny"],
        resolved: "allowed",
        output: "Page loaded (200 OK)",
        createdAt: atMs(2, "10:03:03.000"),
      },
      {
        id: "perm-8",
        toolCallId: "tc-8",
        kind: "memory",
        title: "Remember fact",
        message: "Marshal wants to store a memory",
        detail: "Remember that this workspace prefers scoped approvals.",
        buttons: ["Allow", "Deny"],
        resolved: "allowed",
        output: "Memory saved",
        createdAt: atMs(2, "10:03:03.100"),
      },
      {
        id: "perm-9",
        toolCallId: "tc-9",
        kind: "hook",
        title: "Run hook",
        message: "Marshal wants to run a hook",
        detail: "pre_tool_use validation hook",
        buttons: ["Allow", "Deny"],
        resolved: "allowed",
        output: "Hook completed",
        createdAt: atMs(2, "10:03:03.200"),
      },
      {
        id: "perm-7",
        toolCallId: "tc-7",
        kind: "shell",
        title: "Run command",
        message: "Check CI pipeline status",
        detail: "az pipelines runs list --top 5 --status completed",
        buttons: ["Allow", "Allow for session", "Always allow", "Deny"],
        createdAt: atMs(2, "10:03:04.000"),
      },
    ],
  },
  {
    id: "e2e-session-a",
    name: "Session A — Files",
    createdAt: at(1, "10:00:00.000"),
    updatedAt: at(1, "10:00:02.000"),
    messages: [
      {
        id: "ma1",
        role: "user",
        content: "List files and save output",
        timestamp: at(1, "10:00:00.000"),
      },
      {
        id: "ma2",
        role: "assistant",
        content: "I'll list files and save the output.",
        timestamp: at(1, "10:00:01.000"),
      },
    ],
    permissionCards: [
      {
        id: "perm-a1",
        toolCallId: "tc-a1",
        sessionId: "e2e-session-a",
        kind: "shell",
        title: "Run command",
        message: "List files",
        detail: "ls -la",
        buttons: ["Allow", "Deny"],
        resolved: "allowed",
        output: "total 42",
        createdAt: atMs(1, "10:00:01.000"),
      },
      {
        id: "perm-a2",
        toolCallId: "tc-a2",
        sessionId: "e2e-session-a",
        kind: "write",
        title: "Write file",
        message: "Save output",
        detail: "output.txt",
        buttons: ["Allow", "Deny"],
        createdAt: atMs(1, "10:00:02.000"),
      },
    ],
  },
  {
    id: "e2e-session-b",
    name: "Session B — Calendar",
    createdAt: at(1, "11:00:00.000"),
    updatedAt: at(1, "11:00:01.000"),
    messages: [
      {
        id: "mb1",
        role: "user",
        content: "Check my calendar",
        timestamp: at(1, "11:00:00.000"),
      },
      {
        id: "mb2",
        role: "assistant",
        content: "Let me check your calendar.",
        timestamp: at(1, "11:00:01.000"),
      },
    ],
    permissionCards: [
      {
        id: "perm-b1",
        toolCallId: "tc-b1",
        sessionId: "e2e-session-b",
        kind: "mcp",
        title: "ExampleMcp",
        message: "Read calendar",
        detail: "GET /calendar/events",
        buttons: ["Allow", "Deny"],
        resolved: "denied",
        createdAt: atMs(1, "11:00:01.000"),
      },
    ],
  },
  {
    id: "e2e-relay-archived",
    name: "Relay Chat",
    createdAt: at(1, "08:00:00.000"),
    source: "workflow-agent",
    messages: [
      {
        id: "relay-msg-d1-1",
        role: "user",
        content: "Any urgent emails?",
        timestamp: at(3, "09:00:00.000"),
      },
      {
        id: "relay-msg-d1-2",
        role: "assistant",
        content: "No urgent emails right now.",
        timestamp: at(3, "09:00:05.000"),
      },
      {
        id: "relay-msg-d2-1",
        role: "user",
        content: "Summarize my day",
        timestamp: at(2, "17:00:00.000"),
      },
      {
        id: "relay-msg-d2-2",
        role: "assistant",
        content: "You had 4 meetings and replied to 12 emails.",
        timestamp: at(2, "17:00:05.000"),
      },
      {
        id: "relay-msg-1",
        role: "user",
        content: "What meetings do I have today?",
        timestamp: at(1, "12:00:00.000"),
      },
      {
        id: "relay-msg-2",
        role: "assistant",
        content:
          "You have 3 meetings today: standup at 9am, design review at 11am, and 1:1 with your manager at 3pm.",
        timestamp: at(1, "12:00:05.000"),
      },
    ],
  },
];
