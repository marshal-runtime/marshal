export const CONTEXT_PICKER_LISTBOX_ID = "context-picker-listbox";

// These ids are for aria-activedescendant/idref use; use getElementById, not CSS selectors.
export function contextPickerOptionId(value: string): string {
  const encodedValue = encodeURIComponent(value);
  return `context-picker-option-${encodedValue}`;
}
