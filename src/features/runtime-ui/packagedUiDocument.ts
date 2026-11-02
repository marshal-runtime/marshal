import {
  RUNTIME_UI_SANDBOX_BOOTSTRAP,
  RUNTIME_UI_SANDBOX_CSP_SOURCE,
} from "@common/runtime-ui-sandbox";

export interface PackagedUiDocument {
  readonly srcDoc: string;
  readonly dispose: () => void;
}

const CSP = [
  "default-src 'none'",
  `script-src blob: ${RUNTIME_UI_SANDBOX_CSP_SOURCE}`,
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function createPackagedUiDocument(html: string, nonce: string): PackagedUiDocument {
  const document = new DOMParser().parseFromString(html, "text/html");
  const dispose = () => undefined;
  try {
    document.querySelectorAll("base, meta[http-equiv]").forEach((node) => node.remove());
    for (const script of document.querySelectorAll("script")) {
      if (script.hasAttribute("src")) {
        throw new Error(
          "Package UI scripts must be bundled inline; external imports are unavailable.",
        );
      }
      if (
        script.type &&
        !["module", "text/javascript", "application/javascript"].includes(script.type)
      )
        continue;
      script.dataset.module = String(script.type === "module");
      script.type = "application/x-marshal-bundle";
    }
    const policy = document.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = CSP;
    const bootstrap = document.createElement("script");
    bootstrap.textContent = RUNTIME_UI_SANDBOX_BOOTSTRAP;
    const channel = document.createElement("meta");
    channel.name = "marshal-sandbox-nonce";
    channel.content = nonce;
    document.head.prepend(policy, channel, bootstrap);
    return { srcDoc: `<!doctype html>\n${document.documentElement.outerHTML}`, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
