#!/usr/bin/env node
// Marshal-owned module.
// Minimal ACP agent: speaks JSON-RPC 2.0 over stdio.
// Implements: initialize, session/new, session/prompt.
// On session/prompt, requests one tool permission with the real ACP request
// shape (toolCall + options array), then emits a session/update with a fake
// review body using the `sessionUpdate` discriminator, then returns done.

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
});

let nextReqId = 1000;
const pending = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function request(method, params) {
  const id = nextReqId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function handle(msg) {
  if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
    return;
  }

  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    return;
  }

  // FAKE_HANG_AFTER_INIT: respond to initialize but never reply to anything
  // after that. Used to exercise the slot's maxLifetimeMs SIGKILL path.
  if (process.env.FAKE_HANG_AFTER_INIT) {
    return;
  }

  if (msg.method === "session/new") {
    // The slot's fallback path calls session/new with a fresh id. Append a
    // -fallback suffix so tests can distinguish "freshly created" from
    // "resumed" by inspecting the returned sessionId.
    const sessionId = process.env.FAKE_SESSION_LOAD_FAILS
      ? "fake-session-fallback"
      : "fake-session-1";
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
    return;
  }

  if (msg.method === "session/load") {
    if (process.env.FAKE_SESSION_LOAD_FAILS) {
      // JSON-RPC error response — the slot should treat this as "load failed"
      // and fall back to session/new.
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32600, message: "fake: session/load not supported" },
      });
      return;
    }
    // Happy path: echo back the requested sessionId so the slot believes
    // the load succeeded.
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "session/prompt") {
    const sessionId = msg.params?.sessionId ?? "fake-session-1";
    const requestedCmd = process.env.FAKE_REQUEST_CMD ?? "gh pr comment 1 -b nope";
    const response = await request("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "call_1",
        title: "Execute command",
        kind: "execute",
        status: "pending",
        rawInput: { command: requestedCmd },
      },
      options: [
        { optionId: "opt_allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "opt_allow_always", name: "Allow always", kind: "allow_always" },
        { optionId: "opt_reject_once", name: "Reject once", kind: "reject_once" },
        { optionId: "opt_reject_always", name: "Reject always", kind: "reject_always" },
      ],
    });
    if (!process.env.FAKE_EMPTY_BODY) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "## Findings\n\n- fake review body\n" },
          },
        },
      });
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { stopReason: "end_turn", permissionResponse: response },
    });
    return;
  }
}
