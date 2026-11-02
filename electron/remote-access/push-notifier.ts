import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type {
  PermissionCardData,
  SessionMetadata,
  SessionViewStatus,
} from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import {
  RemotePushPrefsSchema,
  type RemotePushPrefs,
  type RemotePushStatus,
} from "../../common/remote-push";
import { matchesSessionFilter } from "../../common/session-filters";
import {
  generateVapidKeys,
  isAllowedPushEndpoint,
  sendWebPush,
  type PushSubscriptionKeys,
} from "./web-push";

const log = createLogger("RemotePush");

const SubscriptionSchema = z.object({
  endpoint: z.string().max(2048),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});
const StateSchema = z.object({
  vapid: z.object({
    publicKey: z.string(),
    privateJwk: z.object({
      kty: z.string(),
      crv: z.string(),
      d: z.string(),
      x: z.string(),
      y: z.string(),
    }),
  }),
  subscriptions: z.array(SubscriptionSchema.extend({ prefs: RemotePushPrefsSchema })).max(20),
});
type PushState = z.infer<typeof StateSchema>;

export type PushSessionInfo = Pick<SessionMetadata, "automationId" | "source"> & { name?: string };

export interface RemotePushNotifierDeps {
  filePath: string;
  /** VAPID subject: the private Tailscale origin when configured. */
  subject: () => string;
  getSession: (sessionId: string) => Promise<PushSessionInfo | null>;
  /** True when a phone is on screen showing this session (no need to buzz it). */
  isViewingOnPhone: (sessionId: string) => boolean;
}

const BUSY: ReadonlySet<SessionViewStatus> = new Set(["submitted", "streaming"]);
const NOTIFICATION_TITLE_MAX = 120;
const NOTIFICATION_BODY_MAX = 600;

export class RemotePushNotifier {
  private state: PushState;
  private readonly statuses = new Map<string, SessionViewStatus>();
  private readonly announcedCards = new Set<string>();

  constructor(private readonly deps: RemotePushNotifierDeps) {
    this.state = this.load();
  }

  get publicKey(): string {
    return this.state.vapid.publicKey;
  }

  status(endpoint?: string): RemotePushStatus {
    const match = this.state.subscriptions.find((entry) => entry.endpoint === endpoint);
    return { publicKey: this.publicKey, subscribed: !!match, prefs: match?.prefs ?? null };
  }

  subscribe(subscription: PushSubscriptionKeys, prefs: RemotePushPrefs): RemotePushStatus {
    const parsed = SubscriptionSchema.parse(subscription);
    if (!isAllowedPushEndpoint(parsed.endpoint))
      throw new Error("This browser's push service is not supported");
    this.state.subscriptions = [
      ...this.state.subscriptions.filter((entry) => entry.endpoint !== parsed.endpoint),
      { ...parsed, prefs: RemotePushPrefsSchema.parse(prefs) },
    ].slice(-20);
    this.save();
    return this.status(parsed.endpoint);
  }

  unsubscribe(endpoint: string): RemotePushStatus {
    this.state.subscriptions = this.state.subscriptions.filter(
      (entry) => entry.endpoint !== endpoint,
    );
    this.save();
    return this.status(endpoint);
  }

  /** Session view stream: a busy → ready/error transition is a finished turn. */
  observeView(sessionId: string, status: SessionViewStatus, error: string | null): void {
    const previous = this.statuses.get(sessionId);
    this.statuses.set(sessionId, status);
    if (!previous || !BUSY.has(previous) || BUSY.has(status)) return;
    const failed = status === "error";
    void this.dispatch(
      sessionId,
      "finished",
      failed ? "Stopped with an error" : "Finished",
      failed ? (error ?? "") : "",
    );
  }

  observeCards(sessionId: string, cards: PermissionCardData[]): void {
    for (const card of cards) {
      const key = `${sessionId}:${card.id}`;
      if (card.resolved) {
        this.announcedCards.delete(key);
        continue;
      }
      if (this.announcedCards.has(key)) continue;
      this.announcedCards.add(key);
      void this.dispatch(
        sessionId,
        "needsApproval",
        "Needs your approval",
        card.title || card.message,
      );
    }
  }

  private async dispatch(
    sessionId: string,
    kind: "finished" | "needsApproval",
    headline: string,
    detail: string,
  ): Promise<void> {
    if (!this.state.subscriptions.some((entry) => entry.prefs.enabled && entry.prefs[kind])) return;
    if (this.deps.isViewingOnPhone(sessionId)) return;
    const session = await this.deps.getSession(sessionId).catch(() => null);
    if (!session) return;
    const isChat = matchesSessionFilter(session, new Set(["chats"]));
    const recipients = this.state.subscriptions.filter(
      (entry) => entry.prefs.enabled && entry.prefs[kind] && (isChat || entry.prefs.agentThreads),
    );
    this.send(recipients, kind, {
      title: session.name || "Marshal",
      body: detail ? `${headline} · ${detail.replace(/\s+/g, " ").slice(0, 140)}` : headline,
      sessionId,
      tag: `${sessionId}:${kind}`,
    });
  }

  /** Pushes an explicit runtime notification (`ui.notification.show`) to every enabled phone. */
  notify(delivery: {
    deliveryId: string;
    title: string;
    message: string;
    sessionId?: string;
  }): void {
    this.send(
      this.state.subscriptions.filter((entry) => entry.prefs.enabled),
      "notification",
      {
        title: delivery.title.slice(0, NOTIFICATION_TITLE_MAX),
        body: delivery.message.replace(/\s+/g, " ").slice(0, NOTIFICATION_BODY_MAX),
        sessionId: delivery.sessionId,
        tag: `notification:${delivery.deliveryId}`,
      },
    );
  }

  private send(
    recipients: PushState["subscriptions"],
    kind: string,
    payload: { title: string; body: string; sessionId?: string; tag: string },
  ): void {
    for (const entry of recipients) {
      void sendWebPush(entry, payload, this.state.vapid, this.deps.subject()).then((result) => {
        if (result === "expired") this.unsubscribe(entry.endpoint);
        else if (result === "failed") log.warn("Push delivery failed", { kind });
      });
    }
  }

  private load(): PushState {
    try {
      // SF-4: parsed as unknown and validated by StateSchema below.
      const raw: unknown = JSON.parse(readFileSync(this.deps.filePath, "utf8"));
      const parsed = StateSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
    } catch {
      /* First use: create keys below. */
    }
    const state: PushState = { vapid: generateVapidKeys(), subscriptions: [] };
    this.state = state;
    this.save();
    return state;
  }

  private save(): void {
    mkdirSync(path.dirname(this.deps.filePath), { recursive: true });
    writeFileSync(this.deps.filePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    chmodSync(this.deps.filePath, 0o600);
  }
}
