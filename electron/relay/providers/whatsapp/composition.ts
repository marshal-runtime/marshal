import { parseRelayAccountId } from "../../../../common/relay-contract";
import type { RelayAccountId } from "../../../../common/relay-contract";
import type { RelayProviderCapabilities } from "../../../../common/relay-contract";
import type { RelayTimestamp } from "../../../../common/relay-experience-contract";
import type {
  RelayCommunityProvisioningPort,
  RelayConnectionControlPort,
  RelayManagedGroupAdministrationPort,
  RelayPairingControlPort,
  RelaySetupStatusPort,
} from "../../experience-ports";
import type { RelayInteractionAdministration } from "../../contracts";
import {
  WhatsAppRelayProvider,
  type WhatsAppInboundAuthorizationPort,
  type WhatsAppMediaPipelinePort,
  type WhatsAppProtocolPort,
} from "./provider";

export interface WhatsAppConnectionLanePort
  extends
    RelaySetupStatusPort,
    RelayPairingControlPort,
    RelayConnectionControlPort,
    WhatsAppProtocolPort {}

export interface WhatsAppGroupLanePort
  extends RelayCommunityProvisioningPort, RelayManagedGroupAdministrationPort {}

export type WhatsAppAuthorizationLanePort = WhatsAppInboundAuthorizationPort;

export type WhatsAppMediaLanePort = WhatsAppMediaPipelinePort;

export interface WhatsAppProviderCompositionDependencies {
  readonly accountId: RelayAccountId;
  readonly capabilities?: RelayProviderCapabilities;
  readonly connection: WhatsAppConnectionLanePort;
  readonly interactions?: RelayInteractionAdministration;
  readonly groups: WhatsAppGroupLanePort;
  readonly authorization: WhatsAppAuthorizationLanePort;
  readonly media: WhatsAppMediaLanePort;
  readonly now?: () => RelayTimestamp;
  readonly createOperationId?: () => string;
}

export interface WhatsAppProviderComposition {
  readonly accountId: RelayAccountId;
  readonly provider: WhatsAppRelayProvider;
  readonly setupStatus: RelaySetupStatusPort;
  readonly pairingControl: RelayPairingControlPort;
  readonly connectionControl: RelayConnectionControlPort;
  readonly communityProvisioning: RelayCommunityProvisioningPort;
  readonly managedGroupAdministration: RelayManagedGroupAdministrationPort;
  dispose(): void;
}

export function createWhatsAppProviderComposition(
  dependencies: WhatsAppProviderCompositionDependencies,
): WhatsAppProviderComposition {
  const accountId = parseRelayAccountId(dependencies.accountId);
  const provider = new WhatsAppRelayProvider({
    accountId,
    ...(dependencies.capabilities === undefined
      ? {}
      : { capabilities: dependencies.capabilities }),
    setupStatus: dependencies.connection,
    connectionControl: dependencies.connection,
    communityProvisioning: dependencies.groups,
    groupAdministration: dependencies.groups,
    inboundAuthorization: dependencies.authorization,
    media: dependencies.media,
    protocol: dependencies.connection,
    ...(dependencies.interactions === undefined
      ? {}
      : { interactions: dependencies.interactions }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.createOperationId === undefined
      ? {}
      : { createOperationId: dependencies.createOperationId }),
  });

  return {
    accountId,
    provider,
    setupStatus: dependencies.connection,
    pairingControl: dependencies.connection,
    connectionControl: dependencies.connection,
    communityProvisioning: dependencies.groups,
    managedGroupAdministration: dependencies.groups,
    dispose: () => provider.dispose(),
  };
}
