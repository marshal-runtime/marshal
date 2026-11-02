import fs from "node:fs";
import path from "node:path";

import {
  evaluate,
  getActiveSessionId,
  getAssistantMessageCount,
  getAuthStatus,
  getLastAssistantMessage,
  getToolTrace,
  screenshot,
  sendPrompt,
  sleep,
  waitForReady,
  waitForNewAssistantMessage,
} from "../marshal-cdp-helpers.mjs";

const CAPABILITY_NAME = "browser_navigate";
const CAPABILITY_INPUT = { url: "https://example.com" };
const PROMPT = [
  "Use the registered Marshal product tool runtimeSearch to find the exact capability",
  `"${CAPABILITY_NAME}", then use runtimeInvoke to invoke it with this exact JSON input:`,
  JSON.stringify(CAPABILITY_INPUT) + ".",
  "You must call both tools through the normal product tool path; do not answer from memory, use shell,",
  "inspect source files, or use a diagnostic API. Report the capability name and whether the invocation succeeded.",
].join(" ");

export default {
  name: "Marshal Runtime product path",
  async run({ Runtime, Page, resultsDir, connection }) {
    let steps = 0;
    await waitForReady(Runtime);
    steps++;

    const authStatus = await getAuthStatus(Runtime);
    if (authStatus !== "authenticated") {
      throw new Error(`Production backend is not authenticated: ${authStatus}`);
    }
    steps++;

    const acceptanceBridgePresent = await evaluate(
      Runtime,
      `typeof window.runtimeAcceptanceAPI !== "undefined"`,
    );
    if (acceptanceBridgePresent) {
      throw new Error("Acceptance bridge must be absent from real-backend and packaged runs.");
    }
    steps++;

    const assistantCountBefore = await getAssistantMessageCount(Runtime);
    const versionGate = await evaluate(
      Runtime,
      `(() => {
        const dialog = document.querySelector('[data-slot="dialog-content"][role="dialog"]');
        const text = dialog?.textContent ?? "";
        return {
          blocked: text.includes("Update Required"),
          text: text.slice(0, 512),
        };
      })()`,
    );
    let promptDelivery = { path: "chat-editor", versionGate };
    if (versionGate.blocked) {
      const sessionId = await getActiveSessionId(Runtime);
      if (!sessionId)
        throw new Error("No active product session was available behind version gate.");
      await evaluate(
        Runtime,
        `(window.copilotAPI.send(${JSON.stringify(PROMPT)}, ${JSON.stringify(sessionId)}, [])
          .catch(e => console.error('[e2e-runtime] send failed:', e)), undefined)`,
      );
      promptDelivery = {
        path: "production-renderer-copilot-api",
        sessionId,
        versionGate,
      };
    } else {
      await sendPrompt(Runtime, PROMPT);
    }
    steps++;
    await waitForNewAssistantMessage(Runtime, assistantCountBefore, 15, 180);
    steps++;

    const response = await getLastAssistantMessage(Runtime);
    const toolTrace = await getToolTrace(Runtime, true);
    const searchTrace = toolTrace.find((entry) => toolNameMatches(entry.name, "runtimeSearch"));
    const invokeTrace = toolTrace.find((entry) => toolNameMatches(entry.name, "runtimeInvoke"));
    if (!searchTrace || !invokeTrace) {
      throw new Error(
        `Agent did not execute both runtimeSearch and runtimeInvoke. Observed: ${toolTrace
          .map((entry) => entry.name ?? entry.title ?? entry.text)
          .join(" | ")}`,
      );
    }
    steps++;
    const traceText = JSON.stringify(toolTrace);
    if (!traceText.includes(CAPABILITY_NAME) || !runtimeInvocationSucceeded(invokeTrace)) {
      throw new Error("runtimeInvoke trace did not contain a successful capability result.");
    }
    if (!response || !response.includes(CAPABILITY_NAME) || !responseConfirmsSuccess(response)) {
      throw new Error("Agent response did not confirm the successful Marshal Runtime invocation.");
    }
    steps++;

    const panel = await waitForBrowserPanel(Runtime);
    if (!panel.visible || !panel.text.includes("example.com")) {
      throw new Error(
        `Marshal Runtime browser panel was not visible with page details: ${panel.text}`,
      );
    }
    steps++;

    fs.writeFileSync(
      path.join(resultsDir, "runtime-story-results.json"),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          acceptanceBridgePresent,
          backendProof: {
            authStatus,
            productionBackend: true,
            targetTitle: connection?.target?.title ?? null,
            targetUrl: connection?.target?.url ?? null,
          },
          conversation: {
            prompt: PROMPT,
            assistantResponse: response,
            delivery: promptDelivery,
          },
          toolTrace,
          capability: {
            requested: CAPABILITY_NAME,
            input: CAPABILITY_INPUT,
            searchedBy: searchTrace.name,
            invokedBy: invokeTrace.name,
            invocationSucceeded: true,
          },
          browserPanel: panel,
          stories: [
            {
              id: "MRT-BOOT-005",
              status: "PASS",
              criterion: "authenticated-production-agent-capability",
            },
          ],
        },
        null,
        2,
      ),
    );
    await screenshot(Page, resultsDir, "99-marshal-runtime.png");
    steps++;
    return steps;
  },
};

async function waitForBrowserPanel(Runtime, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const panel = await evaluate(
      Runtime,
      `(() => {
        const node = document.querySelector('[data-testid="marshal-browser-panel"]');
        return { visible: !!node, text: node?.textContent ?? "" };
      })()`,
    );
    if (panel.visible) return panel;
    await sleep(250);
  }
  return { visible: false, text: "" };
}

function toolNameMatches(actual, expected) {
  return (
    typeof actual === "string" &&
    (actual === expected || actual.endsWith(`.${expected}`) || actual.endsWith(`_${expected}`))
  );
}

export function runtimeInvocationSucceeded(trace) {
  const output = `${trace?.details ?? ""}\n${trace?.text ?? ""}`.replaceAll('\\"', '"');
  return /"ok"\s*:\s*true/.test(output) && !/"ok"\s*:\s*false/.test(output);
}

export function responseConfirmsSuccess(response) {
  const normalized = response.replace(/[*_`]/g, "").replace(/\s+/g, " ");
  return (
    /(?:invocation\s*:\s*succeeded\b|invocation succeeded\s*:\s*(?:yes|true)\b|invocation was successful|successfully invoked)/i.test(
      normalized,
    ) &&
    !/(?:invocation succeeded\s*:\s*(?:no|false)\b|approval (?:was )?required|invocation failed)/i.test(
      normalized,
    )
  );
}
