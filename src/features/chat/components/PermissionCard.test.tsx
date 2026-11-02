import { describe, it, expect, vi, beforeEach } from "vitest";

import { SERVICE_TERMS_URL } from "@/features/auth/legal-links";
import { installMockAPIs, render, screen, userEvent } from "@/test-utils";
import type { PermissionCardData } from "@/types/electron";

import { PermissionCard } from "./PermissionCard";

beforeEach(() => {
  installMockAPIs();
});

const makeRequest = (overrides: Partial<PermissionCardData> = {}): PermissionCardData => ({
  id: "perm-123",
  kind: "shell",
  title: "Run a Command",
  message: "Marshal wants to run a terminal command",
  detail: "npm test",
  buttons: ["Allow", "Allow for session", "Always allow", "Deny"],
  ...overrides,
});

async function openScopeMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Choose access scope" }));
}

describe("PermissionCard", () => {
  it("labels the forget-completely card as erasing memory permanently", () => {
    const request = makeRequest({ kind: "settings", title: "Forget Memory Completely" });
    render(<PermissionCard request={request} onRespond={vi.fn<() => void>()} />);
    expect(screen.getByText("Erases memory permanently")).toBeInTheDocument();
  });

  it("renders card with correct title, message, and detail", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest()} onRespond={onRespond} />);

    expect(screen.getByText("Run a Command")).toBeInTheDocument();
    expect(screen.getByText("Marshal wants to run a terminal command")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  it("renders direct decisions and the access-scope selector when unresolved", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest()} onRespond={onRespond} />);

    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    await openScopeMenu(user);
    expect(screen.getByRole("menuitem", { name: /This session/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /All chats/ })).toBeInTheDocument();
  });

  it("preserves newlines in message via whitespace-pre-wrap", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({ message: 'Update event\nNew subject: "Test"\nAttendees: a@b.com' })}
        onRespond={onRespond}
      />,
    );
    const messageEl = screen.getByText(/Update event/);
    expect(messageEl).toHaveClass("whitespace-pre-wrap");
    expect(messageEl.textContent).toContain("New subject:");
    expect(messageEl.textContent).toContain("Attendees:");
  });

  it("clicking Allow calls onRespond with 'allow' action", async () => {
    const ue = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest()} onRespond={onRespond} />);

    await ue.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onRespond).toHaveBeenCalledWith("perm-123", "allow");
  });

  it("clicking Deny calls onRespond with Deny action", async () => {
    const ue = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest()} onRespond={onRespond} />);

    await ue.click(screen.getByRole("button", { name: "Not now" }));
    expect(onRespond).toHaveBeenCalledWith("perm-123", "deny");
  });

  it("shows running state when allowed without output", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest({ resolved: "allowed" })} onRespond={onRespond} />);

    expect(screen.queryByText("Deny")).not.toBeInTheDocument();
    expect(screen.getByText("Run a Command")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByTestId("running-bar")).toBeInTheDocument();
  });

  it("shows completed state when allowed with output", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({ resolved: "allowed", output: "all tests passed" })}
        onRespond={onRespond}
      />,
    );

    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.getByText("Run a Command")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
  });

  it("shows resolved denied state with no buttons but detail visible", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest({ resolved: "denied" })} onRespond={onRespond} />);

    expect(screen.queryByText("Allow")).not.toBeInTheDocument();
    expect(screen.queryByText("Allow everywhere")).not.toBeInTheDocument();
    expect(screen.getByText("Run a Command")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  it("shows output toggle when allowed with output", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({ resolved: "allowed", output: "test output result" })}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText("Output")).toBeInTheDocument();
    // Output preview visible by default (short output shown inline)
    expect(screen.getByText("test output result")).toBeInTheDocument();
  });

  it("expands output on toggle click", async () => {
    const ue = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    const longOutput = "x".repeat(200);
    render(
      <PermissionCard
        request={makeRequest({ resolved: "allowed", output: longOutput })}
        onRespond={onRespond}
      />,
    );

    // Long output shows truncated preview
    const toggleBtn = screen.getByTestId("output-toggle");
    expect(toggleBtn).toBeInTheDocument();
    expect(screen.getByTestId("output-preview")).toBeInTheDocument();

    // Click toggle to expand
    await ue.click(toggleBtn);

    // Full output now visible in the output container
    const outputEl = screen.getByTestId("output-full");
    expect(outputEl).toBeInTheDocument();
    expect(outputEl.textContent).toBe(longOutput);
    // Preview should be gone
    expect(screen.queryByTestId("output-preview")).not.toBeInTheDocument();
  });

  it("renders detail in monospace block", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard request={makeRequest({ detail: "git status" })} onRespond={onRespond} />,
    );

    const detail = screen.getByText("git status");
    // Now uses Tailwind classes with a <pre> element for monospace
    expect(detail.tagName).toBe("PRE");
    expect(detail.className).toContain("font-mono");
  });

  it("does not repeat sdkWarning in the desktop detail block", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({
          detail: "npm test\n\nWarning: This command touches the working tree.",
          sdkWarning: "This command touches the working tree.",
        })}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText("This command touches the working tree.")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(
      screen.queryByText("Warning: This command touches the working tree."),
    ).not.toBeInTheDocument();
  });

  it("shows sdkWarning once and strips the trailing 'Warning: …' suffix from detail", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({
          detail: "git push --force\n\nWarning: Modifies tracked files.",
          sdkWarning: "Modifies tracked files.",
        })}
        onRespond={onRespond}
      />,
    );

    expect(screen.getAllByText("Modifies tracked files.")).toHaveLength(1);
    expect(screen.getByTestId("sdk-warning-alert")).toBeInTheDocument();
    expect(screen.queryByText(/Warning: Modifies/)).not.toBeInTheDocument();
  });

  it("shows short detail inline without expand button", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest({ detail: "npm test" })} onRespond={onRespond} />);

    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.queryByText("Expand details")).not.toBeInTheDocument();
  });

  it("truncates long detail and shows expand button", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    const longDetail = "x".repeat(300);
    render(<PermissionCard request={makeRequest({ detail: longDetail })} onRespond={onRespond} />);

    // Should show truncated preview, not full text
    expect(screen.queryByText(longDetail)).not.toBeInTheDocument();
    expect(screen.getByText("Expand details")).toBeInTheDocument();

    // Preview should be height-capped to prevent card bloat
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.className).toContain("max-h-40");
    expect(pre!.className).toContain("overflow-hidden");
  });

  it("expand button opens dialog with full detail", async () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    const longDetail = "Name: Test\n\nPrompt:\n" + "Check everything. ".repeat(30);
    render(
      <PermissionCard
        request={makeRequest({ detail: longDetail, title: "⚙️ Create Automation" })}
        onRespond={onRespond}
      />,
    );

    const expandBtn = screen.getByText("Expand details");
    await userEvent.click(expandBtn);

    // Dialog should contain the full prompt text (use role to find the dialog)
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.textContent).toContain("Check everything.");
    expect(dialog.textContent).toContain("Name: Test");

    // Dialog content should be scrollable for long prompts
    const pre = dialog.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.className).toContain("overflow-auto");
    expect(pre!.className).toContain("min-h-0");

    // Dialog should use responsive width (sm:max-w-2xl, not base sm:max-w-sm)
    const dialogContent = dialog.closest("[data-slot='dialog-content']");
    expect(dialogContent).not.toBeNull();
    expect(dialogContent!.className).toContain("sm:max-w-2xl");
  });

  it("uses correct data-kind attribute for different kinds", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();

    const { unmount: u1 } = render(
      <PermissionCard request={makeRequest({ kind: "shell" })} onRespond={onRespond} />,
    );
    expect(
      screen.getByText("Run a Command").closest("[data-kind]")!.getAttribute("data-kind"),
    ).toBe("shell");
    u1();

    const { unmount: u2 } = render(
      <PermissionCard request={makeRequest({ kind: "write" })} onRespond={onRespond} />,
    );
    expect(
      screen.getByText("Run a Command").closest("[data-kind]")!.getAttribute("data-kind"),
    ).toBe("write");
    u2();

    const { unmount: u3 } = render(
      <PermissionCard request={makeRequest({ kind: "mcp" })} onRespond={onRespond} />,
    );
    expect(
      screen.getByText("Run a Command").closest("[data-kind]")!.getAttribute("data-kind"),
    ).toBe("mcp");
    u3();

    const { unmount: u4 } = render(
      <PermissionCard request={makeRequest({ kind: "url" })} onRespond={onRespond} />,
    );
    expect(
      screen.getByText("Run a Command").closest("[data-kind]")!.getAttribute("data-kind"),
    ).toBe("url");
    u4();

    const { unmount: u5 } = render(
      <PermissionCard request={makeRequest({ kind: "read" })} onRespond={onRespond} />,
    );
    expect(
      screen.getByText("Run a Command").closest("[data-kind]")!.getAttribute("data-kind"),
    ).toBe("read");
    u5();

    const { unmount: u6 } = render(
      <PermissionCard request={makeRequest({ kind: "memory" })} onRespond={onRespond} />,
    );
    expect(
      screen.getByText("Run a Command").closest("[data-kind]")!.getAttribute("data-kind"),
    ).toBe("memory");
    u6();

    const { unmount: u7 } = render(
      <PermissionCard request={makeRequest({ kind: "hook" })} onRespond={onRespond} />,
    );
    expect(
      screen.getByText("Run a Command").closest("[data-kind]")!.getAttribute("data-kind"),
    ).toBe("hook");
    u7();
  });

  it("shows kind label in unresolved card", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest({ kind: "shell" })} onRespond={onRespond} />);
    expect(screen.getByText("Command")).toBeInTheDocument();
  });

  it("shows kind label for write kind", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest({ kind: "write" })} onRespond={onRespond} />);
    expect(screen.getByText("File Edit")).toBeInTheDocument();
  });

  it("shows kind label for read kind", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest({ kind: "read" })} onRespond={onRespond} />);
    expect(screen.getByText("File Read")).toBeInTheDocument();
  });

  it("shows kind label for memory kind", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest({ kind: "memory" })} onRespond={onRespond} />);
    expect(screen.getByText("Memory")).toBeInTheDocument();
  });

  it("shows kind label for hook kind", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest({ kind: "hook" })} onRespond={onRespond} />);
    expect(screen.getByText("Hook")).toBeInTheDocument();
  });

  it("renders a subtle browser-use EULA link for Browser Control prompts", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({ kind: "url", browserUseDisclosure: true })}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText(/Browser Control can interact with sites/i)).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Learn about browser use" }));

    expect(window.shellAPI?.openExternal).toHaveBeenCalledWith(SERVICE_TERMS_URL);
  });

  it("does not render browser-use disclosure for non-browser prompts", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({ kind: "shell", browserUseDisclosure: false })}
        onRespond={onRespond}
      />,
    );

    expect(screen.queryByText(/Browser Control can interact with sites/i)).not.toBeInTheDocument();
  });

  it("shows allowed state when resolved with empty output", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({ resolved: "allowed", output: "" })}
        onRespond={onRespond}
      />,
    );

    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.getByTestId("resolved-badge")).toBeInTheDocument();
    expect(screen.getByTestId("resolved-badge").textContent).toContain("Allowed");
    expect(screen.queryByTestId("running-bar")).not.toBeInTheDocument();
  });

  it("shows failed state even with empty output", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({ resolved: "failed", output: "" })}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByTestId("running-bar")).not.toBeInTheDocument();
  });

  it("shows failed state with warning badge and output", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({ resolved: "failed", output: "Error: command not found" })}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByTestId("resolved-badge").textContent).toContain("Failed");
    expect(screen.queryByTestId("running-bar")).not.toBeInTheDocument();
  });

  it("clicking 'Allow for session' calls onRespond with allow-session", async () => {
    const ue = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest()} onRespond={onRespond} />);

    await openScopeMenu(ue);
    await ue.click(screen.getByRole("menuitem", { name: /This session/ }));
    expect(onRespond).toHaveBeenCalledWith("perm-123", "allow-session", undefined);
  });

  it("clicking 'Allow everywhere' calls onRespond with always-allow", async () => {
    const ue = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest()} onRespond={onRespond} />);

    await openScopeMenu(ue);
    await ue.click(screen.getByRole("menuitem", { name: /All chats/ }));
    expect(onRespond).toHaveBeenCalledWith("perm-123", "always-allow", undefined);
  });

  it("clicking 'Allow everywhere' calls onRespond with always-allow (with explicit buttons array)", async () => {
    const ue = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({
          buttons: ["Allow", "Allow for session", "Always allow", "Deny"],
        })}
        onRespond={onRespond}
      />,
    );

    await openScopeMenu(ue);
    await ue.click(screen.getByRole("menuitem", { name: /All chats/ }));
    expect(onRespond).toHaveBeenCalledWith("perm-123", "always-allow", undefined);
  });

  it("exposes a dismiss control for a timed-out resolved state", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    const onDismiss = vi.fn<(requestId: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({ resolved: "timed-out" })}
        onRespond={onRespond}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByTestId("permission-card").getAttribute("data-resolved")).toBe("timed-out");
    await user.click(screen.getByRole("button", { name: "Dismiss timed out tool notice" }));
    expect(onDismiss).toHaveBeenCalledWith("perm-123");
  });

  it("renders with empty buttons array without crashing", () => {
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(<PermissionCard request={makeRequest({ buttons: [] })} onRespond={onRespond} />);

    expect(screen.getByText("Run a Command")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose access scope" })).not.toBeInTheDocument();
  });

  it("legacy button 'Auto-allow safe commands' maps to allow-type", async () => {
    const ue = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({
          buttons: ["Allow", "Auto-allow safe commands", "Deny"],
        })}
        onRespond={onRespond}
      />,
    );

    await openScopeMenu(ue);
    await ue.click(screen.getByRole("menuitem", { name: /Similar safe actions/ }));
    expect(onRespond).toHaveBeenCalledWith("perm-123", "allow-type", undefined);
  });

  it("falls back to request.tooltips for non-standard button labels", async () => {
    const ue = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({
          buttons: ["Allow", "Auto-allow safe commands", "Deny"],
          tooltips: { "Auto-allow safe commands": "Will save pattern: npm run *" },
        })}
        onRespond={onRespond}
      />,
    );

    await openScopeMenu(ue);
    expect(screen.getByText("Will save pattern: npm run *")).toBeInTheDocument();
  });

  it("static tooltips win over request.tooltips for canonical button labels", async () => {
    const ue = userEvent.setup();
    const onRespond = vi.fn<(requestId: string, action: string) => void>();
    render(
      <PermissionCard
        request={makeRequest({
          tooltips: { "Always allow": "Legacy tooltip that should be ignored" },
        })}
        onRespond={onRespond}
      />,
    );

    await openScopeMenu(ue);
    expect(screen.getByText("Always allow this action in all chats")).toBeInTheDocument();
    expect(screen.queryByText("Legacy tooltip that should be ignored")).not.toBeInTheDocument();
  });
});

describe("PermissionCard — static button tooltips", () => {
  it("'Allow' surfaces 'Allow this action once' on hover", async () => {
    const ue = userEvent.setup();
    render(<PermissionCard request={makeRequest()} onRespond={() => {}} />);
    await ue.hover(screen.getByRole("button", { name: "Allow once" }));
    expect((await screen.findAllByText("Allow this action once")).length).toBeGreaterThan(0);
  });

  it("'Allow for session' surfaces 'Allow this action until this session ends' on hover", async () => {
    const ue = userEvent.setup();
    render(<PermissionCard request={makeRequest()} onRespond={() => {}} />);
    await openScopeMenu(ue);
    expect(screen.getByText("Allow this action until this session ends")).toBeInTheDocument();
  });

  it("'Allow everywhere' surfaces 'Always allow this action in all chats' on hover", async () => {
    const ue = userEvent.setup();
    render(<PermissionCard request={makeRequest()} onRespond={() => {}} />);
    await openScopeMenu(ue);
    expect(screen.getByText("Always allow this action in all chats")).toBeInTheDocument();
  });

  it("'Deny' surfaces 'Deny this action once' on hover", async () => {
    const ue = userEvent.setup();
    render(<PermissionCard request={makeRequest()} onRespond={() => {}} />);
    await ue.hover(screen.getByRole("button", { name: "Not now" }));
    expect((await screen.findAllByText("Deny this action once")).length).toBeGreaterThan(0);
  });
});

describe("PermissionCard — category badge", () => {
  const baseRequest = {
    id: "req1",
    kind: "shell" as const,
    title: "npm run build",
    message: "Builds the project",
    detail: "",
    buttons: ["Allow", "Deny"],
  };

  it("renders Read-only badge for readonly category", () => {
    render(
      <PermissionCard request={{ ...baseRequest, category: "readonly" }} onRespond={() => {}} />,
    );
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("renders Destructive badge for destructive category", () => {
    render(
      <PermissionCard request={{ ...baseRequest, category: "destructive" }} onRespond={() => {}} />,
    );
    expect(screen.getByText("Destructive")).toBeInTheDocument();
  });

  it("renders Writes files badge for writes category", () => {
    render(
      <PermissionCard request={{ ...baseRequest, category: "writes" }} onRespond={() => {}} />,
    );
    expect(screen.getByText("Writes files")).toBeInTheDocument();
  });

  it("renders Network badge for network category", () => {
    render(
      <PermissionCard request={{ ...baseRequest, category: "network" }} onRespond={() => {}} />,
    );
    expect(screen.getByText("Network")).toBeInTheDocument();
  });

  it("hides badge when category is unknown", () => {
    render(
      <PermissionCard request={{ ...baseRequest, category: "unknown" }} onRespond={() => {}} />,
    );
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
    expect(screen.queryByText("Destructive")).not.toBeInTheDocument();
  });

  it("hides badge when category is missing", () => {
    render(<PermissionCard request={baseRequest} onRespond={() => {}} />);
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });
});

describe("PermissionCard — persistent access scope", () => {
  it("renders the all-chats scope for any always-allow button regardless of pattern", async () => {
    const user = userEvent.setup();
    render(
      <PermissionCard
        request={{
          id: "req1",
          kind: "shell",
          title: "az repos list",
          message: "",
          detail: "",
          buttons: ["Allow", "Always allow", "Deny"],
          suggestedPattern: "az repos list *",
          patternRationale: "read-only listing",
        }}
        onRespond={() => {}}
      />,
    );
    await openScopeMenu(user);
    expect(screen.getByRole("menuitem", { name: /All chats/ })).toBeInTheDocument();
    expect(screen.queryByText("Always allow")).not.toBeInTheDocument();
  });

  it("renders the all-chats scope when suggestedPattern is null", async () => {
    const user = userEvent.setup();
    render(
      <PermissionCard
        request={{
          id: "req2",
          kind: "shell",
          title: "rm file.txt",
          message: "",
          detail: "",
          buttons: ["Allow", "Always allow", "Deny"],
          suggestedPattern: null,
        }}
        onRespond={() => {}}
      />,
    );
    await openScopeMenu(user);
    expect(screen.getByRole("menuitem", { name: /All chats/ })).toBeInTheDocument();
  });

  it("renders the all-chats scope for non-shell cards", async () => {
    const user = userEvent.setup();
    render(
      <PermissionCard
        request={{
          id: "req3",
          kind: "write",
          title: "Edit file",
          message: "",
          detail: "src/foo.ts",
          buttons: ["Allow", "Always allow", "Deny"],
          suggestedPattern: null,
        }}
        onRespond={() => {}}
      />,
    );
    await openScopeMenu(user);
    expect(screen.getByRole("menuitem", { name: /All chats/ })).toBeInTheDocument();
  });
});

describe("PermissionCard — primary vs secondary Always-allow", () => {
  const shellRequest = (overrides: Partial<PermissionCardData> = {}): PermissionCardData => ({
    id: "req-1",
    kind: "shell",
    title: "az repos list",
    message: "",
    detail: "az repos list --project office",
    buttons: ["Allow", "Allow for session", "Always allow", "Deny"],
    ...overrides,
  });

  it("shows ONLY the primary when there is no broader suggestion", async () => {
    const user = userEvent.setup();
    render(
      <PermissionCard
        request={shellRequest({ primaryPattern: "az repos list *" })}
        onRespond={() => {}}
      />,
    );
    await openScopeMenu(user);
    expect(screen.getByRole("menuitem", { name: /All chats/ })).toBeInTheDocument();
    expect(screen.queryByTestId("allow-broader-pattern")).not.toBeInTheDocument();
  });

  it("hides the secondary when suggestedPattern matches the primary", () => {
    render(
      <PermissionCard
        request={shellRequest({
          primaryPattern: "az repos list *",
          suggestedPattern: "az repos list *",
        })}
        onRespond={() => {}}
      />,
    );
    expect(screen.queryByTestId("allow-broader-pattern")).not.toBeInTheDocument();
  });

  it("shows BOTH primary and secondary when suggestedPattern differs", async () => {
    const user = userEvent.setup();
    render(
      <PermissionCard
        request={shellRequest({
          primaryPattern: "az repos list --project *",
          suggestedPattern: "az repos list *",
          patternRationale: "read-only listing",
        })}
        onRespond={() => {}}
      />,
    );
    await openScopeMenu(user);
    expect(screen.getByRole("menuitem", { name: /All chats/ })).toBeInTheDocument();
    expect(screen.getByTestId("allow-broader-pattern")).toBeInTheDocument();
    expect(screen.getByText("Similar actions in all chats")).toBeInTheDocument();
  });

  it("hides secondary when primary is null (literal) — avoids surfacing a broader rule that contradicts a guardrail null", () => {
    render(
      <PermissionCard
        request={shellRequest({
          primaryPattern: null,
          suggestedPattern: "rm *",
        })}
        onRespond={() => {}}
      />,
    );
    expect(screen.queryByTestId("allow-broader-pattern")).not.toBeInTheDocument();
  });

  it("clicking secondary sends overridePattern and always-allow action", async () => {
    const ue = userEvent.setup();
    const onRespond = vi.fn<(id: string, action: string, override?: string) => void>();
    render(
      <PermissionCard
        request={shellRequest({
          primaryPattern: "az repos list --project *",
          suggestedPattern: "az repos list *",
        })}
        onRespond={onRespond}
      />,
    );
    await openScopeMenu(ue);
    await ue.click(screen.getByTestId("allow-broader-pattern"));
    expect(onRespond).toHaveBeenCalledWith("req-1", "always-allow", "az repos list *");
  });

  it("primary click sends primary pattern via approvalPattern, NOT the broader one", async () => {
    const ue = userEvent.setup();
    const onRespond = vi.fn<(id: string, action: string, override?: string) => void>();
    render(
      <PermissionCard
        request={shellRequest({
          primaryPattern: "az repos list --project *",
          suggestedPattern: "az repos list *",
        })}
        onRespond={onRespond}
      />,
    );
    await openScopeMenu(ue);
    await ue.click(screen.getByTestId("allow-primary-pattern"));
    // Primary intentionally passes no overridePattern — main process uses
    // request.approvalPattern (locked at card creation).
    expect(onRespond).toHaveBeenCalledWith("req-1", "always-allow", undefined);
  });

  it("broader-pattern tooltip shows the wider pattern inline", async () => {
    const ue = userEvent.setup();
    render(
      <PermissionCard
        request={shellRequest({
          primaryPattern: "az repos list --project *",
          suggestedPattern: "az repos list *",
          patternRationale: "Read-only listing — rationale is no longer shown",
        })}
        onRespond={() => {}}
      />,
    );
    await openScopeMenu(ue);
    const patternSpans = await screen.findAllByText("az repos list *");
    expect(patternSpans.length).toBeGreaterThan(0);
    const scopeText = patternSpans[0].parentElement?.textContent?.replace(/\s+/g, " ").trim();
    expect(scopeText).toContain("Always allow az repos list * in all chats");
    // Rationale is no longer surfaced — primary or secondary.
    expect(
      screen.queryByText("Read-only listing — rationale is no longer shown"),
    ).not.toBeInTheDocument();
  });

  it("primary=null + secondary=null: renders the all-chats scope, no secondary", async () => {
    const user = userEvent.setup();
    render(
      <PermissionCard
        request={shellRequest({
          primaryPattern: null,
          suggestedPattern: null,
        })}
        onRespond={() => {}}
      />,
    );
    await openScopeMenu(user);
    expect(screen.getByRole("menuitem", { name: /All chats/ })).toBeInTheDocument();
    expect(screen.queryByTestId("allow-broader-pattern")).not.toBeInTheDocument();
  });
});

describe("sensitive-path warning banner", () => {
  it("renders sensitivePathWarning banner when set", () => {
    const card: PermissionCardData = {
      id: "r1",
      kind: "write",
      title: "Save File",
      message: "wants to edit a file",
      detail: "File: ~/.ssh/config",
      buttons: ["Allow", "Allow for session", "Always allow", "Deny"],
      sensitivePathWarning: "/home/user/.ssh/config is in a security-sensitive location",
    };
    render(
      <PermissionCard
        request={card}
        onRespond={vi.fn<(requestId: string, action: string) => void>()}
      />,
    );
    expect(screen.getByTestId("sensitive-path-warning")).toBeInTheDocument();
    expect(
      screen.getByText("/home/user/.ssh/config is in a security-sensitive location"),
    ).toBeInTheDocument();
  });

  it("does not render warning banner when sensitivePathWarning is absent", () => {
    const card: PermissionCardData = {
      id: "r2",
      kind: "write",
      title: "Save File",
      message: "wants to edit a file",
      detail: "File: /tmp/safe.txt",
      buttons: ["Allow", "Allow for session", "Always allow", "Deny"],
    };
    render(
      <PermissionCard
        request={card}
        onRespond={vi.fn<(requestId: string, action: string) => void>()}
      />,
    );
    expect(screen.queryByTestId("sensitive-path-warning")).not.toBeInTheDocument();
  });
});

describe("PermissionCard — 'Always allow' tooltip fallthrough when primaryPattern is empty", () => {
  it("does not render legacy code-block-derived tooltip even when primaryPattern is empty", () => {
    render(
      <PermissionCard
        request={{
          id: "p1",
          kind: "shell",
          title: "Run command",
          message: "wants to run",
          detail: "rm -rf /tmp/foo",
          buttons: ["Allow", "Allow for session", "Deny"],
          primaryPattern: "",
        }}
        onRespond={vi.fn<(id: string, action: string) => void>()}
      />,
    );
    expect(screen.queryByText("Always allow this command")).not.toBeInTheDocument();
  });
});
