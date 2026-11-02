import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

// D4 deterministic native-frame regression suite, controlled-data scenarios
// (AUDIT-VERDICT-AND-ACCEPTANCE.md "Testing capability gaps", point 4). This
// file is DISTINCT from real-provider acceptance: it renders the real
// production RuntimeUiInstanceFrame/PackagedRuntimeUiRenderer chain (read-only
// import — this facility never edits src/features/runtime-ui/**, which D1
// owns) around this facility's own sample-app fixture, and drives every
// interactive control with genuine externally-dispatched browser automation
// via `page.frameLocator`, which reaches inside the sandboxed cross-origin
// application iframe the same way a real user's click would. Each action is
// independently confirmed by the sandboxed content's own script reporting
// the resulting DOM event back through the real `tools/call` bridge — so a
// green result here means the click/type/scroll/select action actually
// landed, not merely that an API call succeeded (the exact gap
// AUDIT-VERDICT-AND-ACCEPTANCE.md's "Testing capability gaps" section names).
//
// This suite does not reproduce D1's pane-height regression (that is
// src/features/runtime-ui/RuntimeUiApplicationWorkspace.layout.browser.test.tsx,
// invoked by path from ../scripts/run-native-frame-regression.mjs) and does
// not exercise any real provider or network call.
import type {
  RuntimeUiApplicationCapabilityInvokeCommand,
  RuntimeUiInstance,
} from "../../../common/runtime-ui";
import { MarshalRuntimeEditorContext } from "../../../src/features/runtime-ui/RuntimeEditor";
import { RuntimeUiContext } from "../../../src/features/runtime-ui/runtimeUiContext";
import { RuntimeUiInstanceFrame } from "../../../src/features/runtime-ui/RuntimeUiHost";
import type { RuntimeUiModel } from "../../../src/features/runtime-ui/useRuntimeUi";
// Vite raw-text import: this facility owns sample-app/index.html and never
// executes it outside a sandboxed iframe.
import SAMPLE_APP_HTML from "../sample-app/index.html?raw";

interface InvokeCapabilityRequest {
  readonly capability: string;
  readonly input: unknown;
}

type InvokeCapabilityMock = ReturnType<
  typeof vi.fn<(request: InvokeCapabilityRequest) => Promise<{ output: unknown }>>
>;

interface Harness {
  readonly invokeCapability: InvokeCapabilityMock;
  readonly pane: HTMLElement;
  readonly frameLocator: ReturnType<typeof page.frameLocator>;
  readonly setPaneSize: (width: number, height: number) => void;
  readonly bumpRevision: () => void;
}

interface SampleReport {
  readonly event: string;
  readonly [key: string]: unknown;
}

function reportedInputs(invokeCapability: InvokeCapabilityMock): SampleReport[] {
  return invokeCapability.mock.calls
    .map(([request]) => request)
    .filter((request) => request.capability === "sample.report")
    .map((request) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the sample-app script (index.html) is this same facility's own fixture; its tools/call arguments always carry an `event` string.
      const report = request.input as SampleReport;
      return report;
    });
}

function reportedEvents(invokeCapability: InvokeCapabilityMock): string[] {
  return reportedInputs(invokeCapability).map((report) => report.event);
}

function findReport(
  invokeCapability: InvokeCapabilityMock,
  event: string,
): SampleReport | undefined {
  return reportedInputs(invokeCapability)
    .filter((report) => report.event === event)
    .at(-1);
}

interface LongLineMeasurement {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly overflowX: string;
}

function isLongLineMeasurement(value: unknown): value is LongLineMeasurement {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { scrollWidth?: unknown }).scrollWidth === "number" &&
    typeof (value as { clientWidth?: unknown }).clientWidth === "number" &&
    typeof (value as { overflowX?: unknown }).overflowX === "string"
  );
}

function longLineMeasurement(report: SampleReport | undefined): LongLineMeasurement {
  const value = report?.longLine;
  if (!isLongLineMeasurement(value)) {
    throw new Error(
      "The 'ready' report did not include a longLine scrollWidth/clientWidth/overflowX measurement.",
    );
  }
  return value;
}

function renderHarness(): Harness {
  let revisionId = "one";
  const instance: RuntimeUiInstance = {
    instanceId: "acceptance-facility-sample",
    owner: {
      applicationScope: "user",
      workspaceName: "marshal",
      extensionId: "@host-smoke/acceptance-sample",
      applicationId: "acceptance-sample",
    },
    surface: "tab",
    revision: 1,
    openedAt: "now",
    updatedAt: "now",
    focusedAt: "now",
    idempotencyKey: "acceptance-facility",
    content: {
      kind: "application",
      renderId: "acceptance-facility-renderer",
      resource: {
        uri: "ui://host-smoke/acceptance-sample",
        mimeType: "text/html",
        name: "Acceptance sample",
      },
      descriptor: {
        version: "1.0.0",
        presentationModes: ["inline"],
        actions: [],
        tools: [{ id: "report", name: "sample.report", inputSchema: { type: "object" } }],
      },
    },
  };
  const invokeCapability: InvokeCapabilityMock = vi
    .fn<(request: InvokeCapabilityRequest) => Promise<{ output: unknown }>>()
    .mockResolvedValue({ output: { ok: true } });
  // Only the methods RuntimeUiInstanceFrame's subtree actually calls for a
  // single "application" instance (invokeCapability/readResource/session and
  // image selection) are provided — navigation/placement methods
  // (activatePlacement, close, focus, getPlacements, ...) belong to other
  // parts of RuntimeUiAPI this harness never renders.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- see comment above; renderer tests provide only the methods under exercise (matches src/test-utils.tsx's window.workflowsAPI convention).
  window.runtimeUiAPI = {
    invokeCapability: async (request: RuntimeUiApplicationCapabilityInvokeCommand) => ({
      success: true,
      value: await invokeCapability({ capability: request.capability, input: request.input }),
    }),
    readResource: async () => ({
      success: true,
      value: {
        uri: instance.content.kind === "application" ? instance.content.resource.uri : "",
        mimeType: "text/html",
        text: SAMPLE_APP_HTML,
        revisionId,
        integrity: `sha256-${revisionId}`,
      },
    }),
    getSelectedSession: async () => ({ success: true, value: null }),
    selectSession: async () => ({ success: true, value: null }),
    listImages: async () => ({ success: true, value: [] }),
    selectImages: async () => ({ success: true, value: [] }),
    releaseImage: async () => ({ success: true, value: null }),
    onEvent: () => () => undefined,
  } as unknown as Window["runtimeUiAPI"];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Only the fields RuntimeUiInstanceFrame actually reads from the model in
  // this harness (pending/focus/close) are provided — the same minimal shape
  // the D1-lane's own probe precedent used against this real component.
  const fakeModel: Pick<RuntimeUiModel, "pending" | "focus" | "close"> = {
    pending: new Map(),
    focus: vi.fn(),
    close: vi.fn(),
  };
  render(
    <QueryClientProvider client={queryClient}>
      <MarshalRuntimeEditorContext value={{ id: "acceptance-facility", SourceEditor: () => null }}>
        <RuntimeUiContext
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- this harness only exercises the pending/focus/close surface RuntimeUiInstanceFrame reads; the rest of RuntimeUiModel is intentionally unused here.
          value={fakeModel as RuntimeUiModel}
        >
          <div data-testid="acceptance-pane" style={{ width: 900, height: 800 }}>
            <RuntimeUiInstanceFrame
              instances={[instance]}
              className="size-full bg-card"
              contentClassName="h-full"
            />
          </div>
        </RuntimeUiContext>
      </MarshalRuntimeEditorContext>
    </QueryClientProvider>,
  );
  const pane = screen.getByTestId("acceptance-pane");
  const iframeLocator = page.getByTitle("Acceptance sample");
  const frameLocator = page.frameLocator(iframeLocator);
  return {
    invokeCapability,
    pane,
    frameLocator,
    setPaneSize(width, height) {
      pane.style.width = `${width}px`;
      pane.style.height = `${height}px`;
    },
    bumpRevision() {
      revisionId = "two";
      void queryClient.invalidateQueries({ queryKey: ["runtime-ui", "packaged-resource"] });
    },
  };
}

async function waitForInitialized(_harness: Harness) {
  await screen.findByTitle("Acceptance sample");
  await waitFor(() => expect(screen.queryByText("Loading application…")).toBeNull());
}

let unmount: (() => void) | undefined;

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- IS_REACT_ACT_ENVIRONMENT is a non-standard global flag added by React for test environments (matches src/test-environment-setup.ts)
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  delete window.runtimeUiAPI;
});

test("small pane: renders the real native frame and a real click reaches the sandboxed app", async () => {
  const harness = renderHarness();
  unmount = () => screen.getByTestId("acceptance-pane").remove();
  harness.setPaneSize(320, 400);
  await waitForInitialized(harness);
  await harness.frameLocator.getByRole("button", { name: "Refresh" }).click();
  await waitFor(() => expect(reportedEvents(harness.invokeCapability)).toContain("refreshed"));
});

test("resize: pane grows and the sandboxed app stays reachable — pagination-shaped content loads a real next page", async () => {
  const harness = renderHarness();
  unmount = () => screen.getByTestId("acceptance-pane").remove();
  await waitForInitialized(harness);
  harness.setPaneSize(1400, 1200);
  await harness.frameLocator.getByRole("button", { name: "Load more" }).click();
  await waitFor(() => expect(reportedEvents(harness.invokeCapability)).toContain("page-loaded"));
  // The sandboxed app reports its own next DOM state; the outer test cannot
  // read into the cross-origin iframe directly, so this is the app's own
  // independent confirmation that a real second page rendered.
  expect(findReport(harness.invokeCapability, "page-loaded")).toMatchObject({
    page: 2,
    firstRowText: "row 4 (page 2)",
  });
});

test("typing: a real keystroke in the sandboxed input is observed by the app itself", async () => {
  const harness = renderHarness();
  unmount = () => screen.getByTestId("acceptance-pane").remove();
  await waitForInitialized(harness);
  await harness.frameLocator.getByLabelText("Query").fill("code-review");
  await waitFor(() => {
    expect(findReport(harness.invokeCapability, "typed")).toMatchObject({ value: "code-review" });
  });
});

test("native selection: choosing an option is observed by the app and reflected in its own DOM", async () => {
  const harness = renderHarness();
  unmount = () => screen.getByTestId("acceptance-pane").remove();
  await waitForInitialized(harness);
  await harness.frameLocator.getByRole("combobox").selectOptions("two");
  await waitFor(() => {
    // readoutText is read by the sandboxed app from its own DOM after the
    // change event, so this proves the selection actually landed and the
    // app's own UI reflects it — not just that a change event fired.
    expect(findReport(harness.invokeCapability, "selected")).toMatchObject({
      value: "two",
      readoutText: "selected: two",
    });
  });
});

test("error feedback: a deliberate failure path is real-clickable and visibly surfaced inside the app", async () => {
  const harness = renderHarness();
  unmount = () => screen.getByTestId("acceptance-pane").remove();
  await waitForInitialized(harness);
  await harness.frameLocator.getByRole("button", { name: "Trigger error" }).click();
  await waitFor(() => {
    // visible/text are read by the sandboxed app from its own error banner
    // element, independently confirming the failure was actually surfaced
    // (not merely that the click handler ran).
    expect(findReport(harness.invokeCapability, "error-shown")).toMatchObject({
      visible: true,
      text: expect.stringContaining("Deliberate acceptance-facility error"),
    });
  });
});

test("inner scrolling: the bottom sentinel is reached by scrolling inside the app document, not the outer pane", async () => {
  const harness = renderHarness();
  unmount = () => screen.getByTestId("acceptance-pane").remove();
  await waitForInitialized(harness);
  await harness.frameLocator.getByTestId("bottom-sentinel").wheel({ delta: { y: 4000 } });
  await waitFor(
    () => expect(reportedEvents(harness.invokeCapability)).toContain("scrolled-near-bottom"),
    {
      timeout: 8000,
    },
  );
});

test("long lines: overflow content is measurably wider than its viewport and horizontally scrollable, not silently clipped", async () => {
  const harness = renderHarness();
  unmount = () => screen.getByTestId("acceptance-pane").remove();
  await waitForInitialized(harness);
  // The exact defect class the audit flagged for the extension's own diff
  // view ("Long extension diff lines also overflow into a hidden region").
  // The sandboxed app measures its own scrollWidth/clientWidth/overflow
  // policy — this facility cannot read layout across the cross-origin frame
  // boundary directly, so the content itself is the source of truth here.
  await waitFor(() => {
    const longLine = longLineMeasurement(findReport(harness.invokeCapability, "ready"));
    expect(longLine.scrollWidth).toBeGreaterThan(longLine.clientWidth);
    expect(longLine.overflowX).not.toBe("hidden");
  });
});

test("init/selection changes: bumping the published revision reinitializes the app and it stays interactive", async () => {
  const harness = renderHarness();
  unmount = () => screen.getByTestId("acceptance-pane").remove();
  await waitForInitialized(harness);
  await harness.frameLocator.getByRole("button", { name: "Refresh" }).click();
  await waitFor(() => expect(reportedEvents(harness.invokeCapability)).toContain("refreshed"));
  harness.bumpRevision();
  await waitForInitialized(harness);
  // A fresh iframe means a fresh in-app `page` counter; a real click must still
  // land after reinitialization, proving the revision swap did not leave the
  // application dead.
  await harness.frameLocator.getByRole("button", { name: "Load more" }).click();
  await waitFor(() => expect(reportedEvents(harness.invokeCapability)).toContain("page-loaded"));
});
