import type { Env } from './kvstore'
import type { AnnotationShape, ClientCrop, ExtractionResult } from './types'
import { asExtractionResult, clamp01, normalizeExtraction, parseModelJson } from './util'

/**
 * AI document understanding engine for the Cloudflare deployment, backed by
 * the Workers AI binding. Same product rules and JSON contract as the
 * z-ai/glm-4.6v engine in src/lib/vision.ts of the Next.js app.
 *
 * Workers AI vision models accept ONE image per call, so annotated pages are
 * extracted with one call per zoomed crop (sent by the browser) plus one
 * light meta call against the full page for document type and record counts.
 * When no annotations exist, a single full-page call does everything.
 */

const MAX_TOKENS_FULL = 3000
const MAX_TOKENS_CROP = 3000
const MAX_TOKENS_META = 600

function buildSystemPrompt(mode: 'general' | 'cashier'): string {
  const base = `You are the document understanding engine of a data extraction platform. You read photographs, scans and screenshots of documents (tables, registers, receipts, forms, handwritten records) and output structured data.

ABSOLUTE RULES:
1. NEVER guess or invent text. If a value is unreadable, return null for "value" with "uncertain": true and a short "reason" (e.g. "smudged", "cut off", "handwriting unclear"). Missing information must stay missing.
2. NEVER silently omit a visible record. Transcribe every record you can see in the requested region. If some rows are cut off or unreadable, still list them (null values where needed) and explain in "warnings".
3. PRESERVE ROW ALIGNMENT. Each record's fields must all come from the same visual row/entry of the document. Never mix values between rows.
4. FLAG UNCERTAIN CHARACTERS. If a character is ambiguous (letter O vs digit 0 in "ACS001" vs "ACSO01", 5 vs S, 8 vs B), keep your best reading as "value", set "uncertain": true, and list every plausible reading in "alternatives".
5. TRANSCRIBE EXACTLY. Copy text as printed/written, including case and punctuation. Do not normalize, correct spelling, translate or reorder. For amounts keep the currency symbol or code exactly as shown.
6. For every cell, if you can locate it, return "bbox" as [x, y, width, height] in normalized coordinates (0 to 1 relative to the given image, y from top). If you cannot locate it, return null.
7. Set "visibleRecordCount" to the number of records you can actually SEE (not just the ones you extracted). If impossible to count, null.
8. Extract ONLY the fields requested by the user instructions or present in the marked region. Ignore everything else.
9. Handwritten and printed text are both valid. Read handwriting carefully, character by character.
10. Output ONE valid JSON object and nothing else. No markdown fences, no commentary.

Confidence guidance: 0.95+ crisp printed text you are sure about; 0.7-0.94 readable but imperfect photo/handwriting; 0.4-0.69 partly ambiguous characters (must also be "uncertain": true); below 0.4 barely readable (value should usually be null).`

  const cashier = `SPECIALIZED FINANCIAL MODE: this document is a receipt, transaction slip, payment record, invoice, statement or cash collection sheet. Prioritize these fields when present: Transaction ID/Reference, Amount, Transaction Date, Payment Reference, Description, Customer Name. Amounts must include currency exactly as printed. Dates transcribe exactly as written (do not reformat). Transaction IDs must be transcribed digit-by-digit with uncertain flags on ambiguous characters.`

  return mode === 'cashier' ? base + '\n\n' + cashier : base
}

const JSON_SHAPE = `{"documentType":"...","columns":["..."],"rows":[{"cells":[{"column":"...","value":"...","confidence":0.0-1.0,"uncertain":false,"alternatives":["..."],"bbox":[x,y,w,h],"reason":null}]}],"visibleRecordCount":123,"recordCountNote":"...","warnings":["..."]}`

const JSON_SHAPE_NO_BBOX = `{"documentType":"...","columns":["..."],"rows":[{"cells":[{"column":"...","value":"...","confidence":0.0-1.0,"uncertain":false,"alternatives":["..."],"reason":null}]}],"visibleRecordCount":123,"recordCountNote":"...","warnings":["..."]}`

function buildFullPagePrompt(input: {
  jobTitle: string
  instructions: string
  annotations: AnnotationShape[]
  pageInfo: string
}): string {
  const parts: string[] = []
  parts.push(`Document batch "${input.jobTitle}" — ${input.pageInfo}.`)
  if (input.annotations.length) {
    parts.push(
      `The user marked ${input.annotations.length} region(s) on this page with drawings. THESE MARKS ARE EXTRACTION INSTRUCTIONS: extract only information inside the marked regions. Zoomed crops of the marked regions are provided as separate requests; use this full page for overall context.`
    )
  }
  if (input.instructions.trim()) {
    parts.push(`User instructions (natural language, follow exactly):\n"""\n${input.instructions.trim()}\n"""`)
  } else {
    parts.push('The user gave no written instructions. Extract the main tabular records visible in the document (all rows, all columns).')
  }
  parts.push(
    `Respond with a single JSON object with this exact shape:\n${JSON_SHAPE_NO_BBOX}\n- "columns": clean human-readable names of the requested/available fields (e.g. "Student Name", "Transaction ID", "Amount").\n- Every cell must use a "column" that appears in "columns". Keep cells of one record inside one row object, in the same order as "columns". Do NOT include bbox coordinates in this full-page response (set them to null / omit them).\n- If a requested field does not exist for a record, include the cell with value null, uncertain true, reason "not present".`
  )
  return parts.join('\n\n')
}

function buildMetaPrompt(input: { jobTitle: string; pageInfo: string }): string {
  return `Document batch "${input.jobTitle}" — ${input.pageInfo}. This is a full page of a document whose marked regions are being extracted separately. Look at the WHOLE page and report ONLY:
- "documentType": short label of the document kind (e.g. "class register", "cash receipts", "invoice")
- "visibleRecordCount": number of data records/rows VISIBLE on the whole page (null if impossible)
- "warnings": short strings about anything that could affect extraction (blur, cut-off rows, handwriting)
Respond with a single JSON object of exactly this shape and nothing else:
{"documentType":"...","visibleRecordCount":123,"warnings":["..."]}`
}

function buildCropPrompt(input: {
  jobTitle: string
  instructions: string
  cropLabel: string
  cropIndex: number
  cropCount: number
}): string {
  const parts: string[] = []
  parts.push(
    `Document batch "${input.jobTitle}". This image is a ZOOMED CROP of user-marked region ${input.cropIndex + 1} of ${input.cropCount}, labeled "${input.cropLabel}". The user marked this region as an extraction instruction: extract the records visible in THIS crop only.`
  )
  if (input.instructions.trim()) {
    parts.push(`User instructions (natural language, follow exactly):\n"""\n${input.instructions.trim()}\n"""`)
  }
  parts.push(
    `Respond with a single JSON object with this exact shape:\n${JSON_SHAPE}\n- "columns": clean human-readable names of the fields visible in this region.\n- Every cell must use a "column" that appears in "columns". Keep cells of one record inside one row object, in the same order as "columns".\n- If a requested field does not exist for a record, include the cell with value null, uncertain true, reason "not present".\n- Set "visibleRecordCount" to the number of records visible in THIS crop; set "documentType" to the document kind if recognizable, otherwise "unknown".`
  )
  return parts.join('\n\n')
}

const SYSTEM_TAIL = `\n\nOUTPUT FORMAT (critical): your ENTIRE response must be exactly ONE valid JSON object — no markdown, no bold, no numbered lists, no code fences, no explanations before or after. Start your response with { and end it with }.`

interface AiVisionResponse {
  response?: unknown
  result?: { response?: unknown }
}

/** Normalize the different Workers AI response shapes into plain text. */
function responseToText(res: AiVisionResponse): string {
  const raw = (res?.response ?? res?.result?.response ?? res?.result ?? '') as unknown
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((part) => (typeof part === 'string' ? part : ((part as Record<string, unknown>)?.text as string) ?? ''))
      .join('')
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (Array.isArray(obj.content)) {
      return (obj.content as Record<string, unknown>[]).map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
    }
    return JSON.stringify(raw)
  }
  return ''
}

/**
 * One vision inference. Tries the chat/messages schema first (better instruction
 * following on llama-3.2-vision) and falls back to the flat image+prompt schema.
 * Each format gets one retry with a JSON-correction nudge.
 */
async function callVision(
  env: Env,
  imageBase64: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<string> {
  const model = env.VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct'
  const dataUrl = `data:image/jpeg;base64,${imageBase64}`
  const attempts: ((p: string) => Record<string, unknown>)[] = [
    (p) => ({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [{ type: 'text', text: p }, { type: 'image_url', image_url: { url: dataUrl } }] },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
    }),
    (p) => ({
      image: imageBase64,
      prompt: `${systemPrompt}\n\n${p}`,
      max_tokens: maxTokens,
      temperature: 0.1,
      raw_output: false,
    }),
  ]

  let lastError = new Error('AI extraction failed')
  for (const makeInput of attempts) {
    // First try, then one corrective retry per format.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const user = attempt === 1 ? userPrompt : `${userPrompt}\n\nREMINDER: your previous answer was not a single valid JSON object. Respond again with ONLY one valid JSON object, starting with { and ending with }.`
      try {
        const res = (await env.AI.run(model, makeInput(user))) as AiVisionResponse
        const raw = responseToText(res)
        if (!raw.trim()) throw new Error('empty output')
        try {
          parseModelJson(raw)
          return raw
        } catch {
          lastError = new Error(
            `AI returned unparseable output (raw starts: ${raw.slice(0, 140).replace(/\s+/g, ' ')})`
          )
        }
      } catch (err) {
        lastError = err as Error
        // Schema-level failure (e.g. messages unsupported) -> try next format immediately
        if (attempt === 1 && isSchemaError(lastError)) break
      }
    }
  }
  throw lastError
}

function isSchemaError(err: Error): boolean {
  const msg = err.message || ''
  return /must (be|required)|expected|invalid|unsupported|schema|4\b00|unserialis|expects/i.test(msg)
}

export interface ExtractInput {
  jobTitle: string
  mode: 'general' | 'cashier'
  instructions: string
  annotations: AnnotationShape[]
  pageInfo: string
  fullImageBase64: string
  crops: ClientCrop[]
}

export async function extractPageWithAI(env: Env, input: ExtractInput): Promise<ExtractionResult> {
  const system = buildSystemPrompt(input.mode) + SYSTEM_TAIL

  if (input.crops.length) {
    // Meta call: document type + record count over the full page.
    let documentType = 'document'
    let visibleRecordCount: number | null = null
    let recordCountNote: string | null = null
    const warnings: string[] = []
    try {
      const metaRaw = await callVision(env, input.fullImageBase64, system, buildMetaPrompt(input), MAX_TOKENS_META)
      const meta = asExtractionResult(parseModelJson(metaRaw))
      if (meta.documentType && meta.documentType !== 'document') documentType = meta.documentType
      visibleRecordCount = meta.visibleRecordCount
      recordCountNote = meta.recordCountNote
      warnings.push(...meta.warnings)
    } catch {
      warnings.push('Could not read the full page for record counting — record counts may be unavailable.')
    }

    // One call per marked region.
    const allRows: { cells: ExtractionResult['rows'][number]['cells'] }[] = []
    const columns: string[] = []
    for (let i = 0; i < input.crops.length; i++) {
      const crop = input.crops[i]
      const raw = await callVision(
        env,
        dataUrlToBase64Strict(crop.dataUrl),
        system,
        buildCropPrompt({
          jobTitle: input.jobTitle,
          instructions: input.instructions,
          cropLabel: crop.label,
          cropIndex: i,
          cropCount: input.crops.length,
        }),
        MAX_TOKENS_CROP
      )
      const res = normalizeExtraction(asExtractionResult(parseModelJson(raw)))
      for (const c of res.columns) if (!columns.includes(c)) columns.push(c)
      // Map crop-relative bboxes back to full-page coordinates (crop rect is normalized).
      for (const row of res.rows) {
        for (const cell of row.cells) {
          if (cell.bbox) {
            cell.bbox = [
              clamp01(crop.x + cell.bbox[0] * crop.w),
              clamp01(crop.y + cell.bbox[1] * crop.h),
              clamp01(cell.bbox[2] * crop.w),
              clamp01(cell.bbox[3] * crop.h),
            ]
          }
        }
        allRows.push(row)
      }
      warnings.push(...res.warnings)
    }

    return {
      documentType,
      columns,
      rows: allRows,
      visibleRecordCount,
      recordCountNote,
      warnings: [...new Set(warnings)],
    }
  }

  // No annotations: single full-page extraction call.
  const raw = await callVision(env, input.fullImageBase64, system, buildFullPagePrompt(input), MAX_TOKENS_FULL)
  return normalizeExtraction(asExtractionResult(parseModelJson(raw)))
}

function dataUrlToBase64Strict(dataUrl: string): string {
  const m = /^data:[^;]+;base64,(.+)$/.exec(dataUrl.trim())
  if (!m) throw new Error('Invalid crop image payload')
  return m[1]
}
