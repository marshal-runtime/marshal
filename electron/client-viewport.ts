import type { MarshalUiViewport } from "../common/runtime-ui-viewports";

/**
 * Which client surface last spoke in each session. Remote-access sockets
 * dispatch with negative sender ids (see remote-access/server.ts); renderer
 * WebContents ids are positive. The value feeds the per-turn prompt context so
 * an agent serving the phone knows it, and defaults generated UI to the
 * mobile variant (see system-message.ts). Sticky until the other surface
 * speaks; sessions nobody marked are desktop.
 */
const viewportBySession = new Map<string, MarshalUiViewport>();

export function viewportForSenderId(senderId: number): MarshalUiViewport {
  return senderId < 0 ? "mobile" : "desktop";
}

export function setSessionClientViewport(sessionId: string, viewport: MarshalUiViewport): void {
  viewportBySession.set(sessionId, viewport);
}

export function getSessionClientViewport(sessionId: string): MarshalUiViewport {
  return viewportBySession.get(sessionId) ?? "desktop";
}
