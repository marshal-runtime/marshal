import { z } from "zod";

/** Per-device phone notification preferences, stored on the Mac with the push subscription. */
export const RemotePushPrefsSchema = z
  .object({
    enabled: z.boolean(),
    /** A thread finished its turn (or stopped with an error). */
    finished: z.boolean(),
    /** A thread is waiting on a permission approval. */
    needsApproval: z.boolean(),
    /** Also notify for subagent, workflow, relay and automation threads. */
    agentThreads: z.boolean(),
  })
  .strict();

export type RemotePushPrefs = z.infer<typeof RemotePushPrefsSchema>;

export const DEFAULT_REMOTE_PUSH_PREFS: RemotePushPrefs = {
  enabled: true,
  finished: true,
  needsApproval: true,
  agentThreads: false,
};

export interface RemotePushStatus {
  /** VAPID application server key (base64url) for PushManager.subscribe. */
  publicKey: string;
  subscribed: boolean;
  prefs: RemotePushPrefs | null;
}
