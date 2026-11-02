interface ActivationPolicyApp {
  setActivationPolicy(policy: "regular"): void;
}

export function ensureMacDockPresence(
  app: ActivationPolicyApp,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin") app.setActivationPolicy("regular");
}

export function shouldSkipTaskbarForHiddenWindow(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "darwin";
}
