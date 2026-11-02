interface WindowState {
  isMaximized: boolean;
  isFullScreen: boolean;
}

export function createWindowStore() {
  let state: WindowState = { isMaximized: false, isFullScreen: false };
  const listeners = new Set<() => void>();

  const notify = () => listeners.forEach((listener) => listener());

  void window.windowControlsAPI?.getState().then((result) => {
    if (result.success) {
      state = {
        isMaximized: result.isMaximized ?? false,
        isFullScreen: result.isFullScreen ?? false,
      };
      notify();
    }
  });

  window.windowControlsAPI?.onMaximizeChanged((isMaximized) => {
    state = { ...state, isMaximized };
    notify();
  });
  window.windowControlsAPI?.onFullScreenChanged((isFullScreen) => {
    state = { ...state, isFullScreen };
    notify();
  });

  return {
    subscribe: (callback: () => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    getSnapshot: () => state,
  };
}
