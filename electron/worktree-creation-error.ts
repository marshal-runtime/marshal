export type WorktreeCreationErrorCategory =
  | "capacity"
  | "transient"
  | "permission-denied"
  | "conflict"
  | "invalid-repository"
  | "git-unavailable"
  | "unknown";

const RETRYABLE_CATEGORIES = new Set<WorktreeCreationErrorCategory>([
  "capacity",
  "transient",
]);

function readProperty(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function collectErrorDetails(error: unknown): { codes: Set<string>; text: string } {
  const codes = new Set<string>();
  const text: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (typeof current === "string") {
      text.push(current);
      continue;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);

    if (current instanceof Error) text.push(current.message);
    for (const key of ["code", "errno"]) {
      const value = readProperty(current, key);
      if (typeof value === "string") codes.add(value.toUpperCase());
    }
    for (const key of ["stderr", "stdout", "syscall", "path"]) {
      const value = readProperty(current, key);
      if (typeof value === "string") text.push(value);
    }
    const cause = readProperty(current, "cause");
    if (cause !== undefined) pending.push(cause);
  }

  return { codes, text: text.join("\n").toLowerCase() };
}

function originalErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Unknown worktree creation failure";
}

export class WorktreeCreationError extends Error {
  readonly kind = "environmental";
  readonly operation = "worktree.create";
  readonly retryable: boolean;

  constructor(
    readonly category: WorktreeCreationErrorCategory,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorktreeCreationError";
    this.retryable = RETRYABLE_CATEGORIES.has(category);
  }
}

export function classifyWorktreeCreationError(error: unknown): WorktreeCreationError {
  if (error instanceof WorktreeCreationError) return error;

  const { codes, text } = collectErrorDetails(error);
  let category: WorktreeCreationErrorCategory;
  let code: string;

  if (
    codes.has("ENOSPC") ||
    codes.has("EDQUOT") ||
    codes.has("EMFILE") ||
    codes.has("ENFILE") ||
    codes.has("ENOMEM") ||
    /no space left on device|not enough space on the disk|insufficient disk space|disk quota exceeded|disk is full/.test(
      text,
    )
  ) {
    category = "capacity";
    code =
      [...codes].find((candidate) =>
        ["ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "ENOMEM"].includes(candidate),
      ) ?? "ENOSPC";
  } else if (
    codes.has("EAGAIN") ||
    codes.has("EBUSY") ||
    codes.has("ETXTBSY") ||
    /resource temporarily unavailable|device or resource busy|index\.lock.*file exists|another git process seems to be running/.test(
      text,
    )
  ) {
    category = "transient";
    code =
      [...codes].find((candidate) => ["EAGAIN", "EBUSY", "ETXTBSY"].includes(candidate)) ??
      "ELOCKED";
  } else if (
    codes.has("EACCES") ||
    codes.has("EPERM") ||
    codes.has("EROFS") ||
    /permission denied|access is denied|operation not permitted|read-only file system/.test(text)
  ) {
    category = "permission-denied";
    code =
      [...codes].find((candidate) => ["EACCES", "EPERM", "EROFS"].includes(candidate)) ??
      "EACCES";
  } else if (
    codes.has("EEXIST") ||
    codes.has("ENOTEMPTY") ||
    /already exists|already checked out|already registered|already used by worktree/.test(text)
  ) {
    category = "conflict";
    code =
      [...codes].find((candidate) => ["EEXIST", "ENOTEMPTY"].includes(candidate)) ?? "EEXIST";
  } else if (
    codes.has("ENOENT") &&
    /spawn\s+git|execfile\s+git|command not found|not recognized as an internal or external command|could not find git/.test(
      text,
    )
  ) {
    category = "git-unavailable";
    code = "ENOENT";
  } else if (
    codes.has("ENOENT") ||
    codes.has("ENOTDIR") ||
    /createworktree requires|repository path is not a directory|not a git repository|must be run in a work tree|does not exist|cannot change to|invalid reference|not a valid (?:object name|branch point)|reference is not a tree|unknown revision|bad object/.test(
      text,
    )
  ) {
    category = "invalid-repository";
    code = codes.has("ENOTDIR")
      ? "ENOTDIR"
      : codes.has("ENOENT")
        ? "ENOENT"
        : "INVALID_REPOSITORY";
  } else {
    category = "unknown";
    code = [...codes][0] ?? "UNKNOWN";
  }

  return new WorktreeCreationError(category, code, originalErrorMessage(error), { cause: error });
}
