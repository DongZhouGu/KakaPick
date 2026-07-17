export type PhotosPerPage = 1 | 2 | 3 | 4 | 5 | "auto";

export interface ShortcutBindings {
  readonly reject: string;
  readonly rate1: string;
  readonly rate2: string;
  readonly rate3: string;
  readonly rate4: string;
  readonly rate5: string;
}

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  reject: "z",
  rate1: "1",
  rate2: "2",
  rate3: "3",
  rate4: "4",
  rate5: "5",
};

export interface CullingPreferences {
  readonly photosPerPage: PhotosPerPage;
  readonly advanceAfterRating: boolean;
  readonly showAiHint: boolean;
  readonly shortcuts: ShortcutBindings;
}

const KEY = "burstpick:culling-preferences:v2";
export const DEFAULT_CULLING_PREFERENCES: CullingPreferences = {
  photosPerPage: 2,
  advanceAfterRating: true,
  showAiHint: false,
  shortcuts: { ...DEFAULT_SHORTCUTS },
};

function defaultStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

function readShortcuts(parsed: Record<string, unknown> | null): ShortcutBindings {
  const s = parsed?.shortcuts as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return { ...DEFAULT_SHORTCUTS };
  return {
    reject: typeof s.reject === "string" ? s.reject : DEFAULT_SHORTCUTS.reject,
    rate1: typeof s.rate1 === "string" ? s.rate1 : DEFAULT_SHORTCUTS.rate1,
    rate2: typeof s.rate2 === "string" ? s.rate2 : DEFAULT_SHORTCUTS.rate2,
    rate3: typeof s.rate3 === "string" ? s.rate3 : DEFAULT_SHORTCUTS.rate3,
    rate4: typeof s.rate4 === "string" ? s.rate4 : DEFAULT_SHORTCUTS.rate4,
    rate5: typeof s.rate5 === "string" ? s.rate5 : DEFAULT_SHORTCUTS.rate5,
  };
}

export function readCullingPreferences(storage = defaultStorage()): CullingPreferences {
  try {
    const parsed = JSON.parse(storage?.getItem(KEY) ?? "null") as Record<string, unknown> | null;
    const pp = parsed?.photosPerPage;
    return {
      photosPerPage: pp === "auto" ? "auto" : (typeof pp === "number" && [1, 2, 3, 4, 5].includes(pp) ? pp as PhotosPerPage : 2),
      advanceAfterRating: typeof parsed?.advanceAfterRating === "boolean" ? parsed.advanceAfterRating : true,
      showAiHint: typeof parsed?.showAiHint === "boolean" ? parsed.showAiHint : false,
      shortcuts: readShortcuts(parsed),
    };
  } catch { return DEFAULT_CULLING_PREFERENCES; }
}

export function writeCullingPreferences(preferences: CullingPreferences, storage = defaultStorage()): void {
  try { storage?.setItem(KEY, JSON.stringify(preferences)); } catch { /* preferences are optional */ }
}
