import { describe, expect, it } from "vitest";

import { readYamlField } from "./foundation/parsing/frontmatter";

describe("readYamlField", () => {
  it("reads a plain value", () => {
    expect(readYamlField("name: my-skill\ndescription: A skill", "name")).toBe("my-skill");
  });

  it("reads a double-quoted value", () => {
    expect(readYamlField('description: "A quoted description"', "description")).toBe(
      "A quoted description",
    );
  });

  it("reads a single-quoted value", () => {
    expect(readYamlField("name: 'hello world'", "name")).toBe("hello world");
  });

  it("reads a block scalar (|)", () => {
    const fm = "description: |\n  Line one\n  Line two\nname: foo";
    expect(readYamlField(fm, "description")).toBe("Line one\nLine two");
  });

  it("reads a block scalar with strip modifier (|-)", () => {
    const fm = "description: |-\n  Only line\nname: foo";
    expect(readYamlField(fm, "description")).toBe("Only line");
  });

  it("returns null when key is absent", () => {
    expect(readYamlField("name: foo", "description")).toBeNull();
  });

  it("returns null for an empty value", () => {
    expect(readYamlField("description: \nname: foo", "description")).toBeNull();
  });

  it("does not match a key that is a prefix of another key", () => {
    // 'name' must not match 'nameExtra'
    const fm = "nameExtra: wrong\nname: correct";
    expect(readYamlField(fm, "name")).toBe("correct");
  });
});
