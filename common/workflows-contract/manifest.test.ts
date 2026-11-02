import { describe, expect, it } from "vitest";

import { WorkflowManifestSchema } from "./manifest";

const BASE_MANIFEST = {
  id: "legacy-workflow",
  version: "1.0.0",
  title: "Legacy workflow",
  permissions: { mode: "ask" },
};

describe("WorkflowManifestSchema Teams removal", () => {
  it("loads a manifest that still asks for Teams completion notifications as none", () => {
    const manifest = WorkflowManifestSchema.parse({ ...BASE_MANIFEST, notifyOnComplete: "teams" });
    expect(manifest.notifyOnComplete).toBe("none");
  });

  it("drops Teams notification destinations from the visible destination list", () => {
    const manifest = WorkflowManifestSchema.parse({
      ...BASE_MANIFEST,
      extensions: {
        notificationRouting: { visibleDestinations: ["teams-chat", "teams-channel", "email"] },
      },
    });
    expect(manifest.extensions?.notificationRouting?.visibleDestinations).toEqual(["email"]);
  });
});
