import { useEffect, useRef } from "react";
import type { PublicPhotoUnit } from "../../shared/api.js";
import { thumbnailUrl } from "../api.js";

interface LoupeProps {
  readonly fit: boolean;
  readonly onClose: () => void;
  readonly onToggleFit: () => void;
  readonly photo: PublicPhotoUnit;
}

export function Loupe({ fit, onClose, onToggleFit, photo }: LoupeProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLButtonElement>("button");
    first?.focus();
    const keepFocus = (event: FocusEvent) => {
      if (dialog !== null && event.target instanceof Node && !dialog.contains(event.target)) first?.focus();
    };
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || dialog === null) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")];
      const start = controls[0];
      const end = controls.at(-1);
      if (event.shiftKey && document.activeElement === start) { event.preventDefault(); end?.focus(); }
      else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); start?.focus(); }
    };
    dialog?.addEventListener("keydown", trap);
    document.addEventListener("focusin", keepFocus);
    return () => {
      dialog?.removeEventListener("keydown", trap);
      document.removeEventListener("focusin", keepFocus);
    };
  }, [onClose]);
  return (
    <div className="loupe-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} className="loupe" role="dialog" aria-modal="true" aria-label={`查看 ${photo.stem}`}>
        <header>
          <div><strong>{photo.stem}</strong><span>{photo.rating === 0 ? "未评分" : `${photo.rating} 星`}</span></div>
          <div>
            <button type="button" onClick={onToggleFit}>{fit ? "放大查看" : "适合窗口"}</button>
            <button type="button" onClick={onClose} aria-label="关闭放大查看">关闭</button>
          </div>
        </header>
        <div className={fit ? "loupe-image fit" : "loupe-image actual"}>
          <img src={thumbnailUrl(photo.id, 1600)} alt={`${photo.stem} 放大预览`} />
        </div>
      </section>
    </div>
  );
}
