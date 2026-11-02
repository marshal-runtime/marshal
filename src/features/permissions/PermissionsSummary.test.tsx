import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, userEvent } from "@/test-utils";
import type { PermissionsConfig } from "@/types/electron";

import { PermissionsSummary } from "./PermissionsSummary";

beforeEach(() => {
  installMockAPIs();
});

const defaultPermissions: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: [],
  tools: {},
  servers: {
    filesystem: { enabled: true, autoApprove: true },
    playwright: { enabled: true, autoApprove: false },
    shell: { enabled: true, autoApprove: false },
    "example-mcp": { enabled: true, autoApprove: false },
  },
};

function renderSummary(overrides: { permissions?: Partial<PermissionsConfig> } = {}) {
  const permissions = { ...defaultPermissions, ...overrides.permissions };
  const onManagePermissions = vi.fn<() => void>();

  render(
    <PermissionsSummary permissions={permissions} onManagePermissions={onManagePermissions} />,
  );

  return { onManagePermissions };
}

describe("PermissionsSummary", () => {
  it("renders server count summary", () => {
    renderSummary();
    expect(screen.getByText(/4\/4 servers enabled/)).toBeInTheDocument();
  });

  it("shows tool count when tools are approved", () => {
    renderSummary({
      permissions: { tools: { "tool:listEmails": true, "tool:sendEmail": true } },
    });
    expect(screen.getByText(/2 tool rules/)).toBeInTheDocument();
  });

  it("hides tool count when no tools approved", () => {
    renderSummary();
    expect(screen.queryByText(/tool rule/)).not.toBeInTheDocument();
  });

  it("shows shell pattern count", () => {
    renderSummary({ permissions: { allow: ["npm run *", "cat *"] } });
    expect(screen.getByText(/2 shell patterns/)).toBeInTheDocument();
  });

  it("excludes false tool values from count", () => {
    renderSummary({
      permissions: {
        tools: {
          "tool:listEmails": true,
          "tool:sendEmail": false,
          "tool:getEmail": true,
        },
      },
    });
    expect(screen.getByText(/2 tool rules/)).toBeInTheDocument();
  });

  it("shows read-only note when enabled", () => {
    renderSummary({ permissions: { autoApproveReadOnly: true } });
    expect(screen.getByText("Read-only operations auto-approved")).toBeInTheDocument();
  });

  it("clicking Manage Permissions calls onManagePermissions", async () => {
    const user = userEvent.setup();
    const { onManagePermissions } = renderSummary();
    await user.click(screen.getByText("Manage Permissions"));
    expect(onManagePermissions).toHaveBeenCalledTimes(1);
  });
});

describe("customizeDisabled", () => {
  it("renders Customize button disabled with tooltip when customizeDisabled is true", async () => {
    const user = userEvent.setup();
    render(
      <PermissionsSummary
        permissions={undefined}
        onManagePermissions={() => {}}
        onCustomize={() => {}}
        onReset={() => {}}
        customizeDisabled
        customizeTooltip="Test tooltip text"
      />,
    );
    const button = screen.getByRole("button", { name: /customize/i });
    expect(button).toBeDisabled();
    // Hover the wrapping span to surface the tooltip
    const wrapperSpan = button.closest("span");
    expect(wrapperSpan).not.toBeNull();
    await user.hover(wrapperSpan!); // eslint-disable-line @typescript-eslint/no-non-null-assertion
    const tooltipTexts = await screen.findAllByText(/Test tooltip text/i);
    expect(tooltipTexts.length).toBeGreaterThan(0);
  });

  it("renders Customize button enabled when customizeDisabled is false", () => {
    render(
      <PermissionsSummary
        permissions={undefined}
        onManagePermissions={() => {}}
        onCustomize={() => {}}
        onReset={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: /customize/i });
    expect(button).not.toBeDisabled();
  });
});
