import { installRemotePreload } from "virtual:marshal-remote-preload";

import { installComposerFocus } from "./composerFocus";
import { remoteTransport } from "./transport";
import { installRemoteViewport } from "./viewport";

import "./remote.css";
declare const __MARSHAL_CLOUD_HOSTED__: boolean;
const cloudHosted = typeof __MARSHAL_CLOUD_HOSTED__ !== "undefined" && __MARSHAL_CLOUD_HOSTED__;
const hostLabel = cloudHosted ? "cloud" : "Mac";
window.marshalCloudRemote = cloudHosted;
window.marshalRemote = true;
document.documentElement.dataset.remote = "true";
document.documentElement.dataset.platform = "apple";
installRemoteViewport();
installComposerFocus();
const root = document.getElementById("root")!;
const scannedKey = new URLSearchParams(location.hash.slice(1)).get("key");
if (scannedKey) history.replaceState(null, "", location.pathname);
async function loginWithKey(secret: string) {
  const res = await fetch("/remote/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error ?? "Unable to connect");
  }
}
let appRequested = false;
async function start() {
  const response = await fetch("/remote/status");
  if (response.status !== 200) {
    showLogin();
    return;
  }
  if (appRequested) return;
  appRequested = true;
  root.innerHTML =
    '<div class="remote-connect"><h1>Marshal</h1><p>Connecting to Marshal…</p></div>';
  remoteTransport.onState = (state) => {
    // Only the splash is replaced; once the app has rendered it shows its own banner.
    if (state === "disconnected" && root.firstElementChild?.classList.contains("remote-connect"))
      root.innerHTML = `<div class="remote-connect"><h1>Reconnecting…</h1><p>${cloudHosted ? "Your cloud tasks continue while reconnecting." : "Keep Marshal running on your Mac and Tailscale connected."}</p></div>`;
  };
  // The bridge waits for the socket, so the app bundle downloads while the
  // connection is still being established instead of after it.
  installRemotePreload(remoteTransport);
  remoteTransport.connect();
  try {
    await import("./main");
  } catch {
    root.innerHTML =
      '<div class="remote-connect"><h1>Unable to load chats</h1><p>Check your connection and try again.</p><button type="button">Retry</button></div>';
    root.querySelector("button")!.onclick = () => location.reload();
  }
}
function showLogin() {
  root.innerHTML = `<form class="remote-connect"><img src="${cloudHosted ? "/ui/marshal-icon.svg" : "/marshal-icon.svg"}" width="56" height="56" alt=""><h1>Marshal</h1><p>${cloudHosted ? "Your cloud tasks, on any device." : "Your Mac, in your pocket."}</p><label for="access-key">${cloudHosted ? "Cloud access key" : "Access key from Marshal settings"}</label><input id="access-key" type="password" autocomplete="current-password" required spellcheck="false"><button type="submit">Connect to ${hostLabel}</button><p role="alert"></p></form>`;
  const form = root.querySelector("form")!;
  form.onsubmit = (event) => {
    event.preventDefault();
    void (async () => {
      const button = form.querySelector("button")!;
      button.disabled = true;
      try {
        const res = await fetch("/remote/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: form.querySelector("input")!.value.trim(),
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? "Unable to connect");
        }
        await start();
      } catch (error) {
        form.querySelector("[role=alert]")!.textContent =
          error instanceof Error ? error.message : "Unable to connect";
      } finally {
        button.disabled = false;
      }
    })();
  };
}
void (async () => {
  if (scannedKey) {
    try {
      await loginWithKey(scannedKey);
    } catch {
      showLogin();
      return;
    }
  }
  await start();
})().catch(() => {
  root.innerHTML = `<div class="remote-connect"><h1>Connection unavailable</h1><p>${cloudHosted ? "Your cloud tasks continue running. Reload to reconnect." : "Check Tailscale, then reload this page."}</p></div>`;
});
