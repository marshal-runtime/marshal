// Marshal-owned module.
/** rehype-harden options for image security — shared between config and tests. */
export const imageHardenOptions = {
  ...(typeof window !== "undefined" && window.marshalRemote
    ? { defaultOrigin: location.origin }
    : {}),
  allowedImagePrefixes: (typeof window !== "undefined" && window.marshalRemote
    ? [`${location.origin}/remote/media?`]
    : []) as string[], // block all http/https images
  allowedLinkPrefixes: ["*"], // don't restrict links
  allowedProtocols: ["local-file:"],
  allowDataImages: true, // allow data:image/* URLs
  // blob: validated & passed through automatically by harden
  blockedImageClass:
    "inline-flex items-center gap-1 rounded-sm bg-muted px-2 py-1 text-xs text-muted-foreground",
};
