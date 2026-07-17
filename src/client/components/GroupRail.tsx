import type { PublicAlbumSession } from "../../shared/api.js";

interface GroupRailProps {
  readonly album: PublicAlbumSession;
  readonly currentIndex: number;
  readonly onSelect: (index: number) => void;
}

export function GroupRail({ album, currentIndex, onSelect }: GroupRailProps) {
  const photos = new Map(album.photos.map((photo) => [photo.id, photo]));
  return (
    <nav className="group-rail" aria-label="连拍分组">
      <p className="rail-title">时间线</p>
      <ol>
        {album.groups.map((group, index) => {
          const rated = group.photoIds.filter((id) => (photos.get(id)?.rating ?? 0) > 0).length;
          return (
            <li key={group.id}>
              <button type="button" aria-current={index === currentIndex ? "true" : undefined} onClick={() => onSelect(index)}>
                <span className="group-number">{String(index + 1).padStart(2, "0")}</span>
                <span>{group.photoIds.length} 张</span>
                <small>{rated} 已评{group.manual ? " · 手动" : ""}</small>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
