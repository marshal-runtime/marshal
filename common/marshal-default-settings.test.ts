import { describe, expect, it } from "vitest";

import {
  DEFAULT_PERMISSIONS,
  DEFAULT_SETTINGS,
  DEFAULT_SWARM_WORKER_MODEL,
  DEFAULT_SWARM_WORKER_REASONING_EFFORT,
} from "./marshal-default-settings";
import {
  DEFAULT_WORK_SERVICE_PROVIDER_IDS,
  WHATSAPP_RELAY_PROVIDER_ID,
} from "./provider-config";

describe("DEFAULT_PERMISSIONS", () => {
  it("keeps Browser Control enabled but not auto-approved by default", () => {
    expect(DEFAULT_PERMISSIONS.servers.playwright).toEqual({
      enabled: true,
      autoApprove: false,
    });
  });

  it("does not auto-approve SDK web fetch by default", () => {
    expect(DEFAULT_PERMISSIONS.tools["tool:web_fetch"]).toBeUndefined();
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("selects each built-in work-service provider independently", () => {
    expect(DEFAULT_SETTINGS).toEqual(expect.objectContaining(DEFAULT_WORK_SERVICE_PROVIDER_IDS));
  });

  it("keeps WhatsApp enabled but disconnected in the default relay model", () => {
    expect(DEFAULT_SETTINGS.relay).toEqual({
      providers: {
        [WHATSAPP_RELAY_PROVIDER_ID]: {
          enabled: true,
          connectionIntent: "disconnect",
        },
      },
      defaultNotificationDestinations: [],
      progressDestinations: [WHATSAPP_RELAY_PROVIDER_ID],
      progressIntervalMinutes: 15,
    });
  });

  it("uses Luna at medium reasoning for swarm workers", () => {
    expect(DEFAULT_SETTINGS.swarmWorkerModel).toBe(DEFAULT_SWARM_WORKER_MODEL);
    expect(DEFAULT_SETTINGS.swarmWorkerReasoningEffort).toBe(
      DEFAULT_SWARM_WORKER_REASONING_EFFORT,
    );
    expect(DEFAULT_SWARM_WORKER_MODEL).toBe("gpt-5.6-luna");
    expect(DEFAULT_SWARM_WORKER_REASONING_EFFORT).toBe("medium");
  });
});
