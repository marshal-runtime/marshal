import { DEFAULT_SETTINGS } from "@common/marshal-default-settings";
import { describe, expect, it } from "vitest";

import {
  setRelayProgressIntervalMinutes,
  setRelayProviderDestination,
  setRelayProviderEnabled,
} from "./relayProviderSettingsModel";

describe("relay provider settings model", () => {
  it("enables WhatsApp", () => {
    const updated = setRelayProviderEnabled(DEFAULT_SETTINGS, "whatsapp", true);

    expect(updated.relay?.providers.whatsapp?.enabled).toBe(true);
  });

  it("updates notification destinations", () => {
    const withDefaultNotifications = setRelayProviderDestination(
      DEFAULT_SETTINGS,
      "whatsapp",
      "defaultNotificationDestinations",
      true,
    );
    const withoutProgress = setRelayProviderDestination(
      withDefaultNotifications,
      "whatsapp",
      "progressDestinations",
      false,
    );

    expect(withDefaultNotifications.relay?.defaultNotificationDestinations).toContain("whatsapp");
    expect(withoutProgress.relay?.progressDestinations).not.toContain("whatsapp");
  });

  it("turns connection intent off when a provider is disabled", () => {
    const connected = {
      ...DEFAULT_SETTINGS,
      relay: {
        ...DEFAULT_SETTINGS.relay!,
        providers: {
          ...DEFAULT_SETTINGS.relay!.providers,
          whatsapp: {
            enabled: true,
            connectionIntent: "connect" as const,
          },
        },
      },
    };

    const updated = setRelayProviderEnabled(connected, "whatsapp", false);

    expect(updated.relay?.providers.whatsapp).toMatchObject({
      enabled: false,
      connectionIntent: "disconnect",
    });
  });

  it("bounds the relay progress interval", () => {
    expect(
      setRelayProgressIntervalMinutes(DEFAULT_SETTINGS, 0).relay?.progressIntervalMinutes,
    ).toBe(1);
    expect(
      setRelayProgressIntervalMinutes(DEFAULT_SETTINGS, 10_000).relay?.progressIntervalMinutes,
    ).toBe(24 * 60);
  });
});
