import { describe, expect, it } from "vitest";

import { htmlToPlainText } from "./escaping";

describe("htmlToPlainText", () => {
  it("strips HTML markup and decodes common entities", () => {
    expect(htmlToPlainText("<p>Preview <b>text</b> &amp; more</p>")).toBe("Preview text & more");
  });

  it("drops incomplete trailing tags instead of leaving raw markup", () => {
    expect(htmlToPlainText("Hello<script")).toBe("Hello");
  });
});
