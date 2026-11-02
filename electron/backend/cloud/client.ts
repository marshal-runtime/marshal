import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { RuntimeConversationState } from "../../../common/runtime-conversation-state";
import type {
  RuntimeSessionEvent,
  RuntimeAssistantMessageEvent,
} from "../../../common/runtime-events";
import { cleanContextUserText, stateFromEvents } from "../conversation-state";
import type {
  RuntimeClient,
  RuntimeClientFactory,
  RuntimeClientSession,
  RuntimeSessionConfig,
  RuntimeSendOptions,
} from "../runtime-contract";
import { CloudClient } from "./transport";
import { captureCloudWorkspace } from "./workspace";
interface Snapshot {
  id: string;
  status: string;
  sequence: number;
  approvals: Array<{
    id: string;
    requestId: string;
    tool: string;
    input: unknown;
    decision?: string;
  }>;
}
interface Event {
  sequence: number;
  eventId: string;
  at: string;
  type: string;
  data: Record<string, unknown>;
}
interface Page {
  events: Event[];
  nextSequence: number;
  hasMore: boolean;
}
export function cloudRuntimeEvent(e: Event): RuntimeSessionEvent | undefined {
  const base = { id: e.eventId, timestamp: e.at, parentId: null };
  const d = e.data;
  const text = typeof d.text === "string" ? d.text : "";
  if (e.type === "session.created" && d.conversation)
    return {
      ...base,
      type: "session.context_checkpoint",
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
      data: { state: d.conversation as RuntimeConversationState },
    };
  const messageId =
    e.type === "assistant.message"
      ? e.eventId
      : typeof d.messageId === "string"
        ? d.messageId
        : undefined;
  if (e.type === "assistant.delta")
    return { ...base, type: "assistant.message_delta", data: { messageId, deltaContent: text } };
  if (e.type === "assistant.message")
    return { ...base, type: "assistant.message", data: { messageId, content: text } };
  if (e.type === "tool.started")
    return {
      ...base,
      type: "tool.execution_start",
      data: { toolName: String(d.name), toolCallId: String(d.id), arguments: d.input },
    };
  if (e.type === "tool.finished")
    return {
      ...base,
      type: "tool.execution_complete",
      data: { toolCallId: String(d.id), success: d.success !== false, result: d.result },
    };
  if (e.type === "message.completed") return { ...base, type: "session.idle", data: {} };
  if (e.type === "message.failed" || e.type === "session.needs_attention")
    return {
      ...base,
      type: "session.error",
      data: { message: typeof d.error === "string" ? d.error : "Cloud execution needs attention" },
    };
  if ((e.type === "session.created" || e.type === "message.queued") && typeof d.prompt === "string")
    return { ...base, type: "user.message", data: { content: cleanContextUserText(d.prompt) } };
  return undefined;
}
export function cloudTranscript(
  events: RuntimeSessionEvent[],
): import("../../../common/marshal-ipc-contract").SessionMessage[] {
  return events.flatMap<import("../../../common/marshal-ipc-contract").SessionMessage>((e) => {
    if (e.type === "session.context_checkpoint")
      return e.data.state.messages.flatMap((m, index) =>
        m.role === "tool"
          ? []
          : [
              {
                id: `import-${e.id}-${index}`,
                role: m.role,
                content: m.content,
                timestamp: e.timestamp,
              },
            ],
      );
    if (e.type === "user.message" || e.type === "assistant.message")
      return [
        {
          id: e.id,
          role: e.type === "user.message" ? "user" : "assistant",
          content: e.data.content,
          timestamp: e.timestamp,
        },
      ];
    return [];
  });
}
export async function inspectCloudSession(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid cloud session ID");
  const transport = await cloudTransport();
  const metadata = await transport.request<Snapshot & { environmentId: string; title: string }>(
    "GET",
    `/v1/sessions/${id}`,
  );
  const client = await createCloudClientFactory()("");
  try {
    const session = await client.resumeSession(id, {});
    return { session, client, metadata };
  } catch (error) {
    await client.stop();
    throw error;
  }
}
async function cloudTransport(options?: { serviceUrl: string; token: string }) {
  const url = options?.serviceUrl ?? process.env.MARSHAL_CLOUD_PUBLIC_URL;
  const token =
    options?.token ??
    (process.env.MARSHAL_CLOUD_TOKEN_FILE
      ? (await readFile(process.env.MARSHAL_CLOUD_TOKEN_FILE, "utf8")).trim()
      : undefined);
  if (!url || !token)
    throw new Error(
      "Configure MARSHAL_CLOUD_PUBLIC_URL and MARSHAL_CLOUD_TOKEN_FILE to enable cloud workers",
    );
  return new CloudClient(url, token);
}

class CloudSession implements RuntimeClientSession {
  private listeners = new Set<(e: RuntimeSessionEvent) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private closed = false;
  private approvals = new Set<string>();
  private synchronized = false;
  private rawHistory: Event[] = [];
  private errorReported = false;
  constructor(
    readonly sessionId: string,
    private client: CloudClient,
    private config: RuntimeSessionConfig,
    private cursor: number,
  ) {}
  on(handler: (e: RuntimeSessionEvent) => void) {
    this.listeners.add(handler);
    this.timer ??= setInterval(() => void this.poll(), 1000);
    void this.poll();
    return () => {
      this.listeners.delete(handler);
      if (!this.listeners.size) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }
  private emit(e: RuntimeSessionEvent) {
    for (const handler of this.listeners) handler(e);
  }
  private async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const snapshot = await this.client.request<Snapshot>("GET", `/v1/sessions/${this.sessionId}`);
      if (!this.synchronized) {
        const history = await this.getMessages();
        if (this.closed) return;
        this.emit({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          parentId: null,
          type: "session.history_snapshot",
          data: { messages: cloudTranscript(history) },
        });
        this.cursor = this.rawHistory.at(-1)?.sequence ?? this.cursor;
        if (snapshot.status === "running" || snapshot.status === "waiting_approval") {
          const boundary = this.rawHistory.findLastIndex(
            (e) => e.type === "message.completed" || e.type === "message.failed",
          );
          const tail = this.rawHistory.slice(boundary + 1);
          const textBoundary = tail.findLastIndex((e) => e.type === "assistant.message");
          for (const raw of tail.slice(textBoundary + 1))
            if (["assistant.delta", "tool.started", "tool.finished"].includes(raw.type)) {
              const e = cloudRuntimeEvent(raw);
              if (e) this.emit(e);
            }
        }
        this.synchronized = true;
      }
      for (let i = 0; i < 10; i++) {
        // oxlint-disable-next-line no-await-in-loop -- iterations are intentionally sequential
        const page = await this.client.request<Page>(
          "GET",
          `/v1/sessions/${this.sessionId}/events?after=${this.cursor}`,
        );
        if (this.closed) return;
        if (page.events.some((e) => e.type === "message.queued")) {
          // oxlint-disable-next-line no-await-in-loop -- iterations are intentionally sequential
          const history = await this.getMessages();
          if (this.closed) return;
          this.emit({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            parentId: null,
            type: "session.history_snapshot",
            data: { messages: cloudTranscript(history) },
          });
        }
        for (const raw of page.events) {
          const e = cloudRuntimeEvent(raw);
          if (e) this.emit(e);
        }
        this.cursor = page.nextSequence;
        if (!page.hasMore) break;
      }
      for (const a of snapshot.approvals)
        if (
          snapshot.status === "waiting_approval" &&
          !a.decision &&
          !this.approvals.has(a.id) &&
          this.config.onPermissionRequest
        ) {
          this.approvals.add(a.id);
          void Promise.resolve(
            this.config.onPermissionRequest(
              {
                kind: "custom-tool",
                toolCallId: a.requestId,
                toolName: a.tool,
                arguments: a.input,
              },
              { sessionId: this.sessionId },
            ),
          )
            .then(async (decision) => {
              if (this.closed) return;
              await this.client.request(
                "POST",
                `/v1/sessions/${this.sessionId}/approvals/${a.id}`,
                {
                  requestId: `desktop-${a.id}`,
                  decision: decision.kind === "approve-once" ? "allow" : "deny",
                },
              );
            })
            .catch(() => this.approvals.delete(a.id));
        }
      this.errorReported = false;
    } catch {
      this.synchronized = false;
      if (!this.closed && !this.errorReported) {
        this.errorReported = true;
        this.emit({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          parentId: null,
          type: "session.status",
          data: {
            status: "reconnecting",
            message: "Reconnecting to cloud; execution continues independently",
          },
        });
      }
    } finally {
      this.polling = false;
    }
  }
  async send(options: RuntimeSendOptions) {
    if (options.attachments?.length)
      throw new Error(
        "Cloud file attachments require workspace transfer; local paths cannot be used in the cloud",
      );
    const requestId = randomUUID();
    const result = await this.client.request<{ id: string }>(
      "POST",
      `/v1/sessions/${this.sessionId}/messages`,
      {
        requestId,
        prompt: this.config.conversationState
          ? cleanContextUserText(options.prompt)
          : options.prompt,
      },
    );
    void this.poll();
    return result.id;
  }
  async sendAndWait(
    options: RuntimeSendOptions,
    timeout = 30 * 60_000,
  ): Promise<RuntimeAssistantMessageEvent | undefined> {
    let last: RuntimeAssistantMessageEvent | undefined;
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const wait = new Promise<void>((r, j) => {
      resolve = r;
      reject = j;
    });
    const off = this.on((e) => {
      if (e.type === "assistant.message") last = e;
      if (e.type === "session.idle") resolve();
      if (e.type === "session.error") reject(new Error(e.data.message));
    });
    const timer = setTimeout(
      () => reject(new Error("Cloud response timeout; execution continues")),
      timeout,
    );
    try {
      await this.send(options);
      await wait;
      return last;
    } finally {
      clearTimeout(timer);
      off();
    }
  }
  async disconnect() {
    this.closed = true;
    clearInterval(this.timer);
    this.listeners.clear();
  }
  async destroy() {
    await this.disconnect();
  }
  async abort() {
    await this.client.request("POST", `/v1/sessions/${this.sessionId}/stop`, {});
    this.emit({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      parentId: null,
      type: "abort",
      data: {},
    });
  }
  async setModel() {
    throw new Error("Change cloud environment by creating a new cloud worker");
  }
  async getMessages() {
    const result: RuntimeSessionEvent[] = [];
    const rawEvents: Event[] = [];
    let after = 0;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- iterations are intentionally sequential
      const p = await this.client.request<Page>(
        "GET",
        `/v1/sessions/${this.sessionId}/events?after=${after}`,
      );
      for (const raw of p.events) {
        rawEvents.push(raw);
        const e = cloudRuntimeEvent(raw);
        if (e) result.push(e);
      }
      after = p.nextSequence;
      if (!p.hasMore) {
        this.rawHistory = rawEvents;
        return result;
      }
    }
  }
  async exportConversationState(): Promise<RuntimeConversationState> {
    const events = await this.getMessages();
    const initial = events.find((e) => e.type === "session.context_checkpoint");
    const current = stateFromEvents("marshal-cloud", events);
    return initial?.type === "session.context_checkpoint"
      ? {
          ...current,
          summary: current.summary ?? initial.data.state.summary,
          messages: [...initial.data.state.messages, ...current.messages],
        }
      : current;
  }
}
export function createCloudClientFactory(options?: {
  serviceUrl: string;
  token: string;
}): RuntimeClientFactory {
  return async () => {
    const transport = await cloudTransport(options);
    const sessions = new Set<CloudSession>();
    const connect = (id: string, config: RuntimeSessionConfig, cursor: number) => {
      const s = new CloudSession(id, transport, config, cursor);
      sessions.add(s);
      return s;
    };
    const client: RuntimeClient = {
      stop: async () => {
        await Promise.all([...sessions].map((s) => s.disconnect()));
        sessions.clear();
        return [];
      },
      deleteSession: async (id) => {
        await transport.request("POST", `/v1/sessions/${id}/cancel`, {});
      },
      getAuthStatus: async () => {
        await transport.request("GET", "/v1/environments");
        return { isAuthenticated: true, login: "Marshal Cloud" };
      },
      listModels: async () => {
        const result = await transport.request<{
          environments: Array<{ id: string; title: string }>;
        }>("GET", "/v1/environments");
        return result.environments.map((e) => ({
          id: e.id,
          name: `Cloud · ${e.title}`,
          capabilities: { supportsVision: false, supports: { reasoningEffort: false } },
        }));
      },
      createSession: async (config) => {
        if (!config.model) throw new Error("Select a cloud environment");
        // "danger-full-access" is the derived allow-all default (no restriction).
        if (
          config.availableTools ||
          (config.sandbox && config.sandbox.mode !== "danger-full-access")
        )
          throw new Error(
            "This cloud adapter cannot enforce the requested host tool or sandbox restrictions",
          );
        const workspace = config.workingDirectory
          ? await captureCloudWorkspace(config.workingDirectory)
          : undefined;
        const snapshot = await transport.request<Snapshot>("POST", "/v1/sessions", {
          requestId: randomUUID(),
          environmentId: config.model,
          title: "Cloud task",
          workspace,
          conversation: config.conversationState,
        });
        return connect(snapshot.id, config, snapshot.sequence);
      },
      resumeSession: async (id, config) => {
        const snapshot = await transport.request<Snapshot>("GET", `/v1/sessions/${id}`);
        return connect(id, config, snapshot.sequence);
      },
    };
    return client;
  };
}
