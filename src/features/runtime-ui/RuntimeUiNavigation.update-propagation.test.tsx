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

// HOST-UX-3 (CF-08): post-update placement propagation without the
// activatePlacement workaround. Sibling of
// RuntimeUiNavigation.enable-propagation.test.tsx (F-DEPLOY-3), which pins the
// enable path; this pins the UPDATE path — the exact live symptom was a
// runtimeUpdateExtension after which "Pull Requests" flickered/vanished from
// an already-open window until a manual diagnostic activatePlacement, because
// the placements query (staleTime Infinity, RuntimeUiPlacements.tsx) was
// never re-fetched. A runtime update tears down and re-registers the
// extension's placements under a fresh publication revision, so the
// pre-update snapshot is stale the moment the update lands. The chain under
// test: agent-path runtimeUpdateExtension → notifyExtensionsChanged
// (electron/marshal-runtime/runtime-self-tools.ts) → main broadcasts
// "runtime-extensions:changed" (electron/main.ts) → boot-time
// wireQueryInvalidations invalidates ["runtime-ui","placements"] → the SAME
// mounted tree re-queries runtime-ui:getPlacements and renders the
// post-update contribution. No reload, no remount, no manual activation.

const applicationV1 = {
  extensionId: "fixture.code-review",
  applicationId: "pull-requests",
  title: "Pull Requests",
  description: "Code review nav application (installed package)",
  renderId: "fixture.code-review.pull-requests",
  action: "augment" as const,
};

// The same identity re-published by the updated package; the differing title
// makes "the renderer shows the POST-update registration" observable.
const applicationV2 = {
  ...applicationV1,
  title: "Pull Requests (updated)",
  description: "Code review nav application (updated package)",
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
  let updated = false;
  let changed: ((event: RuntimeExtensionsChangedEvent) => void) | undefined;
  const getPlacements = vi.fn<RuntimeUiAPI["getPlacements"]>(async () => ({
    revision: updated ? 2 : 1,
    generatedAt: new Date(0).toISOString(),
    diagnostics: [],
    placements: RUNTIME_UI_HOST_PLACEMENTS.map((metadata) => ({
      metadata,
      applications:
        metadata.id === "nav.primary" ? [updated ? applicationV2 : applicationV1] : [],
    })),
  }));
  const api: Partial<RuntimeUiAPI> = {
    getSnapshot: vi.fn<RuntimeUiAPI["getSnapshot"]>(async (scope) => emptySnapshot(scope)),
    subscribe: vi.fn<RuntimeUiAPI["subscribe"]>(async (scope) => emptySnapshot(scope)),
    unsubscribe: vi.fn<RuntimeUiAPI["unsubscribe"]>(async () => ({ success: true })),
    onEvent: vi.fn<RuntimeUiAPI["onEvent"]>(() => () => {}),
    getPlacements,
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
    getPlacements,
    // Simulates an agent-path runtimeUpdateExtension completing: the updated
    // package's placements are now live in main, and main broadcasts
    // "runtime-extensions:changed" (runtime-self-tools notifyExtensionsChanged).
    fireAgentOriginatedUpdate: () => {
      updated = true;
      changed?.({ revision: 2 });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HOST-UX-3: update-originated nav propagation without reload or manual activation", () => {
  it("re-fetches placements after runtime-extensions:changed and renders the post-update contribution in the same mounted tree", async () => {
    const { getPlacements, fireAgentOriginatedUpdate } = fixture();
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

    // The window is open with the pre-update package's nav entry visible.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pull Requests" })).toBeVisible(),
    );
    const fetchesBeforeUpdate = getPlacements.mock.calls.length;

    // Agent-path runtimeUpdateExtension completes; main broadcasts the change.
    fireAgentOriginatedUpdate();

    // Same mounted tree — no reload, no remount, no activatePlacement
    // workaround — must re-query and show the updated package's entry.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pull Requests (updated)" })).toBeVisible(),
    );
    expect(screen.queryByRole("button", { name: "Pull Requests" })).toBeNull();
    expect(getPlacements.mock.calls.length).toBeGreaterThan(fetchesBeforeUpdate);

    unwire();
  });
});
