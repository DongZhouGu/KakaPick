import { useEffect } from "react";
import type { Rating } from "../shared/domain.js";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select, [role='textbox']");
}

export interface CullingKeyHandlers {
  readonly enabled?: boolean;
  readonly onEscape?: () => void;
  readonly onGroup: (offset: -1 | 1) => void;
  readonly onMerge: () => void;
  readonly onRate: (rating: Rating, applySelection: boolean) => void;
  readonly onSpace: () => void;
  readonly onSplit: () => void;
  readonly onToggleSelect?: () => void;
  readonly onUndo: () => void;
}

export function useCullingKeys(handlers: CullingKeyHandlers): void {
  useEffect(() => {
    if (handlers.enabled === false) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const rating = Number(event.key);
      if (/^[0-5]$/u.test(event.key)) {
        event.preventDefault();
        handlers.onRate(rating as Rating, event.shiftKey);
      } else if (event.key === "[") {
        event.preventDefault();
        handlers.onGroup(-1);
      } else if (event.key === "]") {
        event.preventDefault();
        handlers.onGroup(1);
      } else if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        handlers.onSpace();
      } else if (event.key.toLocaleLowerCase("en-US") === "s") {
        event.preventDefault();
        handlers.onSplit();
      } else if (event.key.toLocaleLowerCase("en-US") === "m") {
        event.preventDefault();
        handlers.onMerge();
      } else if (event.key.toLocaleLowerCase("en-US") === "z" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        handlers.onUndo();
      } else if (event.key === "Escape") {
        handlers.onEscape?.();
      } else if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        handlers.onToggleSelect?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}
