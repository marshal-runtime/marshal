import type { FileAttachment } from "../components/ChatInput";

// In-memory handoff across the remote composer's session-key remount. Files
// remain on the Mac; this only retains their references and image previews.
const transfers = new Map<string, FileAttachment[]>();
export function stageDraftAttachments(sessionId: string, files: FileAttachment[]) {
  transfers.set(sessionId, files);
  if (transfers.size > 100) {
    const first = transfers.keys().next().value;
    if (first) transfers.delete(first);
  }
}
export function peekDraftAttachments(sessionId: string): FileAttachment[] {
  return transfers.get(sessionId) ?? [];
}
export function clearDraftAttachmentTransfer(sessionId: string) {
  transfers.delete(sessionId);
}
