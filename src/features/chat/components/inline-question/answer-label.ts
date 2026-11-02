export const MAX_INLINE_QUESTION_SHORTCUTS = 26;

export function inlineQuestionAnswerLabel(index: number): string {
  return String.fromCharCode(65 + index);
}
