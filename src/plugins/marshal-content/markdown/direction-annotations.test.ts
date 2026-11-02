import type { Element, ElementContent, Root, Text } from "hast";
import { describe, it, expect } from "vitest";

import { rehypeMarshalTextDirection, resolveContentDirection } from "./direction-annotations";

function makeText(value: string): Text {
  return { type: "text", value };
}

function makeElement(tagName: string, children: ElementContent[] = []): Element {
  return { type: "element", tagName, properties: {}, children };
}

function makeElementWithText(tagName: string, text: string): Element {
  return { type: "element", tagName, properties: {}, children: [makeText(text)] };
}

function makeTree(elements: Element[]): Root {
  return { type: "root", children: elements };
}

function transform(tree: Root): Root {
  rehypeMarshalTextDirection()(tree);
  return tree;
}

function getDir(el: Element): unknown {
  return el.properties?.dir;
}

describe("rehypeMarshalTextDirection", () => {
  it('adds dir="auto" to <p> elements', () => {
    const p = makeElement("p");
    transform(makeTree([p]));
    expect(getDir(p)).toBe("auto");
  });

  it('adds dir="ltr" to <pre> elements', () => {
    const pre = makeElement("pre");
    transform(makeTree([pre]));
    expect(getDir(pre)).toBe("ltr");
  });

  it("does NOT add dir to inline <code> elements", () => {
    const code = makeElement("code");
    transform(makeTree([code]));
    expect(getDir(code)).toBeUndefined();
  });

  it('adds dir="auto" to list items', () => {
    const li = makeElement("li");
    transform(makeTree([li]));
    expect(getDir(li)).toBe("auto");
  });

  it.each(["h1", "h2", "h3", "h4", "h5", "h6"])('adds dir="auto" to <%s>', (tag) => {
    const el = makeElement(tag);
    transform(makeTree([el]));
    expect(getDir(el)).toBe("auto");
  });

  it('adds dir="auto" to <blockquote>', () => {
    const bq = makeElement("blockquote");
    transform(makeTree([bq]));
    expect(getDir(bq)).toBe("auto");
  });

  it.each(["td", "th"])('adds dir="auto" to <%s>', (tag) => {
    const el = makeElement(tag);
    transform(makeTree([el]));
    expect(getDir(el)).toBe("auto");
  });

  it("does NOT modify <div> elements", () => {
    const div = makeElement("div");
    transform(makeTree([div]));
    expect(getDir(div)).toBeUndefined();
  });

  it("does NOT modify <span> elements", () => {
    const span = makeElement("span");
    transform(makeTree([span]));
    expect(getDir(span)).toBeUndefined();
  });

  it("handles nested structures correctly", () => {
    const code = makeElement("code");
    const pre = makeElement("pre", [code]);
    const p = makeElement("p");
    transform(makeTree([pre, p]));
    expect(getDir(pre)).toBe("ltr");
    expect(getDir(code)).toBeUndefined();
    expect(getDir(p)).toBe("auto");
  });

  it("preserves explicit dir attributes from raw HTML", () => {
    const p: Element = { type: "element", tagName: "p", properties: { dir: "rtl" }, children: [] };
    transform(makeTree([p]));
    expect(getDir(p)).toBe("rtl");
  });

  it("preserves explicit dir on pre elements", () => {
    const pre: Element = {
      type: "element",
      tagName: "pre",
      properties: { dir: "auto" },
      children: [],
    };
    transform(makeTree([pre]));
    expect(getDir(pre)).toBe("auto");
  });

  it('sets dir="rtl" when text contains Hebrew characters', () => {
    const p = makeElementWithText("p", "הספרייה REACT מאפשרת לבנות ממשקי משתמש");
    transform(makeTree([p]));
    expect(getDir(p)).toBe("rtl");
  });

  it('keeps dir="auto" when text is pure English', () => {
    const p = makeElementWithText(
      "p",
      "REACT makes it easier to build interactive user interfaces",
    );
    transform(makeTree([p]));
    expect(getDir(p)).toBe("auto");
  });

  it('sets dir="rtl" for Hebrew paragraph starting with English word', () => {
    const p = makeElementWithText("p", "REACT מאפשרת לבנות ממשקי משתמש אינטראקטיביים בצורה מסודרת");
    transform(makeTree([p]));
    expect(getDir(p)).toBe("rtl");
  });

  it("extracts text from nested children for direction", () => {
    const span = makeElementWithText("span", "שלום עולם");
    const p = makeElement("p", [makeText("Hello "), span]);
    transform(makeTree([p]));
    expect(getDir(p)).toBe("rtl");
  });
});

describe("resolveContentDirection", () => {
  it("returns auto for empty text", () => {
    expect(resolveContentDirection("")).toBe("auto");
  });

  it("returns auto for neutral characters only", () => {
    expect(resolveContentDirection("123 !@# ...")).toBe("auto");
  });

  it("returns rtl for Hebrew text", () => {
    expect(resolveContentDirection("שלום עולם")).toBe("rtl");
  });

  it("returns auto for English text", () => {
    expect(resolveContentDirection("Hello world")).toBe("auto");
  });

  it("returns rtl when Hebrew dominates despite English prefix", () => {
    expect(resolveContentDirection("REACT מאפשרת לבנות ממשקי משתמש אינטראקטיביים")).toBe("rtl");
  });

  it("returns rtl when English dominates but Hebrew word present", () => {
    expect(resolveContentDirection("The שלום framework is great for building apps")).toBe("rtl");
  });

  it("returns rtl for Arabic text", () => {
    expect(resolveContentDirection("مرحبا بالعالم")).toBe("rtl");
  });
});
