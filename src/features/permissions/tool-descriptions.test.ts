import { describe, expect, it } from "vitest";

import { getToolCopy, getToolDescription, getToolLabel } from "./tool-descriptions";

describe("tool-descriptions", () => {
  describe("BLOCKED_LABEL_KEYS guard", () => {
    it("returns undefined for labels owned by upstream PRs", () => {
      expect(getToolLabel("shell")).toBeUndefined();
      expect(getToolLabel("serverAutoApprove")).toBeUndefined();
      expect(getToolLabel("shellAutoApprove")).toBeUndefined();
    });

    it("still returns a description for shell, serverAutoApprove, and shellAutoApprove (blocked-label keys that have spec entries)", () => {
      // All three keys have spec entries — labels are suppressed (owned
      // upstream), descriptions still flow through to render.
      expect(getToolDescription("shell")).toBeTruthy();
      expect(getToolDescription("serverAutoApprove")).toBeTruthy();
      expect(getToolDescription("shellAutoApprove")).toBeTruthy();
    });

    it("returns the spec label for non-blocked keys", () => {
      expect(getToolLabel("playwright")).toBe("Browser Control");
      expect(getToolLabel("filesystem")).toBe("File System Access");
    });
  });

  describe("getToolCopy key resolution", () => {
    it("resolves a direct hit", () => {
      expect(getToolCopy("playwright")?.label).toBe("Browser Control");
    });

    it("strips the canonical tool: prefix", () => {
      const copy = getToolCopy("tool:remember");
      expect(copy?.label).toBe("Save something to memory");
    });

    it("strips mcp: prefix to the nested key tail", () => {
      expect(getToolCopy("mcp:playwright:browser_navigate")?.label).toBe("Open a website");
    });

    it("returns undefined for an unknown key (caller falls back to registry name)", () => {
      expect(getToolCopy("xyzzy_no_such_tool")).toBeUndefined();
      expect(getToolLabel("xyzzy_no_such_tool")).toBeUndefined();
      expect(getToolDescription("xyzzy_no_such_tool")).toBeUndefined();
    });
  });

  describe("v2 spec content pins", () => {
    it("pins the autoApproveReadOnly description literal (changed by v2)", () => {
      // Hard-coded literal — reverting the file back to v1 copy fails this
      // test. Pinning at least one v2 description string ensures the suite
      // catches a copy-regression even when render-path tests draw the
      // expected text from the same module they're testing.
      expect(getToolDescription("autoApproveReadOnly")).toBe(
        "Enables Marshal to skip the approval prompt for read-only actions like reading emails or searching files.",
      );
    });

    it("pins the interceptFileChooser description (sub-row, no ?? fallback)", () => {
      // PermissionsEditor dropped its `?? "Agent can upload files..."` fallback,
      // so the rendered text comes entirely from this entry. Pin it.
      expect(getToolDescription("interceptFileChooser")).toBe(
        "Attaches files from your computer to upload fields in the browser on your behalf, without asking you each time.",
      );
    });

    it("pins the requestPermissionEscalation entry (new on main, added by v2)", () => {
      // This is the only new key introduced by v2. A copy error here would
      // otherwise be silent — every other key was already exercised by
      // existing render paths.
      const copy = getToolCopy("requestPermissionEscalation");
      expect(copy?.label).toBe("Request a permission change");
      expect(copy?.description).toBe(
        "Asks for your approval to change a sensitive permission setting, via a consent card in the chat.",
      );
    });

    it("pins serverAutoApprove + shellAutoApprove descriptions (restored after review — diverges from v2 spec)", () => {
      // v2 dropped both entries, but PermissionsEditor.tsx and
      // ToolGroupSection.tsx read them to render the "Auto-approve without
      // asking" sub-row description. PermissionsEditor.tsx picks
      // shellAutoApprove for the Shell row and serverAutoApprove for every
      // other SDK server; ToolGroupSection.tsx always uses serverAutoApprove
      // for MCP servers. Restored on review. Labels are
      // suppressed via BLOCKED_LABEL_KEYS — only the descriptions render.
      expect(getToolDescription("serverAutoApprove")).toBe(
        "Runs every tool from this server without stopping to ask for your approval at each step.",
      );
      expect(getToolDescription("shellAutoApprove")).toBe(
        "Runs shell commands without stopping to ask for your approval at each step.",
      );
    });

    it("pins the provider-neutral notifications group description", () => {
      expect(getToolDescription("tool:notifications")).toBe(
        "Connect, disconnect, and send proactive notifications through the configured provider.",
      );
    });

    it("pins playwright group description (v2 rewrite; same regression class as autoApproveReadOnly)", () => {
      // playwright.description is the only group-header copy under
      // Browser Control. Render-path tests draw the expected text from the
      // same module they're testing (so a v1 reversion masks itself);
      // pin the literal here to break that symmetry.
      expect(getToolDescription("playwright")).toBe(
        "Enables Marshal to open and use a web browser on your behalf, including opening websites, clicking buttons, typing into forms, downloading files, and taking screenshots.",
      );
    });
  });
});
