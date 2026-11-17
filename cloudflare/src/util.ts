import type { ExtractionCell, ExtractionResult } from './types'

/** Small utilities shared across the Worker. */

export function uid(): string {
  return crypto.randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** ArrayBuffer -> base64 (chunked so large images don't blow the stack). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function dataUrlToBase64(dataUrl: string): { base64: string; ok: boolean } {
  const m = /^data:[^;]+;base64,(.+)$/.exec(dataUrl.trim())
  if (!m) return { base64: '', ok: false }
  return { base64: m[1], ok: true }
}

/**
 * Robust JSON extraction from model output — same behaviour as
 * `parseModelJson` in the Next.js vision engine (handles fences and stray prose),
 * plus salvage of JSON truncated by the max-token limit (unbalanced braces get
 * auto-closed) and of markdown answers where JSON objects are embedded in prose.
 */
export function parseModelJson(raw: string): unknown {
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) throw new Error('No JSON object found in model output')
  s = s.slice(first, last + 1)
  try {
    return JSON.parse(s)
  } catch {
    const repaired = s.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    try {
      return JSON.parse(repaired)
    } catch {
      try {
        return JSON.parse(closeUnbalanced(repaired))
      } catch {
        const salvaged = salvageMarkdown(raw)
        if (salvaged) return salvaged
        throw new Error('Unparseable model output')
      }
    }
  }
}

/** Extract every balanced top-level {...} object from a text. */
function extractBalancedObjects(text: string): unknown[] {
  const objs: unknown[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\' && inStr) {
      esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const frag = text.slice(start, i + 1)
        try {
          objs.push(JSON.parse(frag.replace(/,\s*([}\]])/g, '$1')))
        } catch {
          try {
            objs.push(JSON.parse(closeUnbalanced(frag)))
          } catch {
            /* skip malformed fragment */
          }
        }
        start = -1
      }
    }
  }
  return objs
}

/**
 * Last-resort salvage for models that answer in markdown prose with embedded
 * JSON row objects (e.g. "**Rows:** 1. {"cells": [...]}"). Collects row
 * objects and header fragments and reassembles the extraction shape.
 */
function salvageMarkdown(raw: string): unknown | null {
  const objs = extractBalancedObjects(raw)
  if (!objs.length) return null
  const rows: unknown[] = []
  let documentType: string | null = null
  let columns: unknown = null
  let visibleRecordCount: number | null = null
  const warnings: unknown[] = []

  for (const o of objs) {
    const obj = o as Record<string, unknown>
    if (Array.isArray(obj?.cells)) rows.push({ cells: obj.cells })
    else {
      if (!documentType && typeof obj?.documentType === 'string') documentType = obj.documentType
      if (!columns && Array.isArray(obj?.columns)) columns = obj.columns
      if (visibleRecordCount === null && typeof obj?.visibleRecordCount === 'number') visibleRecordCount = obj.visibleRecordCount
      if (Array.isArray(obj?.warnings)) warnings.push(...obj.warnings)
    }
  }
  if (!rows.length) return null

  // documentType fallback from prose like "**Document Type:** ACS 101 Register"
  const m = /Document\s*Type\*?\*?\s*:\s*([^*\n\r]+)/i.exec(raw)
  if (!documentType && m) documentType = m[1].trim()

  return {
    documentType: documentType ?? 'document',
    columns,
    rows,
    visibleRecordCount,
    recordCountNote: null,
    warnings,
  }
}

/** Close open strings/objects/arrays left by a max-token truncation. */
function closeUnbalanced(s: string): string {
  let inString = false
  let escaped = false
  const stack: string[] = []
  for (const ch of s) {
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  let out = s
  if (inString) out += '"'
  // trim a dangling partial entry then close in reverse order
  out = out.replace(/,\s*"?\w*"?\s*:?\s*$/, '')
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']'
  return out
}

/**
 * Defensive validation of a model extraction payload into the strict
 * ExtractionResult shape (equivalent of the zod schema in lib/vision.ts).
 */
export function asExtractionResult(parsed: unknown): ExtractionResult {
  const obj = (parsed ?? {}) as Record<string, unknown>
  const documentType = typeof obj.documentType === 'string' && obj.documentType.trim() ? obj.documentType.trim() : 'document'

  const columns: string[] = []
  if (Array.isArray(obj.columns)) {
    for (const c of obj.columns) {
      const name = String(c ?? '').trim()
      if (name && !columns.includes(name)) columns.push(name)
    }
  }

  const rawRows = Array.isArray(obj.rows) ? obj.rows : []
  const rows = rawRows.map((r) => {
    const cellsRaw = Array.isArray((r as Record<string, unknown>)?.cells) ? ((r as Record<string, unknown>).cells as unknown[]) : []
    const cells: ExtractionCell[] = cellsRaw.map((cRaw) => {
      const c = (cRaw ?? {}) as Record<string, unknown>
      const value = c.value === null || c.value === undefined ? null : String(c.value)
      const bboxArr = Array.isArray(c.bbox) && c.bbox.length === 4 && c.bbox.every((v) => Number.isFinite(Number(v)))
        ? ([clamp01(Number(c.bbox[0])), clamp01(Number(c.bbox[1])), clamp01(Number(c.bbox[2])), clamp01(Number(c.bbox[3]))] as [number, number, number, number])
        : null
      return {
        column: String(c.column ?? '').trim(),
        value: value !== null && value.trim() !== '' ? value.trim() : null,
        confidence: Math.min(1, Math.max(0, Number(c.confidence) || 0)),
        uncertain: Boolean(c.uncertain),
        alternatives: (Array.isArray(c.alternatives) ? c.alternatives : []).map((a) => String(a ?? '').trim()).filter(Boolean),
        bbox: bboxArr,
        reason: c.reason == null ? null : String(c.reason),
      }
    }).filter((c) => c.column)
    return { cells }
  })

  const visibleRecordCount =
    typeof obj.visibleRecordCount === 'number' && Number.isFinite(obj.visibleRecordCount) ? Math.round(obj.visibleRecordCount) : null

  const warnings = (Array.isArray(obj.warnings) ? obj.warnings : []).map((w) => String(w ?? '')).filter(Boolean)

  return {
    documentType,
    columns,
    rows,
    visibleRecordCount,
    recordCountNote: obj.recordCountNote == null ? null : String(obj.recordCountNote),
    warnings,
  }
}

/**
 * Align extraction rows to the declared columns, exactly like `normalizeResult`
 * in lib/vision.ts: every row gets a cell per column (missing => explicit null).
 */
export function normalizeExtraction(res: ExtractionResult): ExtractionResult {
  const columns = res.columns
  const colSet = new Set(columns)
  for (const r of res.rows) {
    for (const c of r.cells) if (!colSet.has(c.column)) {
      columns.push(c.column)
      colSet.add(c.column)
    }
  }
  for (const row of res.rows) {
    const present = new Set(row.cells.map((c) => c.column))
    for (const col of columns) {
      if (!present.has(col)) {
        row.cells.push({ column: col, value: null, confidence: 0, uncertain: true, alternatives: [], bbox: null, reason: 'not present' })
      }
    }
    row.cells.sort((a, b) => columns.indexOf(a.column) - columns.indexOf(b.column))
  }
  return res
}
