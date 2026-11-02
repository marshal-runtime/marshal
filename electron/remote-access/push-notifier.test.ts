import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemotePushNotifier } from "./push-notifier";
import { sendWebPush } from "./web-push";

vi.mock("./web-push", () => ({
  generateVapidKeys: () => ({
    publicKey: "public-key",
    privateJwk: { kty: "EC", crv: "P-256", d: "d", x: "x", y: "y" },
  }),
  isAllowedPushEndpoint: () => true,
  sendWebPush: vi.fn<(...args: unknown[]) => Promise<string>>(() => Promise.resolve("sent")),
}));

const ENABLED_ENDPOINT = "https://web.push.apple.com/enabled";
const DISABLED_ENDPOINT = "https://web.push.apple.com/disabled";
const KEYS = { p256dh: "p256dh", auth: "auth" };
const PREFS = { enabled: true, finished: false, needsApproval: false, agentThreads: false };
const DELIVERY_ID = "delivery-1";
const TITLE = "Deploy failed";
const LONG_MESSAGE = `brand 372\n${"x".repeat(1000)}`;

describe("RemotePushNotifier.notify", () => {
  let dir: string;
  let notifier: RemotePushNotifier;

  beforeEach(() => {
    vi.mocked(sendWebPush).mockClear();
    dir = mkdtempSync(path.join(tmpdir(), "push-notifier-"));
    const filePath = path.join(dir, "remote-push.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        vapid: {
          publicKey: "public-key",
          privateJwk: { kty: "EC", crv: "P-256", d: "d", x: "x", y: "y" },
        },
        subscriptions: [
          { endpoint: ENABLED_ENDPOINT, keys: KEYS, prefs: PREFS },
          { endpoint: DISABLED_ENDPOINT, keys: KEYS, prefs: { ...PREFS, enabled: false } },
        ],
      }),
    );
    notifier = new RemotePushNotifier({
      filePath,
      subject: () => "mailto:test@example.com",
      getSession: () => Promise.resolve(null),
      isViewingOnPhone: () => false,
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("pushes the notification to enabled phones only, even with thread pushes off", () => {
    notifier.notify({ deliveryId: DELIVERY_ID, title: TITLE, message: "brand 372 gate error" });

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWebPush).mock.calls[0][0].endpoint).toBe(ENABLED_ENDPOINT);
    expect(vi.mocked(sendWebPush).mock.calls[0][1]).toEqual({
      title: TITLE,
      body: "brand 372 gate error",
      sessionId: undefined,
      tag: `notification:${DELIVERY_ID}`,
    });
  });

  it("flattens whitespace and caps the body for the lock screen", () => {
    notifier.notify({
      deliveryId: DELIVERY_ID,
      title: TITLE,
      message: LONG_MESSAGE,
      sessionId: "s1",
    });

    expect(vi.mocked(sendWebPush).mock.calls[0][1]).toEqual({
      title: TITLE,
      body: `brand 372 ${"x".repeat(590)}`,
      sessionId: "s1",
      tag: `notification:${DELIVERY_ID}`,
    });
  });
});
