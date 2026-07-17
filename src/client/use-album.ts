import { useCallback, useEffect, useRef, useState } from "react";
import { API_PREFIX, type ApiScanWarning, type OpenAlbumRequest, type PublicAlbumSession, type ScanProgressEvent } from "../shared/api.js";
import type { Rating } from "../shared/domain.js";
import {
  ClientApiError,
  getAlbum,
  mergeGroup,
  openAlbum,
  ratePhotos,
  regroup,
  splitGroup,
  subscribeAlbum,
  undo,
} from "./api.js";

export type AlbumPhase = "welcome" | "opening" | "scanning" | "ready" | "error";

const ACTIVE_ALBUM_KEY = "burstpick-active-album";
const ACTIVE_ALBUM_NAME_KEY = "burstpick-active-album-name";

export interface AlbumController {
  readonly album: PublicAlbumSession | undefined;
  readonly albumId: string | undefined;
  readonly albumName: string | undefined;
  readonly error: string | undefined;
  readonly phase: AlbumPhase;
  readonly progress: ScanProgressEvent | undefined;
  readonly warnings: readonly ApiScanWarning[];
  readonly open: (input: OpenAlbumRequest, displayName?: string) => Promise<void>;
  readonly rate: (photoIds: readonly string[], rating: Rating) => Promise<boolean>;
  readonly split: (photoId: string) => Promise<void>;
  readonly merge: (groupId: string) => Promise<void>;
  readonly setSensitivity: (value: number) => Promise<void>;
  readonly undo: () => Promise<void>;
  readonly reset: () => void;
}

function messageFor(error: unknown): string {
  return error instanceof ClientApiError ? error.message : "操作失败，请重试。";
}

export function useAlbum(): AlbumController {
  const [phase, setPhase] = useState<AlbumPhase>("welcome");
  const [albumId, setAlbumId] = useState<string>();
  const [albumName, setAlbumName] = useState<string>();
  const [album, setAlbum] = useState<PublicAlbumSession>();
  const [progress, setProgress] = useState<ScanProgressEvent>();
  const [warnings, setWarnings] = useState<readonly ApiScanWarning[]>([]);
  const [error, setError] = useState<string>();
  const closeEvents = useRef<(() => void) | undefined>(undefined);

  const load = useCallback(async (id: string) => {
    const next = await getAlbum(id);
    setAlbum(next.album);
    setWarnings(next.warnings);
    setPhase("ready");
    setError(undefined);
  }, []);

  useEffect(() => {
    const storedId = sessionStorage.getItem(ACTIVE_ALBUM_KEY);
    if (storedId === null || !/^[0-9a-f]{64}$/u.test(storedId)) return;
    setAlbumId(storedId);
    setAlbumName(sessionStorage.getItem(ACTIVE_ALBUM_NAME_KEY) ?? "本地相册");
    setPhase("opening");
    void load(storedId).catch(() => {
      sessionStorage.removeItem(ACTIVE_ALBUM_KEY);
      sessionStorage.removeItem(ACTIVE_ALBUM_NAME_KEY);
      setPhase("welcome");
    });
  }, [load]);

  useEffect(() => () => closeEvents.current?.(), []);

  const open = useCallback(async (input: OpenAlbumRequest, displayName?: string) => {
    closeEvents.current?.();
    setError(undefined);
    setProgress(undefined);
    setPhase("opening");
    setAlbumName(displayName ?? ("demo" in input ? "示例相册" : "本地相册"));
    try {
      const result = await openAlbum(input);
      setWarnings(result.warnings);
      setAlbumId(result.albumId);
      sessionStorage.setItem(ACTIVE_ALBUM_KEY, result.albumId);
      sessionStorage.setItem(ACTIVE_ALBUM_NAME_KEY, displayName ?? ("demo" in input ? "示例相册" : "本地相册"));
      if (result.status === "ready") {
        await load(result.albumId);
        return;
      }
      setPhase("scanning");
      closeEvents.current = subscribeAlbum(result.albumId, {
        onProgress: setProgress,
        onComplete: (scanWarnings) => {
          setWarnings(scanWarnings);
          void load(result.albumId).catch((cause: unknown) => {
          setError(messageFor(cause));
          setPhase("error");
          });
        },
        onError: (message) => {
          setError(message);
          setPhase("error");
        },
      });
    } catch (cause) {
      setError(messageFor(cause));
      setPhase("error");
    }
  }, [load]);

  const command = useCallback(async (operation: () => Promise<{ album: PublicAlbumSession; warnings: readonly ApiScanWarning[] }>) => {
    setError(undefined);
    try {
      const next = await operation();
      setAlbum(next.album);
      setWarnings(next.warnings);
    } catch (cause) {
      setError(messageFor(cause));
    }
  }, []);

  const rate = useCallback(async (photoIds: readonly string[], rating: Rating) => {
    if (album === undefined || photoIds.length === 0) return false;
    const before = album;
    const ids = new Set(photoIds);
    setAlbum({ ...before, photos: before.photos.map((photo) =>
      ids.has(photo.id) ? { ...photo, rating } : photo
    ) });
    setError(undefined);
    try {
      const next = await ratePhotos([...ids], rating);
      setAlbum(next.album);
      setWarnings(next.warnings);
      return true;
    } catch (cause) {
      setAlbum(before);
      setError(`${messageFor(cause)} 未提交的评分已恢复。`);
      return false;
    }
  }, [album]);

  const reset = useCallback(() => {
    closeEvents.current?.();
    closeEvents.current = undefined;
    if (albumId !== undefined) {
      const token = sessionStorage.getItem("burstpick-token");
      if (token !== null) fetch(`${API_PREFIX}/albums/${encodeURIComponent(albumId)}`, { method: "DELETE", headers: { "x-burstpick-token": token } }).catch(() => undefined);
    }
    setAlbum(undefined);
    setAlbumId(undefined);
    setAlbumName(undefined);
    setError(undefined);
    setProgress(undefined);
    setWarnings([]);
    setPhase("welcome");
    // Keep ACTIVE_ALBUM_KEY so next app open auto-restores
  }, [albumId]);

  return {
    album,
    albumId,
    albumName,
    error,
    phase,
    progress,
    warnings,
    open,
    rate,
    split: async (photoId) => command(() => splitGroup(photoId)),
    merge: async (groupId) => command(() => mergeGroup(groupId)),
    setSensitivity: async (value) => command(() => regroup(value)),
    undo: async () => command(undo),
    reset,
  };
}
