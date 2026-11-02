import { describe, expect, it } from "vitest";

import { getEditOperation, isEditBoundaryCharacter } from "./editUndo";

describe("getEditOperation", () => {
  it.each([
    ["same text", "hello", "hello", "none"],
    ["insertion", "helo", "hello", "insert"],
    ["deletion", "hello", "helo", "delete"],
    ["same-length replacement", "hello", "jello", "replace"],
    ["multichar insertion", "hi", "hello", "replace"],
    ["multichar deletion", "hello", "hi", "replace"],
  ])("%s", (_label, prev, next, expected) => {
    expect(getEditOperation(prev, next)).toBe(expected);
  });
});

describe("isEditBoundaryCharacter", () => {
  it.each([" ", "\n", "\t", ".", ",", ";", ":", "!", "?", "(", ")", "{", "}", "[", "]", '"', "'"])(
    "recognizes %j as a boundary",
    (character) => {
      expect(isEditBoundaryCharacter(character)).toBe(true);
    },
  );

  it.each(["a", "Z", "0", "_", "-", "ab", ""])("rejects %j as a boundary", (character) => {
    expect(isEditBoundaryCharacter(character)).toBe(false);
  });
});
