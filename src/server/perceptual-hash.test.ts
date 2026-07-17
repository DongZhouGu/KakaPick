import { describe, expect, it } from "vitest";
import { differenceHash, hashSimilarity } from "./perceptual-hash.js";

function rows(factory: (column: number, row: number) => number): Uint8Array {
  return Uint8Array.from({ length: 72 }, (_, index) => factory(index % 9, Math.floor(index / 9)));
}

describe("differenceHash", () => {
  it("returns sixteen zero hexadecimal digits for rows that increase from left to right", () => {
    expect(differenceHash(rows((column) => column))).toBe("0000000000000000");
  });

  it("sets bits for left-to-right decreases in row-major order", () => {
    const pixels = rows((column, row) => (row === 0 ? 8 - column : column));

    expect(differenceHash(pixels)).toBe("ff00000000000000");
    expect(differenceHash(rows((column) => 8 - column))).toBe("ffffffffffffffff");
  });

  it("requires exactly seventy-two grayscale bytes", () => {
    expect(() => differenceHash(new Uint8Array(71))).toThrow(RangeError);
    expect(() => differenceHash(new Uint8Array(73))).toThrow(RangeError);
    expect(() => differenceHash([...new Uint8Array(71), 256])).toThrow(RangeError);
  });
});

describe("hashSimilarity", () => {
  it("uses normalized Hamming distance across all sixty-four bits", () => {
    expect(hashSimilarity("0000000000000000", "0000000000000000")).toBe(1);
    expect(hashSimilarity("0000000000000000", "ffffffffffffffff")).toBe(0);
    expect(hashSimilarity("0000000000000000", "000000000000000f")).toBe(0.9375);
  });

  it("rejects values outside the canonical hash format", () => {
    expect(() => hashSimilarity("0".repeat(15), "0".repeat(16))).toThrow(TypeError);
    expect(() => hashSimilarity("G".repeat(16), "0".repeat(16))).toThrow(TypeError);
  });
});
