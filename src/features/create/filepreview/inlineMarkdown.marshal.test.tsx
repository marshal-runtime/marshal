// marshal-owned renderer test
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs } from "@/test-utils";

import { parseInline } from "./inlineMarkdown";

beforeEach(() => {
  installMockAPIs();
  vi.stubGlobal("open", vi.fn());
});

describe("parseInline link onClick", () => {
  it("opens https:// links via window.open", async () => {
    const user = userEvent.setup();
    render(<>{parseInline("[Visit GitHub](https://github.com)")}</>);
    await user.click(screen.getByRole("link", { name: "Visit GitHub" }));
    expect(window.open).toHaveBeenCalledWith("https://github.com", "_blank", "noreferrer");
  });

  it("opens file:// links via window.open", async () => {
    const user = userEvent.setup();
    render(<>{parseInline("[Open file](file:///home/user/doc.txt)")}</>);
    await user.click(screen.getByRole("link", { name: "Open file" }));
    expect(window.open).toHaveBeenCalledWith("file:///home/user/doc.txt", "_blank", "noreferrer");
  });

  it("opens <https://url> autolinks via shellAPI", async () => {
    const user = userEvent.setup();
    render(<>{parseInline("<https://example.com/page>")}</>);
    await user.click(screen.getByRole("link", { name: "https://example.com/page" }));
    expect(window.shellAPI!.openExternal).toHaveBeenCalledWith("https://example.com/page");
  });
});
