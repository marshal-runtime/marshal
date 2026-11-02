import {
  RELAY_FIXED_AGENT_TOOL_NAMES,
  type RelayFixedAgentCatalogPort,
  type RelayFixedAgentLifecycleDescriptor,
  type RelayFixedAgentRole,
  type RelayFixedAgentSpecification,
  type RelayFixedAgentToolPolicyMismatch,
} from "./contracts";
import { INFORMATION_CONTROL_INSTRUCTIONS } from "./instructions/information-control";
import { NEW_CHATS_INSTRUCTIONS } from "./instructions/new-chats";
import { PROGRESS_INSTRUCTIONS } from "./instructions/progress";

export const RELAY_FIXED_AGENT_LIFECYCLE: RelayFixedAgentLifecycleDescriptor = {
  persistence: "persistent",
  inspectable: true,
  retention: "fixed",
  dynamicCleanup: "exclude",
};

export const RELAY_FIXED_AGENT_SPECIFICATIONS: readonly RelayFixedAgentSpecification[] = [
  {
    agentId: "new-chats",
    specVersion: 1,
    role: "new-chats",
    displayName: "New Chats",
    description: "Clarifies natural-language requests and starts one dedicated task session.",
    instructions: NEW_CHATS_INSTRUCTIONS,
    sessionPriority: "foreground",
    toolPolicy: {
      mode: "default-deny",
      allowedTools: [
        {
          toolId: RELAY_FIXED_AGENT_TOOL_NAMES.newChatsClarify,
          reason: "Ask one natural-language question when a request is materially incomplete.",
        },
        {
          toolId: RELAY_FIXED_AGENT_TOOL_NAMES.newChatsStartTask,
          reason: "Start one persistent default-agent task session for a completed request.",
        },
      ],
    },
  },
  {
    agentId: "progress",
    specVersion: 1,
    role: "progress",
    displayName: "Progress",
    description: "Presents deliberately published progress and routes correlated natural replies.",
    instructions: PROGRESS_INSTRUCTIONS,
    sessionPriority: "control",
    toolPolicy: {
      mode: "default-deny",
      allowedTools: [
        {
          toolId: RELAY_FIXED_AGENT_TOOL_NAMES.progressRouteReply,
          reason: "Route correlated steering and clarification replies to the originating session.",
        },
      ],
    },
  },
  {
    agentId: "information-control",
    specVersion: 1,
    role: "information-control",
    displayName: "Information & Control",
    description: "Lists, searches, inspects, and opens managed groups for recent sessions.",
    instructions: INFORMATION_CONTROL_INSTRUCTIONS,
    sessionPriority: "control",
    toolPolicy: {
      mode: "default-deny",
      allowedTools: [
        {
          toolId: RELAY_FIXED_AGENT_TOOL_NAMES.informationListRecent,
          reason: "List recent inspectable sessions.",
        },
        {
          toolId: RELAY_FIXED_AGENT_TOOL_NAMES.informationSearch,
          reason: "Search inspectable sessions using natural-language text.",
        },
        {
          toolId: RELAY_FIXED_AGENT_TOOL_NAMES.informationStatus,
          reason: "Read the current status of one inspectable session.",
        },
        {
          toolId: RELAY_FIXED_AGENT_TOOL_NAMES.informationOpenGroup,
          reason: "Ensure or reopen the managed group for one inspectable session.",
        },
      ],
    },
  },
];

export const RELAY_FIXED_AGENT_TOOL_POLICY_MISMATCHES: readonly RelayFixedAgentToolPolicyMismatch[] =
  [
    {
      mismatchId: "remote-permission-approval-not-represented",
      affectedRoles: ["new-chats", "progress", "information-control"],
      canonicalDescriptor: "RelayDefaultDenyToolPolicyDescriptor",
      hostRequirement: "remote-permission-approval-forbidden",
      enforcement: "RelayFixedAgentToolRegistration.resolveRemotePermission",
    },
  ];

export function getRelayFixedAgentSpecification(
  role: RelayFixedAgentRole,
): RelayFixedAgentSpecification {
  const specification = RELAY_FIXED_AGENT_SPECIFICATIONS.find(
    (candidate) => candidate.role === role,
  );
  if (!specification) throw new Error(`Unknown relay fixed-agent role: ${role}`);
  return specification;
}

export function createRelayFixedAgentCatalog(): RelayFixedAgentCatalogPort {
  return {
    async list() {
      return { ok: true, value: RELAY_FIXED_AGENT_SPECIFICATIONS };
    },
    async get(agentId) {
      const specification = RELAY_FIXED_AGENT_SPECIFICATIONS.find(
        (candidate) => candidate.agentId === agentId,
      );
      return specification
        ? { ok: true, value: specification }
        : {
            ok: false,
            error: {
              code: "not-found",
              message: `Unknown relay fixed agent: ${agentId}`,
              retryable: false,
            },
          };
    },
  };
}
