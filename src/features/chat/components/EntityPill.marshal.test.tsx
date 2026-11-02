// marshal-owned renderer test
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import { render, screen } from "@/test-utils";

import { EntityPill } from "./EntityPill";

// EntityPill file kind renders FileExtensionIcon; stub the visual layer so this
// suite stays a pure unit test of pill chrome / sizing / remove behavior.
vi.mock("./entity-pill-visual", () => ({
  EntityPillIcon: ({ kind, size }: { kind: { type: string }; size: string }) => (
    <span data-testid="entity-pill-icon" data-kind={kind.type} data-size={size} />
  ),
  FileExtensionIcon: () => <span data-testid="entity-pill-icon" data-kind="file" />,
}));

describe("EntityPill", () => {
  describe("kind: file", () => {
    it("renders icon + label and the remove button when onRemove is provided", () => {
      render(
        <EntityPill
          kind={{ type: "file", name: "report.docx", extension: "docx" }}
          onRemove={vi.fn<() => void>()}
        />,
      );
      expect(screen.getByText("report.docx")).toBeInTheDocument();
      expect(screen.getByTestId("entity-pill-icon")).toHaveAttribute("data-kind", "file");
      expect(screen.getByRole("button", { name: /remove report\.docx/i })).toBeInTheDocument();
    });

    it("omits the remove button when onRemove is not provided", () => {
      render(<EntityPill kind={{ type: "file", name: "report.docx" }} />);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("calls onRemove when the remove button is clicked", async () => {
      const onRemove = vi.fn<() => void>();
      render(<EntityPill kind={{ type: "file", name: "x.txt" }} onRemove={onRemove} />);
      await userEvent.setup().click(screen.getByRole("button", { name: /remove/i }));
      expect(onRemove).toHaveBeenCalledTimes(1);
    });
  });

  describe("kind: person", () => {
    it("renders the display name and a person icon", () => {
      render(<EntityPill kind={{ type: "person", name: "Ada Lovelace" }} />);
      expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
      expect(screen.getByTestId("entity-pill-icon")).toHaveAttribute("data-kind", "person");
    });
  });

  describe("kind: image", () => {
    it("renders a thumbnail and (optionally) a remove button instead of an icon + label", () => {
      render(
        <EntityPill
          kind={{ type: "image", name: "shot.png", dataUrl: "data:image/png;base64,iVB" }}
          onRemove={vi.fn<() => void>()}
        />,
      );
      const img = screen.getByTestId("file-preview-img");
      expect(img).toHaveAttribute("src", "data:image/png;base64,iVB");
      expect(img).toHaveAttribute("alt", "shot.png");
      expect(screen.queryByTestId("entity-pill-icon")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /remove shot\.png/i })).toBeInTheDocument();
    });
  });

  describe("size variant", () => {
    it("forwards size=md to the icon by default", () => {
      render(<EntityPill kind={{ type: "person", name: "Ada" }} />);
      expect(screen.getByTestId("entity-pill-icon")).toHaveAttribute("data-size", "md");
    });

    it("forwards size=sm and skips the remove button affordance even when onRemove is set", () => {
      render(
        <EntityPill
          kind={{ type: "person", name: "Ada" }}
          size="sm"
          onRemove={vi.fn<() => void>()}
        />,
      );
      expect(screen.getByTestId("entity-pill-icon")).toHaveAttribute("data-size", "sm");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.getByTestId("file-preview")).toHaveClass("h-6");
    });
  });
});
