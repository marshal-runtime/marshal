export const RUNTIME_UI_SANDBOX_BOOTSTRAP = String.raw`(() => {
  const nonce = document.querySelector('meta[name="marshal-sandbox-nonce"]').content;
  const report = () => parent.postMessage({ marshalSandboxError: nonce }, '*');
  addEventListener('error', report);
  addEventListener('unhandledrejection', report);
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') top.postMessage({ marshalSandboxEscape: nonce }, '*');
  });
  parent.postMessage({ marshalSandbox: nonce }, '*');
  addEventListener('DOMContentLoaded', async () => {
    for (const source of document.querySelectorAll('script[type="application/x-marshal-bundle"]')) {
      const url = URL.createObjectURL(new Blob([source.textContent], { type: 'text/javascript' }));
      const script = document.createElement('script');
      if (source.dataset.module === 'true') script.type = 'module';
      script.src = url;
      try {
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = reject;
          source.replaceWith(script);
        });
      } catch { report(); break; }
      finally { URL.revokeObjectURL(url); }
    }
  }, { once: true });
})();`;

export const RUNTIME_UI_SANDBOX_CSP_SOURCE =
  "'sha256-+rUn+6o906cem/GQnSF6CQiCEaBfSk7GiKNE7tAvfAQ='";
