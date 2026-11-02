const dismissedChatNoticeKeys = new Set<string>();

export function getDismissedChatNoticeKeys(): Set<string> {
  return dismissedChatNoticeKeys;
}

export function dismissChatNotice(noticeKey: string): void {
  dismissedChatNoticeKeys.add(noticeKey);
}

export function clearDismissedChatNoticesForTest(): void {
  dismissedChatNoticeKeys.clear();
}
