import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LEDGER_FILENAME,
  readRestartLedgerEntries,
  recordPendingRestartSync,
  recordRestartRefusalSync,
  resolvePendingRestartsOnBootSync,
} from "./app-restart-ledger";

describe("app-restart-ledger", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-ledger-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records a pending restart entry before exit", () => {
    const entry = recordPendingRestartSync(dir, {
      requesterSessionId: "sess-1",
      reason: "apply runtime pack update",
      force: false,
    });
    expect(entry).not.toBeNull();
    expect(entry?.status).toBe("pending");
    expect(entry?.requesterSessionId).toBe("sess-1");
    expect(entry?.reason).toBe("apply runtime pack update");

    const onDisk = readRestartLedgerEntries(dir);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({
      id: entry?.id,
      status: "pending",
      requesterSessionId: "sess-1",
      reason: "apply runtime pack update",
      force: false,
    });
    expect(typeof onDisk[0]?.timestamp).toBe("string");
  });

  it("records a refusal with the busy sessions that blocked it", () => {
    const entry = recordRestartRefusalSync(dir, {
      requesterSessionId: "sess-1",
      reason: "restart to pick up config",
      force: false,
      busySessionIds: ["sess-2", "sess-3"],
    });
    expect(entry?.status).toBe("refused");
    expect(entry?.busySessionIds).toEqual(["sess-2", "sess-3"]);

    const onDisk = readRestartLedgerEntries(dir);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]?.status).toBe("refused");
  });

  it("marks pending entries completed on boot and returns them for the notice surface", () => {
    const pending = recordPendingRestartSync(dir, {
      requesterSessionId: "sess-1",
      reason: "reload extensions",
      force: true,
    });

    const completed = resolvePendingRestartsOnBootSync(dir);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      id: pending?.id,
      status: "completed",
      requesterSessionId: "sess-1",
      reason: "reload extensions",
    });
    expect(typeof completed[0]?.completedAt).toBe("string");

    // The ledger now holds the pending record plus a completion record.
    const onDisk = readRestartLedgerEntries(dir);
    expect(onDisk).toHaveLength(2);
    expect(onDisk[1]?.status).toBe("completed");
    expect(onDisk[1]?.id).toBe(pending?.id);

    // Second boot: nothing left to resolve.
    expect(resolvePendingRestartsOnBootSync(dir)).toHaveLength(0);
  });

  it("does not resolve refusals on boot", () => {
    recordRestartRefusalSync(dir, {
      requesterSessionId: "sess-1",
      reason: "blocked",
      force: false,
      busySessionIds: ["sess-9"],
    });
    expect(resolvePendingRestartsOnBootSync(dir)).toHaveLength(0);
  });

  it("survives a missing ledger file and malformed lines", () => {
    expect(readRestartLedgerEntries(dir)).toEqual([]);
    expect(resolvePendingRestartsOnBootSync(dir)).toEqual([]);

    fs.writeFileSync(path.join(dir, LEDGER_FILENAME), 'not-json\n{"half":\n');
    expect(readRestartLedgerEntries(dir)).toEqual([]);

    const entry = recordPendingRestartSync(dir, {
      requesterSessionId: "sess-1",
      reason: "after corruption",
      force: false,
    });
    expect(entry).not.toBeNull();
    expect(readRestartLedgerEntries(dir)).toHaveLength(1);
  });

  it("returns null instead of throwing when the directory is not writable", () => {
    const bogus = path.join(dir, "missing", "nested");
    // recordPendingRestartSync creates directories; point at a file to force failure.
    fs.writeFileSync(path.join(dir, "blocker"), "x");
    const entry = recordPendingRestartSync(path.join(dir, "blocker"), {
      requesterSessionId: "sess-1",
      reason: "should fail",
      force: false,
    });
    expect(entry).toBeNull();
    expect(readRestartLedgerEntries(bogus)).toEqual([]);
  });
});
