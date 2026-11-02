// Marshal-owned module.
import { describe, it, expect, afterEach } from "vitest";

import { rangeToMarkdownRange } from "./rangeToMarkdownRange";

describe("rangeToMarkdownRange", () => {
  let container: HTMLDivElement;

  afterEach(() => {
    container?.remove();
  });

  it("text node at start of annotated element", () => {
    container = document.createElement("div");
    const span = document.createElement("span");
    span.setAttribute("data-md-start", "10");
    span.setAttribute("data-md-end", "20");
    span.textContent = "Hello World";
    container.appendChild(span);
    document.body.appendChild(container);

    const textNode = span.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.collapse(true);

    const result = rangeToMarkdownRange(range, container);
    expect(result).not.toBeNull();
    expect(result!.mdStart).toBe(10);
    expect(result!.mdEnd).toBe(10);
  });

  it("text node at middle of annotated element", () => {
    container = document.createElement("div");
    const span = document.createElement("span");
    span.setAttribute("data-md-start", "10");
    span.setAttribute("data-md-end", "20");
    span.textContent = "Hello World";
    container.appendChild(span);
    document.body.appendChild(container);

    const textNode = span.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 5); // After "Hello"
    range.collapse(true);

    const result = rangeToMarkdownRange(range, container);
    expect(result).not.toBeNull();
    expect(result!.mdStart).toBe(15);
    expect(result!.mdEnd).toBe(15);
  });

  it("collapsed range (cursor, no selection)", () => {
    container = document.createElement("div");
    const span = document.createElement("span");
    span.setAttribute("data-md-start", "10");
    span.setAttribute("data-md-end", "20");
    span.textContent = "Hello World";
    container.appendChild(span);
    document.body.appendChild(container);

    const textNode = span.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.setEnd(textNode, 3); // Same as start (collapsed)

    const result = rangeToMarkdownRange(range, container);
    expect(result).not.toBeNull();
    expect(result!.mdStart).toBe(13);
    expect(result!.mdEnd).toBe(13);
  });

  it("range spanning text", () => {
    container = document.createElement("div");
    const span = document.createElement("span");
    span.setAttribute("data-md-start", "10");
    span.setAttribute("data-md-end", "21");
    span.textContent = "Hello World";
    container.appendChild(span);
    document.body.appendChild(container);

    const textNode = span.firstChild!;
    const range = document.createRange();
    // Select "llo Wo" (offset 2 to 8) in "Hello World"
    range.setStart(textNode, 2);
    range.setEnd(textNode, 8);

    const result = rangeToMarkdownRange(range, container);
    expect(result).not.toBeNull();
    expect(result!.mdStart).toBe(12); // 10 + 2
    expect(result!.mdEnd).toBe(18); // 10 + 8
  });

  it("nested annotations (inner annotation wins)", () => {
    container = document.createElement("div");
    const outer = document.createElement("span");
    outer.setAttribute("data-md-start", "0");
    outer.setAttribute("data-md-end", "20");

    const inner = document.createElement("strong");
    inner.setAttribute("data-md-start", "5");
    inner.setAttribute("data-md-end", "15");
    inner.textContent = "bold text";

    outer.appendChild(inner);
    container.appendChild(outer);
    document.body.appendChild(container);

    const textNode = inner.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4); // "bold"

    const result = rangeToMarkdownRange(range, container);
    expect(result).not.toBeNull();
    // Should use inner annotation (5), not outer (0)
    expect(result!.mdStart).toBe(5); // 5 + 0
    expect(result!.mdEnd).toBe(9); // 5 + 4
  });

  it("missing data-md-start returns null", () => {
    container = document.createElement("div");
    const span = document.createElement("span");
    // No data-md-start or data-md-end attributes
    span.textContent = "Hello World";
    container.appendChild(span);
    document.body.appendChild(container);

    const textNode = span.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);

    const result = rangeToMarkdownRange(range, container);
    expect(result).toBeNull();
  });

  it("range outside editor boundary returns null", () => {
    container = document.createElement("div");
    const inside = document.createElement("span");
    inside.setAttribute("data-md-start", "10");
    inside.setAttribute("data-md-end", "20");
    inside.textContent = "Inside";
    container.appendChild(inside);
    document.body.appendChild(container);

    // Create an outside element not within container
    const outside = document.createElement("div");
    outside.textContent = "Outside text";
    document.body.appendChild(outside);

    const textNode = outside.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);

    // Pass container as editorEl, but range is outside it
    const result = rangeToMarkdownRange(range, container);
    expect(result).toBeNull();

    outside.remove();
  });
});
