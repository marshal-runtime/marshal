/**
 * Mock scenario selection for E2E mode.
 *
 * With the ClientFactory DI approach, SessionManager uses a MockCopilotClient
 * (injected via main.ts) whose MockCopilotSession.send() drives scenario
 * playback. This module provides the scenario selection logic and heartbeat/
 * automation step scenarios consumed by MockCopilotSession.
 *
 * The old sendMessage/sendAndCollect patching has been removed — all event
 * emission now flows through the real SDK session hooks.
 */
import type { MockStep } from "../common/marshal-mock-scenarios";
import {
  mockEvent,
  MOCK_SCENARIOS,
  MOCK_TRIGGERED_SCENARIOS,
} from "../common/marshal-mock-scenarios";

// ---------------------------------------------------------------------------
// Heartbeat scenarios — must use HEARTBEAT_URGENT / HEARTBEAT_OK markers
// so HeartbeatManager.parseResponse() picks them up and fires notifications.
// ---------------------------------------------------------------------------

let heartbeatRunCount = 0;
let heartbeatPermRunCount = 0;

// Heartbeat event delays must total > 2s so the panel's 2s status poll
// catches the running state before session.idle fires.
const HEARTBEAT_SCENARIOS: MockStep[][] = [
  // Run 1: single urgent
  [
    {
      type: "event",
      delay: 1000,
      event: mockEvent("assistant.message_delta", {
        messageId: "m-hb-1",
        deltaContent: "Checking your messages and emails...\n\n",
      }),
    },
    {
      type: "event",
      delay: 2000,
      event: mockEvent("assistant.message_delta", {
        messageId: "m-hb-1",
        deltaContent:
          "HEARTBEAT_URGENT|Slack|Manager needs response on Q3 budget|https://example.com/chat\n",
      }),
    },
    {
      type: "event",
      delay: 200,
      event: mockEvent("assistant.message", {
        messageId: "m-hb-1",
        content:
          "Checking your messages and emails...\n\nHEARTBEAT_URGENT|Slack|Manager needs response on Q3 budget|https://example.com/chat\n",
      }),
    },
    { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
  ],
  // Run 2: all clear
  [
    {
      type: "event",
      delay: 1000,
      event: mockEvent("assistant.message_delta", {
        messageId: "m-hb-2",
        deltaContent: "Checking your messages and emails...\n\nHEARTBEAT_OK\n",
      }),
    },
    {
      type: "event",
      delay: 2000,
      event: mockEvent("assistant.message", {
        messageId: "m-hb-2",
        content: "Checking your messages and emails...\n\nHEARTBEAT_OK\n",
      }),
    },
    { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
  ],
  // Run 3: multiple urgent
  [
    {
      type: "event",
      delay: 1000,
      event: mockEvent("assistant.message_delta", {
        messageId: "m-hb-3",
        deltaContent: "Checking your messages and emails...\n\n",
      }),
    },
    {
      type: "event",
      delay: 2000,
      event: mockEvent("assistant.message_delta", {
        messageId: "m-hb-3",
        deltaContent:
          "HEARTBEAT_URGENT|Slack|VP escalation on hiring plan|https://example.com/chat\n" +
          "HEARTBEAT_URGENT|Email|PR review blocking release|https://mail.example.com\n" +
          "HEARTBEAT_URGENT|Slack|Customer incident P1|https://example.com/incident\n",
      }),
    },
    {
      type: "event",
      delay: 500,
      event: mockEvent("assistant.message", {
        messageId: "m-hb-3",
        content:
          "Checking your messages and emails...\n\n" +
          "HEARTBEAT_URGENT|Slack|VP escalation on hiring plan|https://example.com/chat\n" +
          "HEARTBEAT_URGENT|Email|PR review blocking release|https://mail.example.com\n" +
          "HEARTBEAT_URGENT|Slack|Customer incident P1|https://example.com/incident\n",
      }),
    },
    { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
  ],
];

// ---------------------------------------------------------------------------
// Heartbeat permission scenarios — exercises deny-prompt pipeline.
// Uses listAutomations (a read-only self-tool).
// When autoApproveReadOnly is on (default), the tool passes at step 6.
// When autoApproveReadOnly is off, it reaches step 9 (deny-prompt) and gets denied.
// This lets tests toggle autoApproveReadOnly and observe the transition.
// ---------------------------------------------------------------------------

const HEARTBEAT_PERMISSION_SCENARIOS: MockStep[][] = [
  [
    {
      type: "event",
      delay: 1000,
      event: mockEvent("assistant.message_delta", {
        messageId: "m-hb-perm",
        deltaContent: "Checking your automations...\n\n",
      }),
    },
    // --- Tool: listAutomations (read-only self-tool) ---
    {
      type: "permission-request",
      delay: 100,
      permissionRequest: {
        kind: "custom-tool",
        toolCallId: "tc-hb-perm-1",
        toolName: "listAutomations",
        command: "listAutomations",
        fullCommandText: "listAutomations",
      },
    },
    {
      type: "pre-tool-use",
      delay: 100,
      toolCall: {
        toolCallId: "tc-hb-perm-1",
        toolName: "listAutomations",
      },
    },
    {
      type: "event",
      delay: 200,
      event: mockEvent("tool.execution_start", {
        toolCallId: "tc-hb-perm-1",
        toolName: "listAutomations",
        mcpToolName: "listAutomations",
        arguments: {},
      }),
    },
    {
      type: "event",
      delay: 500,
      event: mockEvent("tool.execution_complete", {
        toolCallId: "tc-hb-perm-1",
        success: true,
      }),
    },
    {
      type: "post-tool-use",
      delay: 50,
      toolCall: {
        toolCallId: "tc-hb-perm-1",
        toolName: "listAutomations",
        toolResult: "Found 3 automations",
      },
    },
    // Final text with HEARTBEAT_OK marker
    {
      type: "event",
      delay: 200,
      event: mockEvent("assistant.message_delta", {
        messageId: "m-hb-perm",
        deltaContent: "HEARTBEAT_OK\n",
      }),
    },
    {
      type: "event",
      delay: 200,
      event: mockEvent("assistant.message", {
        messageId: "m-hb-perm",
        content: "Checking your messages...\n\nHEARTBEAT_OK\n",
      }),
    },
    { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
  ],
];

// ---------------------------------------------------------------------------
// Automation step response — generates output relevant to the step prompt
// ---------------------------------------------------------------------------

function buildAutomationStepResponse(prompt: string): MockStep[] {
  const output =
    `Based on "${prompt.slice(0, 60).trim()}":\n\n` +
    "- Reviewed relevant data from your workspace\n" +
    "- Found 3 items matching your criteria\n" +
    "- Summary: All items have been processed successfully\n\n" +
    "Let me know if you need more details on any specific item.";

  return [
    {
      type: "event",
      delay: 300,
      event: mockEvent("assistant.message_delta", { messageId: "m-wf", deltaContent: output }),
    },
    {
      type: "event",
      delay: 200,
      event: mockEvent("assistant.message", { messageId: "m-wf", content: output }),
    },
    { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
  ];
}

// ---------------------------------------------------------------------------
// Automation step response with permission — single shell permission-request
// ---------------------------------------------------------------------------

function buildAutomationStepResponseWithPermission(prompt: string): MockStep[] {
  const intro = `Analyzing "${prompt.slice(0, 40).trim()}"...\n\n`;
  const output =
    "- Scanned the codebase for TODO comments\n" +
    "- Found 7 items across 4 files\n" +
    "- All items have been catalogued\n\n" +
    "Step complete.";
  const fullText = intro + output;

  return [
    {
      type: "event",
      delay: 300,
      event: mockEvent("assistant.message_delta", {
        messageId: "m-wf-perm",
        deltaContent: intro,
      }),
    },
    // --- Tool: shell ---
    {
      type: "permission-request",
      delay: 100,
      permissionRequest: {
        kind: "shell",
        toolCallId: "tc-wf-perm-1",
        toolName: "shell",
        command: 'grep -r "TODO" ./src/',
        fullCommandText: 'grep -r "TODO" ./src/',
      },
    },
    {
      type: "pre-tool-use",
      delay: 100,
      toolCall: {
        toolCallId: "tc-wf-perm-1",
        toolName: "shell",
        toolArgs: { command: 'grep -r "TODO" ./src/' },
      },
    },
    {
      type: "event",
      delay: 200,
      event: mockEvent("tool.execution_start", {
        toolCallId: "tc-wf-perm-1",
        toolName: "shell",
        mcpToolName: "shell",
        arguments: { command: 'grep -r "TODO" ./src/' },
      }),
    },
    {
      type: "event",
      delay: 500,
      event: mockEvent("tool.execution_complete", {
        toolCallId: "tc-wf-perm-1",
        success: true,
      }),
    },
    {
      type: "post-tool-use",
      delay: 50,
      toolCall: {
        toolCallId: "tc-wf-perm-1",
        toolName: "shell",
        toolResult: "Found 7 TODOs",
      },
    },
    // Step output
    {
      type: "event",
      delay: 200,
      event: mockEvent("assistant.message_delta", {
        messageId: "m-wf-perm",
        deltaContent: output,
      }),
    },
    {
      type: "event",
      delay: 200,
      event: mockEvent("assistant.message", { messageId: "m-wf-perm", content: fullText }),
    },
    { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
  ];
}

// ---------------------------------------------------------------------------
// Scenario picker — selects response based on prompt content
// ---------------------------------------------------------------------------

/** Counter for cycling through MOCK_SCENARIOS on generic user sends. */
let mockCallCount = 0;

export function pickScenario(prompt: string): MockStep[] {
  const lower = prompt.toLowerCase();

  if (lower.includes("readonly-shell")) {
    return MOCK_TRIGGERED_SCENARIOS["readonly-shell"] ?? [];
  }

  // Heartbeat prompts contain the buildPrompt() markers
  if (
    lower.includes("heartbeat") ||
    lower.includes("heartbeat_urgent") ||
    lower.includes("heartbeat_ok") ||
    lower.includes("check my messages") ||
    lower.includes("flag anything urgent")
  ) {
    // Permission variant — prompt contains "permission" keyword
    if (lower.includes("permission")) {
      const scenario =
        HEARTBEAT_PERMISSION_SCENARIOS[
          heartbeatPermRunCount % HEARTBEAT_PERMISSION_SCENARIOS.length
        ];
      heartbeatPermRunCount++;
      return scenario;
    }
    const scenario = HEARTBEAT_SCENARIOS[heartbeatRunCount % HEARTBEAT_SCENARIOS.length];
    heartbeatRunCount++;
    return scenario;
  }

  const triggeredEntry = Object.entries(MOCK_TRIGGERED_SCENARIOS).find(([trigger]) =>
    lower.includes(trigger),
  );
  if (triggeredEntry) {
    return triggeredEntry[1];
  }

  // Automation step prompts — anything with context from buildStepPrompt
  if (lower.includes("step") || lower.includes("previous step") || prompt.length > 100) {
    // Permission variant — prompt contains "permission" keyword
    if (lower.includes("permission")) {
      return buildAutomationStepResponseWithPermission(prompt);
    }
    return buildAutomationStepResponse(prompt);
  }

  // Cycle through the rich mock scenarios
  const scenario = MOCK_SCENARIOS[mockCallCount % MOCK_SCENARIOS.length];
  mockCallCount++;
  return scenario;
}
