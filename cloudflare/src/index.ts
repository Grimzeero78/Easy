import { Hono } from 'hono'
import * as XLSX from 'xlsx'
import type { Env } from './kvstore'
import {
  deleteKey,
  getExportData,
  getExportsIndex,
  getFields,
  getJob,
  getJobExports,
  getJobsIndex,
  getPageImage,
  getPages,
  getTemplateData,
  getTemplatesIndex,
  putExportData,
  putFields,
  putJob,
  putJobExports,
  putPageImage,
  putPages,
  putTemplateData,
  putTemplatesIndex,
  recomputeJobSummary,
  removeExportEverywhere,
  removeJobFromIndex,
  upsertExportsIndex,
} from './kvstore'
import { applyDuplicateFlags, computeReport } from './report'
import { extractPageWithAI } from './vision'
import { arrayBufferToBase64, nowIso, uid } from './util'
import { buildCsv, buildDocx, buildJson, buildPdf, buildTxt, buildXlsx, type ExportInput, type ExportRecordRow } from './exporters'
import type {
  AnnotationShape,
  ClientCrop,
  ExportMetaRecord,
  FieldView,
  ImageQuality,
  JobRecord,
  PageRecord,
  TemplateItem,
} from './types'

const app = new Hono<{ Bindings: Env }>()

/* Global error net so every failure returns JSON like the Next API does. */
app.use('/api/*', async (c, next) => {
  try {
    await next()
  } catch (err) {
    return c.json({ error: `Server error: ${(err as Error).message}` }, 500)
  }
})

app.get('/api', (c) => c.json({ message: 'Hello, world!' }))

// GET /api/ai-license — one-time model license bootstrap.
// Llama models on Workers AI require a single run with the prompt "agree"
// before first use (Meta Community License). Call this once per account.
app.get('/api/ai-license', async (c) => {
  try {
    const res = (await c.env.AI.run(c.env.VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct', {
      prompt: 'agree',
      max_tokens: 5,
      raw_output: true,
    } as unknown as Record<string, unknown>)) as { response?: string }
    return c.json({ ok: true, note: 'Model license accepted for this account.', response: (res?.response ?? '').slice(0, 40) })
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500)
  }
})

/* ================= Jobs ================= */

// GET /api/jobs — dashboard list (denormalized index)
app.get('/api/jobs', async (c) => {
  const jobs = await getJobsIndex(c.env.KV)
  return c.json({ jobs })
})

// POST /api/jobs — create a new extraction job
app.post('/api/jobs', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled extraction'
  const mode = body.mode === 'cashier' ? 'cashier' : 'general'
  const now = nowIso()
  const job: JobRecord = { id: uid(), title, mode, status: 'draft', instructions: '', createdAt: now, updatedAt: now }
  await putJob(c.env.KV, job)
  await recomputeJobSummary(c.env.KV, job)
  return c.json({ job: { id: job.id, title: job.title, mode: job.mode, status: job.status } })
})

// GET /api/jobs/[id] — full job detail: pages (meta only), fields, report
app.get('/api/jobs/:id', async (c) => {
  const id = c.req.param('id')
  const job = await getJob(c.env.KV, id)
  if (!job) return c.json({ error: 'Job not found' }, 404)
  const [pages, storedFields] = await Promise.all([getPages(c.env.KV, id), getFields(c.env.KV, id)])
  const fields = applyDuplicateFlags(storedFields).fields

  const pageMetas = pages.map(({ jobId: _jobId, ...meta }) => meta)

  return c.json({
    job: {
      id: job.id,
      title: job.title,
      mode: job.mode,
      status: job.status,
      instructions: job.instructions,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
    pages: pageMetas,
    fields,
    report: computeReport(pages, fields),
  })
})

// PATCH /api/jobs/[id] — update title / instructions / mode / status
app.patch('/api/jobs/:id', async (c) => {
  const id = c.req.param('id')
  const job = await getJob(c.env.KV, id)
  if (!job) return c.json({ error: 'Job not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.title === 'string' && body.title.trim()) job.title = body.title.trim()
  if (typeof body.instructions === 'string') job.instructions = body.instructions
  if (body.mode === 'general' || body.mode === 'cashier') job.mode = body.mode
  if (typeof body.status === 'string') job.status = body.status
  job.updatedAt = nowIso()
  await putJob(c.env.KV, job)
  await recomputeJobSummary(c.env.KV, job)
  return c.json({ job: { id: job.id, status: job.status } })
})

// DELETE /api/jobs/[id] — user-controlled deletion (cascades everything)
app.delete('/api/jobs/:id', async (c) => {
  const id = c.req.param('id')
  const job = await getJob(c.env.KV, id)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const pages = await getPages(c.env.KV, id)
  for (const p of pages) {
    await deleteKey(c.env.KV, `pagedata:${p.id}:orig`)
    await deleteKey(c.env.KV, `pagedata:${p.id}:enh`)
    await deleteKey(c.env.KV, `pagejob:${p.id}`)
  }
  for (const e of await getJobExports(c.env.KV, id)) {
    await deleteKey(c.env.KV, `exportdata:${e.id}`)
    await removeExportEverywhere(c.env.KV, e.id)
  }
  await deleteKey(c.env.KV, `jobpages:${id}`)
  await deleteKey(c.env.KV, `jobfields:${id}`)
  await deleteKey(c.env.KV, `jobexports:${id}`)
  await deleteKey(c.env.KV, `job:${id}`)
  await removeJobFromIndex(c.env.KV, id)
  return c.json({ ok: true })
})

/* ================= Pages ================= */

// POST /api/jobs/[id]/pages — upload one page image (FormData).
// CF mode: the browser ran the quality gate and sends `quality`, `width`,
// `height` plus the enhanced reading copy; the Worker stores both variants.
app.post('/api/jobs/:id/pages', async (c) => {
  const id = c.req.param('id')
  const job = await getJob(c.env.KV, id)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return c.json({ error: 'Missing file' }, 400)
  const fileName = (form.get('fileName') as string) || file.name || 'page.jpg'

  try {
    const originalBuf = await file.arrayBuffer()
    const enhancedFile = form.get('enhanced')
    const enhancedBuf = enhancedFile instanceof File ? await enhancedFile.arrayBuffer() : null

    let quality: ImageQuality | null = null
    const qualityRaw = form.get('quality')
    if (typeof qualityRaw === 'string' && qualityRaw) {
      try {
        quality = JSON.parse(qualityRaw) as ImageQuality
      } catch {
        quality = null
      }
    }
    let width = Number(form.get('width')) || 0
    let height = Number(form.get('height')) || 0
    if (quality) {
      width = quality.width || width
      height = quality.height || height
    }
    if (!quality) {
      // Fallback when the client could not assess quality (no pixel metrics available server-side)
      quality = {
        blurScore: 0,
        brightness: 0,
        contrast: 0,
        width,
        height,
        darkFraction: 0,
        brightFraction: 0,
        verdict: 'pass',
        issues: [],
      }
    }

    const pageId = uid()
    const pages = await getPages(c.env.KV, id)
    const order = pages.length

    await putPageImage(c.env.KV, pageId, 'orig', originalBuf)
    if (enhancedBuf) await putPageImage(c.env.KV, pageId, 'enh', enhancedBuf)
    await c.env.KV.put(`pagejob:${pageId}`, id)

    const page: PageRecord = {
      id: pageId,
      jobId: id,
      order,
      fileName,
      width,
      height,
      quality,
      annotations: [],
      status: quality.verdict === 'fail' ? 'blocked' : 'uploaded',
      errorMessage: null,
      hasExtraction: false,
      extractionMeta: {},
    }
    pages.push(page)
    await putPages(c.env.KV, id, pages)
    job.updatedAt = nowIso()
    await putJob(c.env.KV, job)
    await recomputeJobSummary(c.env.KV, job)

    return c.json({
      page: {
        id: page.id,
        order: page.order,
        fileName: page.fileName,
        width,
        height,
        status: page.status,
        quality,
      },
    })
  } catch (err) {
    return c.json({ error: `Could not process image: ${(err as Error).message}` }, 400)
  }
})

// GET /api/pages/[id]/image?variant=enhanced|original — serve stored page image
app.get('/api/pages/:id/image', async (c) => {
  const id = c.req.param('id')
  const variant = c.req.query('variant') === 'original' ? 'original' : 'enhanced'
  const jobId = await c.env.KV.get(`pagejob:${id}`)
  if (!jobId) return c.json({ error: 'Page not found' }, 404)
  const pages = await getPages(c.env.KV, jobId)
  const page = pages.find((p) => p.id === id)
  if (!page) return c.json({ error: 'Page not found' }, 404)

  const enh = variant === 'enhanced' ? await getPageImage(c.env.KV, id, 'enh') : null
  const data = enh ?? (await getPageImage(c.env.KV, id, 'orig'))
  if (!data) return c.json({ error: 'Page image missing' }, 404)

  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=3600',
    },
  })
})

// PATCH /api/pages/[id] — save annotations drawn on the page (normalized shapes)
app.patch('/api/pages/:id', async (c) => {
  const id = c.req.param('id')
  const jobId = await c.env.KV.get(`pagejob:${id}`)
  if (!jobId) return c.json({ error: 'Page not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  if (!Array.isArray(body.annotations)) return c.json({ error: 'annotations must be an array' }, 400)

  const annotations: AnnotationShape[] = body.annotations
    .filter((a: Record<string, unknown>) => a && typeof a === 'object')
    .map((a: Record<string, unknown>) => ({
      id: String(a.id ?? crypto.randomUUID()),
      type: (['rect', 'ellipse', 'freehand'].includes(a.type as string) ? a.type : 'rect') as AnnotationShape['type'],
      x: Math.max(0, Math.min(1, Number(a.x) || 0)),
      y: Math.max(0, Math.min(1, Number(a.y) || 0)),
      w: Math.max(0, Math.min(1, Number(a.w) || 0)),
      h: Math.max(0, Math.min(1, Number(a.h) || 0)),
      label: typeof a.label === 'string' ? a.label.slice(0, 200) : '',
      points: Array.isArray(a.points) ? (a.points as number[]).slice(0, 2000) : undefined,
    }))

  const pages = await getPages(c.env.KV, jobId)
  const page = pages.find((p) => p.id === id)
  if (!page) return c.json({ error: 'Page not found' }, 404)
  page.annotations = annotations
  await putPages(c.env.KV, jobId, pages)
  return c.json({ annotations })
})

// DELETE /api/pages/[id] — remove a page (user-controlled deletion)
app.delete('/api/pages/:id', async (c) => {
  const id = c.req.param('id')
  const jobId = await c.env.KV.get(`pagejob:${id}`)
  if (!jobId) return c.json({ error: 'Page not found' }, 404)

  const pages = await getPages(c.env.KV, jobId)
  const page = pages.find((p) => p.id === id)
  if (!page) return c.json({ error: 'Page not found' }, 404)

  const removedOrder = page.order
  const remaining = pages.filter((p) => p.id !== id).map((p, i) => ({ ...p, order: i }))
  await putPages(c.env.KV, jobId, remaining)

  // Remove the page's fields and re-index pageIndex of later pages
  const fields = await getFields(c.env.KV, jobId)
  const nextFields = fields
    .filter((f) => f.pageIndex !== removedOrder)
    .map((f) => (f.pageIndex > removedOrder ? { ...f, pageIndex: f.pageIndex - 1 } : f))
  await putFields(c.env.KV, jobId, nextFields)

  await deleteKey(c.env.KV, `pagedata:${id}:orig`)
  await deleteKey(c.env.KV, `pagedata:${id}:enh`)
  await deleteKey(c.env.KV, `pagejob:${id}`)

  const job = await getJob(c.env.KV, jobId)
  if (job) {
    job.updatedAt = nowIso()
    await putJob(c.env.KV, job)
    await recomputeJobSummary(c.env.KV, job)
  }
  return c.json({ ok: true })
})

/* ================= Extraction ================= */

// POST /api/pages/[id]/extract — run AI extraction on ONE page.
// Optional JSON body: { crops: [{ label, dataUrl, x, y, w, h }] } (CF mode,
// crops generated in the browser for each user-marked region).
app.post('/api/pages/:id/extract', async (c) => {
  const id = c.req.param('id')
  const jobId = await c.env.KV.get(`pagejob:${id}`)
  if (!jobId) return c.json({ error: 'Page not found' }, 404)
  const [job, pages] = await Promise.all([getJob(c.env.KV, jobId), getPages(c.env.KV, jobId)])
  const page = pages.find((p) => p.id === id)
  if (!job || !page) return c.json({ error: 'Page not found' }, 404)

  // HARD QUALITY GATE — never silently process images below threshold
  if (page.quality?.verdict === 'fail' || page.status === 'blocked') {
    return c.json(
      { error: 'This page failed the quality check and is blocked from AI extraction. Retake or replace the picture.' },
      403
    )
  }

  const imageData = (await getPageImage(c.env.KV, id, 'enh')) ?? (await getPageImage(c.env.KV, id, 'orig'))
  if (!imageData) return c.json({ error: 'Page image missing' }, 400)

  // Optional client-sent crops of annotated regions
  let crops: ClientCrop[] = []
  const body = await c.req.json().catch(() => ({}))
  if (Array.isArray(body?.crops)) {
    crops = body.crops
      .filter((cr: Record<string, unknown>) => cr && typeof cr === 'object' && typeof cr.dataUrl === 'string')
      .slice(0, 12)
      .map((cr: Record<string, unknown>) => ({
        label: String(cr.label ?? '').slice(0, 200),
        dataUrl: String(cr.dataUrl).slice(0, 9_000_000),
        x: Math.max(0, Math.min(1, Number(cr.x) || 0)),
        y: Math.max(0, Math.min(1, Number(cr.y) || 0)),
        w: Math.max(0.01, Math.min(1, Number(cr.w) || 1)),
        h: Math.max(0.01, Math.min(1, Number(cr.h) || 1)),
      }))
  }

  page.status = 'extracting'
  job.status = 'extracting'
  job.updatedAt = nowIso()
  await putPages(c.env.KV, jobId, pages)
  await putJob(c.env.KV, job)

  try {
    const pageInfo = `page ${page.order + 1}${page.annotations.length ? ' with ' + page.annotations.length + ' user-marked region(s)' : ''}`
    const result = await extractPageWithAI(c.env, {
      jobTitle: job.title,
      mode: job.mode === 'cashier' ? 'cashier' : 'general',
      instructions: job.instructions,
      annotations: page.annotations,
      pageInfo,
      fullImageBase64: arrayBufferToBase64(imageData),
      crops,
    })

    page.status = 'extracted'
    page.errorMessage = null
    page.hasExtraction = true
    page.extractionMeta = {
      documentType: result.documentType,
      columns: result.columns,
      visibleRecordCount: result.visibleRecordCount,
      warnings: result.warnings,
    }

    // Replace stored fields for this page (re-extraction = fresh, verified state)
    const allFields = await getFields(c.env.KV, jobId)
    const kept = allFields.filter((f) => f.pageIndex !== page.order)
    const created: FieldView[] = []
    result.rows.forEach((row, ri) => {
      row.cells.forEach((cell, ci) => {
        const missing = cell.value === null || cell.value === ''
        created.push({
          id: `${jobId}~${ri}~${ci}`,
          pageIndex: page.order,
          rowIndex: ri,
          columnName: cell.column,
          value: cell.value ?? '',
          confidence: cell.confidence,
          uncertain: cell.uncertain || missing,
          missing,
          alternatives: cell.alternatives ?? [],
          bbox: cell.bbox ?? null,
          reason: missing ? cell.reason ?? 'unreadable or missing' : cell.reason ?? null,
          edited: false,
          duplicate: false,
        })
      })
    })
    const merged = applyDuplicateFlags([...kept, ...created]).fields
    await putFields(c.env.KV, jobId, merged)

    // Job status transitions (a blocked/failed page counts as "done" for the batch)
    const allDone = pages.every((p) => ['extracted', 'failed', 'blocked'].includes(p.status))
    job.status = allDone ? 'review' : 'extracting'
    job.updatedAt = nowIso()
    await putPages(c.env.KV, jobId, pages)
    await putJob(c.env.KV, job)
    await recomputeJobSummary(c.env.KV, job)

    const report = computeReport(pages, merged)
    return c.json({
      pageId: id,
      rows: result.rows.length,
      columns: result.columns,
      documentType: result.documentType,
      visibleRecordCount: result.visibleRecordCount,
      warnings: result.warnings,
      reportSummary: report.summary,
    })
  } catch (err) {
    page.status = 'failed'
    page.errorMessage = (err as Error).message
    await putPages(c.env.KV, jobId, pages)
    return c.json({ error: `Extraction failed: ${(err as Error).message}` }, 500)
  }
})

/* ================= Fields (human verification) ================= */

// PATCH /api/fields/[id] — correct a value or accept an alternative.
// Field ids are "{jobId}~{row}~{cell}" so the owning job resolves in O(1).
app.patch('/api/fields/:id', async (c) => {
  const id = c.req.param('id')
  const jobId = id.split('~')[0]
  const fields = await getFields(c.env.KV, jobId)
  const field = fields.find((f) => f.id === id)
  if (!field) return c.json({ error: 'Field not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  if (typeof body.value === 'string') {
    const v = body.value
    field.value = v
    field.uncertain = false
    field.missing = v.trim() === ''
    field.reason = v.trim() === '' ? field.reason : null
  } else if (typeof body.acceptAlternative === 'string') {
    field.value = body.acceptAlternative
    field.uncertain = false
    field.missing = false
    field.reason = null
  }
  field.edited = true

  const merged = applyDuplicateFlags(fields).fields
  await putFields(c.env.KV, jobId, merged)
  const job = await getJob(c.env.KV, jobId)
  if (job) await recomputeJobSummary(c.env.KV, job)

  const updated = merged.find((f) => f.id === id)!
  return c.json({
    field: {
      id: updated.id,
      value: updated.value,
      uncertain: updated.uncertain,
      missing: updated.missing,
      edited: updated.edited,
    },
  })
})

/* ================= Exports ================= */

// POST /api/jobs/[id]/export — generate the final document
// body: { format, templateId?, columns? }
const FORMATS = ['xlsx', 'csv', 'pdf', 'docx', 'txt', 'json'] as const

app.post('/api/jobs/:id/export', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const format = String(body.format || 'xlsx')
  if (!FORMATS.includes(format as (typeof FORMATS)[number])) {
    return c.json({ error: `Unsupported format: ${format}` }, 400)
  }

  const [job, pages, fields] = await Promise.all([getJob(c.env.KV, id), getPages(c.env.KV, id), getFields(c.env.KV, id)])
  if (!job) return c.json({ error: 'Job not found' }, 404)
  if (!fields.length) return c.json({ error: 'Nothing to export yet — run extraction first.' }, 400)

  // Assemble records: page order preserved, then row order
  const byRecord = new Map<string, FieldView[]>()
  for (const f of fields) {
    const k = `${f.pageIndex}:${f.rowIndex}`
    const arr = byRecord.get(k) ?? []
    arr.push(f)
    byRecord.set(k, arr)
  }
  const sortedKeys = [...byRecord.keys()].sort((a, b) => {
    const [pa, ra] = a.split(':').map(Number)
    const [pb, rb] = b.split(':').map(Number)
    return pa - pb || ra - rb
  })

  // Column selection: explicit list > template columns > first-appearance order
  let columns: string[] = []
  let templateBytes: ArrayBuffer | null = null
  if (body.templateId) {
    const templates = await getTemplatesIndex(c.env.KV)
    const tpl = templates.find((t) => t.id === String(body.templateId))
    if (!tpl) return c.json({ error: 'Template not found' }, 404)
    if (tpl.type === 'columns' && tpl.columns) {
      const extra = fields.map((f) => f.columnName).filter((col, i, arr) => arr.indexOf(col) === i && !tpl.columns!.some((t) => t.toLowerCase() === col.toLowerCase()))
      columns = [...tpl.columns, ...extra]
    } else if (tpl.type === 'xlsx') {
      templateBytes = await getTemplateData(c.env.KV, tpl.id)
      if (tpl.headers) {
        const extra = fields.map((f) => f.columnName).filter((col, i, arr) => arr.indexOf(col) === i && !tpl.headers!.some((t) => t.toLowerCase() === col.toLowerCase()))
        columns = [...tpl.headers, ...extra]
      }
    }
  }
  if (Array.isArray(body.columns) && body.columns.length) {
    const chosen = body.columns.map(String)
    const extra = fields.map((f) => f.columnName).filter((col, i, arr) => arr.indexOf(col) === i && !chosen.includes(col))
    columns = [...chosen, ...extra]
  }
  if (!columns.length) {
    for (const f of fields) if (!columns.includes(f.columnName)) columns.push(f.columnName)
  }

  const records: ExportRecordRow[] = sortedKeys.map((k) => {
    const arr = byRecord.get(k)!
    const [pi, ri] = k.split(':').map(Number)
    const values: Record<string, string> = {}
    for (const col of columns) {
      const f = arr.find((x) => x.columnName === col)
      values[col] = f ? f.value ?? '' : ''
    }
    return { pageIndex: pi, rowIndex: ri, values }
  })

  const report = computeReport(pages, fields)
  const input: ExportInput = {
    title: job.title,
    columns,
    records,
    reportSummary: report.summary,
  }

  try {
    let data: Uint8Array
    let mime: string
    let ext: string
    switch (format) {
      case 'xlsx':
        data = new Uint8Array(buildXlsx(input, templateBytes))
        mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ext = 'xlsx'
        break
      case 'csv':
        data = new TextEncoder().encode(buildCsv(input))
        mime = 'text/csv'
        ext = 'csv'
        break
      case 'pdf':
        data = await buildPdf(input)
        mime = 'application/pdf'
        ext = 'pdf'
        break
      case 'docx':
        data = new Uint8Array(await buildDocx(input))
        mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ext = 'docx'
        break
      case 'txt':
        data = new TextEncoder().encode(buildTxt(input))
        mime = 'text/plain'
        ext = 'txt'
        break
      case 'json':
        data = new TextEncoder().encode(
          buildJson(input, {
            mode: job.mode,
            instructions: job.instructions,
            pages: report.pages,
            duplicates: report.duplicateRowIndexes,
          })
        )
        mime = 'application/json'
        ext = 'json'
        break
      default:
        throw new Error('unreachable')
    }

    const safeTitle = job.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'extraction'
    const fileName = `${safeTitle}.${ext}`
    const exportId = `${id}~${uid()}`
    const createdAt = nowIso()
    await putExportData(c.env.KV, exportId, data)

    const rec: ExportMetaRecord = { id: exportId, format, fileName, rows: records.length, jobId: id, jobTitle: job.title, createdAt }
    const jobExports = await getJobExports(c.env.KV, id)
    jobExports.push(rec)
    await putJobExports(c.env.KV, id, jobExports)
    await upsertExportsIndex(c.env.KV, rec)

    job.status = 'exported'
    job.updatedAt = createdAt
    await putJob(c.env.KV, job)
    await recomputeJobSummary(c.env.KV, job)

    return c.json({
      export: { id: rec.id, format, fileName, rows: rec.rows, createdAt },
      columnsUsed: columns,
    })
  } catch (err) {
    return c.json({ error: `Export generation failed: ${(err as Error).message}` }, 500)
  }
})

// GET /api/exports — recent exports (dashboard)
app.get('/api/exports', async (c) => {
  const exports = await getExportsIndex(c.env.KV)
  return c.json({ exports })
})

// GET /api/exports/[id]/download — download the generated file
app.get('/api/exports/:id/download', async (c) => {
  const id = c.req.param('id')
  const jobId = id.split('~')[0]
  const rec = (await getJobExports(c.env.KV, jobId)).find((e) => e.id === id)
  if (!rec) return c.json({ error: 'Export not found' }, 404)
  const data = await getExportData(c.env.KV, id)
  if (!data) return c.json({ error: 'Export not found' }, 404)

  const mimes: Record<string, string> = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    json: 'application/json',
  }
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': mimes[rec.format] ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${rec.fileName}"`,
      'Content-Length': String(data.byteLength),
    },
  })
})

// DELETE /api/exports/[id] — user-controlled deletion of generated files
app.delete('/api/exports/:id', async (c) => {
  const id = c.req.param('id')
  const jobId = id.split('~')[0]
  const recs = await getJobExports(c.env.KV, jobId)
  const rec = recs.find((e) => e.id === id)
  if (!rec) return c.json({ error: 'Export not found' }, 404)
  await putJobExports(c.env.KV, jobId, recs.filter((e) => e.id !== id))
  await deleteKey(c.env.KV, `exportdata:${id}`)
  await removeExportEverywhere(c.env.KV, id)
  const job = await getJob(c.env.KV, jobId)
  if (job) await recomputeJobSummary(c.env.KV, job)
  return c.json({ ok: true })
})

/* ================= Templates ================= */

// GET /api/templates — saved templates (dashboard + export view)
app.get('/api/templates', async (c) => {
  const templates = await getTemplatesIndex(c.env.KV)
  return c.json({ templates })
})

// POST /api/templates — create a template
// FormData: type = "xlsx" (file) | "columns" (name, columns JSON array)
app.post('/api/templates', async (c) => {
  const form = await c.req.formData()
  const type = String(form.get('type') || 'columns')

  if (type === 'xlsx') {
    const file = form.get('file')
    if (!(file instanceof File)) return c.json({ error: 'Missing .xlsx file' }, 400)
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      return c.json({ error: 'Template must be an .xlsx file' }, 400)
    }
    try {
      const bytes = await file.arrayBuffer()
      const wb = XLSX.read(bytes, { type: 'array' })
      // Detect header row in the first sheet: first row (within 6) with >= 2 named cells
      let headers: string[] = []
      for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, blankrows: true, defval: '' })
        const limit = Math.min(6, rows.length)
        for (let r = 0; r < limit; r++) {
          const cells = (rows[r] ?? []).map((v) => (v == null ? '' : String(v).trim())).filter(Boolean)
          if (cells.length >= 2) {
            headers = cells
            break
          }
        }
        if (headers.length) break
      }
      if (!headers.length) {
        return c.json({ error: 'No header row detected in the template (need a row with at least 2 named columns).' }, 400)
      }
      const id = uid()
      await putTemplateData(c.env.KV, id, bytes)
      const templates = await getTemplatesIndex(c.env.KV)
      const item: TemplateItem = {
        id,
        name: String(form.get('name') || file.name.replace(/\.xlsx$/i, '')),
        type: 'xlsx',
        fileName: file.name,
        headers,
        createdAt: nowIso(),
      }
      templates.unshift(item)
      await putTemplatesIndex(c.env.KV, templates)
      return c.json({ template: { id, name: item.name, type: item.type, headers } })
    } catch (err) {
      return c.json({ error: `Could not read template: ${(err as Error).message}` }, 400)
    }
  }

  if (type === 'columns') {
    const name = String(form.get('name') || '').trim()
    let columns: string[] = []
    try {
      const raw = form.get('columns')
      columns = JSON.parse(String(raw ?? '[]'))
      columns = columns.map((col) => String(col).trim()).filter(Boolean)
    } catch {
      return c.json({ error: 'columns must be a JSON array of strings' }, 400)
    }
    if (!name) return c.json({ error: 'Template name is required' }, 400)
    if (columns.length < 1) return c.json({ error: 'At least one column is required' }, 400)
    const id = uid()
    const templates = await getTemplatesIndex(c.env.KV)
    const item: TemplateItem = { id, name, type: 'columns', columns, createdAt: nowIso() }
    templates.unshift(item)
    await putTemplatesIndex(c.env.KV, templates)
    return c.json({ template: { id, name, type, columns } })
  }

  return c.json({ error: 'Unknown template type' }, 400)
})

// DELETE /api/templates/[id]
app.delete('/api/templates/:id', async (c) => {
  const id = c.req.param('id')
  const templates = await getTemplatesIndex(c.env.KV)
  const tpl = templates.find((t) => t.id === id)
  if (!tpl) return c.json({ error: 'Template not found' }, 404)
  await putTemplatesIndex(c.env.KV, templates.filter((t) => t.id !== id))
  await deleteKey(c.env.KV, `tpldata:${id}`)
  return c.json({ ok: true })
})

/* ================= Static SPA hosting ================= */

// Everything that is not /api/* is served by the static asset bundle
// (the exported Next.js SPA). The ASSETS binding applies the configured
// SPA fallback (not_found_handling = single-page-application).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
