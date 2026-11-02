import { ChevronDown, ChevronUp, X } from "@/components/icons";
import { useEffect, useRef } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { Toggle } from "@/components/marshal-ui/toggle";

import type { SearchOptions, SearchState } from "./state/useFileSearch";

interface SearchBarProps {
  state: SearchState;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  onToggleOption: (option: keyof SearchOptions) => void;
}

export function SearchBar({
  state,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
  onToggleOption,
}: SearchBarProps) {
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.isOpen) {
      requestAnimationFrame(() => findInputRef.current?.focus());
    }
  }, [state.isOpen]);

  if (!state.isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    }
  };

  const matchCountDisplay = state.matchLimitHit ? `${state.matchCount}+` : `${state.matchCount}`;
  const matchLabel =
    state.query && state.matchCount > 0
      ? `${state.currentMatch + 1} of ${matchCountDisplay}`
      : state.query && !state.regexError
        ? "No results"
        : "";

  return (
    <div
      role="search"
      className="z-40 flex w-fit items-center gap-1 rounded-b-md border border-t-0 border-border bg-popover px-2 py-1.5 shadow-md"
      data-testid="search-bar"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="relative flex items-center">
        <input
          ref={findInputRef}
          type="text"
          className={`h-[26px] w-[180px] rounded-sm border bg-background px-2 pr-[76px] text-xs text-foreground outline-none placeholder:text-muted-foreground ${
            state.regexError ? "border-destructive" : "border-border focus:border-primary"
          }`}
          placeholder="Find"
          aria-label="Find"
          value={state.query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          data-testid="search-input"
          spellCheck={false}
          autoComplete="off"
        />
        <div className="absolute right-1 flex gap-0.5">
          <Toggle
            size="sm"
            variant="outline"
            pressed={state.options.caseSensitive}
            onPressedChange={() => onToggleOption("caseSensitive")}
            title="Match Case"
            className="h-[20px] min-w-[24px] px-1 text-[11px]"
          >
            Aa
          </Toggle>
          <Toggle
            size="sm"
            variant="outline"
            pressed={state.options.wholeWord}
            onPressedChange={() => onToggleOption("wholeWord")}
            title="Match Whole Word"
            className="h-[20px] min-w-[24px] px-1 text-[11px]"
          >
            ab
          </Toggle>
          <Toggle
            size="sm"
            variant="outline"
            pressed={state.options.useRegex}
            onPressedChange={() => onToggleOption("useRegex")}
            title="Use Regular Expression"
            className="h-[20px] min-w-[24px] px-1 text-[11px]"
          >
            .*
          </Toggle>
        </div>
      </div>

      <span
        className="min-w-[64px] text-center text-[11px] text-muted-foreground"
        data-testid="search-match-count"
        aria-live="polite"
      >
        {state.regexError ? (
          <span className="text-destructive" title={state.regexError}>
            Invalid regex
          </span>
        ) : (
          matchLabel
        )}
      </span>

      <Button
        variant="ghost"
        size="icon-xs"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPrev}
        disabled={state.matchCount === 0}
        title="Previous Match (Shift+Enter)"
        aria-label="Previous match"
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onNext}
        disabled={state.matchCount === 0}
        title="Next Match (Enter)"
        aria-label="Next match"
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onClose}
        title="Close (Escape)"
        aria-label="Close search"
        data-testid="search-close"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
