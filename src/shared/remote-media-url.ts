/** Translate Mac image references only in the authenticated browser surface. */
export function remoteMediaUrl(value: string): string {
  if (typeof window === "undefined" || !window.marshalRemote) return value;
  let filePath: string;
  if (/^(?:local-file|file):/i.test(value)) {
    try {
      filePath = decodeURIComponent(new URL(value.replace(/^local-file:/i, "file:")).pathname);
    } catch {
      return value;
    }
  } else if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/remote/")) {
    filePath = value;
  } else return value;
  return `${location.origin}/remote/media?path=${encodeURIComponent(filePath)}`;
}
