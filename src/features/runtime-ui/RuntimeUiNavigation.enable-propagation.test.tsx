import type {
  RuntimeExtensionsAPI,
  RuntimeExtensionsChangedEvent,
  RuntimeUiAPI,
} from "@common/marshal-ipc-contract";
import { RUNTIME_UI_HOST_PLACEMENTS, type RuntimeUiScope } from "@common/runtime-ui";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";
import type { SessionMetadata } from "@/types/electron";

import { testDouble } from "../../../electron/testing/harness";
import { wireQueryInvalidations } from "../../shared/hooks/wireQueryInvalidations";
import { RuntimeUiHost } from "./RuntimeUiHost";
import { RuntimeUiNavigationEntries } from "./RuntimeUiNavigation";

// F-DEPLOY-3 (installed no-reload nav propagation, D1-style regression: real
// components + controlled data, per RuntimeUiApplicationWorkspace.layout.browser.test.tsx).
// Parent's live receipt (coordination verification/d3-no-reload-nav-live-20260910.md):
// an agent-originated `runtimeEnableExtension` on an already-open window never
// surfaced the newly-enabled extension's nav.primary entry until a manual reload.
//
// This proves the deterministic half of the chain end to end with real
// components and controlled data: a window is already open (mounted once,
// never remounted) with NO "Pull Requests" nav entry; the real
// wireQueryInvalidations boot-time wiring is active on a real QueryClient; an
// enable-originated "runtime-extensions:changed" event arrives on the same IPC
// channel the main process broadcasts on; the real runtime-ui:getPlacements
// query (staleTime Infinity, RuntimeUiPlacements.tsx) is invalidated and
// re-fetched; the real RuntimeUiNavigationEntries consumer renders the entry —
// no reload, no remount.
//
// The one link this test cannot exercise is the actual Marshal Runtime kernel
// emitting that event for a real agent-path enable (main.ts wiring calling
// into @marshal/runtime, an opaque vendored package) — that is covered by the
// acceptance facility step and the parent's live receipt, not here. See the
// FDEPLOY3 report for the full root-cause chain and the facility-step honesty
// note.

const application = {
  extensionId: "fixture.code-review",
  applicationId: "pull-requests",
  title: "Pull Requests",
  description: "Code review nav application",
  renderId: "fixture.code-review.pull-requests",
  action: "augment" as const,
};

function emptySnapshot(scope: RuntimeUiScope) {
  return {
    success: true as const,
    value: {
      revision: 0,
      generatedAt: new Date(0).toISOString(),
      scope,
      instances: [],
      events: [],
    },
  };
}

function fixture() {
  let enabled = false;
  let changed: ((event: RuntimeExtensionsChangedEvent) => void) | undefined;
  const api: Partial<RuntimeUiAPI> = {
    getSnapshot: vi.fn<RuntimeUiAPI["getSnapshot"]>(async (scope) => emptySnapshot(scope)),
    subscribe: vi.fn<RuntimeUiAPI["subscribe"]>(async (scope) => emptySnapshot(scope)),
    unsubscribe: vi.fn<RuntimeUiAPI["unsubscribe"]>(async () => ({ success: true })),
    onEvent: vi.fn<RuntimeUiAPI["onEvent"]>(() => () => {}),
    getPlacements: vi.fn<RuntimeUiAPI["getPlacements"]>(async () => ({
      revision: enabled ? 1 : 0,
      generatedAt: new Date(0).toISOString(),
      diagnostics: [],
      placements: RUNTIME_UI_HOST_PLACEMENTS.map((metadata) => ({
        metadata,
        applications: enabled && metadata.id === "nav.primary" ? [application] : [],
      })),
    })),
    activatePlacement: vi.fn<RuntimeUiAPI["activatePlacement"]>(),
  };
  installMockAPIs({
    runtimeExtensionsAPI: {
      onChanged: vi.fn<RuntimeExtensionsAPI["onChanged"]>((callback) => {
        changed = callback;
        return () => {
          changed = undefined;
        };
      }),
    },
  });
  window.runtimeUiAPI = testDouble<RuntimeUiAPI>(api);
  return {
    // Simulates the main process broadcasting "runtime-extensions:changed"
    // after an agent-path enable succeeds (the fix in
    // electron/marshal-runtime/runtime-self-tools.ts + electron/main.ts).
    fireAgentOriginatedEnable: () => {
      enabled = true;
      changed?.({ revision: 1 });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("F-DEPLOY-3: enable-originated nav propagation without reload", () => {
  it("shows a newly agent-enabled extension's nav entry after runtime-extensions:changed, without remounting", async () => {
    const { fireAgentOriginatedEnable } = fixture();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const unwire = wireQueryInvalidations(queryClient);
    const sessions: SessionMetadata[] = [];
    const editor = { id: "test", SourceEditor: () => null };

    render(
      <RuntimeUiHost activeSessionId={null} sessions={sessions} editor={editor}>
        <RuntimeUiNavigationEntries />
      </RuntimeUiHost>,
      { queryClient },
    );

    // Window is already open; the extension is not enabled yet.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Pull Requests" })).toBeNull());

    // Agent-path enable completes; main process broadcasts the change.
    fireAgentOriginatedEnable();

    // Same mounted tree — no reload/remount — must now show the nav entry.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pull Requests" })).toBeVisible(),
    );

    unwire();
  });
});
