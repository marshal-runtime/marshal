import {
  RELAY_FIXED_AGENT_TOOL_NAMES,
  type RelayFixedAgentRole,
  type RelayFixedAgentToolDefinition,
} from "./contracts";

const STRING_PROPERTY = { type: "string", minLength: 1 } as const;
const LIMIT_PROPERTY = { type: "integer", minimum: 1, maximum: 50 } as const;

const TOOL_DEFINITIONS: Readonly<
  Record<RelayFixedAgentRole, readonly RelayFixedAgentToolDefinition[]>
> = {
  "new-chats": [
    {
      name: RELAY_FIXED_AGENT_TOOL_NAMES.newChatsClarify,
      description:
        "Send one concise natural-language clarification question back to the person who made the request.",
      parameters: {
        type: "object",
        properties: {
          question: STRING_PROPERTY,
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
    {
      name: RELAY_FIXED_AGENT_TOOL_NAMES.newChatsStartTask,
      description:
        "Start the completed request with the configured default agent in exactly one persistent task session and request its dedicated managed group.",
      parameters: {
        type: "object",
        properties: {
          title: STRING_PROPERTY,
          request: STRING_PROPERTY,
        },
        required: ["title", "request"],
        additionalProperties: false,
      },
    },
  ],
  progress: [
    {
      name: RELAY_FIXED_AGENT_TOOL_NAMES.progressRouteReply,
      description:
        "Route a natural-language reply to the session and turn identified by the correlated progress item.",
      parameters: {
        type: "object",
        properties: {
          replyKind: {
            type: "string",
            enum: ["steering", "clarification-answer"],
          },
          message: STRING_PROPERTY,
        },
        required: ["replyKind", "message"],
        additionalProperties: false,
      },
    },
  ],
  "information-control": [
    {
      name: RELAY_FIXED_AGENT_TOOL_NAMES.informationListRecent,
      description: "List recent inspectable sessions, including the persistent relay fixed agents.",
      parameters: {
        type: "object",
        properties: {
          limit: LIMIT_PROPERTY,
        },
        additionalProperties: false,
      },
    },
    {
      name: RELAY_FIXED_AGENT_TOOL_NAMES.informationSearch,
      description: "Search inspectable sessions by natural-language text.",
      parameters: {
        type: "object",
        properties: {
          query: STRING_PROPERTY,
          limit: LIMIT_PROPERTY,
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: RELAY_FIXED_AGENT_TOOL_NAMES.informationStatus,
      description: "Get the current status and metadata for one session.",
      parameters: {
        type: "object",
        properties: {
          sessionId: STRING_PROPERTY,
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
    {
      name: RELAY_FIXED_AGENT_TOOL_NAMES.informationOpenGroup,
      description:
        "Request or reopen the managed relay group for one inspectable session. Optionally deliver a message to that session so its agent replies in the group.",
      parameters: {
        type: "object",
        properties: {
          sessionId: STRING_PROPERTY,
          message: STRING_PROPERTY,
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
  ],
};

export function getRelayFixedAgentToolDefinitions(
  role: RelayFixedAgentRole,
): readonly RelayFixedAgentToolDefinition[] {
  return TOOL_DEFINITIONS[role];
}
