import { beforeEach, describe, expect, it } from "vitest";

import { installMockAPIs, render, screen, userEvent } from "@/test-utils";

import { SERVICE_TERMS_URL } from "./legal-links";
import { TermsFooter } from "./TermsFooter";

beforeEach(() => {
  installMockAPIs();
});

describe("TermsFooter", () => {
  it("opens the service terms in the default browser", async () => {
    const user = userEvent.setup();
    render(<TermsFooter />);

    await user.click(screen.getByRole("button", { name: "Terms of Service" }));
    expect(window.shellAPI?.openExternal).toHaveBeenCalledWith(SERVICE_TERMS_URL);
  });

  it("does not expose provider-specific legal branding", () => {
    render(<TermsFooter />);
    expect(screen.getByRole("button", { name: "Terms of Service" })).toBeInTheDocument();
  });
});
