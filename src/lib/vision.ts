import ZAI from 'z-ai-web-dev-sdk'
import type { VisionMessage } from 'z-ai-web-dev-sdk'
import { z } from 'zod'
import type { AnnotationShape } from './quality'
import { bufToDataUrl, cropRegions } from './quality'

/**
 * AI document understanding engine.
 * Combines vision-language AI (glm-4.6v) with structured extraction schemas.
 * Hard product rules enforced by the system prompt + schema validation:
 *   - never guess unreadable text, never invent values (missing => null value + uncertain flag)
 *   - preserve row/column relationships (fields must come from the same visual row)
 *   - flag uncertain characters (e.g. O vs 0) with alternatives instead of picking silently
 *   - report how many records are visible vs extracted (count mismatch detection)
 *   - respect user annotations as extraction instructions
 *   - return bounding boxes for traceability back to the original image
 */

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

const cellSchema = z.object({
  column: z.string(),
  value: z.union([z.string(), z.number(), z.null()]).transform((v) => (v === null ? null : String(v))),
  confidence: z.number().min(0).max(1).default(0.5),
  uncertain: z.boolean().default(false),
  alternatives: z.array(z.string()).default([]),
  bbox: z
    .array(z.number())
    .length(4)
    .nullable()
    .optional()
    .transform((v) => (v && v.length === 4 ? (v as [number, number, number, number]) : null)),
  reason: z.string().nullish().transform((v) => v ?? null),
})

const resultSchema = z.object({
  documentType: z.string().default('document'),
  columns: z.array(z.string()).default([]),
  rows: z
    .array(
      z.object({
        cells: z.array(cellSchema).default([]),
      })
    )
    .default([]),
  visibleRecordCount: z.number().int().nullable().default(null),
  recordCountNote: z.string().nullish().transform((v) => v ?? null),
  warnings: z.array(z.string()).default([]),
})

function buildSystemPrompt(mode: 'general' | 'cashier'): string {
  const base = `You are the document understanding engine of a data extraction platform. You read photographs, scans and screenshots of documents (tables, registers, receipts, forms, handwritten records) and output structured data.

ABSOLUTE RULES — violating any of these is a critical failure:
1. NEVER guess or invent text. If a value is unreadable, return null for "value" with "uncertain": true and a short "reason" (e.g. "smudged", "cut off by page edge", "handwriting unclear"). Missing information must stay missing.
2. NEVER silently omit a visible record. Transcribe every record you can see in the requested regions. If some rows are cut off or unreadable, still list them (with null values where needed) and explain in "warnings".
3. PRESERVE ROW ALIGNMENT. Each record's fields must all come from the same visual row/entry of the document. Double-check that a name, its ID and its number belong together. Never mix values between rows.
4. FLAG UNCERTAIN CHARACTERS. If a character is ambiguous (e.g. letter O vs digit 0 in "ACS001" vs "ACSO01", or 5 vs S, 8 vs B), keep your best reading as "value", set "uncertain": true, and list every plausible reading in "alternatives" (e.g. ["ACS001","ACSO01"]). Lower confidence accordingly.
5. TRANSCRIBE EXACTLY. Copy text as printed/written, including case and punctuation. Do not normalize, correct spelling, translate, or reorder. For amounts keep the currency symbol or code exactly as shown.
6. TRACEABILITY. For every cell, if you can locate it, return "bbox" as [x, y, width, height] in normalized coordinates (0 to 1, relative to the full image, y from top). If you cannot locate a cell, return null.
7. COUNT RECORDS. Set "visibleRecordCount" to the number of records you can actually SEE in the requested regions (not just the ones you extracted). If genuinely impossible to count, null.
8. RESPECT THE REQUEST. Extract ONLY the columns/fields requested by the user instructions and marked regions. Ignore everything else. Do not add extra columns unless the user asked for "everything".
9. Handwritten and printed text are both valid. Read handwriting carefully character by character.
10. Output ONE valid JSON object and nothing else. No markdown fences, no commentary.

Confidence guidance: 0.95+ crisp printed text you are sure about; 0.7-0.94 readable but imperfect photo/handwriting; 0.4-0.69 partly ambiguous characters (must also be "uncertain": true); below 0.4 barely readable (value should usually be null).`

  const cashier = `SPECIALIZED FINANCIAL MODE: this document is a receipt, transaction slip, payment record, invoice, statement or cash collection sheet. Prioritize these fields when present: Transaction ID/Reference, Amount, Transaction Date, Payment Reference, Description, Customer Name. Amounts must include currency exactly as printed. Dates transcribe exactly as written (do not reformat). Transaction IDs must be transcribed digit-by-digit with uncertain flags on ambiguous characters.`

  return mode === 'cashier' ? base + '\n\n' + cashier : base
}

function buildUserText(jobTitle: string, instructions: string, annotations: AnnotationShape[], pageInfo: string): string {
  const parts: string[] = []
  parts.push(`Document batch "${jobTitle}" — ${pageInfo}.`)
  if (annotations.length) {
    parts.push(
      `The user marked ${annotations.length} region(s) on this page with drawings. THESE MARKS ARE EXTRACTION INSTRUCTIONS: extract only information inside the marked regions. The marked regions are attached as zoomed crops after the full page, in this order:`
    )
    annotations.forEach((a, i) => {
      const label = a.label?.trim() ? `"${a.label.trim()}"` : '(no label)'
      parts.push(`  Crop ${i + 1}: a ${a.type} marking ${label}`)
    })
    parts.push('For marked regions, extract the requested fields from those regions only. If the user labeled a region, use the label to understand what it contains.')
  }
  if (instructions.trim()) {
    parts.push(`User instructions (natural language, follow exactly):\n"""\n${instructions.trim()}\n"""`)
  } else {
    parts.push('The user gave no written instructions. Extract the main tabular records visible in the document (all rows, all columns).')
  }
  parts.push(
    `Respond with a single JSON object with this exact shape:
{"documentType":"...","columns":["..."],"rows":[{"cells":[{"column":"...","value":"...","confidence":0.0-1.0,"uncertain":false,"alternatives":["..."],"bbox":[x,y,w,h],"reason":null}]}],"visibleRecordCount":123,"recordCountNote":"...","warnings":["..."]}
- "columns": the names of the fields requested/available (use clean human-readable names, e.g. "Student Name", "Transaction ID", "Amount").
- Every cell must use a "column" that appears in "columns". Keep cells of one record inside one row object, in the same order as "columns".
- If a requested field does not exist for a record, include the cell with value null, uncertain true, reason "not present".`
  )
  return parts.join('\n')
}

/** Robust JSON extraction from model output (handles fences and stray prose). */
export function parseModelJson(raw: string): unknown {
  let s = raw.trim()
  // strip markdown fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  // slice from first { to matching last }
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) throw new Error('No JSON object found in model output')
  s = s.slice(first, last + 1)
  try {
    return JSON.parse(s)
  } catch {
    // repair common issues: trailing commas, smart quotes, newlines inside strings already fine
    let repaired = s.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    return JSON.parse(repaired)
  }
}

export interface PageExtractionInput {
  jobTitle: string
  mode: 'general' | 'cashier'
  instructions: string
  annotations: AnnotationShape[]
  enhancedImage: Buffer
  pageInfo: string
}

export async function extractPage(input: PageExtractionInput): Promise<ExtractionResult> {
  const zai = await ZAI.create()

  // Build zoomed crops for annotated regions so the model reads fine print reliably
  const crops = await cropRegions(input.enhancedImage, input.annotations)

  const content: Extract<VisionMessage['content'], unknown[]> = [
    { type: 'text', text: buildUserText(input.jobTitle, input.instructions, input.annotations, input.pageInfo) },
    { type: 'text', text: 'FULL PAGE (reference, shows the whole document and row context):' },
    { type: 'image_url', image_url: { url: bufToDataUrl(input.enhancedImage) } },
  ]
  for (const c of crops) {
    content.push({ type: 'text', text: `MARKED REGION CROP ${c.index + 1} (${c.label}) — zoomed view of the user's marking:` })
    content.push({ type: 'image_url', image_url: { url: bufToDataUrl(c.buffer) } })
  }

  const messages: VisionMessage[] = [
    { role: 'system', content: buildSystemPrompt(input.mode) },
    { role: 'user', content },
  ]

  let raw = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await zai.chat.completions.createVision({
      model: 'glm-4.6v',
      messages: attempt === 1 ? messages : [...messages, { role: 'assistant', content: raw || '(invalid output)' }, { role: 'user', content: 'That was not valid JSON. Respond again with ONLY the single valid JSON object.' }],
      thinking: { type: 'disabled' },
    })
    raw = response.choices?.[0]?.message?.content ?? ''
    try {
      const parsed = parseModelJson(raw)
      const validated = resultSchema.parse(parsed)
      return normalizeResult(validated, input.annotations)
    } catch (err) {
      if (attempt === 2) throw new Error(`AI returned unparseable output: ${(err as Error).message}`)
    }
  }
  throw new Error('AI extraction failed') // unreachable
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}

function normalizeResult(res: z.infer<typeof resultSchema>, annotations: AnnotationShape[]): ExtractionResult {
  const colSet = new Set(res.columns.map((c) => c.trim()).filter(Boolean))
  // If annotations have labels and user asked via annotations only, still keep model columns.
  const columns = res.columns.map((c) => c.trim()).filter(Boolean)

  const rows = res.rows.map((r) => ({
    cells: r.cells
      .filter((c) => {
        if (!colSet.has(c.column.trim())) colSet.add(c.column.trim())
        return true
      })
      .map((c) => ({
        column: c.column.trim(),
        value: c.value !== null && String(c.value).trim() !== '' ? String(c.value).trim() : null,
        confidence: clamp01(c.confidence),
        uncertain: c.uncertain || c.value === null,
        alternatives: (c.alternatives ?? []).map((a) => String(a).trim()).filter(Boolean),
        bbox:
          c.bbox && c.bbox.every((v) => Number.isFinite(v))
            ? ([clamp01(c.bbox[0]), clamp01(c.bbox[1]), clamp01(c.bbox[2]), clamp01(c.bbox[3])] as [number, number, number, number])
            : null,
        reason: c.reason,
      })),
  }))

  // Ensure every row has a cell for every column (missing => explicit null cell)
  for (const row of rows) {
    const present = new Set(row.cells.map((c) => c.column))
    for (const col of columns) {
      if (!present.has(col)) {
        row.cells.push({ column: col, value: null, confidence: 0, uncertain: true, alternatives: [], bbox: null, reason: 'not present' })
      }
    }
    row.cells.sort((a, b) => columns.indexOf(a.column) - columns.indexOf(b.column))
  }

  return {
    documentType: res.documentType,
    columns,
    rows,
    visibleRecordCount: res.visibleRecordCount ?? null,
    recordCountNote: res.recordCountNote,
    warnings: res.warnings ?? [],
  }
}
