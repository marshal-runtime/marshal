import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createLogger, addLogSink, type LogEntry } from "./marshal-logger";

describe("createLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs info to console.log with tag prefix", () => {
    const log = createLogger("Test");
    log.info("hello", 42);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[Test]"), "hello", 42);
  });

  it("logs warn to console.warn with tag prefix", () => {
    const log = createLogger("Test");
    log.warn("degraded");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[Test]"), "degraded");
  });

  it("logs error to console.error with tag prefix", () => {
    const log = createLogger("Test");
    const err = new Error("boom");
    log.error("failed:", err);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[Test]"), "failed:", err);
  });

  it("child() appends sublabel to tag", () => {
    const log = createLogger("Session");
    const child = log.child("request");
    child.info("sending");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[Session:request]"), "sending");
  });

  it("child() chains", () => {
    const log = createLogger("A").child("B").child("C");
    log.info("deep");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[A:B:C]"), "deep");
  });

  it("with() adds context values to output", () => {
    const log = createLogger("Session").with({ sessionId: "ses_123" });
    log.info("created");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[Session]"), "created");
    expect(String(logSpy.mock.calls[0][0])).toContain("[ses_123]");
  });

  it("with() merges context across calls", () => {
    const log = createLogger("Session").with({ sessionId: "ses_123" }).with({ userId: "u_1" });
    log.info("msg");
    const prefix = String(logSpy.mock.calls[0][0]);
    expect(prefix).toContain("[Session]");
    expect(prefix).toContain("[ses_123]");
    expect(prefix).toContain("[u_1]");
  });

  it("child() and with() compose", () => {
    const log = createLogger("Session").child("request").with({ sessionId: "s1" });
    log.info("go");
    const prefix = String(logSpy.mock.calls[0][0]);
    expect(prefix).toContain("[Session:request]");
    expect(prefix).toContain("[s1]");
  });
});

describe("addLogSink", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("custom sink receives structured LogEntry", () => {
    const entries: LogEntry[] = [];
    const remove = addLogSink((entry) => entries.push({ ...entry }));
    try {
      const log = createLogger("Mod");
      log.warn("test", { data: 1 });

      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe("warn");
      expect(entries[0].tag).toBe("Mod");
      expect(entries[0].args).toEqual(["test", { data: 1 }]);
      expect(entries[0].timestamp).toBeGreaterThan(0);
      expect(entries[0].context).toEqual({});
    } finally {
      remove();
    }
  });

  it("custom sink receives context", () => {
    const entries: LogEntry[] = [];
    const remove = addLogSink((entry) => entries.push({ ...entry }));
    try {
      const log = createLogger("Mod").with({ sid: "abc" });
      log.info("x");

      expect(entries[0].context).toEqual({ sid: "abc" });
    } finally {
      remove();
    }
  });

  it("remove() unsubscribes the sink", () => {
    const entries: LogEntry[] = [];
    const remove = addLogSink((entry) => entries.push(entry));

    const log = createLogger("X");
    log.info("before");
    remove();
    log.info("after");

    expect(entries).toHaveLength(1);
    expect(entries[0].args).toEqual(["before"]);
  });

  it("throwing sink does not break other sinks", () => {
    const removeBad = addLogSink(() => {
      throw new Error("boom");
    });
    const entries: LogEntry[] = [];
    const removeGood = addLogSink((entry) => entries.push(entry));
    try {
      const log = createLogger("Y");
      log.info("still works");

      expect(entries).toHaveLength(1);
      expect(entries[0].args).toEqual(["still works"]);
    } finally {
      removeBad();
      removeGood();
    }
  });
});

describe("log.fault", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("emits at error level with telemetry set to the fault code", () => {
    const entries: LogEntry[] = [];
    const remove = addLogSink((entry) => entries.push({ ...entry }));
    try {
      const log = createLogger("Telemetry");
      log.fault({ family: "marshal-auth", code: 3 });

      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe("error");
      expect(entries[0].telemetry).toEqual({ family: "marshal-auth", code: 3 });
    } finally {
      remove();
    }
  });

  it("forwards cause to LogEntry.cause", () => {
    const entries: LogEntry[] = [];
    const remove = addLogSink((entry) => entries.push({ ...entry }));
    try {
      const cause = new Error("upstream boom");
      const log = createLogger("Telemetry");
      log.fault({ family: "marshal-auth", code: 3 }, cause);

      expect(entries[0].cause).toBe(cause);
    } finally {
      remove();
    }
  });

  it("forwards extra args to the entry alongside the telemetry hint", () => {
    const entries: LogEntry[] = [];
    const remove = addLogSink((entry) => entries.push({ ...entry }));
    try {
      const log = createLogger("Telemetry");
      log.fault({ family: "marshal-mcp", code: 1 }, undefined, "Failed to connect", "stdio");

      expect(entries[0].args).toEqual(["Failed to connect", "stdio"]);
      expect(entries[0].telemetry).toEqual({ family: "marshal-mcp", code: 1 });
    } finally {
      remove();
    }
  });

  it("non-fault entries leave telemetry and cause undefined", () => {
    const entries: LogEntry[] = [];
    const remove = addLogSink((entry) => entries.push({ ...entry }));
    try {
      const log = createLogger("Telemetry");
      log.info("info entry");
      log.warn("warn entry");
      log.error("error entry", new Error("plain"));

      expect(entries).toHaveLength(3);
      for (const entry of entries) {
        expect(entry.telemetry).toBeUndefined();
        expect(entry.cause).toBeUndefined();
      }
    } finally {
      remove();
    }
  });

  it("omits cause when caller passes none", () => {
    const entries: LogEntry[] = [];
    const remove = addLogSink((entry) => entries.push({ ...entry }));
    try {
      const log = createLogger("Telemetry");
      log.fault({ family: "marshal-crash", code: 2 });

      expect(entries[0].telemetry).toEqual({ family: "marshal-crash", code: 2 });
      expect(entries[0].cause).toBeUndefined();
    } finally {
      remove();
    }
  });

  it("renders empty-args fault entries through consoleSink without crashing", () => {
    const log = createLogger("Telemetry");
    log.fault({ family: "marshal-ipc", code: 1 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[Telemetry]"));
  });
});

describe("log.event", () => {
  it("emits at info level with event field set", () => {
    const entries: LogEntry[] = [];
    const remove = addLogSink((e) => entries.push(e));
    const log = createLogger("Sessions");
    log.event("LlmTokenUsage", { model: "gpt-4o", inputTokens: 100 });
    remove();

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("info");
    expect(entries[0].event).toEqual({
      scenario: "LlmTokenUsage",
      fields: { model: "gpt-4o", inputTokens: 100 },
    });
  });

  it("does not set event on non-event entries", () => {
    const entries: LogEntry[] = [];
    const remove = addLogSink((e) => entries.push(e));
    const log = createLogger("Test");
    log.info("regular message");
    remove();

    expect(entries[0].event).toBeUndefined();
  });

  it("does not set telemetry or cause fields", () => {
    const entries: LogEntry[] = [];
    const remove = addLogSink((e) => entries.push(e));
    const log = createLogger("Test");
    log.event("Scenario", { key: "val" });
    remove();

    expect(entries[0].telemetry).toBeUndefined();
    expect(entries[0].cause).toBeUndefined();
  });
});
