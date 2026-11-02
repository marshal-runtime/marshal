import { describe, expect, it } from "vitest";

import {
  defaultRuntimeAccountId,
  hasRuntimeAccount,
  listRuntimeAccounts,
  normalizeRuntimeAccounts,
  parseRuntimeTargetKey,
  runtimeAccountIdFromLabel,
  runtimeAccountLabel,
  runtimeTargetKey,
} from "./runtime-accounts";

describe("runtime target keys", () => {
  it("omits the original account", () => {
    expect(runtimeTargetKey({ runtimeId: "claude" })).toBe("claude");
    expect(runtimeTargetKey({ runtimeId: "claude", accountId: "default" })).toBe("claude");
    expect(runtimeTargetKey({ runtimeId: "claude", accountId: "work" })).toBe("claude@work");
  });

  it("parses keys and keeps an explicit original account", () => {
    expect(parseRuntimeTargetKey("codex")).toEqual({ runtimeId: "codex" });
    expect(parseRuntimeTargetKey("codex@team-2")).toEqual({
      runtimeId: "codex",
      accountId: "team-2",
    });
    expect(parseRuntimeTargetKey("codex@default")).toEqual({
      runtimeId: "codex",
      accountId: "default",
    });
  });

  it.each(["", "codex@", "@team", "codex@Team", "codex@-team", `codex@${"a".repeat(33)}`])(
    "rejects %j",
    (key) => {
      expect(parseRuntimeTargetKey(key)).toBeNull();
    },
  );
});

describe("normalizeRuntimeAccounts", () => {
  it("drops unknown runtimes, malformed and duplicate accounts, and dangling defaults", () => {
    expect(
      normalizeRuntimeAccounts({
        claude: {
          accounts: [
            { id: "work", label: "  Work  " },
            { id: "work", label: "Duplicate" },
            { id: "Bad Id" },
            "home",
          ],
          defaultAccountId: "work",
        },
        codex: { accounts: [], defaultAccountId: "missing" },
        copilot: { accounts: [{ id: "x" }] },
      }),
    ).toEqual({ claude: { accounts: [{ id: "work", label: "Work" }], defaultAccountId: "work" } });
  });

  it("stores the original account as the absence of a default", () => {
    expect(
      normalizeRuntimeAccounts({
        cursor: { accounts: [{ id: "a" }], defaultAccountId: "default" },
      }),
    ).toEqual({ cursor: { accounts: [{ id: "a" }] } });
  });

  it("returns undefined when nothing survives", () => {
    expect(normalizeRuntimeAccounts({})).toBeUndefined();
    expect(normalizeRuntimeAccounts([])).toBeUndefined();
    expect(normalizeRuntimeAccounts("claude")).toBeUndefined();
  });
});

describe("account lookups", () => {
  const settings = {
    claude: {
      accounts: [{ id: "work" }, { id: "default", label: "Personal" }],
      defaultAccountId: "work",
    },
  };

  it("lists the original account first, with any relabel", () => {
    expect(listRuntimeAccounts(settings, "claude")).toEqual([
      { id: "default", label: "Personal" },
      { id: "work" },
    ]);
    expect(listRuntimeAccounts(undefined, "codex")).toEqual([{ id: "default" }]);
  });

  it("answers membership and defaults", () => {
    expect(hasRuntimeAccount(settings, { runtimeId: "claude", accountId: "work" })).toBe(true);
    expect(hasRuntimeAccount(settings, { runtimeId: "claude", accountId: "home" })).toBe(false);
    expect(hasRuntimeAccount(undefined, { runtimeId: "codex" })).toBe(true);
    expect(defaultRuntimeAccountId(settings, "claude")).toBe("work");
    expect(defaultRuntimeAccountId(settings, "codex")).toBeUndefined();
  });

  it("labels accounts", () => {
    expect(runtimeAccountLabel({ id: "default" })).toBe("Primary");
    expect(runtimeAccountLabel({ id: "work" })).toBe("work");
    expect(runtimeAccountLabel({ id: "work", label: "Work" })).toBe("Work");
  });
});

describe("runtimeAccountIdFromLabel", () => {
  it("slugifies labels and avoids taken and reserved ids", () => {
    expect(runtimeAccountIdFromLabel("Work Account!", new Set())).toBe("work-account");
    expect(runtimeAccountIdFromLabel("Work", new Set(["work"]))).toBe("work-2");
    expect(runtimeAccountIdFromLabel("Default", new Set())).toBe("default-2");
    expect(runtimeAccountIdFromLabel("日本", new Set())).toBe("account");
  });
});
