// Marshal-owned module.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import { HotkeysRoot } from "@/features/hotkeys";
import type { MessageQuestion } from "@/types/electron";

import { InlineQuestion } from "./InlineQuestion";

const noop = vi.fn<() => void>();

const QUESTION: MessageQuestion = {
  question: "What database should I use?",
  answers: [
    { title: "PostgreSQL", description: "Best for relational data" },
    { title: "MongoDB", description: "Good for document-oriented data" },
    { title: "SQLite" },
  ],
  recommendedIndex: 0,
};

describe("InlineQuestion", () => {
  it("renders the question text", () => {
    render(<InlineQuestion question={QUESTION} onSelect={noop} />);
    expect(screen.getByText("What database should I use?")).toBeInTheDocument();
  });

  it("renders all answer titles with letter badges", () => {
    render(<InlineQuestion question={QUESTION} onSelect={noop} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("PostgreSQL")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.getByText("MongoDB")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getByText("SQLite")).toBeInTheDocument();
  });

  it("renders descriptions when provided", () => {
    render(<InlineQuestion question={QUESTION} onSelect={noop} />);
    expect(screen.getByText("Best for relational data")).toBeInTheDocument();
    expect(screen.getByText("Good for document-oriented data")).toBeInTheDocument();
  });

  it("shows Recommended tag on the recommended answer", () => {
    render(<InlineQuestion question={QUESTION} onSelect={noop} />);
    expect(screen.getByText("Recommended")).toBeInTheDocument();
  });

  it("calls onSelect with letter-prefixed title when clicked", async () => {
    const onSelect = vi.fn<(answer: string) => void>();
    const user = userEvent.setup();
    render(<InlineQuestion question={QUESTION} onSelect={onSelect} />);
    await user.click(screen.getByText("MongoDB"));
    expect(onSelect).toHaveBeenCalledWith("B. MongoDB");
  });

  it("shows only selected answer with checkmark after selection", () => {
    const selected: MessageQuestion = {
      ...QUESTION,
      selectedAnswer: "A. PostgreSQL",
    };
    render(<InlineQuestion question={selected} onSelect={noop} />);
    expect(screen.getByTestId("inline-question-selected")).toBeInTheDocument();
    expect(screen.getByText("A. PostgreSQL")).toBeInTheDocument();
    expect(screen.queryByText("MongoDB")).not.toBeInTheDocument();
    expect(screen.queryByText("SQLite")).not.toBeInTheDocument();
  });

  it("shows Other freeform text after selection", () => {
    const selected: MessageQuestion = {
      ...QUESTION,
      selectedAnswer: "Other: I want to use Redis",
    };
    render(<InlineQuestion question={selected} onSelect={noop} />);
    expect(screen.getByText("Other: I want to use Redis")).toBeInTheDocument();
  });

  it("does not render answer buttons when already selected", () => {
    const selected: MessageQuestion = {
      ...QUESTION,
      selectedAnswer: "A. PostgreSQL",
    };
    render(<InlineQuestion question={selected} onSelect={noop} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("selects answer via keyboard letter shortcut", async () => {
    const onSelect = vi.fn<(answer: string) => void>();
    const user = userEvent.setup();
    render(
      <HotkeysRoot>
        <InlineQuestion question={QUESTION} onSelect={onSelect} />
      </HotkeysRoot>,
    );
    // Press 'b' for MongoDB (index 1)
    await user.keyboard("b");
    expect(onSelect).toHaveBeenCalledWith("B. MongoDB");
  });

  it("selects answer via shifted keyboard letter shortcut", async () => {
    const onSelect = vi.fn<(answer: string) => void>();
    const user = userEvent.setup();
    render(
      <HotkeysRoot>
        <InlineQuestion question={QUESTION} onSelect={onSelect} />
      </HotkeysRoot>,
    );

    await user.keyboard("{Shift>}b{/Shift}");

    expect(onSelect).toHaveBeenCalledWith("B. MongoDB");
  });

  it("selects answers with letter keys outside editable surfaces", async () => {
    const onSelect = vi.fn<(answer: string) => void>();
    const user = userEvent.setup();
    render(
      <HotkeysRoot>
        <InlineQuestion question={QUESTION} onSelect={onSelect} />
      </HotkeysRoot>,
    );

    await user.keyboard("b");

    expect(onSelect).toHaveBeenCalledWith("B. MongoDB");
  });

  it("does not fire keyboard shortcut when textarea is focused", async () => {
    const onSelect = vi.fn<(answer: string) => void>();
    const user = userEvent.setup();
    render(
      <HotkeysRoot>
        <InlineQuestion question={QUESTION} onSelect={onSelect} />
        <textarea data-testid="input" />
      </HotkeysRoot>,
    );
    // Focus the textarea first, then press a letter
    await user.click(screen.getByTestId("input"));
    await user.keyboard("a");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not fire keyboard shortcut when a contenteditable is focused", async () => {
    const onSelect = vi.fn<(answer: string) => void>();
    const user = userEvent.setup();
    render(
      <HotkeysRoot>
        <InlineQuestion question={QUESTION} onSelect={onSelect} />
        {/* Mirrors the Lexical-based chat input which renders a contenteditable div */}
        <div contentEditable data-testid="editor" suppressContentEditableWarning />
      </HotkeysRoot>,
    );
    await user.click(screen.getByTestId("editor"));
    await user.keyboard("a");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([
    ["Control", "{Control>}a{/Control}"],
    ["Meta", "{Meta>}a{/Meta}"],
    ["Alt", "{Alt>}a{/Alt}"],
  ])("does not fire keyboard shortcut for %s modifier combos", async (_modifier, shortcut) => {
    const onSelect = vi.fn<(answer: string) => void>();
    const user = userEvent.setup();
    render(
      <HotkeysRoot>
        <InlineQuestion question={QUESTION} onSelect={onSelect} />
      </HotkeysRoot>,
    );

    await user.keyboard(shortcut);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ignores letter keys while an input is focused", async () => {
    const onSelect = vi.fn<(answer: string) => void>();
    const user = userEvent.setup();
    render(
      <HotkeysRoot>
        <input aria-label="editing" />
        <InlineQuestion question={QUESTION} onSelect={onSelect} />
      </HotkeysRoot>,
    );

    screen.getByLabelText("editing").focus();
    await user.keyboard("a");

    expect(onSelect).not.toHaveBeenCalled();
  });
});
