import type { RuntimeUiEvent, RuntimeUiInstance } from "@common/runtime-ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PackagedRuntimeUiRenderer } from "./PackagedRuntimeUiRenderer";
import type { RuntimeUiApplicationRenderHost } from "./RuntimeUiApplicationRegistry";

function html(version: string): string {
  return `<main><h1>${version}</h1><button id="run">Run</button><output id="result"></output></main><script>
  function call(id, method, params) { parent.postMessage({jsonrpc:'2.0', id, method, params}, '*'); }
  addEventListener('message', async (event) => {
    if(event.source !== parent) return;
    if(event.data.id === 'initialize') {
      let isolated = false; let evalBlocked = false; let networkBlocked = false;
      try { parent.document.body; } catch { isolated = true; }
      try { eval('1+1'); } catch { evalBlocked = true; }
      try { await fetch('https://example.com/forbidden'); } catch { networkBlocked = true; }
      document.querySelector('#run').onclick = () => call('echo','tools/call',{name:'sample.echo',arguments:{version:${JSON.stringify(version)},isolated,evalBlocked,networkBlocked}});
      document.querySelector('#run').click();
      parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');
    }
    if(event.data.id === 'echo') {
      document.querySelector('#result').textContent = event.data.result.structuredContent.output;
      call('report','tools/call',{name:'sample.report',arguments:{text:document.querySelector('#result').textContent}});
    }
    if(event.data.method === 'ui/notifications/tool-input' && event.data.params.arguments.state?.stream) {
      call('stream','tools/call',{name:'sample.report',arguments:{stream:event.data.params.arguments.state.stream}});
    }
  });
  call('initialize','ui/initialize',{});
  </script>`;
}

function fixture() {
  const instance: RuntimeUiInstance = {
    instanceId: "packaged-app",
    owner: {
      applicationScope: "user",
      workspaceName: "marshal",
      extensionId: "@example/sample",
      applicationId: "sample",
    },
    surface: "tab",
    revision: 1,
    openedAt: "now",
    updatedAt: "now",
    focusedAt: "now",
    idempotencyKey: "open",
    content: {
      kind: "application",
      renderId: "sample-renderer",
      resource: { uri: "ui://example/sample", mimeType: "text/html", name: "Sample application" },
      descriptor: {
        version: "1.0.0",
        presentationModes: ["inline"],
        actions: [],
        tools: ["echo", "report"].map((name) => ({
          id: name,
          name: `sample.${name}`,
          inputSchema: { type: "object" },
        })),
      },
    },
  };
  let version = "one";
  let listener: ((event: RuntimeUiEvent) => void) | undefined;
  const unsubscribe = vi.fn<() => void>();
  const invokeCapability = vi
    .fn<RuntimeUiApplicationRenderHost["invokeCapability"]>()
    .mockImplementation(async ({ capability }) => ({
      output: capability === "sample.echo" ? "result from host" : "ok",
    }));
  const host: RuntimeUiApplicationRenderHost = {
    instance,
    editor: { id: "fixture", SourceEditor: () => null },
    invokeCapability,
    readResource: async (uri) => ({
      uri,
      mimeType: "text/html",
      text: html(version),
      revisionId: version,
      integrity: `sha256-${version}`,
    }),
    subscribe: (next) => {
      listener = next;
      return unsubscribe;
    },
    focus: async () => undefined,
    close: async () => undefined,
    update: async () => undefined,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <PackagedRuntimeUiRenderer host={host} instance={instance} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    host,
    invokeCapability,
    unsubscribe,
    queryClient,
    replace: () => {
      version = "two";
      return queryClient.invalidateQueries({ queryKey: ["runtime-ui", "packaged-resource"] });
    },
    stream: () => {
      if (instance.content.kind !== "application") throw new Error("Missing application content");
      listener?.({
        type: "instance-updated",
        scope: instance.owner,
        sequence: 2,
        occurredAt: "now",
        instance: {
          ...instance,
          revision: 2,
          content: { ...instance.content, state: { stream: "partial response" } },
        },
      });
    },
  };
}

describe("generic packaged application in Chromium", () => {
  it("runs extension-authored UI, isolates parent/network/eval, dispatches and streams, then replaces live", async () => {
    const f = fixture();
    const frame = await screen.findByTitle("Sample application");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await waitFor(
      () =>
        expect(f.invokeCapability).toHaveBeenCalledWith(
          expect.objectContaining({
            capability: "sample.echo",
            input: { version: "one", isolated: true, evalBlocked: true, networkBlocked: true },
          }),
        ),
      { timeout: 8000 },
    );
    await waitFor(() =>
      expect(f.invokeCapability).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "sample.report",
          input: { text: "result from host" },
        }),
      ),
    );
    act(() => f.stream());
    await waitFor(() =>
      expect(f.invokeCapability).toHaveBeenCalledWith(
        expect.objectContaining({ input: { stream: "partial response" } }),
      ),
    );
    await act(() => f.replace());
    await waitFor(() =>
      expect(f.invokeCapability).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "sample.echo",
          input: { version: "two", isolated: true, evalBlocked: true, networkBlocked: true },
        }),
      ),
    );
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    f.unmount();
    expect(f.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("shows recoverable bundle errors and never loads an external script", async () => {
    const f = fixture();
    await screen.findByTitle("Sample application");
    act(() => {
      f.queryClient.setQueriesData(
        { queryKey: ["runtime-ui", "packaged-resource"] },
        {
          uri: "ui://example/sample",
          mimeType: "text/html",
          revisionId: "broken",
          integrity: "broken",
          text: '<script src="https://example.com/app.js"></script>',
        },
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Package UI scripts must be bundled inline",
    );
    expect(screen.getByRole("button", { name: "Retry application" })).toBeInTheDocument();
    f.unmount();
  });
});
