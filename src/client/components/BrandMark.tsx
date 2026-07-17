interface BrandMarkProps {
  readonly className?: string;
  readonly language?: "zh" | "en";
  readonly showName?: boolean;
}

export function BrandMark({ className, language = "zh", showName = true }: BrandMarkProps) {
  const classes = ["brand-lockup", className].filter(Boolean).join(" ");
  return (
    <span className={classes}>
      <svg className="brand-logo" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <rect x="13" y="7" width="27" height="27" rx="7" stroke="currentColor" strokeWidth="4" opacity=".58" />
        <rect x="7" y="13" width="27" height="27" rx="7" stroke="currentColor" strokeWidth="4" />
        <path d="M15 27l6 6 13-15" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {showName ? <span className="brand-name">{language === "zh" ? "咔咔选" : "KakaPick"}</span> : null}
    </span>
  );
}
