import { describe, expect, it } from "vitest";

import {
  getRelayProviderIdentity,
  isRelayProviderConnectionRequested,
  resolveRelayProviderIdentity,
} from "./relay-provider-settings";

describe("relay provider settings identity mapping", () => {
  it("keeps persisted provider keys distinct from runtime provider IDs", () => {
    expect(getRelayProviderIdentity("whatsapp")).toEqual({
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
    });
  });

  it("accepts canonical runtime IDs without renaming the persisted key", () => {
    expect(resolveRelayProviderIdentity("whatsapp-baileys")).toEqual({
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
    });
    expect(resolveRelayProviderIdentity({ runtimeProviderId: "whatsapp-baileys" })).toEqual({
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
    });
  });

  it("rejects references that name no supported provider", () => {
    expect(() =>
      resolveRelayProviderIdentity({
        providerKey: "unsupported-chat",
        runtimeProviderId: "unsupported-chat",
      }),
    ).toThrow("supported relay provider key");
  });

  it("requires both provider enablement and connect intent", () => {
    expect(
      isRelayProviderConnectionRequested(
        {
          relay: {
            providers: {
              whatsapp: { enabled: true, connectionIntent: "connect" },
            },
            defaultNotificationDestinations: [],
            progressDestinations: [],
            progressIntervalMinutes: 15,
          },
        },
        "whatsapp",
      ),
    ).toBe(true);
    expect(
      isRelayProviderConnectionRequested(
        {
          relay: {
            providers: {
              whatsapp: { enabled: false, connectionIntent: "connect" },
            },
            defaultNotificationDestinations: [],
            progressDestinations: [],
            progressIntervalMinutes: 15,
          },
        },
        "whatsapp",
      ),
    ).toBe(false);
  });
});
