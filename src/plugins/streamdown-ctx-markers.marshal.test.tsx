// marshal-owned renderer test
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarkdownRenderer } from "./streamdown-config";

vi.mock("@/shared/hooks/useTheme", () => ({
  useMermaidTheme: () => ({}),
}));

describe("MarkdownRenderer — invisible context markers", () => {
  it("hides <!--ctx:mailto:...--> from the rendered DOM", () => {
    const { container } = render(
      <MarkdownRenderer>{`Hi **Alice** <!--ctx:mailto:alice@x.com--> please review`}</MarkdownRenderer>,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Alice");
    expect(text).toContain("please review");
    expect(text).not.toContain("alice@x.com");
    expect(text).not.toContain("ctx:");
    expect(container.innerHTML).not.toContain("alice@x.com");
  });

  it("hides <!--ctx:https://...--> from the rendered DOM", () => {
    const url = "https://files.example.com/sites/x/doc.pdf";
    const { container } = render(
      <MarkdownRenderer>{`See **doc.pdf** <!--ctx:${url}--> attached`}</MarkdownRenderer>,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("doc.pdf");
    expect(text).not.toContain(url);
    expect(container.innerHTML).not.toContain(url);
  });

  it("renders the bold display text", async () => {
    const { container } = render(
      <MarkdownRenderer>{`**Alice** <!--ctx:mailto:a@b-->`}</MarkdownRenderer>,
    );
    await screen.findAllByText(/Alice/);
    const html = container.innerHTML;
    const hasBold =
      /<(strong|b)\b[^>]*>\s*Alice/i.test(html) ||
      /font-(?:bold|semibold)[^"]*"[^>]*>\s*Alice/i.test(html);
    expect(hasBold).toBe(true);
  });
});
