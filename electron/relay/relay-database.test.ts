import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RELAY_DATABASE_SCHEMA_VERSION,
  RelayDatabase,
  relayTextColumn,
  requireRelayRow,
} from "./relay-database";

describe("RelayDatabase", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("migrates a new database once and reopens the same schema", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-relay-schema-"));
    const databasePath = path.join(tempDir, "relay.db");
    const first = new RelayDatabase(databasePath);

    expect(first.getSchemaVersion()).toBe(RELAY_DATABASE_SCHEMA_VERSION);
    const tables = first
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'relay_%'
         ORDER BY name ASC`,
      )
      .all()
      .map((row) => relayTextColumn(requireRelayRow(row, "relay schema table"), "name"));
    expect(tables).toEqual([
      "relay_binding_activity",
      "relay_binding_retirements",
      "relay_bindings",
      "relay_inbound_journal",
      "relay_message_correlations",
      "relay_publications",
    ]);
    first.close();

    const reopened = new RelayDatabase(databasePath);
    expect(reopened.getSchemaVersion()).toBe(RELAY_DATABASE_SCHEMA_VERSION);
    reopened.close();
  });
});
