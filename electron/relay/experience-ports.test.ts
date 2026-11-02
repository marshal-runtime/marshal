import { describe, expectTypeOf, it } from "vitest";

import type {
  RelayExperienceResult,
  RelayPublicationEnqueueReceipt,
  RelayPublicationErrorCode,
  RelayPublicationIntent,
  RelaySessionErrorCode,
  RelaySessionSteerReceipt,
  RelaySessionSteerRequest,
  RelaySetupErrorCode,
  RelaySetupSnapshot,
  RelayTimestamp,
} from "../../common/relay-experience-contract";
import type {
  RelayAttachmentIngestionPort,
  RelayClock,
  RelayCommunityProvisioningPort,
  RelayConnectionControlPort,
  RelayFixedAgentCatalogPort,
  RelayGroupActivityPort,
  RelayGroupSessionBindingReader,
  RelayGroupSessionBindingWriter,
  RelayInboundAuthorizationPort,
  RelayManagedGroupAdministrationPort,
  RelayManagedGroupQueryPort,
  RelayPairingControlPort,
  RelayPublicationCommandPort,
  RelayPublicationCorrelationReader,
  RelaySessionCreationPort,
  RelaySessionQueryPort,
  RelaySessionSteeringPort,
  RelaySetupStatusPort,
  RelayVoiceTranscriptionPort,
} from "./experience-ports";

describe("relay experience ports", () => {
  it("keeps ownership split across narrow interfaces", () => {
    expectTypeOf<keyof RelayClock>().toEqualTypeOf<"now">();
    expectTypeOf<keyof RelaySetupStatusPort>().toEqualTypeOf<"getStatus" | "subscribe">();
    expectTypeOf<keyof RelayPairingControlPort>().toEqualTypeOf<"beginPairing" | "cancelPairing">();
    expectTypeOf<keyof RelayConnectionControlPort>().toEqualTypeOf<"connect" | "disconnect">();
    expectTypeOf<keyof RelayCommunityProvisioningPort>().toEqualTypeOf<"provision">();
    expectTypeOf<keyof RelayManagedGroupQueryPort>().toEqualTypeOf<"getTopology" | "getGroup">();
    expectTypeOf<keyof RelayManagedGroupAdministrationPort>().toEqualTypeOf<
      "createGroup" | "renameGroup" | "retireGroup"
    >();
    expectTypeOf<keyof RelayGroupSessionBindingReader>().toEqualTypeOf<
      "getByGroup" | "listBySession"
    >();
    expectTypeOf<keyof RelayGroupSessionBindingWriter>().toEqualTypeOf<"upsert" | "remove">();
    expectTypeOf<keyof RelayGroupActivityPort>().toEqualTypeOf<"get" | "record">();
    expectTypeOf<keyof RelayFixedAgentCatalogPort>().toEqualTypeOf<"list" | "get">();
    expectTypeOf<keyof RelaySessionCreationPort>().toEqualTypeOf<"create">();
    expectTypeOf<keyof RelaySessionQueryPort>().toEqualTypeOf<"query">();
    expectTypeOf<keyof RelaySessionSteeringPort>().toEqualTypeOf<"steer">();
    expectTypeOf<keyof RelayPublicationCommandPort>().toEqualTypeOf<"enqueue">();
    expectTypeOf<keyof RelayPublicationCorrelationReader>().toEqualTypeOf<"get">();
    expectTypeOf<keyof RelayInboundAuthorizationPort>().toEqualTypeOf<"authorize">();
    expectTypeOf<keyof RelayAttachmentIngestionPort>().toEqualTypeOf<"ingest">();
    expectTypeOf<keyof RelayVoiceTranscriptionPort>().toEqualTypeOf<"transcribe">();
  });

  it("uses typed serializable results at integration boundaries", () => {
    expectTypeOf<RelayClock["now"]>().returns.toEqualTypeOf<RelayTimestamp>();
    expectTypeOf<RelaySetupStatusPort["getStatus"]>().returns.toEqualTypeOf<
      Promise<RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>>
    >();
    expectTypeOf<RelaySessionSteeringPort["steer"]>()
      .parameter(0)
      .toEqualTypeOf<RelaySessionSteerRequest>();
    expectTypeOf<RelaySessionSteeringPort["steer"]>().returns.toEqualTypeOf<
      Promise<RelayExperienceResult<RelaySessionSteerReceipt, RelaySessionErrorCode>>
    >();
    expectTypeOf<RelayPublicationCommandPort["enqueue"]>()
      .parameter(0)
      .toEqualTypeOf<RelayPublicationIntent>();
    expectTypeOf<RelayPublicationCommandPort["enqueue"]>().returns.toEqualTypeOf<
      Promise<RelayExperienceResult<RelayPublicationEnqueueReceipt, RelayPublicationErrorCode>>
    >();
  });
});
