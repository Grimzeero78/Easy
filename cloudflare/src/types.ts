/**
 * Shared API contract types — mirrors src/lib/types.ts of the Next.js app so
 * the same frontend works against this Worker unchanged.
 */

export type QualityVerdict = 'pass' | 'warn' | 'fail'

export interface QualityIssue {
  code: string
  severity: 'warn' | 'fail'
  message: string
}

export interface ImageQuality {
  blurScore: number
  brightness: number
  contrast: number
  width: number
  height: number
  darkFraction: number
  brightFraction: number
  verdict: QualityVerdict
  issues: QualityIssue[]
}

export interface AnnotationShape {
  id: string
  type: 'rect' | 'ellipse' | 'freehand'
  x: number
  y: number
  w: number
  h: number
  label?: string
  points?: number[]
}

export interface PageMeta {
  id: string
  order: number
  fileName: string
  width: number
  height: number
  quality: ImageQuality
  annotations: AnnotationShape[]
  status: string // uploaded | extracting | extracted | failed | blocked
  errorMessage: string | null
  hasExtraction: boolean
  extractionMeta: {
    documentType?: string
    columns?: string[]
    visibleRecordCount?: number | null
    warnings?: string[]
  }
}

export interface PageRecord extends PageMeta {
  jobId: string
}

export interface FieldView {
  id: string
  pageIndex: number
  rowIndex: number
  columnName: string
  value: string | null
  confidence: number
  uncertain: boolean
  missing: boolean
  alternatives: string[]
  bbox: [number, number, number, number] | null
  reason: string | null
  edited: boolean
  duplicate: boolean
}

export interface JobRecord {
  id: string
  title: string
  mode: 'general' | 'cashier'
  status: string // draft | extracting | review | exported
  instructions: string
  createdAt: string
  updatedAt: string
}

export interface JobListItem {
  id: string
  title: string
  mode: 'general' | 'cashier'
  status: string
  pageCount: number
  extractedPages: number
  recordCount: number
  flaggedCount: number
  exportCount: number
  createdAt: string
  updatedAt: string
}

export interface ExportMetaRecord {
  id: string
  format: string
  fileName: string
  rows: number
  jobId: string
  jobTitle: string
  createdAt: string
}

export interface ExportListItem {
  id: string
  format: string
  fileName: string
  rows: number
  jobTitle?: string
  createdAt: string
}

export interface TemplateItem {
  id: string
  name: string
  type: 'xlsx' | 'columns'
  fileName?: string | null
  columns?: string[] | null
  headers?: string[] | null
  createdAt: string
}

export interface PageReport {
  pageIndex: number
  fileName: string
  rows: number
  flagged: number
  missing: number
  visibleRecordCount: number | null
  countMismatch: boolean
  warnings: string[]
  qualityVerdict: string
  status: string
}

export interface JobReport {
  totalFields: number
  totalRows: number
  uniqueRows: number
  duplicateRows: number
  flaggedFields: number
  missingFields: number
  editedFields: number
  avgConfidence: number
  columns: string[]
  duplicateRowIndexes: { pageIndex: number; rowIndex: number }[]
  pages: PageReport[]
  needsReview: boolean
  summary: string[]
}

/* ---------- AI extraction shapes (mirrors lib/vision.ts) ---------- */

export interface ExtractionCell {
  column: string
  value: string | null
  confidence: number
  uncertain: boolean
  alternatives: string[]
  bbox?: [number, number, number, number] | null
  reason?: string | null
}

export interface ExtractionResult {
  documentType: string
  columns: string[]
  rows: { cells: ExtractionCell[] }[]
  visibleRecordCount: number | null
  recordCountNote: string | null
  warnings: string[]
}

/** Client-sent zoomed crop of a user-marked region (CF mode). */
export interface ClientCrop {
  label: string
  dataUrl: string
  x: number
  y: number
  w: number
  h: number
}
