type AcceleratorConversionResult =
  | { success: true; accelerator: string }
  | { success: false; error: string };
type HotkeyConversionResult = { success: true; hotkey: string } | { success: false; error: string };

type ElectronModifier = "CommandOrControl" | "Command" | "Control" | "Alt" | "Shift";

const electronModifierOrder: ElectronModifier[] = [
  "CommandOrControl",
  "Command",
  "Control",
  "Alt",
  "Shift",
];

function splitHotkey(hotkey: string): string[] {
  if (hotkey === "+") return ["+"];
  if (hotkey.endsWith("++")) {
    const parts = hotkey.split("+");
    return [...parts.slice(0, -2), "+"];
  }
  return hotkey.split("+");
}

function normalizeModifier(token: string): ElectronModifier | undefined {
  switch (token.toLowerCase()) {
    case "mod":
    case "commandorcontrol":
      return "CommandOrControl";
    case "cmd":
    case "command":
    case "meta":
      return "Command";
    case "ctrl":
    case "control":
      return "Control";
    case "option":
    case "alt":
      return "Alt";
    case "shift":
      return "Shift";
    default:
      return undefined;
  }
}

function normalizeKey(token: string): string {
  if (token === " " || token.trim().toLowerCase() === "space") return "Space";
  const value = token.trim();
  return value.length === 1 ? value.toUpperCase() : value;
}

function parseHotkey(hotkey: string): AcceleratorConversionResult {
  const modifiers = new Set<ElectronModifier>();
  const keys: string[] = [];

  for (const rawToken of splitHotkey(hotkey)) {
    if (rawToken.length > 0 && rawToken !== " " && rawToken.trim() === "") {
      return { success: false, error: "Hotkey contains a blank token." };
    }
    const token = rawToken.trim();
    if (token === "") return { success: false, error: "Hotkey contains an empty token." };

    const modifier = normalizeModifier(token);
    if (modifier) modifiers.add(modifier);
    else keys.push(normalizeKey(rawToken));
  }

  if (keys.length === 0) {
    return { success: false, error: "Press a non-modifier key with the shortcut." };
  }
  if (keys.length > 1) {
    return { success: false, error: "Use only one non-modifier key in the shortcut." };
  }

  const prefix = electronModifierOrder.filter((modifier) => modifiers.has(modifier));
  return { success: true, accelerator: [...prefix, keys[0]].join("+") };
}

function getModifierCountAndKey(hotkey: string): {
  modifierCount: number;
  key: string | undefined;
} {
  let modifierCount = 0;
  let key: string | undefined;
  for (const rawToken of splitHotkey(hotkey)) {
    if (normalizeModifier(rawToken.trim())) modifierCount += 1;
    else key = normalizeKey(rawToken);
  }
  return { modifierCount, key };
}

function isSinglePrintableKey(key: string): boolean {
  return key.length === 1 || key === "Space";
}

export function tanStackHotkeyToElectronAccelerator(hotkey: string): AcceleratorConversionResult {
  return parseHotkey(hotkey);
}

export function electronAcceleratorToTanStackHotkey(accelerator: string): HotkeyConversionResult {
  const parsed = parseHotkey(accelerator);
  return parsed.success
    ? { success: true, hotkey: parsed.accelerator.replace("CommandOrControl", "Mod") }
    : parsed;
}

export function validateShowHideHotkey(hotkey: string): AcceleratorConversionResult {
  const parsed = parseHotkey(hotkey);
  if (!parsed.success) return parsed;

  const { modifierCount, key } = getModifierCountAndKey(hotkey);
  if (modifierCount === 0 && key !== undefined && isSinglePrintableKey(key)) {
    return {
      success: false,
      error: "Use at least one modifier for the global show/hide shortcut.",
    };
  }
  return parsed;
}
