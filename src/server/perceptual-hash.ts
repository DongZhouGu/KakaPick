const PIXEL_COLUMNS = 9;
const PIXEL_ROWS = 8;
const PIXEL_COUNT = PIXEL_COLUMNS * PIXEL_ROWS;
const HASH_PATTERN = /^[0-9a-f]{16}$/;

function parseHash(value: string): bigint {
  if (!HASH_PATTERN.test(value)) {
    throw new TypeError("Perceptual hashes must contain exactly 16 lowercase hexadecimal digits");
  }

  return BigInt(`0x${value}`);
}

function countSetBits(value: bigint): number {
  let remaining = value;
  let count = 0;

  while (remaining !== 0n) {
    remaining &= remaining - 1n;
    count += 1;
  }

  return count;
}

export function differenceHash(pixels: ArrayLike<number>): string {
  if (pixels.length !== PIXEL_COUNT) {
    throw new RangeError(`differenceHash requires exactly ${PIXEL_COUNT} grayscale bytes`);
  }

  for (let index = 0; index < pixels.length; index += 1) {
    const pixel = pixels[index];
    if (pixel === undefined || !Number.isInteger(pixel) || pixel < 0 || pixel > 255) {
      throw new RangeError("differenceHash pixels must be bytes from 0 through 255");
    }
  }

  let hash = 0n;
  for (let row = 0; row < PIXEL_ROWS; row += 1) {
    const rowStart = row * PIXEL_COLUMNS;
    for (let column = 0; column < PIXEL_COLUMNS - 1; column += 1) {
      const left = pixels[rowStart + column];
      const right = pixels[rowStart + column + 1];
      hash = (hash << 1n) | (left !== undefined && right !== undefined && left > right ? 1n : 0n);
    }
  }

  return hash.toString(16).padStart(16, "0");
}

export function hashSimilarity(left: string, right: string): number {
  const hammingDistance = countSetBits(parseHash(left) ^ parseHash(right));
  return 1 - hammingDistance / 64;
}
