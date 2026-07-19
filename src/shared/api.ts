import { z } from "zod";
import {
  BoundaryOverrideSchema,
  BurstGroupSchema,
  RatingSchema,
  SessionCommandSchema,
} from "./domain.js";

export const API_VERSION = 1 as const;
export const API_PREFIX = `/api/v${API_VERSION}` as const;

const PublicSourceFileBaseSchema = z
  .object({
    relativePath: z.lazy(() => PublicRelativePathSchema),
    size: z.number().finite().nonnegative(),
    modifiedAtMs: z.number().finite().nonnegative(),
  })
  .strict();

export const PublicRawSourceFileSchema = PublicSourceFileBaseSchema.extend({
  kind: z.literal("raw"),
});
export const PublicJpegSourceFileSchema = PublicSourceFileBaseSchema.extend({
  kind: z.literal("jpeg"),
});
export const PublicXmpSourceFileSchema = PublicSourceFileBaseSchema.extend({
  kind: z.literal("xmp"),
});

export const PublicRelativePathSchema = z
  .string()
  .min(1, "相对路径不能为空。")
  .superRefine((value, context) => {
    if (value.includes("\0")) {
      context.addIssue({ code: "custom", message: "相对路径不能包含空字符。" });
      return;
    }
    if (value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.startsWith("\\\\")) {
      context.addIssue({ code: "custom", message: "路径必须是相对路径。" });
      return;
    }
    if (value.includes("\\")) {
      context.addIssue({ code: "custom", message: "相对路径必须使用正斜杠。" });
      return;
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      context.addIssue({ code: "custom", message: "相对路径必须规范化且不能包含目录穿越。" });
    }
  });

const PublicPhotoBaseSchema = z
  .object({
    id: z.string().min(1),
    stem: z.string().min(1),
    xmp: PublicXmpSourceFileSchema.optional(),
    capturedAtMs: z.number().finite().nonnegative(),
    captureTimeSource: z.enum(["exif", "filename", "file-mtime"]),
    cameraId: z.string().min(1).optional(),
    burstId: z.string().min(1).optional(),
    sequenceNumber: z.number().int().nonnegative().optional(),
    perceptualHash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
    sharpness: z.number().finite().nonnegative().optional(),
    overexposedRatio: z.number().min(0).max(1).optional(),
    underexposedRatio: z.number().min(0).max(1).optional(),
    previewWidth: z.number().int().positive().optional(),
    previewHeight: z.number().int().positive().optional(),
    rating: RatingSchema,
  })
  .strict();

export const PublicPhotoUnitSchema = z.union([
  PublicPhotoBaseSchema.extend({
    raw: PublicRawSourceFileSchema,
    jpeg: PublicJpegSourceFileSchema.optional(),
  }),
  PublicPhotoBaseSchema.extend({
    raw: PublicRawSourceFileSchema.optional(),
    jpeg: PublicJpegSourceFileSchema,
  }),
]);

export const PublicAlbumSessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    isDemo: z.boolean(),
    sourcePathHash: z.string().min(1),
    inventoryFingerprint: z.string().min(1),
    boundaryOverrides: z.array(BoundaryOverrideSchema),
    photos: z.array(PublicPhotoUnitSchema),
    groups: z.array(BurstGroupSchema),
    groupingSensitivity: z.number().finite().min(0.5).max(2),
    history: z.array(SessionCommandSchema).max(100),
    rejectedIds: z.array(z.string().min(1)).default([]),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const ApiScanWarningCodeSchema = z.enum([
  "DUPLICATE_RAW",
  "DUPLICATE_JPEG",
  "DUPLICATE_XMP",
  "UNPAIRED_RAW",
  "UNPAIRED_JPEG",
  "METADATA_READ_FAILED",
  "IMAGE_HASH_FAILED",
  "PREVIEW_EXTRACT_FAILED",
  "CAPTURE_TIME_FALLBACK",
]);

export const ApiScanWarningSchema = z
  .object({
    code: ApiScanWarningCodeSchema,
    photoId: z.string().min(1),
    relativePaths: z.array(PublicRelativePathSchema).min(1),
  })
  .strict();

export const EmptyRequestSchema = z.object({}).strict();
export const OpenAlbumRequestSchema = z.union([
  z.object({ path: z.string().trim().min(1).max(16_384) }).strict(),
  z.object({ selectionId: z.string().regex(/^[0-9a-f]{32}$/) }).strict(),
  z.object({ recentId: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({ demo: z.literal(true) }).strict(),
]);
export const RatePhotoRequestSchema = z.object({ rating: RatingSchema }).strict();
export const RatePhotosRequestSchema = z
  .object({
    photoIds: z.array(z.string().min(1)).min(1),
    rating: RatingSchema,
  })
  .strict()
  .refine((value) => new Set(value.photoIds).size === value.photoIds.length, {
    message: "照片 ID 不能重复。",
    path: ["photoIds"],
  });
export const SplitGroupRequestSchema = z.object({ photoId: z.string().min(1) }).strict();
export const MergeGroupRequestSchema = z.object({ groupId: z.string().min(1) }).strict();
export const RegroupRequestSchema = z
  .object({ groupingSensitivity: z.number().finite().min(0.5).max(2) })
  .strict();
export const ThumbnailQuerySchema = z
  .object({
    width: z.coerce.number().int().min(32).max(4096).default(480),
    height: z.coerce.number().int().min(32).max(4096).default(480),
  })
  .strict();
export const MetadataExportPreviewRequestSchema = EmptyRequestSchema;
export const MetadataExportCommitRequestSchema = z
  .object({
    confirmationId: z.string().regex(/^[0-9a-f]{64}$/),
    lightroomSavedAndClosed: z.literal(true),
  })
  .strict();
export const MetadataExportRollbackRequestSchema = EmptyRequestSchema;
export const MetadataExportLatestResponseSchema = z
  .object({ available: z.boolean(), auditId: z.string().regex(/^[0-9a-f]{32}$/).optional(), warnings: z.array(z.string().min(1)).optional() })
  .strict();

export const MetadataExportPreviewItemSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{24}$/),
    label: PublicRelativePathSchema,
    kind: z.enum(["xmp", "jpeg", "dng"]),
    rating: RatingSchema,
    status: z.enum(["ready", "skipped", "conflict"]),
  })
  .strict();
export const MetadataExportPreviewResponseSchema = z
  .object({
    confirmationId: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    conflicts: z.number().int().nonnegative(),
    isDemo: z.boolean(),
    items: z.array(MetadataExportPreviewItemSchema),
    ready: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    warnings: z.array(z.string().min(1)).optional(),
  })
  .strict();
export const MetadataExportResultSchema = z
  .object({
    auditId: z.string().regex(/^[0-9a-f]{32}$/),
    conflicts: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    items: z.array(z.object({
      id: z.string().min(1),
      label: PublicRelativePathSchema.optional(),
      status: z.enum(["written", "skipped", "conflict", "error", "rolled-back"]),
    }).strict()),
    skipped: z.number().int().nonnegative(),
    warnings: z.array(z.string().min(1)).optional(),
    written: z.number().int().nonnegative(),
  })
  .strict();
export const MetadataExportProgressSchema = z.object({
  phase: z.enum(["scanning", "writing", "verifying"]),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  relativePath: PublicRelativePathSchema.optional(),
}).strict().refine((value) => value.completed <= value.total, { message: "进度不能超过总数。", path: ["completed"] });
export const MetadataExportJobResponseSchema = z.object({ jobId: z.string().regex(/^[0-9a-f]{32}$/) }).strict();
export const MetadataExportTerminalSchema = z.union([
  z.object({ status: z.literal("complete"), result: MetadataExportResultSchema }).strict(),
  z.object({ status: z.literal("nochange"), message: z.string().min(1) }).strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({ status: z.literal("failed"), message: z.string().min(1) }).strict(),
]);
export const MetadataExportCancelResponseSchema = z.object({ accepted: z.literal(true) }).strict();

export const CopyExportPreviewRequestSchema = z.object({
  minRating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).default(1),
}).strict();
export const CopyExportCommitRequestSchema = z.object({ confirmationId: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const CopyExportPreviewItemSchema = z.object({
  relativePath: PublicRelativePathSchema,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["copy", "skip", "conflict"]),
  generated: z.boolean(),
}).strict();
export const CopyExportPreviewResponseSchema = z.object({
  confirmationId: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  destinationName: z.string().min(1),
  isDemo: z.boolean(),
  items: z.array(CopyExportPreviewItemSchema),
  counts: z.object({ copy: z.number().int().nonnegative(), skip: z.number().int().nonnegative(), conflicts: z.number().int().nonnegative() }).strict(),
  totalBytes: z.number().int().nonnegative(),
  requiredBytes: z.number().int().nonnegative(),
  freeBytes: z.number().int().nonnegative().optional(),
}).strict();
export const CopyExportJobResponseSchema = z.object({ jobId: z.string().regex(/^[0-9a-f]{32}$/) }).strict();
export const CopyExportPreparationProgressSchema = z.object({
  completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  relativePath: PublicRelativePathSchema.optional(),
}).strict().refine((value) => value.completed <= value.total, { message: "进度不能超过总数。", path: ["completed"] });
export const CopyExportPreviewTerminalSchema = z.union([
  z.object({ status: z.literal("ready"), preview: CopyExportPreviewResponseSchema }).strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({ status: z.literal("failed"), message: z.string().min(1) }).strict(),
]);
export const CopyExportProgressSchema = z.object({
  completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  bytesCompleted: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
  relativePath: PublicRelativePathSchema.optional(), status: z.enum(["copied", "skipped", "conflict", "failed"]).optional(),
}).strict();
export const CopyExportReportItemSchema = z.object({
  relativePath: PublicRelativePathSchema, size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["copied", "skipped", "conflict", "failed"]),
}).strict();
export const CopyExportReportSchema = z.object({
  reportId: z.string().regex(/^[0-9a-f]{32}$/), albumId: z.string().min(1), completedAt: z.string().datetime(), cancelled: z.boolean(),
  counts: z.object({ copied: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), conflicts: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict(),
  items: z.array(CopyExportReportItemSchema),
}).strict();
export const CopyExportTerminalSchema = z.union([
  z.object({ status: z.literal("complete"), reportId: z.string().regex(/^[0-9a-f]{32}$/), cancelled: z.boolean() }).strict(),
  z.object({ status: z.literal("failed"), message: z.string().min(1) }).strict(),
]);
export const CopyExportCancelResponseSchema = z.object({ accepted: z.literal(true) }).strict();

export const ScanProgressSchema = z
  .object({
    phase: z.enum(["inventory", "metadata", "hashing", "grouping"]),
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const ApiErrorCodeSchema = z.enum([
  "INVALID_BODY",
  "INVALID_QUERY",
  "INVALID_TOKEN",
  "UNSAFE_REQUEST_ORIGIN",
  "API_NOT_FOUND",
  "ALBUM_NOT_FOUND",
  "ALBUM_NOT_READY",
  "SCAN_IN_PROGRESS",
  "SCAN_FAILED",
  "PHOTO_NOT_FOUND",
  "GROUP_NOT_FOUND",
  "DIRECTORY_SELECTION_NOT_FOUND",
  "INVALID_DIRECTORY",
  "PICKER_CANCELLED",
  "PICKER_UNAVAILABLE",
  "PICKER_FAILED",
  "SESSION_LOCK_TIMEOUT",
  "SOURCE_CHANGED",
  "UNSAFE_METADATA_PATH",
  "UNSAFE_COPY_PATH",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "EXPORT_CONFLICT",
  "EXPORT_LOCKED",
  "AUDIT_PERSIST_FAILED",
  "PAIR_VERIFY_FAILED",
  "RECOVERY_REQUIRED",
  "ROLLBACK_NOT_FOUND",
  "ROLLBACK_STALE",
  "REPORT_NOT_FOUND",
  "DEMO_EXPORT_DISABLED",
  "FEATURE_NOT_READY",
  "INTERNAL_ERROR",
]);

export const ApiValidationFieldSchema = z
  .object({
    path: z.string(),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const MetadataRecoveryOutcomeSchema = z.object({
  auditRetained: z.boolean(),
  concurrentTargetPreserved: z.boolean(),
  createdTargetRemoved: z.boolean(),
  retainedBackup: z.boolean(),
}).strict();

export const ApiErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: ApiErrorCodeSchema,
        message: z.string().min(1),
        recovery: MetadataRecoveryOutcomeSchema.optional(),
        warnings: z.array(z.string().min(1)).optional(),
        details: z
          .object({ fields: z.array(ApiValidationFieldSchema).min(1) })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export const DirectoryPickerResponseSchema = z.object({
  selectionId: z.string().regex(/^[0-9a-f]{32}$/),
  name: z.string().min(1),
}).strict();
export const RecentAlbumSummarySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1),
  lastOpenedAt: z.string().datetime(),
  photoCount: z.number().int().nonnegative().default(0),
  ratedCount: z.number().int().nonnegative().default(0),
}).strict();
export const RecentAlbumsResponseSchema = z.object({ albums: z.array(RecentAlbumSummarySchema) }).strict();
export const OpenAlbumResponseSchema = z.object({
  albumId: z.string().min(1),
  status: z.enum(["scanning", "ready"]),
  warnings: z.array(ApiScanWarningSchema),
}).strict();
export const AlbumResponseSchema = z.object({
  albumId: z.string().min(1),
  album: PublicAlbumSessionSchema,
  warnings: z.array(ApiScanWarningSchema),
}).strict();
export const AlbumCommandResponseSchema = z.object({ album: PublicAlbumSessionSchema, warnings: z.array(ApiScanWarningSchema) }).strict();
export const RatePhotoResponseSchema = z.object({
  photo: PublicPhotoUnitSchema,
  album: PublicAlbumSessionSchema,
  warnings: z.array(ApiScanWarningSchema),
}).strict();
export const ExportPreviewResponseSchema = z.record(z.string(), z.unknown());
export const ScanCompleteEventSchema = z.object({
  albumId: z.string().min(1), status: z.literal("ready"), warnings: z.array(ApiScanWarningSchema),
}).strict();
export const ScanFailureEventSchema = z.object({
  code: ApiErrorCodeSchema, message: z.string().min(1),
}).strict();

export function ApiSuccessEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({ data }).strict();
}

export type PublicPhotoUnit = z.infer<typeof PublicPhotoUnitSchema>;
export type PublicAlbumSession = z.infer<typeof PublicAlbumSessionSchema>;
export type ApiScanWarning = z.infer<typeof ApiScanWarningSchema>;
export type OpenAlbumRequest = z.infer<typeof OpenAlbumRequestSchema>;
export type RecentAlbumSummary = z.infer<typeof RecentAlbumSummarySchema>;
export type ScanProgressEvent = z.infer<typeof ScanProgressSchema>;
export type MetadataExportPreview = z.infer<typeof MetadataExportPreviewResponseSchema>;
export type MetadataExportResult = z.infer<typeof MetadataExportResultSchema>;
export type MetadataExportProgress = z.infer<typeof MetadataExportProgressSchema>;
export type MetadataExportTerminal = z.infer<typeof MetadataExportTerminalSchema>;
export type MetadataExportLatest = z.infer<typeof MetadataExportLatestResponseSchema>;
export type MetadataExportCommitRequest = z.infer<typeof MetadataExportCommitRequestSchema>;
export type MetadataExportRollbackRequest = z.infer<typeof MetadataExportRollbackRequestSchema>;
export type CopyExportPreviewRequest = z.infer<typeof CopyExportPreviewRequestSchema>;
export type CopyExportCommitRequest = z.infer<typeof CopyExportCommitRequestSchema>;
export type CopyExportPreview = z.infer<typeof CopyExportPreviewResponseSchema>;
export type CopyExportPreparationProgress = z.infer<typeof CopyExportPreparationProgressSchema>;
export type CopyExportPreviewTerminal = z.infer<typeof CopyExportPreviewTerminalSchema>;
export type CopyExportProgress = z.infer<typeof CopyExportProgressSchema>;
export type CopyExportReport = z.infer<typeof CopyExportReportSchema>;
export type CopyExportTerminal = z.infer<typeof CopyExportTerminalSchema>;
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type ApiValidationField = z.infer<typeof ApiValidationFieldSchema>;

export interface ApiSuccessEnvelope<T> {
  readonly data: T;
}

export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;
export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

export function apiSuccess<T>(data: T): ApiSuccessEnvelope<T> {
  return { data };
}
