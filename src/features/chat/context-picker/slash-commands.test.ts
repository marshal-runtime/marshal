import { describe, expect, it } from "vitest";

import {
  filterCommandsByQuery,
  mergeSlashCommands,
  parseSlashInvocation,
  slashCommandFromPlacement,
  SLASH_COMMANDS,
  SLASH_FRESH_FLAG,
} from "./slash-commands";

const GOAL_COMMAND = SLASH_COMMANDS[0];
const SWARM_COMMAND = {
  name: "swarm",
  description: "Start a recursive swarm from this session",
  extensionId: "@marshal/swarm",
  applicationId: "swarm",
};

describe("parseSlashInvocation", () => {
  describe("Sanity", () => {
    it("parses a command name and remaining argument", () => {
      expect(parseSlashInvocation("/swarm build the checkout")).toEqual({
        name: "swarm",
        argument: "build the checkout",
        fresh: false,
      });
    });

    it("treats --fresh immediately after the command as a host flag", () => {
      expect(parseSlashInvocation(`/swarm ${SLASH_FRESH_FLAG} start over`)).toEqual({
        name: "swarm",
        argument: "start over",
        fresh: true,
      });
    });
  });

  describe("Error Handling", () => {
    it("returns null when the text is not a slash command", () => {
      expect(parseSlashInvocation("swarm build")).toBeNull();
      expect(parseSlashInvocation("")).toBeNull();
    });
  });

  describe("Edge Cases", () => {
    it("accepts a command with no argument", () => {
      expect(parseSlashInvocation("/swarm")).toEqual({
        name: "swarm",
        argument: "",
        fresh: false,
      });
    });

    it("accepts a bare --fresh flag", () => {
      expect(parseSlashInvocation(`/swarm ${SLASH_FRESH_FLAG}`)).toEqual({
        name: "swarm",
        argument: "",
        fresh: true,
      });
    });

    it("does not treat --fresh in the middle of the argument as the host flag", () => {
      expect(parseSlashInvocation("/swarm keep --fresh in the plan")).toEqual({
        name: "swarm",
        argument: "keep --fresh in the plan",
        fresh: false,
      });
    });
  });
});

describe("filterCommandsByQuery", () => {
  describe("Sanity", () => {
    it("matches built-in commands by substring", () => {
      expect(filterCommandsByQuery("goa")).toEqual([GOAL_COMMAND]);
    });
  });

  describe("Error Handling", () => {
    it("returns no commands when the query matches nothing", () => {
      expect(filterCommandsByQuery("zzz")).toEqual([]);
    });
  });

  describe("Edge Cases", () => {
    it("filters an injected command list instead of only built-ins", () => {
      expect(filterCommandsByQuery("swa", [GOAL_COMMAND, SWARM_COMMAND])).toEqual([SWARM_COMMAND]);
    });
  });
});

describe("slashCommandFromPlacement", () => {
  describe("Sanity", () => {
    it("uses the application id as the command name", () => {
      expect(
        slashCommandFromPlacement({
          extensionId: "@marshal/swarm",
          applicationId: "swarm",
          title: "Swarm",
          description: "Start a recursive swarm",
        }),
      ).toEqual({
        name: "swarm",
        description: "Start a recursive swarm",
        extensionId: "@marshal/swarm",
        applicationId: "swarm",
      });
    });
  });

  describe("Error Handling", () => {
    it("falls back to the title when description is empty", () => {
      expect(
        slashCommandFromPlacement({
          extensionId: "@acme/hello",
          applicationId: "hello",
          title: "Hello",
          description: "",
        }).description,
      ).toBe("Hello");
    });
  });

  describe("Edge Cases", () => {
    it("keeps a blank description as the title rather than inventing copy", () => {
      expect(
        slashCommandFromPlacement({
          extensionId: "@acme/hello",
          applicationId: "hello",
          title: "",
          description: "",
        }).description,
      ).toBe("");
    });
  });
});

describe("mergeSlashCommands", () => {
  describe("Sanity", () => {
    it("appends injected commands after built-in commands", () => {
      expect(mergeSlashCommands([GOAL_COMMAND], [SWARM_COMMAND])).toEqual([
        GOAL_COMMAND,
        SWARM_COMMAND,
      ]);
    });
  });

  describe("Error Handling", () => {
    it("drops injected commands that collide with a built-in name", () => {
      expect(
        mergeSlashCommands([GOAL_COMMAND], [{ ...GOAL_COMMAND, description: "other" }]),
      ).toEqual([GOAL_COMMAND]);
    });
  });

  describe("Edge Cases", () => {
    it("keeps the first injected command when two share a name", () => {
      const duplicate = { ...SWARM_COMMAND, description: "later" };
      expect(mergeSlashCommands([GOAL_COMMAND], [SWARM_COMMAND, duplicate])).toEqual([
        GOAL_COMMAND,
        SWARM_COMMAND,
      ]);
    });
  });
});
