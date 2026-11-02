import { createRuntimeServiceToken } from "@marshal/runtime";

import {
  parseRelayAccountId,
  type RelayAddress,
  type RelayAccountId,
} from "../../common/relay-contract";
import type { RelayInboundMessageEvent, RelayProvider } from "../relay/contracts";
import type {
  RelayAccountExperienceRuntime,
  RelayInboundRouteContext,
  RelayInboundRouteResult,
} from "../relay/experience-coordinator";

export interface MarshalRelayRegistrationService {
  register(input: { readonly provider: RelayProvider; readonly accountId: string }): () => void;
}

export const MARSHAL_RELAY_REGISTRATION_SERVICE =
  createRuntimeServiceToken<MarshalRelayRegistrationService>("@marshal/host:relay-registration");

interface RelayRegistrationCoordinator {
  readonly bindings: {
    getByExternalConversation(
      provider: string,
      accountId: string,
      conversationId: string,
    ): { readonly localConversationId: string } | undefined;
    upsert(input: {
      provider: string;
      accountId: string;
      externalConversationId: string;
      localConversationId: string;
      role: "session";
    }): unknown;
  };
  registerAccountRuntime(
    account: {
      readonly providerId: RelayAddress["providerId"];
      readonly accountId: RelayAccountId;
    },
    runtime: RelayAccountExperienceRuntime,
  ): () => void;
}

interface RelayRegistrationRegistry {
  register(provider: RelayProvider, accountId: RelayAccountId): () => void;
}

interface RelaySessionPort {
  createSession(
    model?: string,
    soul?: string,
    options?: { readonly name?: string; readonly source?: "user"; readonly setActive?: boolean },
  ): Promise<{ readonly id: string }>;
  isSessionBusy(sessionId: string): boolean;
  sendMessage(
    sessionId: string,
    content: string,
    attachments?: undefined,
    options?: {
      readonly clientMessageId?: string;
      readonly noSwitch?: boolean;
      readonly relayOrigin?: RelayAddress;
    },
  ): Promise<void>;
  steerMessage(
    sessionId: string,
    content: string,
    attachments?: undefined,
    options?: { readonly clientMessageId?: string },
  ): Promise<void>;
}

export function createMarshalRelayRegistrationService(options: {
  readonly registry: RelayRegistrationRegistry;
  readonly coordinator: RelayRegistrationCoordinator;
  readonly sessions: RelaySessionPort;
}): MarshalRelayRegistrationService {
  return {
    register: ({ provider, accountId: rawAccountId }) => {
      assertRelayProvider(provider);
      const accountId = parseRelayAccountId(rawAccountId);
      const account = { providerId: provider.providerId, accountId };
      const unregisterProvider = options.registry.register(provider, accountId);
      let unregisterRuntime: (() => void) | undefined;
      try {
        unregisterRuntime = options.coordinator.registerAccountRuntime(
          account,
          createAccountRuntime(provider, accountId, options.coordinator, options.sessions),
        );
      } catch (error) {
        unregisterProvider();
        throw error;
      }
      return () => {
        unregisterRuntime?.();
        unregisterProvider();
      };
    },
  };
}

function createAccountRuntime(
  provider: RelayProvider,
  accountId: RelayAccountId,
  coordinator: RelayRegistrationCoordinator,
  sessions: RelaySessionPort,
): RelayAccountExperienceRuntime {
  return {
    start: () => provider.connect(accountId),
    stop: () => provider.disconnect(accountId),
    routeInbound: async (
      event: RelayInboundMessageEvent,
      context: RelayInboundRouteContext,
    ): Promise<RelayInboundRouteResult> => {
      const message = event.message;
      const conversationId = message.address.conversationId;
      let sessionId = coordinator.bindings.getByExternalConversation(
        provider.providerId,
        accountId,
        conversationId,
      )?.localConversationId;
      if (!sessionId) {
        const session = await sessions.createSession(undefined, undefined, {
          name: `${provider.providerId}: ${conversationId}`,
          source: "user",
          setActive: false,
        });
        sessionId = session.id;
        coordinator.bindings.upsert({
          provider: provider.providerId,
          accountId,
          externalConversationId: conversationId,
          localConversationId: sessionId,
          role: "session",
        });
      }
      const text = message.text?.trim();
      if (text) {
        if (sessions.isSessionBusy(sessionId)) {
          await sessions.steerMessage(sessionId, text, undefined, {
            clientMessageId: context.idempotencyKey,
          });
        } else {
          await sessions.sendMessage(sessionId, text, undefined, {
            clientMessageId: context.idempotencyKey,
            noSwitch: true,
            relayOrigin: message.address,
          });
        }
      }
      return {
        localMessageId: context.idempotencyKey,
        sessionId,
      };
    },
  };
}

function assertRelayProvider(provider: RelayProvider): void {
  if (
    !provider ||
    typeof provider.providerId !== "string" ||
    typeof provider.connect !== "function" ||
    typeof provider.disconnect !== "function" ||
    typeof provider.status !== "function" ||
    typeof provider.publish !== "function" ||
    typeof provider.subscribe !== "function" ||
    typeof provider.capabilities !== "function"
  ) {
    throw new TypeError("Runtime relay registration requires a valid relay provider.");
  }
}
