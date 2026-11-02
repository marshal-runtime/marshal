import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { render, screen } from "@/test-utils";

import { DismissibleNotice } from "./dismissible-notice";

describe("DismissibleNotice", () => {
  it("keeps the same notice dismissed and shows a distinct notice", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DismissibleNotice noticeKey="first">
        <span>First notice</span>
      </DismissibleNotice>,
    );

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("First notice")).not.toBeInTheDocument();

    rerender(
      <DismissibleNotice noticeKey="first">
        <span>First notice</span>
      </DismissibleNotice>,
    );
    expect(screen.queryByText("First notice")).not.toBeInTheDocument();

    rerender(
      <DismissibleNotice noticeKey="second">
        <span>Second notice</span>
      </DismissibleNotice>,
    );
    expect(screen.getByText("Second notice")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});
