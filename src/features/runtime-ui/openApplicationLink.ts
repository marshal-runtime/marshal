const MAX_URL_LENGTH = 4096;

/**
 * MCP-Apps `ui/open-link`: a sandboxed application asks the host to open a web
 * link outside Marshal. Only http(s) URLs pass. The Mac hands them to the
 * system browser through the main process's validated opener; the phone opens
 * a browser tab itself, riding the user's tap inside the application.
 */
export async function openApplicationLink(raw: unknown): Promise<Record<string, never>> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH)
    throw new Error("A link URL is required.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The link is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Only web links can be opened.");
  if (window.marshalRemote) {
    const tab = window.open(url.href, "_blank");
    if (!tab) throw new Error("The browser blocked the link. Copy it instead.");
    tab.opener = null;
    return {};
  }
  const result = await window.shellAPI?.openExternal(url.href);
  if (!result?.success) throw new Error(result?.error ?? "The link could not be opened.");
  return {};
}
