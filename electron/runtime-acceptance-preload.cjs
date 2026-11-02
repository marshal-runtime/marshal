"use strict";

{
  const {
    contextBridge: acceptanceContextBridge,
    ipcRenderer: acceptanceIpcRenderer,
  } = require("electron");
  const acceptanceToken =
    process.env.MARSHAL_RUNTIME_ACCEPTANCE_PRELOAD_TOKEN ||
    process.env.MARSHAL_RUNTIME_ACCEPTANCE_TOKEN;

  if (
    process.env.MARSHAL_E2E === "1" &&
    process.env.MARSHAL_RUNTIME_ACCEPTANCE === "1" &&
    typeof acceptanceToken === "string" &&
    acceptanceToken.length > 0
  ) {
    acceptanceContextBridge.exposeInMainWorld("runtimeAcceptanceAPI", {
      getBridgeInfo: () =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:getBridgeInfo", acceptanceToken),
      getStatus: () =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:getStatus", acceptanceToken),
      getStartupError: () =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:getStartupError", acceptanceToken),
      getPaths: () => acceptanceIpcRenderer.invoke("runtime-acceptance:getPaths", acceptanceToken),
      getLifecycleEvents: () =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:getLifecycleEvents", acceptanceToken),
      listRegisteredSelfTools: () =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:listRegisteredSelfTools", acceptanceToken),
      listOrdinarySelfTools: (sessionId) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:listOrdinarySelfTools",
          acceptanceToken,
          sessionId,
        ),
      invokeRegisteredSelfTool: (request) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:invokeRegisteredSelfTool",
          acceptanceToken,
          request,
        ),
      search: (request) =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:search", acceptanceToken, request),
      invoke: (request) =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:invoke", acceptanceToken, request),
      executeTypeScript: (request) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:executeTypeScript",
          acceptanceToken,
          request,
        ),
      listResources: (request) =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:listResources", acceptanceToken, request),
      readResource: (request) =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:readResource", acceptanceToken, request),
      listExtensions: (request) =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:listExtensions", acceptanceToken, request),
      installExtension: (request) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:installExtension",
          acceptanceToken,
          request,
        ),
      updateExtension: (request) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:updateExtension",
          acceptanceToken,
          request,
        ),
      enableExtension: (request) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:enableExtension",
          acceptanceToken,
          request,
        ),
      disableExtension: (request) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:disableExtension",
          acceptanceToken,
          request,
        ),
      removeExtension: (request) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:removeExtension",
          acceptanceToken,
          request,
        ),
      materializeExtensionFixture: (spec) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:materializeExtensionFixture",
          acceptanceToken,
          spec,
        ),
      mutateExtensionFixture: (spec) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:mutateExtensionFixture",
          acceptanceToken,
          spec,
        ),
      readSession: (sessionId) =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:readSession", acceptanceToken, sessionId),
      readMemories: () =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:readMemories", acceptanceToken),
      setAcceptancePermission: (permission, decision) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:setAcceptancePermission",
          acceptanceToken,
          permission,
          decision,
        ),
      getAuthorityAudit: () =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:getAuthorityAudit", acceptanceToken),
      getRegistrationInventory: () =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:getRegistrationInventory",
          acceptanceToken,
        ),
      getInvocationCounts: () =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:getInvocationCounts", acceptanceToken),
      probeRuntimeUiOperation: (request) =>
        acceptanceIpcRenderer.invoke(
          "runtime-acceptance:probeRuntimeUiOperation",
          acceptanceToken,
          request,
        ),
      fixture: (request) =>
        acceptanceIpcRenderer.invoke("runtime-acceptance:fixture", acceptanceToken, request),
    });
  }
}
