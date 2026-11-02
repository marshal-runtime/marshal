// Marshal-owned module.
import type { Root } from "hast";
import { describe, it, expect } from "vitest";

import { rehypeLocalImages } from "./rehype-local-images";

function makeTree(src: string): Root {
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "img",
        properties: { src, alt: "test" },
        children: [],
      },
    ],
  };
}

function transform(src: string): string {
  const tree = makeTree(src);
  rehypeLocalImages()(tree);
  const el = tree.children[0];
  if (el.type !== "element") throw new Error("expected element");
  return String(el.properties.src);
}

describe("rehypeLocalImages", () => {
  describe("rewrites image URLs", () => {
    it("rewrites file:/// URL with image extension", () => {
      expect(transform("file:///C:/Users/test/diagram.png")).toBe(
        "local-file:///C:/Users/test/diagram.png",
      );
    });

    it("rewrites file:// URL (two slashes)", () => {
      expect(transform("file://C:/Users/test/photo.jpg")).toBe(
        "local-file:///C:/Users/test/photo.jpg",
      );
    });

    it("rewrites Windows backslash path", () => {
      expect(transform("C:\\Users\\test\\image.png")).toBe("local-file:///C:/Users/test/image.png");
    });

    it("rewrites Windows forward slash path", () => {
      expect(transform("C:/Users/test/image.jpeg")).toBe("local-file:///C:/Users/test/image.jpeg");
    });

    it("handles various image extensions", () => {
      for (const ext of ["png", "jpg", "jpeg", "gif", "svg", "webp"]) {
        expect(transform(`file:///C:/img.${ext}`)).toBe(`local-file:///C:/img.${ext}`);
      }
    });

    it("is case-insensitive for extensions", () => {
      expect(transform("file:///C:/img.PNG")).toBe("local-file:///C:/img.PNG");
      expect(transform("file:///C:/img.Jpg")).toBe("local-file:///C:/img.Jpg");
    });

    it("rewrites already-encoded URLs with %20", () => {
      expect(transform("file:///C:/My%20Files/img.png")).toBe(
        "local-file:///C:/My%20Files/img.png",
      );
    });
  });

  describe("security: blocks non-image URLs", () => {
    it("does NOT rewrite file:// URL without image extension", () => {
      expect(transform("file:///C:/Users/test/secret.txt")).toBe(
        "file:///C:/Users/test/secret.txt",
      );
    });

    it("does NOT rewrite file:// URL for .env", () => {
      expect(transform("file:///C:/project/.env")).toBe("file:///C:/project/.env");
    });

    it("does NOT rewrite file:// URL for .json", () => {
      expect(transform("file:///C:/Users/credentials.json")).toBe(
        "file:///C:/Users/credentials.json",
      );
    });

    it("does NOT rewrite Windows path without image extension", () => {
      expect(transform("C:\\Users\\test\\data.csv")).toBe("C:\\Users\\test\\data.csv");
    });

    it("does NOT rewrite file:// URL for .pem", () => {
      expect(transform("file:///home/user/.ssh/id_rsa.pem")).toBe(
        "file:///home/user/.ssh/id_rsa.pem",
      );
    });
  });

  describe("passes through non-local URLs", () => {
    it("does NOT modify https URLs", () => {
      expect(transform("https://example.com/image.png")).toBe("https://example.com/image.png");
    });

    it("does NOT modify data URLs", () => {
      const dataUrl = "data:image/png;base64,iVBOR";
      expect(transform(dataUrl)).toBe(dataUrl);
    });

    it("does NOT modify relative URLs", () => {
      expect(transform("./images/logo.png")).toBe("./images/logo.png");
    });
  });

  describe("anchor href rewriting", () => {
    it("rewrites file:// href to local-file://", () => {
      const tree: Root = {
        type: "root",
        children: [
          {
            type: "element",
            tagName: "a",
            properties: { href: "file:///C:/docs/readme.txt" },
            children: [],
          },
        ],
      };
      rehypeLocalImages()(tree);
      const el = tree.children[0];
      if (el.type !== "element") throw new Error("expected element");
      expect(el.properties.href).toBe("local-file:///C:/docs/readme.txt");
    });

    it("rewrites any file extension in href (not limited to images)", () => {
      const tree: Root = {
        type: "root",
        children: [
          {
            type: "element",
            tagName: "a",
            properties: { href: "file:///tmp/workspace/report.pdf" },
            children: [],
          },
        ],
      };
      rehypeLocalImages()(tree);
      const el = tree.children[0];
      if (el.type !== "element") throw new Error("expected element");
      expect(el.properties.href).toBe("local-file:///tmp/workspace/report.pdf");
    });

    it("leaves http:// href untouched", () => {
      const tree: Root = {
        type: "root",
        children: [
          {
            type: "element",
            tagName: "a",
            properties: { href: "https://example.com" },
            children: [],
          },
        ],
      };
      rehypeLocalImages()(tree);
      const el = tree.children[0];
      if (el.type !== "element") throw new Error("expected element");
      expect(el.properties.href).toBe("https://example.com");
    });

    it("rewrites mixed-case FILE:// href", () => {
      const tree: Root = {
        type: "root",
        children: [
          {
            type: "element",
            tagName: "a",
            properties: { href: "FILE:///tmp/workspace/doc.txt" },
            children: [],
          },
        ],
      };
      rehypeLocalImages()(tree);
      const el = tree.children[0];
      if (el.type !== "element") throw new Error("expected element");
      expect(el.properties.href).toBe("local-file:///tmp/workspace/doc.txt");
    });
  });

  describe("non-img/a elements are untouched", () => {
    it("ignores other elements", () => {
      const tree: Root = {
        type: "root",
        children: [
          {
            type: "element",
            tagName: "div",
            properties: { "data-src": "file:///C:/secret.png" },
            children: [],
          },
        ],
      };
      rehypeLocalImages()(tree);
      const el = tree.children[0];
      if (el.type !== "element") throw new Error("expected element");
      expect(el.properties["data-src"]).toBe("file:///C:/secret.png");
    });
  });
});
