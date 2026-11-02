import { describe, expect, it } from "vitest";

import type { TelemetryEvent } from "./opensource";
import { TagGdprEvents } from "./TagGdprEvents";

/** Creates a minimal TelemetryEvent for testing without requiring a real SDK instance. */
function makeEvent(
  eventType: string,
  fields: Record<string, unknown> = {},
  tags: Record<string, unknown> = {},
): TelemetryEvent {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: middleware only reads eventType/fields/tags
  return { eventType, fields, tags } as unknown as TelemetryEvent;
}

/** Returns the tags of an event as a plain object for easy assertion in tests. */
function getTags(event: TelemetryEvent): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: tags is a plain Record in all makeEvent fixtures
  return event.tags as Record<string, unknown>;
}

describe("TagGdprEvents", () => {
  describe("SessionStart", () => {
    it("marks SessionStart as GDPR exportable", () => {
      const event = makeEvent("Marshal.SessionStart");
      const result = TagGdprEvents(event);
      expect(getTags(result).isGdprExportable).toBe(true);
    });

    it("sets gdprExportActionName to OpenedMarshal for SessionStart", () => {
      const event = makeEvent("Marshal.SessionStart");
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportActionName).toBe("OpenedMarshal");
    });

    it("sets gdprExportTargetName to undefined for SessionStart", () => {
      const event = makeEvent("Marshal.SessionStart");
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportTargetName).toBeUndefined();
    });

    it("preserves existing tags when tagging SessionStart", () => {
      const event = makeEvent("Marshal.SessionStart", {}, { existingTag: "value" });
      const result = TagGdprEvents(event);
      expect(getTags(result).existingTag).toBe("value");
      expect(getTags(result).isGdprExportable).toBe(true);
    });
  });

  describe("SessionEnd", () => {
    it("marks SessionEnd as GDPR exportable", () => {
      const event = makeEvent("Marshal.SessionEnd");
      const result = TagGdprEvents(event);
      expect(getTags(result).isGdprExportable).toBe(true);
    });

    it("sets gdprExportActionName to ClosedMarshal for SessionEnd", () => {
      const event = makeEvent("Marshal.SessionEnd");
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportActionName).toBe("ClosedMarshal");
    });

    it("sets gdprExportTargetName to undefined for SessionEnd", () => {
      const event = makeEvent("Marshal.SessionEnd");
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportTargetName).toBeUndefined();
    });

    it("preserves existing tags when tagging SessionEnd", () => {
      const event = makeEvent("Marshal.SessionEnd", {}, { existingTag: "value" });
      const result = TagGdprEvents(event);
      expect(getTags(result).existingTag).toBe("value");
      expect(getTags(result).isGdprExportable).toBe(true);
    });
  });

  describe("UserAction", () => {
    it("marks UserAction as GDPR exportable", () => {
      const event = makeEvent("Marshal.UserAction", { action: "SendMessage" });
      const result = TagGdprEvents(event);
      expect(getTags(result).isGdprExportable).toBe(true);
    });

    it("sets gdprExportActionName from the action field for UserAction", () => {
      const event = makeEvent("Marshal.UserAction", { action: "SendMessage" });
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportActionName).toBe("SendMessage");
    });

    it("sets gdprExportTargetName from the moduleName field for UserAction", () => {
      const event = makeEvent("Marshal.UserAction", {
        action: "Click",
        moduleName: "ChatInput",
      });
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportTargetName).toBe("ChatInput");
    });

    it("sets gdprExportTargetName to undefined when moduleName is absent", () => {
      const event = makeEvent("Marshal.UserAction", { action: "Click" });
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportTargetName).toBeUndefined();
    });

    it("converts a numeric action field to string", () => {
      const event = makeEvent("Marshal.UserAction", { action: 42 });
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportActionName).toBe("42");
    });

    it("converts a boolean action field to string", () => {
      const event = makeEvent("Marshal.UserAction", { action: true });
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportActionName).toBe("true");
    });

    it("returns undefined for an array action field", () => {
      const event = makeEvent("Marshal.UserAction", { action: ["a", "b"] });
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportActionName).toBeUndefined();
    });

    it("returns undefined for an undefined action field", () => {
      const event = makeEvent("Marshal.UserAction", {});
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportActionName).toBeUndefined();
    });

    it("converts a numeric moduleName field to string", () => {
      const event = makeEvent("Marshal.UserAction", { action: "Click", moduleName: 99 });
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportTargetName).toBe("99");
    });

    it("returns undefined for an array moduleName field", () => {
      const event = makeEvent("Marshal.UserAction", {
        action: "Click",
        moduleName: ["a", "b"],
      });
      const result = TagGdprEvents(event);
      expect(getTags(result).gdprExportTargetName).toBeUndefined();
    });

    it("preserves existing tags when tagging UserAction", () => {
      const event = makeEvent("Marshal.UserAction", { action: "Click" }, { existingTag: "value" });
      const result = TagGdprEvents(event);
      expect(getTags(result).existingTag).toBe("value");
      expect(getTags(result).isGdprExportable).toBe(true);
    });
  });

  describe("Non-GDPR events", () => {
    it("returns Render events unchanged (same reference)", () => {
      const event = makeEvent("Marshal.Render");
      const result = TagGdprEvents(event);
      expect(result).toBe(event);
    });

    it("does not add GDPR tags to Render events", () => {
      const event = makeEvent("Marshal.Render", {}, { existingTag: "value" });
      const result = TagGdprEvents(event);
      expect(getTags(result).isGdprExportable).toBeUndefined();
      expect(getTags(result).gdprExportActionName).toBeUndefined();
      expect(getTags(result).gdprExportTargetName).toBeUndefined();
    });

    it("returns arbitrary event types unchanged (same reference)", () => {
      const event = makeEvent("Marshal.CustomEvent");
      const result = TagGdprEvents(event);
      expect(result).toBe(event);
    });

    it("preserves existing tags on non-GDPR events without adding GDPR tags", () => {
      const event = makeEvent("Marshal.Render", {}, { existingTag: "value" });
      const result = TagGdprEvents(event);
      expect(getTags(result).existingTag).toBe("value");
    });
  });
});
