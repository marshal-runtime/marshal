export function isValidChatWindowBounds(
  bounds: unknown,
): bounds is { x: number; y: number } | undefined {
  return (
    bounds === undefined ||
    (typeof bounds === "object" &&
      bounds !== null &&
      "x" in bounds &&
      "y" in bounds &&
      Number.isFinite(bounds.x) &&
      Number.isFinite(bounds.y))
  );
}
