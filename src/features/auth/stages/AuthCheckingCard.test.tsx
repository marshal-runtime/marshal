import { describe, it, expect } from "vitest";

import { render, screen } from "@/test-utils";

import { AuthCheckingCard } from "./AuthCheckingCard";

describe("AuthCheckingCard", () => {
  it("renders the checking message", () => {
    render(<AuthCheckingCard />);
    expect(screen.getByText("Checking authentication...")).toBeInTheDocument();
  });

  it("announces the checking state once through the shell live region", () => {
    render(<AuthCheckingCard />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Checking authentication");
  });
});
