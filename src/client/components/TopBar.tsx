type Filter = "all" | "rated" | "unrated";

interface TopBarProps {
  readonly albumName: string;
  readonly filter: Filter;
  readonly onFilter: (filter: Filter) => void;
  readonly onHome: () => void;
  readonly rated: number;
  readonly total: number;
}

export function TopBar({ albumName, filter, onFilter, onHome, rated, total }: TopBarProps) {
  return (
    <header className="top-bar">
      <button type="button" className="brand-button" onClick={onHome} aria-label="返回相册选择">
        <span className="mini-mark" aria-hidden="true" /> 咔咔选
      </button>
      <div className="top-context"><strong>{albumName}</strong><small>扫描完成 · 相册就绪 · 导出预览未开放</small></div>
      <div className="top-stats"><strong>{rated}</strong> / {total} 已评分</div>
      <fieldset className="filter-switch">
        <legend className="sr-only">照片筛选</legend>
        {([ ["all", "全部"], ["rated", "已评分"], ["unrated", "未评分"] ] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={filter === value} onClick={() => onFilter(value)}>{label}</button>
        ))}
      </fieldset>
    </header>
  );
}

export type { Filter };
