import type { ApiScanWarning } from "../../shared/api.js";

const LABELS: Record<ApiScanWarning["code"], string> = {
  DUPLICATE_RAW: "重复 RAW",
  DUPLICATE_JPEG: "重复 JPEG",
  DUPLICATE_XMP: "重复 XMP",
  UNPAIRED_RAW: "未配对 RAW",
  UNPAIRED_JPEG: "未配对 JPEG",
  METADATA_READ_FAILED: "元数据读取失败",
  IMAGE_HASH_FAILED: "画面相似度分析失败",
  PREVIEW_EXTRACT_FAILED: "RAW 预览提取失败",
  CAPTURE_TIME_FALLBACK: "拍摄时间改用文件修改时间",
};

export function ScanWarnings({ warnings }: { readonly warnings: readonly ApiScanWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <section className="scan-warnings" aria-label="扫描警告">
      <h2>扫描警告 · {warnings.length} 项</h2>
      <ul>{warnings.map((warning, index) => (
        <li key={`${warning.code}-${warning.photoId}-${index}`}>
          <strong>{LABELS[warning.code]}</strong>
          <span>{warning.relativePaths.join("、")}</span>
        </li>
      ))}</ul>
    </section>
  );
}
