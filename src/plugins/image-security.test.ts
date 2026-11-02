// @vitest-environment node
import type { Root as HastRoot, Element } from "hast";
import { harden } from "rehype-harden";
import { describe, expect, it } from "vitest";

import { imageHardenOptions } from "./marshal-content/image-harden-options";

/**
 * Tests for the rehype-harden image-blocking config used in streamdown-config.tsx.
 *
 * The config must:
 *   - Block http/https images (replaced with a placeholder span)
 *   - Allow data:image/* URLs
 *   - Allow blob: URLs
 *   - Allow local-file: URLs
 */

function makeTree(imgSrc: string, alt = "test"): HastRoot {
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "img",
            properties: { src: imgSrc, alt },
            children: [],
          },
        ],
      },
    ],
  };
}

function findElement(node: HastRoot | Element, tagName: string): Element | undefined {
  if ("tagName" in node && node.tagName === tagName) return node;
  if ("children" in node) {
    for (const child of node.children) {
      if (child.type === "element") {
        const found = findElement(child, tagName);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function transform(tree: HastRoot): HastRoot {
  const plugin = harden(imageHardenOptions);
  plugin(tree);
  return tree;
}

describe("rehype-harden image security config", () => {
  it("blocks https: image URLs", () => {
    const tree = transform(makeTree("https://evil.com/tracking.png"));
    const img = findElement(tree, "img");
    expect(img).toBeUndefined();
    // harden replaces blocked images with a span placeholder
    const span = findElement(tree, "span");
    expect(span).toBeDefined();
  });

  it("blocks http: image URLs", () => {
    const tree = transform(makeTree("http://evil.com/tracking.png"));
    const img = findElement(tree, "img");
    expect(img).toBeUndefined();
  });

  it("allows data:image/* URLs", () => {
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const tree = transform(makeTree(dataUrl));
    const img = findElement(tree, "img");
    expect(img).toBeDefined();
    expect(img!.properties.src).toBe(dataUrl);
  });

  it("allows blob: URLs", () => {
    const blobUrl = "blob:http://localhost:5173/abc-def-123";
    const tree = transform(makeTree(blobUrl));
    const img = findElement(tree, "img");
    expect(img).toBeDefined();
    expect(img!.properties.src).toBe(blobUrl);
  });

  it("allows local-file: URLs", () => {
    const localUrl = "local-file:///C:/Users/test/image.png";
    const tree = transform(makeTree(localUrl));
    const img = findElement(tree, "img");
    expect(img).toBeDefined();
    expect(img!.properties.src).toBe(localUrl);
  });

  it("applies blockedImageClass to placeholder", () => {
    const tree = transform(makeTree("https://evil.com/pixel.png", "alt text"));
    const span = findElement(tree, "span");
    expect(span).toBeDefined();
    const cls = String(span!.properties.class ?? span!.properties.className ?? "");
    expect(cls).toContain("inline-flex");
    expect(cls).toContain("rounded-sm");
  });

  it("does not block links (allowedLinkPrefixes: ['*'])", () => {
    const tree: HastRoot = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "a",
              properties: { href: "https://example.com" },
              children: [{ type: "text", value: "click" }],
            },
          ],
        },
      ],
    };
    transform(tree);
    const a = findElement(tree, "a");
    expect(a).toBeDefined();
    expect(a!.properties.href).toBe("https://example.com/");
  });
});
