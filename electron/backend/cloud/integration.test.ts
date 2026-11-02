import { it, expect } from "vitest";

import { startFixture } from "../../../../marshal-cloud-workers/scripts/mobile-fixture";
import type { RuntimeSessionEvent } from "../../../common/runtime-events";
import { createCloudClientFactory } from "./client";
it("uses normal chat events and permissions while detach preserves cloud work and reattach restores offline replies", async () => {
  const fixture = await startFixture();
  const factory = createCloudClientFactory({ serviceUrl: fixture.url, token: "a".repeat(40) });
  const client = await factory("");
  const received: RuntimeSessionEvent[] = [];
  try {
    const s = await client.resumeSession(fixture.id, {
      onPermissionRequest: async () => ({ kind: "approve-once" }),
    });
    s.on((e) => received.push(e));
    await expect
      .poll(() => fixture.control.get("owner", fixture.id).status, { timeout: 6000 })
      .toBe("idle");
    await expect
      .poll(() => received.some((e) => e.type === "session.idle"), { timeout: 6000 })
      .toBe(true);
    expect(received.some((e) => e.type === "session.history_snapshot")).toBe(true);
    await client.stop();
    expect(fixture.control.get("owner", fixture.id).status).toBe("idle");
    await fixture.control.send("owner", fixture.id, {
      requestId: "phone",
      prompt: "Continue while desktop is offline",
    });
    await expect
      .poll(() => fixture.control.get("owner", fixture.id).approvals.some((a) => !a.decision), {
        timeout: 6000,
      })
      .toBe(true);
    const a = fixture.control.get("owner", fixture.id).approvals.find((a) => !a.decision)!;
    await fixture.control.decide("owner", fixture.id, a.id, {
      requestId: "phone-approval",
      decision: "allow",
    });
    await expect
      .poll(() => fixture.control.get("owner", fixture.id).status, { timeout: 6000 })
      .toBe("idle");
    const observer = await factory("");
    const reattached = await observer.resumeSession(fixture.id, {});
    const replay: RuntimeSessionEvent[] = [];
    reattached.on((e) => replay.push(e));
    try {
      await expect
        .poll(() => replay.find((e) => e.type === "session.history_snapshot")?.data, {
          timeout: 6000,
        })
        .toMatchObject({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: "Cloud task completed: Continue while desktop is offline",
            }),
          ]),
        });
    } finally {
      await observer.stop();
    }
  } finally {
    await client.stop();
    await fixture.close();
  }
}, 20000);
