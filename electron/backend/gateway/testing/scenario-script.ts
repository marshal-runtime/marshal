// Test-only scripts for MockGatewayWsClient. These mirror
// common/marshal-mock-scenarios.ts at the WebSocket transport layer.

export type GatewayTestRpcMethod =
  | "sessions.list"
  | "sessions.subscribe"
  | "sessions.create"
  | "sessions.patch"
  | "sessions.delete"
  | "chat.send"
  | "chat.abort"
  | "chat.history"
  | "models.list";

export type GatewayTestRpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

// "$runId" values are replaced with the runId returned by `chat.send`.
export interface GatewayTestFrame {
  delay: number;
  eventName: string;
  payload: Record<string, unknown>;
}

export interface GatewayTestScenario {
  rpcs?: Partial<Record<GatewayTestRpcMethod, GatewayTestRpcHandler>>;
  chatFrames?: GatewayTestFrame[];
}

const DEFAULT_TEXT_DELTA_1 = "Hi! ";
const DEFAULT_TEXT_DELTA_2 = "This is the mock gateway.";

export const DEFAULT_GATEWAY_TEST_CHAT_SCENARIO: GatewayTestScenario = {
  chatFrames: [
    {
      delay: 80,
      eventName: "chat",
      payload: {
        runId: "$runId",
        state: "delta",
        message: { content: [{ type: "text", text: DEFAULT_TEXT_DELTA_1 }] },
      },
    },
    {
      delay: 120,
      eventName: "chat",
      payload: {
        runId: "$runId",
        state: "delta",
        message: {
          content: [{ type: "text", text: DEFAULT_TEXT_DELTA_1 + DEFAULT_TEXT_DELTA_2 }],
        },
      },
    },
    {
      delay: 100,
      eventName: "chat",
      payload: {
        runId: "$runId",
        state: "final",
        done: true,
        message: {
          content: [{ type: "text", text: DEFAULT_TEXT_DELTA_1 + DEFAULT_TEXT_DELTA_2 }],
        },
      },
    },
  ],
};

export function selectGatewayTestScenario(_prompt: string): GatewayTestScenario {
  return DEFAULT_GATEWAY_TEST_CHAT_SCENARIO;
}
