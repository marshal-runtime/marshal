/**
 * Masks an email address to prevent EUII from appearing in logs.
 * "jane.doe@example.com" → "j***@example.com"
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return at < 1 ? "***" : maskedEmailParts(email, at);
}

function maskedEmailParts(email: string, at: number): string {
  return `${email[0]}***@${email.slice(at + 1)}`;
}
