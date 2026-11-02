import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRuntimeDocumentAccessStore } from "./runtime-document-access-store";

describe("runtime document access store", () => {
  let root: string;
  let firstFile: string;
  let secondFile: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-runtime-document-"));
    firstFile = path.join(root, "first.md");
    secondFile = path.join(root, "second.md");
    fs.writeFileSync(firstFile, "# First");
    fs.writeFileSync(secondFile, "# Second");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reuses an unguessable capability only for its exact existing file", () => {
    const store = createRuntimeDocumentAccessStore();
    const token = store.issue(firstFile);

    expect(store.issue(firstFile)).toBe(token);
    expect(store.resolve(token, firstFile)).toEqual({ resolved: fs.realpathSync(firstFile) });
    expect(store.resolve(token, firstFile)).toEqual({ resolved: fs.realpathSync(firstFile) });
    expect(store.resolve(token, secondFile)).toEqual({
      error: "File access is no longer available",
    });
    expect(store.resolve("not-the-token", firstFile)).toEqual({
      error: "File access is no longer available",
    });
  });

  it("expires capabilities and rejects missing files", () => {
    let now = 1_000;
    const store = createRuntimeDocumentAccessStore({ now: () => now, ttlMs: 100 });
    const token = store.issue(firstFile);

    now += 100;
    expect(store.resolve(token, firstFile)).toEqual({
      error: "File access is no longer available",
    });
    expect(() => store.issue(path.join(root, "missing.md"))).toThrow(
      "Document must be an existing local file",
    );
  });

  it("evicts the oldest capability when the store reaches its bound", () => {
    const store = createRuntimeDocumentAccessStore({ maxEntries: 1 });
    const firstToken = store.issue(firstFile);
    const secondToken = store.issue(secondFile);

    expect(store.resolve(firstToken, firstFile)).toEqual({
      error: "File access is no longer available",
    });
    expect(store.resolve(secondToken, secondFile)).toEqual({
      resolved: fs.realpathSync(secondFile),
    });
  });
});
