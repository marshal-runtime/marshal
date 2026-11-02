import type { McpServerInfo } from "@common/marshal-ipc-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mcpOAuthStore } from "@/hooks/mcp-oauth-store";
import { act, installMockAPIs, render, screen, waitFor } from "@/test-utils";

import type { SelectedCustomItem } from "./McpServerDetailDialog";
import { McpServerDetailDialog } from "./McpServerDetailDialog";

const baseSelection: SelectedCustomItem = {
  type: "mcp-servers",
  name: "powerbi-remote",
  icon: "🔌",
  description: "Snapshot description (used in the vanished-server fallback)",
  details: [{ label: "URL", value: "https://mcp.example.com/v1/mcp/powerbi" }],
};

const liveServer: McpServerInfo = {
  key: "powerbi_remote",
  name: "powerbi-remote",
  builtin: false,
  status: "connected",
  requiresOAuth: true,
  oauthAlias: "alice@example.com",
  config: {
    name: "powerbi-remote",
    url: "https://mcp.example.com/v1/mcp/powerbi",
    type: "http",
  },
};

describe("McpServerDetailDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
    mcpOAuthStore.resetForTests();
  });

  afterEach(() => {
    mcpOAuthStore.resetForTests();
  });

  // Pin for the `if (!liveServer)` fallback branch in McpServerDetailDialog.
  // When the user opens the detail dialog and the server then vanishes from
  // the live list (e.g. a config refresh removed it), the dialog must keep
  // rendering the snapshot but NEVER expose action buttons — there's no live
  // state to act on, and the no-Remove invariant (plugin-managed MCPs must
  // never be removable from this surface) must hold here too.
  it("renders the snapshot fallback with no action buttons when the server is not in the live list", () => {
    render(
      <McpServerDetailDialog
        selectedCustom={baseSelection}
        customMcpServerInfos={[]}
        onClose={vi.fn<() => void>()}
        onAutoClose={vi.fn<() => void>()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // No primary/secondary OAuth actions — the dialog has no live server to
    // sign in/out from. The vanished-server snapshot is read-only.
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /log out/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /switch account/i })).toBeNull();
    // No-Remove invariant holds in the fallback path too.
    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^uninstall$/i })).toBeNull();
  });

  // Sibling test: when the live server IS present, the dialog uses the live
  // data path (not the fallback). This pins the branch selection so a future
  // refactor that accidentally short-circuits to the fallback when a live
  // server exists fails loudly.
  it("uses the live server path when the selected server is in customMcpServerInfos", () => {
    render(
      <McpServerDetailDialog
        selectedCustom={baseSelection}
        customMcpServerInfos={[liveServer]}
        onClose={vi.fn<() => void>()}
        onAutoClose={vi.fn<() => void>()}
      />,
    );

    // Live path renders the "Log out" secondary action because the server
    // is signed in. (The fallback path never renders any action button.)
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  // Pin the auto-close fix at the unit boundary: the rising-edge `connecting → connected`
  // transition must fire `onAutoClose` (NOT `onClose`) and must NOT fire on
  // a dialog opened on an already-connected server. PluginsPanel.test.tsx
  // covers the full integration; this test isolates the dialog's contract so
  // a future refactor that, say, wires the auto-close to `onClose` or fires
  // it on the initial `undefined → connected` snapshot fails here.
  it("calls onAutoClose (not onClose) on the connecting → connected rising edge", async () => {
    const onClose = vi.fn<() => void>();
    const onAutoClose = vi.fn<() => void>();

    // Use a not-yet-connected live server so the initial liveUiState is
    // `undefined` and we can drive a real `connecting → connected` edge.
    const needsAuthServer: McpServerInfo = {
      ...liveServer,
      status: "needs-auth",
      oauthAlias: undefined,
    };

    render(
      <McpServerDetailDialog
        selectedCustom={baseSelection}
        customMcpServerInfos={[needsAuthServer]}
        onClose={onClose}
        onAutoClose={onAutoClose}
      />,
    );

    // Drive `connecting` first so the next transition is the rising edge.
    await act(async () => {
      mcpOAuthStore.setUiState("powerbi-remote", {
        serverKey: "powerbi-remote",
        state: "connecting",
      });
    });
    expect(onAutoClose).not.toHaveBeenCalled();

    // Rising edge: connecting → connected → onAutoClose fires.
    await act(async () => {
      mcpOAuthStore.setUiState("powerbi-remote", {
        serverKey: "powerbi-remote",
        state: "connected",
      });
    });
    await waitFor(() => {
      expect(onAutoClose).toHaveBeenCalledTimes(1);
    });
    // Crucially, `onClose` must NOT fire on the auto-close path — the
    // parent uses the distinct callbacks to decide whether to clear the
    // status banner. Conflating them would silently regress that behavior.
    expect(onClose).not.toHaveBeenCalled();
  });

  // Regression-protection counterpart: a dialog opened on an
  // already-connected server lands as `undefined → connected`, which is
  // NOT a `connecting → connected` rising edge — onAutoClose must stay
  // silent. Pins the same invariant PluginsPanel.test.tsx already
  // covers at the integration level, but at the unit boundary so the
  // contract is owned by this file too.
  it("does not auto-close when opened on an already-connected server", async () => {
    const onAutoClose = vi.fn<() => void>();

    // Seed the store with `connected` BEFORE render so the dialog's
    // initial liveUiState is `connected` (i.e. the rising-edge ref sees
    // `undefined → connected`, not `connecting → connected`).
    mcpOAuthStore.setUiState("powerbi-remote", {
      serverKey: "powerbi-remote",
      state: "connected",
    });

    render(
      <McpServerDetailDialog
        selectedCustom={baseSelection}
        customMcpServerInfos={[liveServer]}
        onClose={vi.fn<() => void>()}
        onAutoClose={onAutoClose}
      />,
    );

    // Give the effect a chance to fire (or, correctly, NOT fire).
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(onAutoClose).not.toHaveBeenCalled();
  });
});
