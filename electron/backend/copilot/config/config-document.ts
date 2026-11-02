// The Copilot CLI writes ~/.copilot/config.json as JSON-with-comments.
export function parseCopilotConfigDocument(content: string): Record<string, unknown> {
  const json = removeJsoncSyntax(content);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- caller only deletes known fields and re-serializes
  return JSON.parse(json) as Record<string, unknown>; // SF-4: trusted Copilot CLI config
}

function removeJsoncSyntax(content: string): string {
  let result = "";
  let index = 0;

  while (index < content.length) {
    const character = content[index];
    if (character === '"') {
      const end = copyStringLiteral(content, index, (value) => {
        result += value;
      });
      index = end;
      continue;
    }

    if (character === "/" && content[index + 1] === "/") {
      index = skipLineComment(content, index + 2);
      continue;
    }
    if (character === "/" && content[index + 1] === "*") {
      index = skipBlockComment(content, index + 2);
      continue;
    }

    result += character;
    index++;
  }

  return result;
}

function copyStringLiteral(
  content: string,
  start: number,
  append: (value: string) => void,
): number {
  let index = start;
  let value = content[index++];
  while (index < content.length) {
    const character = content[index++];
    value += character;
    if (character === "\\") {
      if (index < content.length) value += content[index++];
      continue;
    }
    if (character === '"') break;
  }
  append(value);
  return index;
}

function skipLineComment(content: string, start: number): number {
  const newline = content.indexOf("\n", start);
  return newline === -1 ? content.length : newline;
}

function skipBlockComment(content: string, start: number): number {
  const closing = content.indexOf("*/", start);
  return closing === -1 ? content.length : closing + 2;
}
