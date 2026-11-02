export type EditOperation = "insert" | "delete" | "replace" | "none";

export function getEditOperation(prev: string, next: string): EditOperation {
  if (prev === next) return "none";
  if (next.length > prev.length + 1) return "replace";
  if (next.length < prev.length - 1) return "replace";
  if (next.length > prev.length) return "insert";
  if (next.length < prev.length) return "delete";
  return "replace";
}

export function isEditBoundaryCharacter(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || /[.,;:!?(){}[\]"']/.test(ch);
}
