export function isTrustedLink(url: string): boolean {
  return /^(?:https?:|mailto:|local-file:)/i.test(url);
}
