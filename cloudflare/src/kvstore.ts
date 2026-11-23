import type {
  ExportListItem,
  ExportMetaRecord,
  FieldView,
  JobListItem,
  JobRecord,
  PageRecord,
  TemplateItem,
} from './types'

/**
 * KV data layer.
 *
 * Layout (single namespace, prefixed keys):
 *   job:{id}              -> JobRecord
 *   jobpages:{jobId}      -> PageRecord[]           (ordered)
 *   pagedata:{pageId}:orig -> original image bytes
 *   pagedata:{pageId}:enh  -> enhanced image bytes
 *   jobfields:{jobId}     -> FieldView[]            (all cells of the job in one key)
 *   jobexports:{jobId}    -> ExportMetaRecord[]
 *   exportdata:{exportId} -> generated file bytes   (exportId = "{jobId}~{uuid}")
 *   tpldata:{tplId}       -> uploaded template bytes
 *   jobs:index            -> JobListItem[]          (dashboard list, denormalized)
 *   exports:index         -> ExportListItem[]       (30 most recent)
 *   tpl:index             -> TemplateItem[]
 *
 * Composite ids ("{jobId}~...") make every request resolve its owner in O(1)
 * KV reads — no lookup tables, no list scans.
 */

export interface Env {
  KV: KVNamespace
  AI: Ai
  ASSETS: Fetcher
  VISION_MODEL: string
}

const JOB = (id: string) => `job:${id}`
const PAGES = (jobId: string) => `jobpages:${jobId}`
const PAGE_DATA = (pageId: string, variant: 'orig' | 'enh') => `pagedata:${pageId}:${variant}`
const FIELDS = (jobId: string) => `jobfields:${jobId}`
const JOB_EXPORTS = (jobId: string) => `jobexports:${jobId}`
const EXPORT_DATA = (exportId: string) => `exportdata:${exportId}`
const TPL_DATA = (tplId: string) => `tpldata:${tplId}`
const JOBS_INDEX = 'jobs:index'
const EXPORTS_INDEX = 'exports:index'
const TPL_INDEX = 'tpl:index'

export async function getJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  return (await kv.get(key, 'json')) as T | null
}

export async function putJson(kv: KVNamespace, key: string, value: unknown): Promise<void> {
  await kv.put(key, JSON.stringify(value))
}

/* ---------- jobs ---------- */

export async function getJob(kv: KVNamespace, id: string): Promise<JobRecord | null> {
  return getJson<JobRecord>(kv, JOB(id))
}

export async function putJob(kv: KVNamespace, job: JobRecord): Promise<void> {
  await putJson(kv, JOB(job.id), job)
}

export async function getPages(kv: KVNamespace, jobId: string): Promise<PageRecord[]> {
  return (await getJson<PageRecord[]>(kv, PAGES(jobId))) ?? []
}

export async function putPages(kv: KVNamespace, jobId: string, pages: PageRecord[]): Promise<void> {
  await putJson(kv, PAGES(jobId), pages)
}

export async function getFields(kv: KVNamespace, jobId: string): Promise<FieldView[]> {
  return (await getJson<FieldView[]>(kv, FIELDS(jobId))) ?? []
}

export async function putFields(kv: KVNamespace, jobId: string, fields: FieldView[]): Promise<void> {
  await putJson(kv, FIELDS(jobId), fields)
}

export async function getJobExports(kv: KVNamespace, jobId: string): Promise<ExportMetaRecord[]> {
  return (await getJson<ExportMetaRecord[]>(kv, JOB_EXPORTS(jobId))) ?? []
}

export async function putJobExports(kv: KVNamespace, jobId: string, exports: ExportMetaRecord[]): Promise<void> {
  await putJson(kv, JOB_EXPORTS(jobId), exports)
}

/* ---------- binary payloads ---------- */

export async function putPageImage(
  kv: KVNamespace,
  pageId: string,
  variant: 'orig' | 'enh',
  data: ArrayBuffer
): Promise<void> {
  await kv.put(PAGE_DATA(pageId, variant), data)
}

export async function getPageImage(
  kv: KVNamespace,
  pageId: string,
  variant: 'orig' | 'enh'
): Promise<ArrayBuffer | null> {
  return await kv.get(PAGE_DATA(pageId, variant), 'arrayBuffer')
}

export async function putExportData(kv: KVNamespace, exportId: string, data: ArrayBuffer | Uint8Array): Promise<void> {
  await kv.put(EXPORT_DATA(exportId), data)
}

export async function getExportData(kv: KVNamespace, exportId: string): Promise<ArrayBuffer | null> {
  return await kv.get(EXPORT_DATA(exportId), 'arrayBuffer')
}

export async function putTemplateData(kv: KVNamespace, tplId: string, data: ArrayBuffer): Promise<void> {
  await kv.put(TPL_DATA(tplId), data)
}

export async function getTemplateData(kv: KVNamespace, tplId: string): Promise<ArrayBuffer | null> {
  return await kv.get(TPL_DATA(tplId), 'arrayBuffer')
}

export async function deleteKey(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key)
}

/* ---------- indexes ---------- */

export async function getJobsIndex(kv: KVNamespace): Promise<JobListItem[]> {
  return (await getJson<JobListItem[]>(kv, JOBS_INDEX)) ?? []
}

export async function getExportsIndex(kv: KVNamespace): Promise<ExportListItem[]> {
  return (await getJson<ExportListItem[]>(kv, EXPORTS_INDEX)) ?? []
}

export async function getTemplatesIndex(kv: KVNamespace): Promise<TemplateItem[]> {
  return (await getJson<TemplateItem[]>(kv, TPL_INDEX)) ?? []
}

/**
 * Recompute the denormalized dashboard summary for one job from its pages,
 * fields and exports, then refresh both indexes. Kept O(1) KV reads so every
 * mutation stays well inside the free-plan subrequest budget.
 */
export async function recomputeJobSummary(kv: KVNamespace, job: JobRecord): Promise<JobListItem> {
  const [pages, fields, jobExports] = await Promise.all([getPages(kv, job.id), getFields(kv, job.id), getJobExports(kv, job.id)])

  const recordKeys = new Set(fields.map((f) => `${f.pageIndex}:${f.rowIndex}`))
  const flaggedCount = fields.filter((f) => (f.uncertain || f.missing) && !f.edited).length

  const item: JobListItem = {
    id: job.id,
    title: job.title,
    mode: job.mode,
    status: job.status,
    pageCount: pages.length,
    extractedPages: pages.filter((p) => p.status === 'extracted').length,
    recordCount: recordKeys.size,
    flaggedCount,
    exportCount: jobExports.length,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }

  const index = (await getJobsIndex(kv)).filter((j) => j.id !== job.id)
  index.push(item)
  index.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  await putJson(kv, JOBS_INDEX, index.slice(0, 100))
  return item
}

export async function removeJobFromIndex(kv: KVNamespace, jobId: string): Promise<void> {
  const index = (await getJobsIndex(kv)).filter((j) => j.id !== jobId)
  await putJson(kv, JOBS_INDEX, index)
}

export async function upsertExportsIndex(kv: KVNamespace, rec: ExportMetaRecord): Promise<void> {
  const index = (await getExportsIndex(kv)).filter((e) => e.id !== rec.id)
  index.unshift({ id: rec.id, format: rec.format, fileName: rec.fileName, rows: rec.rows, jobTitle: rec.jobTitle, createdAt: rec.createdAt })
  await putJson(kv, EXPORTS_INDEX, index.slice(0, 30))
}

export async function removeExportEverywhere(kv: KVNamespace, exportId: string): Promise<void> {
  const index = (await getExportsIndex(kv)).filter((e) => e.id !== exportId)
  await putJson(kv, EXPORTS_INDEX, index)
}

export async function putTemplatesIndex(kv: KVNamespace, templates: TemplateItem[]): Promise<void> {
  await putJson(kv, TPL_INDEX, templates)
}
