// marshal-owned renderer test
import { beforeEach, describe, expect, it } from "vitest";

import { installMockAPIs, render, screen } from "@/test-utils";

import { PersonAvatar } from "./PersonAvatar";

beforeEach(() => {
  installMockAPIs();
});

describe("PersonAvatar", () => {
  it("renders the User icon fallback when no email or displayName is provided", async () => {
    render(<PersonAvatar size={32} />);
    const fallback = await screen.findByTestId("persona-avatar-fallback");
    expect(fallback.querySelector("svg")).not.toBeNull();
  });

  it("renders the User icon fallback when only an email is provided", async () => {
    render(<PersonAvatar email="x@y.com" size={32} />);
    const fallback = await screen.findByTestId("persona-avatar-fallback");
    expect(fallback.querySelector("svg")).not.toBeNull();
  });

  it("renders initials when displayName is provided", async () => {
    render(<PersonAvatar email="dino@example.com" displayName="Dino Ilic" size={32} />);
    const fallback = await screen.findByTestId("persona-avatar-fallback");
    expect(fallback.textContent).toBe("DI");
  });

  it("applies a deterministic color class to the initials fallback", async () => {
    const { unmount } = render(
      <PersonAvatar email="dino@example.com" displayName="Dino Ilic" size={32} />,
    );
    const first = await screen.findByTestId("persona-avatar-fallback");
    const firstClasses = first.className;
    unmount();
    render(<PersonAvatar email="dino@example.com" displayName="Dino Ilic" size={32} />);
    const second = await screen.findByTestId("persona-avatar-fallback");
    expect(second.className).toBe(firstClasses);
    // Sanity: the colored class includes a Tailwind `bg-` token from the palette.
    expect(firstClasses).toMatch(/\bbg-\w+-100\b/);
  });
});
