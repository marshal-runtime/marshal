import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SearchBar } from "./SearchBar";
import type { SearchState } from "./state/useFileSearch";

function makeState(overrides: Partial<SearchState> = {}): SearchState {
  return {
    isOpen: true,
    query: "",
    options: { caseSensitive: false, wholeWord: false, useRegex: false },
    matchCount: 0,
    currentMatch: -1,
    regexError: null,
    matchLimitHit: false,
    ...overrides,
  };
}

function setup(stateOverrides: Partial<SearchState> = {}) {
  const props = {
    onQueryChange: vi.fn<(q: string) => void>(),
    onNext: vi.fn<() => void>(),
    onPrev: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
    onToggleOption: vi.fn<(o: "caseSensitive" | "wholeWord" | "useRegex") => void>(),
  };
  const state = makeState(stateOverrides);
  const user = userEvent.setup();
  render(<SearchBar state={state} {...props} />);
  return { props, user };
}

describe("SearchBar", () => {
  it("renders nothing when isOpen is false", () => {
    setup({ isOpen: false });
    expect(screen.queryByTestId("search-bar")).toBeNull();
  });

  it("renders when isOpen is true", () => {
    setup();
    expect(screen.getByTestId("search-bar")).toBeInTheDocument();
  });

  it("shows the find input with placeholder", () => {
    setup();
    expect(screen.getByPlaceholderText("Find")).toBeInTheDocument();
  });

  it("displays match count when matches exist", () => {
    setup({ query: "test", matchCount: 5, currentMatch: 2 });
    expect(screen.getByTestId("search-match-count")).toHaveTextContent("3 of 5");
  });

  it("displays match count with + suffix when limit is hit", () => {
    setup({ query: "a", matchCount: 10000, currentMatch: 0, matchLimitHit: true });
    expect(screen.getByTestId("search-match-count")).toHaveTextContent("1 of 10000+");
  });

  it("displays 'No results' when query has no matches", () => {
    setup({ query: "xyz", matchCount: 0 });
    expect(screen.getByTestId("search-match-count")).toHaveTextContent("No results");
  });

  it("displays regex error when regex is invalid", () => {
    setup({ query: "[", regexError: "Invalid regular expression" });
    expect(screen.getByTestId("search-match-count")).toHaveTextContent("Invalid regex");
  });

  it("calls onQueryChange when typing in find input", async () => {
    const { props, user } = setup();
    await user.type(screen.getByTestId("search-input"), "a");
    expect(props.onQueryChange).toHaveBeenCalledWith("a");
  });

  it("calls onNext on Enter in find input", async () => {
    const { props, user } = setup({ query: "test", matchCount: 3, currentMatch: 0 });
    await user.type(screen.getByTestId("search-input"), "{Enter}");
    expect(props.onNext).toHaveBeenCalled();
  });

  it("calls onPrev on Shift+Enter in find input", async () => {
    const { props, user } = setup({ query: "test", matchCount: 3, currentMatch: 1 });
    await user.type(screen.getByTestId("search-input"), "{Shift>}{Enter}{/Shift}");
    expect(props.onPrev).toHaveBeenCalled();
  });

  it("calls onClose on Escape in find input", async () => {
    const { props, user } = setup();
    await user.type(screen.getByTestId("search-input"), "{Escape}");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("calls onClose when close button is clicked", async () => {
    const { props, user } = setup();
    await user.click(screen.getByTestId("search-close"));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("disables prev/next buttons when matchCount is 0", () => {
    setup({ query: "x", matchCount: 0 });
    expect(screen.getByLabelText("Previous match")).toBeDisabled();
    expect(screen.getByLabelText("Next match")).toBeDisabled();
  });

  it("enables prev/next buttons when matches exist", () => {
    setup({ query: "test", matchCount: 3, currentMatch: 0 });
    expect(screen.getByLabelText("Previous match")).toBeEnabled();
    expect(screen.getByLabelText("Next match")).toBeEnabled();
  });

  it("prev/next buttons call props when clicked", async () => {
    const { props, user } = setup({ query: "test", matchCount: 3, currentMatch: 0 });
    await user.click(screen.getByLabelText("Next match"));
    expect(props.onNext).toHaveBeenCalled();
    await user.click(screen.getByLabelText("Previous match"));
    expect(props.onPrev).toHaveBeenCalled();
  });

  it("calls onToggleOption('caseSensitive') when Aa button is clicked", async () => {
    const { props, user } = setup();
    await user.click(screen.getByTitle("Match Case"));
    expect(props.onToggleOption).toHaveBeenCalledWith("caseSensitive");
  });

  it("calls onToggleOption('wholeWord') when ab button is clicked", async () => {
    const { props, user } = setup();
    await user.click(screen.getByTitle("Match Whole Word"));
    expect(props.onToggleOption).toHaveBeenCalledWith("wholeWord");
  });

  it("calls onToggleOption('useRegex') when .* button is clicked", async () => {
    const { props, user } = setup();
    await user.click(screen.getByTitle("Use Regular Expression"));
    expect(props.onToggleOption).toHaveBeenCalledWith("useRegex");
  });
});
