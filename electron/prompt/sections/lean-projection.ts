/**
 * Builds a lean prompt section from its unchanged legacy text. The legacy
 * constants stay verbatim (flag OFF is byte-identical by construction); lean
 * text reuses every retained section as-is and only overrides or drops the
 * sections named here, split at top-level `## ` headings.
 */

export interface SectionEdit {
  /** Exact heading text after `## `. */
  readonly heading: string;
  /** Full replacement section text including its heading; omitted drops the section. */
  readonly replacement?: string;
}

interface Section {
  readonly heading: string | null;
  readonly text: string;
}

function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  let inFence = false;
  const flush = () => {
    if (buffer.length > 0 || heading !== null) {
      sections.push({ heading, text: buffer.join("\n") });
    }
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const headingMatch = inFence ? null : /^## (.+)$/.exec(line);
    if (headingMatch) {
      flush();
      heading = headingMatch[1];
      buffer = [line];
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

export function sectionBody(text: string, heading: string): string {
  const section = splitSections(text).find((candidate) => candidate.heading === heading);
  if (!section) throw new Error(`Prompt section not found: ${heading}`);
  return section.text;
}

/** Slice of a section from one marker to the next, both verbatim from the legacy text. */
export function sliceBetween(text: string, start: string, end: string): string {
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end, startAt);
  if (startAt === -1 || endAt === -1) {
    throw new Error(`Prompt slice markers not found: ${start} … ${end}`);
  }
  return text.slice(startAt, endAt);
}

export function applySectionEdits(
  text: string,
  edits: readonly SectionEdit[],
  options: { tolerateMissing?: boolean } = {},
): string {
  const sections = splitSections(text);
  const headings = new Set(sections.map((section) => section.heading));
  const applicable = options.tolerateMissing
    ? edits.filter((edit) => headings.has(edit.heading))
    : edits;
  for (const edit of applicable) {
    if (!headings.has(edit.heading)) {
      throw new Error(`Lean prompt edit targets a missing section: ${edit.heading}`);
    }
  }
  const editsByHeading = new Map(applicable.map((edit) => [edit.heading, edit]));
  const out: string[] = [];
  for (const section of sections) {
    const edit = section.heading === null ? undefined : editsByHeading.get(section.heading);
    if (!edit) {
      out.push(section.text);
    } else if (edit.replacement !== undefined) {
      out.push(`${edit.replacement.trim()}\n`);
    }
  }
  return out.join("\n");
}
