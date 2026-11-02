/* marshal-owned */
/**
 * Disallow raw ipcMain.handle(...) calls — register IPC handlers via
 * createIpcHandle() so the wrapper's sender-frame validation, mock-mode
 * routing, and telemetry dedup all apply.
 */

function isIpcMainHandleCall(node) {
  const c = node.callee;
  return (
    c.type === "MemberExpression" &&
    !c.computed &&
    c.object.type === "Identifier" &&
    c.object.name === "ipcMain" &&
    c.property.type === "Identifier" &&
    c.property.name === "handle"
  );
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow raw ipcMain.handle() — register IPC handlers via createIpcHandle()",
    },
    messages: {
      bare:
        "Register IPC handlers via createIpcHandle() (electron/ipc/ipc-handle.ts). " +
        "The wrapper applies sender-frame validation; raw ipcMain.handle() bypasses it.",
    },
    schema: [],
  },

  create(context) {
    return {
      CallExpression(node) {
        if (isIpcMainHandleCall(node)) {
          context.report({ node, messageId: "bare" });
        }
      },
    };
  },
};

export default {
  meta: { name: "ipc-bridge" },
  rules: {
    "no-bare-ipc-handle": rule,
  },
};
