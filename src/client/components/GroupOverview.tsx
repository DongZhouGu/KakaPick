import type { PublicPhotoUnit } from "../../shared/api.js";
import type { BurstGroup } from "../../shared/domain.js";
import { thumbnailUrl } from "../api.js";

interface GroupOverviewProps {
  readonly albumName: string;
  readonly currentGroupId: string | undefined;
  readonly groups: readonly BurstGroup[];
  readonly onBack: () => void;
  readonly onSelectGroup: (index: number) => void;
  readonly photosById: ReadonlyMap<string, PublicPhotoUnit>;
}

export function GroupOverview({ albumName, currentGroupId, groups, onBack, onSelectGroup, photosById }: GroupOverviewProps) {
  const total = groups.reduce((count, group) => count + group.photoIds.filter((id) => photosById.has(id)).length, 0);
  return <section className="group-overview" aria-label="所有组">
    <header className="overview-header">
      <div><p className="eyebrow">相册总览</p><h1>所有组</h1><p>{albumName} · {groups.length} 组 · {total} 张照片</p></div>
      <button type="button" onClick={onBack}>返回选片</button>
    </header>
    <div className="group-overview-grid">{groups.map((group, index) => {
      const photos = group.photoIds.flatMap((id) => { const photo = photosById.get(id); return photo === undefined ? [] : [photo]; });
      const rated = photos.filter((photo) => photo.rating > 0).length;
      const selected = photos.filter((photo) => photo.rating >= 1).length;
      const covers = photos.slice(0, 4);
      const current = group.id === currentGroupId;
      return <button type="button" className={`group-overview-card${current ? " is-current" : ""}`} key={group.id} aria-label={`第 ${index + 1} 组，${photos.length} 张照片，已评分 ${rated} 张，入选 ${selected} 张${current ? "，当前组" : ""}`} aria-current={current ? "true" : undefined} data-cover-count={covers.length} onClick={() => onSelectGroup(index)}>
        <span className="group-cover" aria-hidden="true">{covers.map((photo) => <img key={photo.id} src={thumbnailUrl(photo.id, 480)} alt="" />)}</span>
        <span className="group-card-meta"><span><strong>第 {index + 1} 组</strong>{current ? <small className="current-badge">当前</small> : null}</span><small>{photos.length} 张 · 已评分 {rated} · 入选 {selected}</small><progress max={Math.max(photos.length, 1)} value={rated}>{photos.length === 0 ? 0 : Math.round(rated / photos.length * 100)}%</progress></span>
      </button>;
    })}</div>
  </section>;
}
