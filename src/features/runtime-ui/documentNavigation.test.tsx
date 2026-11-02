import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MarkdownRenderer } from "@/plugins/streamdown-config";

import { DocumentLinkScope } from "./documentNavigation";
import { documentPath } from "./documentPath";

describe("document navigation", () => {
  it("routes links rendered by the real chat markdown renderer", async () => {
    const open = vi.fn<NonNullable<Window["runtimeUiAPI"]>["open"]>().mockResolvedValue({
      success: true,
      value: {
        receipt: {
          receiptId: "r",
          action: "open",
          status: "applied",
          completedAt: "2026-09-06",
          revision: 1,
        },
      },
    });
    Object.defineProperty(window, "runtimeUiAPI", { configurable: true, value: { open } });
    render(
      <DocumentLinkScope scope={{ sessionId: "session", workspaceName: "workspace" }}>
        <MarkdownRenderer>{"[README.md](file:///repo/README.md)"}</MarkdownRenderer>
      </DocumentLinkScope>,
    );
    await userEvent.setup().click(screen.getByRole("link", { name: "README.md" }));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ content: { kind: "file", path: "/repo/README.md" } }),
    );
  });
  it("resolves document links and leaves web and anchor links alone", () => {
    expect(documentPath("../area%202.md", "/repo/docs/README.md")).toBe("/repo/area 2.md");
    expect(documentPath("local-file:///repo/a%20b.md")).toBe("/repo/a b.md");
    expect(documentPath("file:///C:/docs/a.md")).toBe("C:/docs/a.md");
    for (const url of [
      "https://example.com",
      "mailto:a@b.com",
      "#section",
      "//example.com/file",
      // eslint-disable-next-line no-script-url -- verifies unsafe links are not document paths
      "javascript:alert(1)",
    ])
      expect(documentPath(url)).toBeNull();
  });
  it("opens nested document links in the originating session without OS navigation", async () => {
    const open = vi.fn<NonNullable<Window["runtimeUiAPI"]>["open"]>().mockResolvedValue({
      success: true,
      value: {
        receipt: {
          receiptId: "opened",
          action: "open",
          status: "applied",
          completedAt: "2026-09-06",
          revision: 1,
        },
      },
    });
    Object.defineProperty(window, "runtimeUiAPI", { configurable: true, value: { open } });
    const external = vi.fn<() => void>();
    const scope = { sessionId: "session", workspaceName: "workspace" };
    render(
      <DocumentLinkScope scope={scope}>
        <DocumentLinkScope scope={scope} basePath="/repo/docs/README.md">
          <a href="area.md" onClick={external}>
            Area
          </a>
        </DocumentLinkScope>
      </DocumentLinkScope>,
    );
    await userEvent.setup().click(screen.getByText("Area"));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          ...scope,
          surface: "panel",
          content: { kind: "file", path: "/repo/docs/area.md" },
        }),
      ),
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(external).not.toHaveBeenCalled();
  });
  it("opens file links on the fullscreen surface in mobile view", async () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => true,
      }),
    });
    const open = vi.fn<NonNullable<Window["runtimeUiAPI"]>["open"]>().mockResolvedValue({
      success: true,
      value: {
        receipt: {
          receiptId: "r",
          action: "open",
          status: "applied",
          completedAt: "2026-09-06",
          revision: 1,
        },
      },
    });
    Object.defineProperty(window, "runtimeUiAPI", { configurable: true, value: { open } });
    render(
      <DocumentLinkScope scope={{ sessionId: "session", workspaceName: "workspace" }}>
        <MarkdownRenderer>{"[README.md](file:///repo/README.md)"}</MarkdownRenderer>
      </DocumentLinkScope>,
    );
    await userEvent.setup().click(screen.getByRole("link", { name: "README.md" }));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "fullscreen",
        content: { kind: "file", path: "/repo/README.md" },
      }),
    );
  });
});
