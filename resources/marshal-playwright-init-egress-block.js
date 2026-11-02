// marshal-owned
Object.defineProperty(navigator, "sendBeacon", {
  value: () => true,
  writable: false,
  configurable: false,
});
