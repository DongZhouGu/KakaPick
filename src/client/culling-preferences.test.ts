import { describe, expect, it } from "vitest";
import { readCullingPreferences, writeCullingPreferences } from "./culling-preferences.js";

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("culling preferences", () => {
  it("uses approved defaults for empty or malformed storage", () => {
    expect(readCullingPreferences(memoryStorage())).toEqual({ photosPerPage: 2, advanceAfterRating: true, showAiHint: false, shortcuts: { reject: "z", rate1: "1", rate2: "2", rate3: "3", rate4: "4", rate5: "5" } });
    expect(readCullingPreferences(memoryStorage({ "burstpick:culling-preferences:v2": "{" }))).toEqual({ photosPerPage: 2, advanceAfterRating: true, showAiHint: false, shortcuts: { reject: "z", rate1: "1", rate2: "2", rate3: "3", rate4: "4", rate5: "5" } });
  });

  it("validates fields independently, ignores obsolete presentation state, and round-trips supported values", () => {
    const storage = memoryStorage({ "burstpick:culling-preferences:v2": JSON.stringify({ photosPerPage: 9, advanceAfterRating: false, groupToolsExpanded: "yes" }) });
    expect(readCullingPreferences(storage)).toEqual({ photosPerPage: 2, advanceAfterRating: false, showAiHint: false, shortcuts: { reject: "z", rate1: "1", rate2: "2", rate3: "3", rate4: "4", rate5: "5" } });
    writeCullingPreferences({ photosPerPage: 4, advanceAfterRating: false, showAiHint: false, shortcuts: { reject: "z", rate1: "1", rate2: "2", rate3: "3", rate4: "4", rate5: "5" } }, storage);
    expect(readCullingPreferences(storage)).toEqual({ photosPerPage: 4, advanceAfterRating: false, showAiHint: false, shortcuts: { reject: "z", rate1: "1", rate2: "2", rate3: "3", rate4: "4", rate5: "5" } });
  });
});
