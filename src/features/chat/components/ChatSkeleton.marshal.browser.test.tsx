// marshal-owned renderer test
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChatSkeleton } from "./ChatSkeleton";

describe("ChatSkeleton", () => {
  it("renders three skeleton bubbles", () => {
    render(<ChatSkeleton />);
    expect(screen.getByTestId("chat-skeleton")).toBeInTheDocument();
    expect(screen.getAllByTestId("chat-skeleton-bubble")).toHaveLength(3);
  });

  it("renders no interactive elements", () => {
    render(<ChatSkeleton />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
