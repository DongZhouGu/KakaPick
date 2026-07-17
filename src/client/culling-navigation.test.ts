import { describe, expect, it } from "vitest";
import { moveFocus, visibleBatch } from "./culling-navigation.js";

describe("culling navigation", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("returns the batch containing focus", () => {
    expect(visibleBatch(ids, "c", 2)).toEqual(["c", "d"]);
    expect(visibleBatch(ids, "e", 2)).toEqual(["e"]);
    expect(visibleBatch(ids, "missing", 3)).toEqual(["a", "b", "c"]);
  });

  it("moves symmetrically and reports album boundaries", () => {
    expect(moveFocus(ids, "d", 1)).toBe("e");
    expect(moveFocus(ids, "c", -1)).toBe("b");
    expect(moveFocus(ids, "a", -1)).toBeUndefined();
    expect(moveFocus(ids, "e", 1)).toBeUndefined();
  });
});
