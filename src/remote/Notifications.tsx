/* eslint-disable better-tailwindcss/no-unknown-classes -- Remote styles live in remote.css. */
import {
  DEFAULT_REMOTE_PUSH_PREFS,
  RemotePushPrefsSchema,
  type RemotePushPrefs,
  type RemotePushStatus,
} from "@common/remote-push";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { remoteTransport } from "./transport";

const QUERY_KEY = ["remote", "push"] as const;

const PREF_LABELS: { key: Exclude<keyof RemotePushPrefs, "enabled">; label: string }[] = [
  { key: "finished", label: "When a thread finishes" },
  { key: "needsApproval", label: "When a thread needs approval" },
  { key: "agentThreads", label: "Include agent and workflow threads" },
];

function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function saveSubscription(prefs: RemotePushPrefs): Promise<RemotePushStatus> {
  const status = await fetchStatus(null);
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  const key = applicationServerKey(status.publicKey);
  const existingKey = subscription?.options.applicationServerKey;
  if (subscription && existingKey && new Uint8Array(existingKey).join() !== key.join()) {
    // The Mac's push keys changed (reinstall); a subscription is bound to one key.
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const json = subscription.toJSON();
  return asPushStatus(
    await remoteTransport.invoke(
      "remote:push-subscribe",
      { endpoint: json.endpoint, keys: json.keys },
      prefs,
    ),
  );
}

async function fetchStatus(endpoint: string | null): Promise<RemotePushStatus> {
  return asPushStatus(await remoteTransport.invoke("remote:push-status", endpoint ?? undefined));
}

function asPushStatus(value: unknown): RemotePushStatus {
  if (
    typeof value !== "object" ||
    value === null ||
    !("publicKey" in value) ||
    typeof value.publicKey !== "string" ||
    !("subscribed" in value) ||
    typeof value.subscribed !== "boolean"
  )
    throw new Error("Update Marshal on your Mac to use notifications.");
  const prefs = "prefs" in value ? RemotePushPrefsSchema.safeParse(value.prefs) : null;
  return {
    publicKey: value.publicKey,
    subscribed: value.subscribed,
    prefs: prefs?.success ? prefs.data : null,
  };
}

export function RemoteNotificationSettings({ connected }: { connected: boolean }) {
  const queryClient = useQueryClient();
  const supported = pushSupported();
  const status = useQuery({
    queryKey: QUERY_KEY,
    enabled: supported && connected,
    queryFn: async () => {
      const subscription = await currentSubscription();
      return fetchStatus(subscription?.endpoint ?? null);
    },
  });
  const save = useMutation({
    mutationFn: async ({
      prefs,
      permission,
    }: {
      prefs: RemotePushPrefs;
      permission?: Promise<NotificationPermission>;
    }) => {
      if (permission && (await permission) !== "granted")
        throw new Error("Notifications are blocked. Allow them for Marshal in iOS Settings.");
      return saveSubscription(prefs);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  const disable = useMutation({
    mutationFn: async () => {
      const subscription = await currentSubscription();
      if (!subscription) return;
      await remoteTransport.invoke("remote:push-unsubscribe", subscription.endpoint);
      await subscription.unsubscribe();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  if (!supported) {
    return (
      <section className="remote-notifications">
        <h2>Notifications</h2>
        <p>
          Add Marshal to your Home Screen (steps below) and open it from there to get thread
          notifications. iOS 16.4 or later is required.
        </p>
      </section>
    );
  }

  const prefs = status.data?.subscribed ? status.data.prefs : null;
  const on = !!prefs?.enabled;
  const busy = save.isPending || disable.isPending || status.isPending;
  const error = save.error ?? disable.error ?? status.error;
  return (
    <section className="remote-notifications">
      <h2>Notifications</h2>
      <p>Get a notification on this phone when a thread on your Mac needs you.</p>
      <button
        role="switch"
        aria-checked={on}
        className="remote-switch"
        disabled={busy || !connected}
        onClick={() => {
          if (on) {
            disable.mutate();
            return;
          }
          // iOS only shows the permission prompt from inside the tap itself.
          const permission = Notification.requestPermission();
          save.mutate({
            prefs: { ...(prefs ?? DEFAULT_REMOTE_PUSH_PREFS), enabled: true },
            permission,
          });
        }}
      >
        <span>Thread notifications</span>
        <span aria-hidden="true">{on ? "On" : "Off"}</span>
      </button>
      {on &&
        prefs &&
        PREF_LABELS.map(({ key, label }) => (
          <button
            key={key}
            role="switch"
            aria-checked={prefs[key]}
            className="remote-switch remote-switch-sub"
            disabled={busy || !connected}
            onClick={() => save.mutate({ prefs: { ...prefs, [key]: !prefs[key] } })}
          >
            <span>{label}</span>
            <span aria-hidden="true">{prefs[key] ? "On" : "Off"}</span>
          </button>
        ))}
      {error && (
        <p role="alert" className="remote-notifications-error">
          {error instanceof Error ? error.message : "Could not update notifications"}
        </p>
      )}
    </section>
  );
}
