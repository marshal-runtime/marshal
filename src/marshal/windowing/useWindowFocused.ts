import { useSyncExternalStore } from "react";

type FocusState = { focused: boolean; ready: boolean };

let sawFocus = false;
let snapshot: FocusState = { focused: true, ready: false };

function subscribe(onStoreChange: () => void) {
  const onFocus = () => {
    sawFocus = true;
    snapshot = { focused: true, ready: snapshot.ready };
    onStoreChange();
  };
  const onBlur = () => {
    if (!sawFocus) return;
    snapshot = { focused: false, ready: true };
    onStoreChange();
  };
  if (document.hasFocus()) sawFocus = true;
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  };
}

function getSnapshot(): FocusState {
  return snapshot;
}

export function useWindowFocused(): FocusState {
  return useSyncExternalStore(subscribe, getSnapshot, () => ({
    focused: true,
    ready: false,
  }));
}

export function _resetWindowFocusState() {
  sawFocus = false;
  snapshot = { focused: true, ready: false };
}
