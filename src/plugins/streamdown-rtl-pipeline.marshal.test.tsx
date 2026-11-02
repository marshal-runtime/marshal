// marshal-owned renderer test
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarkdownRenderer } from "./streamdown-config";

vi.mock("@/shared/hooks/useTheme", () => ({
  useMermaidTheme: () => ({}),
}));

describe("MarkdownRenderer — RTL pipeline integration", () => {
  it('renders Hebrew paragraphs with dir="rtl"', () => {
    render(<MarkdownRenderer>{"שלום עולם"}</MarkdownRenderer>);
    expect(screen.getByText("שלום עולם")).toHaveAttribute("dir", "rtl");
  });

  it('renders headings with dir="rtl" for Hebrew text', () => {
    render(<MarkdownRenderer>{"# כותרת"}</MarkdownRenderer>);
    expect(screen.getByRole("heading", { name: "כותרת" })).toHaveAttribute("dir", "rtl");
  });

  it('renders list items with dir="rtl" for Hebrew text', () => {
    render(<MarkdownRenderer>{"- פריט ראשון\n- פריט שני"}</MarkdownRenderer>);
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const li of items) {
      expect(li).toHaveAttribute("dir", "rtl");
    }
  });

  it("code blocks render with pre element (LTR enforced via CSS)", () => {
    const { container } = render(<MarkdownRenderer>{"```\nconst x = 1;\n```"}</MarkdownRenderer>);
    expect(container.textContent).toContain("const x = 1;");
    // Streamdown's code plugin replaces the HAST <pre> with a custom wrapper,
    // so dir="ltr" from the rehype plugin doesn't survive to DOM (covered by unit test).
    // LTR is enforced via CSS: [data-streamdown] pre { direction: ltr }.
    // oxlint-disable-next-line testing-library/no-container, testing-library/no-node-access -- verifying pre element exists for CSS targeting
    expect(container.querySelector("pre")).not.toBeNull();
  });

  it('renders English paragraphs with dir="auto" (browser resolves LTR)', () => {
    render(<MarkdownRenderer>{"Hello world"}</MarkdownRenderer>);
    expect(screen.getByText("Hello world")).toHaveAttribute("dir", "auto");
  });

  it('renders Hebrew paragraph starting with English word as dir="rtl"', () => {
    render(<MarkdownRenderer>{"REACT מאפשרת לבנות ממשקי משתמש אינטראקטיביים"}</MarkdownRenderer>);
    expect(screen.getByText("REACT מאפשרת לבנות ממשקי משתמש אינטראקטיביים")).toHaveAttribute(
      "dir",
      "rtl",
    );
  });

  it("preserves explicit dir attributes from raw HTML", () => {
    render(<MarkdownRenderer>{'<p dir="rtl">forced RTL</p>'}</MarkdownRenderer>);
    expect(screen.getByText("forced RTL")).toHaveAttribute("dir", "rtl");
  });
});
