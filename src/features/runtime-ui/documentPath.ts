export function documentPath(href: string, basePath?: string): string | null {
  if (!href || href.startsWith("#")) return null;
  if (/^(?:file|local-file):/i.test(href)) {
    try {
      const url = new URL(href);
      if (url.hostname) return null;
      return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z]:[/\\]/.test(href)) return href;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return null;
  try {
    const decoded = decodeURIComponent(href.split(/[?#]/)[0] ?? "");
    if (decoded.startsWith("/")) return decoded;
    if (!basePath) return decoded;
    const parent = basePath.replaceAll("\\", "/").replace(/[^/]*$/, "");
    return documentPath(
      new URL(decoded, `file://${parent.startsWith("/") ? "" : "/"}${parent}`).href,
    );
  } catch {
    return null;
  }
}
