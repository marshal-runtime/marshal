// Marshal-owned module.
// Locale for all date/time formatting in the app.
// Change to `undefined` to use the system/browser locale.
const DATE_LOCALE: string | undefined = "en-US";

export function getDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(DATE_LOCALE);
}

/** 12-hour time: "11:03 am", "4:30 pm" — shared by all timestamps */
function formatTime12h(date: Date): string {
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes} ${ampm}`;
}

/** Format "18 Apr" — day-first short date, shared by inline and tooltip */
function formatDayMonth(date: Date): string {
  const day = date.getDate();
  const month = date.toLocaleDateString(DATE_LOCALE, { month: "short" });
  return `${day} ${month}`;
}

/**
 * Inline chat message timestamp (user messages only, shown on hover).
 *
 * Today: clock time only ("11:03 am").
 * This year: date only ("18 Apr").
 * Previous years: date with year ("18 Apr 2025").
 */
export function formatMessageTime(date: Date): string {
  if (isNaN(date.getTime())) return "";
  const now = new Date();
  if (getDateKey(date) === getDateKey(now)) return formatTime12h(date);
  if (date.getFullYear() !== now.getFullYear()) {
    return `${formatDayMonth(date)} ${date.getFullYear()}`;
  }
  return formatDayMonth(date);
}

/** Chat hover tooltip: "17 Apr 2026, 8:35 pm" (12-hour) */
export function formatChatTooltip(date: Date): string {
  if (isNaN(date.getTime())) return "";
  return `${formatDayMonth(date)} ${date.getFullYear()}, ${formatTime12h(date)}`;
}

/** Full timestamp for LeftNav/session tooltips: "21 Apr, 12:31 pm (5m ago)" */
export function formatDateFull(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr || "";

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  const year = date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : "";
  let result = `${formatDayMonth(date)}${year}, ${formatTime12h(date)}`;

  if (diffMins < 1) {
    result += " (just now)";
  } else if (diffMins < 60) {
    result += ` (${diffMins}m ago)`;
  } else if (diffHours < 24) {
    result += ` (${diffHours}h ago)`;
  }

  return result;
}
