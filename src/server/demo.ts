import { createHash } from "node:crypto";
import { AlbumSessionSchema, type AlbumSession, type PhotoUnit, type SourceFile } from "../shared/domain.js";
import { groupBursts } from "./grouping.js";
import { pairSourceFiles } from "./pairing.js";

const DEMO_BASE_TIME_MS = Date.UTC(2026, 0, 1, 9, 0, 0);
const GROUP_SIZES = [5, 7, 4] as const;

export type DemoAlbum = AlbumSession & {
  readonly isDemo: true;
  readonly session: AlbumSession;
  readonly svgByPhotoId: Readonly<Record<string, string>>;
  imageForPhotoId(photoId: string): string | undefined;
};

function demoTimestamp(groupIndex: number, itemIndex: number): number {
  return DEMO_BASE_TIME_MS + groupIndex * 15_000 + itemIndex * 180;
}

function demoFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  let photoNumber = 1;
  GROUP_SIZES.forEach((groupSize, groupIndex) => {
    for (let itemIndex = 0; itemIndex < groupSize; itemIndex += 1) {
      const label = `DEMO_${String(photoNumber).padStart(4, "0")}`;
      const modifiedAtMs = demoTimestamp(groupIndex, itemIndex);
      for (const [extension, kind, size] of [
        ["ARW", "raw", 24_000_000],
        ["JPG", "jpeg", 8_000_000],
      ] as const) {
        const relativePath = `示例连拍 ${groupIndex + 1}/${label}.${extension}`;
        files.push({
          kind,
          modifiedAtMs,
          path: `demo://burstpick/${encodeURIComponent(relativePath)}`,
          relativePath,
          size: size + photoNumber,
        });
      }
      photoNumber += 1;
    }
  });
  return files;
}

function portraitSvg(label: string, index: number): string {
  const hue = (index * 47 + 18) % 360;
  const accent = (hue + 42) % 360;
  const eyeOffset = (index % 3) - 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="900" viewBox="0 0 720 900" role="img" aria-label="${label}"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 42% 22%)"/><stop offset="1" stop-color="hsl(${accent} 52% 48%)"/></linearGradient></defs><rect width="720" height="900" fill="url(#b)"/><circle cx="360" cy="340" r="150" fill="hsl(28 42% 82%)"/><path d="M152 850c20-210 116-302 208-302s188 92 208 302" fill="hsl(${accent} 36% 18%)"/><circle cx="${310 + eyeOffset * 4}" cy="330" r="10" fill="#30251f"/><circle cx="${410 + eyeOffset * 4}" cy="330" r="10" fill="#30251f"/><path d="M320 410q40 28 80 0" fill="none" stroke="#7b493c" stroke-width="9" stroke-linecap="round"/><text x="36" y="850" fill="#fff" font-family="system-ui,sans-serif" font-size="34" font-weight="700">${label} · RAW + JPEG</text></svg>`;
}

export function createDemoAlbum(): DemoAlbum {
  const files = demoFiles();
  const paired = pairSourceFiles("demo://burstpick", files);
  const photos: PhotoUnit[] = paired.photos.map((photo, index) => {
    const groupIndex = GROUP_SIZES.findIndex(
      (_size, candidateIndex) =>
        index < GROUP_SIZES.slice(0, candidateIndex + 1).reduce((sum, size) => sum + size, 0),
    );
    const beforeGroup = GROUP_SIZES.slice(0, groupIndex).reduce((sum, size) => sum + size, 0);
    const itemIndex = index - beforeGroup;
    return {
      ...photo,
      burstId: `demo-burst-${groupIndex + 1}`,
      cameraId: "demo-camera",
      capturedAtMs: demoTimestamp(groupIndex, itemIndex),
      captureTimeSource: "exif",
      perceptualHash: createHash("sha256").update(`demo-portrait-${index}`).digest("hex").slice(0, 16),
      sequenceNumber: itemIndex,
    };
  });
  const groups = groupBursts(photos, { sensitivity: 1, thresholdMs: 650 });
  const session = AlbumSessionSchema.parse({
    schemaVersion: 1,
    sourcePathHash: createHash("sha256").update("demo://burstpick").digest("hex"),
    inventoryFingerprint: createHash("sha256")
      .update(JSON.stringify(files.map((file) => [file.relativePath, file.size, file.modifiedAtMs])))
      .digest("hex"),
    photos,
    groups,
    groupingSensitivity: 1,
    history: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const svgByPhotoId = Object.fromEntries(
    session.photos.map((photo, index) => [photo.id, portraitSvg(photo.stem, index)]),
  );

  return {
    ...session,
    isDemo: true,
    session,
    svgByPhotoId,
    imageForPhotoId(photoId) {
      return svgByPhotoId[photoId];
    },
  };
}
