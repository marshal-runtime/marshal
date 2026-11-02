// marshal-owned renderer test
import { fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { render, screen, act, userEvent } from "@/test-utils";

import { InteractiveTable } from "./InteractiveTable";

const SAMPLE_TABLE = ["| Name | Age |", "| --- | --- |", "| Alice | 30 |", "| Bob | 25 |"];

const SINGLE_COL_TABLE = ["| Name |", "| --- |", "| Alice |"];

const SINGLE_ROW_TABLE = ["| Name | Age |", "| --- | --- |", "| Alice | 30 |"];

const noop = () => {};
const identity = (text: string) => text;

function renderTable(lines: string[] = SAMPLE_TABLE, onUpdate: (lines: string[]) => void = noop) {
  return render(<InteractiveTable lines={lines} parseInlineRich={identity} onUpdate={onUpdate} />);
}

describe("InteractiveTable", () => {
  let user: ReturnType<typeof userEvent.setup>;
  beforeEach(() => {
    vi.clearAllMocks();
    user = userEvent.setup();
  });

  // ── Basic rendering ─────────────────────────────────────────────

  describe("basic rendering", () => {
    it("renders the correct number of header cells", () => {
      renderTable();
      const table = screen.getByRole("table");
      // Header row (not the drag-handle row) has th cells for Name and Age
      // eslint-disable-next-line testing-library/no-node-access
      const headerRow = table.querySelector("thead tr:nth-child(2)")!;
      // th cells: row-handle + Name + Age + pad = 4, data cells are Name + Age
      // eslint-disable-next-line testing-library/no-node-access
      const ths = headerRow.querySelectorAll("th[data-cell]");
      expect(ths).toHaveLength(2);
    });

    it("renders header text from the first line", () => {
      renderTable();
      expect(screen.getByText("Name")).toBeInTheDocument();
      expect(screen.getByText("Age")).toBeInTheDocument();
    });

    it("renders data cells from subsequent lines", () => {
      renderTable();
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByText("30")).toBeInTheDocument();
      expect(screen.getByText("Bob")).toBeInTheDocument();
      expect(screen.getByText("25")).toBeInTheDocument();
    });

    it("renders the correct number of data rows", () => {
      renderTable();
      // eslint-disable-next-line testing-library/no-node-access
      const tbody = document.querySelector("tbody")!;
      // data rows + "add row" row
      // eslint-disable-next-line testing-library/no-node-access
      const trs = tbody.querySelectorAll("tr");
      // 2 data rows + 1 add-row row = 3
      expect(trs).toHaveLength(3);
    });

    it("renders the add-row button", () => {
      renderTable();
      expect(screen.getByText("+ Add row")).toBeInTheDocument();
    });
  });

  // ── Cell editing ────────────────────────────────────────────────

  describe("cell editing", () => {
    it("clicking a data cell enters edit mode showing an input", async () => {
      renderTable();
      const cell = screen.getByText("Alice");
      await user.click(cell);
      const input = screen.getByRole<HTMLInputElement>("textbox");
      expect(input).toBeTruthy();
      expect(input.value).toBe("Alice");
    });

    it("typing in input changes the value", async () => {
      renderTable();
      await user.click(screen.getByText("Alice"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      await user.clear(input);
      await user.type(input, "Charlie");
      expect(input.value).toBe("Charlie");
    });

    it("blur saves the edit and calls onUpdate with updated markdown", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);

      await user.click(screen.getByText("Alice"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      await user.clear(input);
      await user.type(input, "Charlie");
      fireEvent.blur(input);

      expect(onUpdate).toHaveBeenCalledOnce();
      const updatedLines = onUpdate.mock.calls[0][0];
      expect(updatedLines[2]).toBe("| Charlie | 30 |");
      // Other lines unchanged
      expect(updatedLines[0]).toBe("| Name | Age |");
      expect(updatedLines[1]).toBe("| --- | --- |");
      expect(updatedLines[3]).toBe("| Bob | 25 |");
    });

    it("clicking a header cell enters edit mode", async () => {
      renderTable();
      await user.click(screen.getByText("Name"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      expect(input).toBeTruthy();
      expect(input.value).toBe("Name");
    });

    it("editing a header cell updates the header line", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);

      await user.click(screen.getByText("Name"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      await user.clear(input);
      await user.type(input, "Full Name");
      fireEvent.blur(input);

      expect(onUpdate).toHaveBeenCalledOnce();
      const updatedLines = onUpdate.mock.calls[0][0];
      expect(updatedLines[0]).toBe("| Full Name | Age |");
    });

    it("Escape cancels editing without calling onUpdate", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);

      await user.click(screen.getByText("Alice"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      await user.clear(input);
      await user.type(input, "Changed");
      await user.keyboard("{Escape}");

      expect(onUpdate).not.toHaveBeenCalled();
      // Input should be gone (edit mode cancelled)
      expect(screen.queryByRole("textbox")).toBeNull();
    });
  });

  // ── Keyboard navigation ─────────────────────────────────────────

  describe("keyboard navigation", () => {
    it("Tab commits the cell and moves to next cell", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);

      // Click first data cell (Alice at row 0, col 0)
      await user.click(screen.getByText("Alice"));

      // Press Tab
      await user.keyboard("{Tab}");

      // commitCell should have been called
      expect(onUpdate).toHaveBeenCalled();

      // After requestAnimationFrame, next cell should be in edit mode
      // Use a flush to process the rAF callback
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const nextInput = screen.getByRole<HTMLInputElement>("textbox");
      // Next cell should show "30" (row 0, col 1)
      expect(nextInput).toBeTruthy();
      expect(nextInput.value).toBe("30");
    });

    it("Shift+Tab moves to previous cell", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);

      // Click Age cell (row 0, col 1 → value "30")
      await user.click(screen.getByText("30"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      expect(input.value).toBe("30");

      await user.keyboard("{Shift>}{Tab}{/Shift}");

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const prevInput = screen.getByRole<HTMLInputElement>("textbox");
      expect(prevInput).toBeTruthy();
      expect(prevInput.value).toBe("Alice");
    });

    it("Enter commits and moves to cell below", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);

      // Click Alice (row 0, col 0)
      await user.click(screen.getByText("Alice"));

      await user.keyboard("{Enter}");

      expect(onUpdate).toHaveBeenCalled();

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const nextInput = screen.getByRole<HTMLInputElement>("textbox");
      // Cell below Alice is Bob (row 1, col 0)
      expect(nextInput).toBeTruthy();
      expect(nextInput.value).toBe("Bob");
    });

    it("ArrowDown moves to cell below", async () => {
      renderTable(SAMPLE_TABLE);
      await user.click(screen.getByText("Alice"));
      await user.keyboard("{ArrowDown}");

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const input = screen.getByRole<HTMLInputElement>("textbox");
      expect(input.value).toBe("Bob");
    });

    it("ArrowUp moves to cell above", async () => {
      renderTable(SAMPLE_TABLE);
      // Click Bob (row 1, col 0)
      await user.click(screen.getByText("Bob"));
      await user.keyboard("{ArrowUp}");

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const input = screen.getByRole<HTMLInputElement>("textbox");
      expect(input.value).toBe("Alice");
    });

    it("ArrowUp from data row 0 moves to header row", async () => {
      renderTable(SAMPLE_TABLE);
      await user.click(screen.getByText("Alice"));
      await user.keyboard("{ArrowUp}");

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const input = screen.getByRole<HTMLInputElement>("textbox");
      // Header row, col 0 = "Name"
      expect(input.value).toBe("Name");
    });

    it("ArrowUp on header row is a no-op (stays in edit mode)", async () => {
      renderTable(SAMPLE_TABLE);
      // Click header cell "Name"
      await user.click(screen.getByText("Name"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      expect(input.value).toBe("Name");

      await user.keyboard("{ArrowUp}");

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      // Should still be editing the same cell
      const stillInput = screen.getByRole<HTMLInputElement>("textbox");
      expect(stillInput.value).toBe("Name");
    });

    it("ArrowDown on last data row is a no-op (stays in edit mode)", async () => {
      renderTable(SAMPLE_TABLE);
      // Click Bob (last row, col 0)
      await user.click(screen.getByText("Bob"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      expect(input.value).toBe("Bob");

      await user.keyboard("{ArrowDown}");

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      // Should still be editing the same cell
      const stillInput = screen.getByRole<HTMLInputElement>("textbox");
      expect(stillInput.value).toBe("Bob");
    });

    it("ArrowLeft at position 0 moves to previous cell", async () => {
      renderTable(SAMPLE_TABLE);
      // Click "30" (row 0, col 1)
      await user.click(screen.getByText("30"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      expect(input.value).toBe("30");

      // Move cursor to position 0
      await user.keyboard("{Home}");
      await user.keyboard("{ArrowLeft}");

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const prevInput = screen.getByRole<HTMLInputElement>("textbox");
      expect(prevInput.value).toBe("Alice");
    });

    it("ArrowRight at end moves to next cell", async () => {
      renderTable(SAMPLE_TABLE);
      // Click "Alice" (row 0, col 0)
      await user.click(screen.getByText("Alice"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      expect(input.value).toBe("Alice");

      // Move cursor to end
      await user.keyboard("{End}");
      await user.keyboard("{ArrowRight}");

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const nextInput = screen.getByRole<HTMLInputElement>("textbox");
      expect(nextInput.value).toBe("30");
    });
  });

  // ── Add row / Add column buttons ────────────────────────────────

  describe("add row and column buttons", () => {
    it("clicking '+ Add row' appends a new empty row", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);

      await user.click(screen.getByText("+ Add row"));

      expect(onUpdate).toHaveBeenCalledOnce();
      const updatedLines = onUpdate.mock.calls[0][0];
      expect(updatedLines).toHaveLength(5); // original 4 + 1 new row
      expect(updatedLines[4]).toBe("|  |  |");
    });

    it("clicking '+' column button adds a column at end", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);

      // eslint-disable-next-line testing-library/no-node-access
      const addColBtn = document.querySelector<HTMLElement>("[data-add-col]")!;
      expect(addColBtn).toBeInstanceOf(HTMLElement);
      await user.click(addColBtn);

      expect(onUpdate).toHaveBeenCalledOnce();
      const updatedLines = onUpdate.mock.calls[0][0];
      // Each line should have 3 columns now
      expect(updatedLines[0]).toBe("| Name | Age | Header |");
      expect(updatedLines[1]).toBe("| --- | --- | --- |");
      expect(updatedLines[2]).toBe("| Alice | 30 |  |");
      expect(updatedLines[3]).toBe("| Bob | 25 |  |");
    });
  });

  // ── Context menu ────────────────────────────────────────────────

  describe("context menu", () => {
    async function openContextMenuOnCell(text: string) {
      const cell = screen.getByText(text);
      await user.pointer({ keys: "[MouseRight]", target: cell });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    }

    it("right-click on data cell opens context menu with row and column options", async () => {
      renderTable();
      await openContextMenuOnCell("Alice");

      // Column operations
      expect(screen.getByText("← Insert column left")).toBeInTheDocument();
      expect(screen.getByText("→ Insert column right")).toBeInTheDocument();
      expect(screen.getByText("✕ Delete column")).toBeInTheDocument();
      // Row operations (visible because row >= 0)
      expect(screen.getByText("↑ Insert row above")).toBeInTheDocument();
      expect(screen.getByText("↓ Insert row below")).toBeInTheDocument();
      expect(screen.getByText("✕ Delete row")).toBeInTheDocument();
    });

    it("'← Insert column left' calls onUpdate with extra column before", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);
      await openContextMenuOnCell("Alice");

      await user.click(screen.getByText("← Insert column left"));

      expect(onUpdate).toHaveBeenCalledOnce();
      const updatedLines = onUpdate.mock.calls[0][0];
      // Column inserted at index 0 (before col 0)
      expect(updatedLines[0]).toBe("| Header | Name | Age |");
      expect(updatedLines[1]).toBe("| --- | --- | --- |");
      expect(updatedLines[2]).toBe("|  | Alice | 30 |");
    });

    it("'→ Insert column right' calls onUpdate with extra column after", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);
      await openContextMenuOnCell("Alice");

      await user.click(screen.getByText("→ Insert column right"));

      expect(onUpdate).toHaveBeenCalledOnce();
      const updatedLines = onUpdate.mock.calls[0][0];
      // Column inserted after col 0
      expect(updatedLines[0]).toBe("| Name | Header | Age |");
      expect(updatedLines[1]).toBe("| --- | --- | --- |");
      expect(updatedLines[2]).toBe("| Alice |  | 30 |");
    });

    it("'✕ Delete row' removes the row", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);
      await openContextMenuOnCell("Alice");

      await user.click(screen.getByText("✕ Delete row"));

      expect(onUpdate).toHaveBeenCalledOnce();
      const updatedLines = onUpdate.mock.calls[0][0];
      expect(updatedLines).toHaveLength(3); // header + sep + 1 data row
      expect(updatedLines[2]).toBe("| Bob | 25 |");
    });

    it("'✕ Delete column' removes the column", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);
      await openContextMenuOnCell("Alice");

      await user.click(screen.getByText("✕ Delete column"));

      expect(onUpdate).toHaveBeenCalledOnce();
      const updatedLines = onUpdate.mock.calls[0][0];
      expect(updatedLines[0]).toBe("| Age |");
      expect(updatedLines[2]).toBe("| 30 |");
    });

    it("'↑ Insert row above' inserts a row before current", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);
      // Right-click on Bob (row index 1)
      await openContextMenuOnCell("Bob");

      await user.click(screen.getByText("↑ Insert row above"));

      expect(onUpdate).toHaveBeenCalledOnce();
      const updatedLines = onUpdate.mock.calls[0][0];
      expect(updatedLines).toHaveLength(5);
      // New empty row inserted at index 3 (before Bob who was at line index 3)
      expect(updatedLines[3]).toBe("|  |  |");
      expect(updatedLines[4]).toBe("| Bob | 25 |");
    });

    it("'↓ Insert row below' inserts a row after current", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);
      await openContextMenuOnCell("Alice");

      await user.click(screen.getByText("↓ Insert row below"));

      expect(onUpdate).toHaveBeenCalledOnce();
      const updatedLines = onUpdate.mock.calls[0][0];
      expect(updatedLines).toHaveLength(5);
      expect(updatedLines[2]).toBe("| Alice | 30 |");
      expect(updatedLines[3]).toBe("|  |  |");
      expect(updatedLines[4]).toBe("| Bob | 25 |");
    });

    it("delete column is disabled when only 1 column", async () => {
      renderTable(SINGLE_COL_TABLE);
      await openContextMenuOnCell("Alice");

      const deleteCol = screen.getByText("✕ Delete column");
      // eslint-disable-next-line testing-library/no-node-access
      expect(deleteCol.closest("button")).toBeDisabled();
    });

    it("delete row is disabled when only 1 data row", async () => {
      renderTable(SINGLE_ROW_TABLE);
      await openContextMenuOnCell("Alice");

      const deleteRow = screen.getByText("✕ Delete row");
      // eslint-disable-next-line testing-library/no-node-access
      expect(deleteRow.closest("button")).toBeDisabled();
    });

    it("context menu opens on right-click and closes on Escape", async () => {
      renderTable();
      // Menu should not exist initially
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      // Right-click a cell to open
      await openContextMenuOnCell("Alice");
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0);

      // Press Escape to close
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  // ── Serialization ───────────────────────────────────────────────

  describe("serialization", () => {
    it("editing preserves all non-edited lines", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);

      await user.click(screen.getByText("25"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      await user.clear(input);
      await user.type(input, "26");
      fireEvent.blur(input);

      const updatedLines = onUpdate.mock.calls[0][0];
      expect(updatedLines[0]).toBe(SAMPLE_TABLE[0]);
      expect(updatedLines[1]).toBe(SAMPLE_TABLE[1]);
      expect(updatedLines[2]).toBe(SAMPLE_TABLE[2]);
      expect(updatedLines[3]).toBe("| Bob | 26 |");
    });

    it("produces valid markdown pipe table format", async () => {
      const onUpdate = vi.fn<(lines: string[]) => void>();
      renderTable(SAMPLE_TABLE, onUpdate);

      await user.click(screen.getByText("Alice"));
      const input = screen.getByRole<HTMLInputElement>("textbox");
      await user.clear(input);
      await user.type(input, "Alice Smith");
      fireEvent.blur(input);

      const updatedLines = onUpdate.mock.calls[0][0];
      // Every line should start with | and end with |
      for (const line of updatedLines) {
        expect(line).toMatch(/^\|.*\|$/);
      }
    });
  });
});
