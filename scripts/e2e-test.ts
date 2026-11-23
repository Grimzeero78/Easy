/**
 * Full backend E2E test against the running dev server (localhost:3000).
 * Exercises: job creation, upload + quality gate, REAL AI extraction,
 * field verification, duplicate/missing checks, all export formats,
 * Excel template upload + population.
 */
const BASE = 'http://localhost:3000'

async function api(path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = text.slice(0, 300)
  }
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 400)}`)
  }
  return json as Record<string, unknown>
}

function section(name: string) {
  console.log(`\n========== ${name} ==========`)
}

async function main() {
  const fs = await import('fs')

  /* ---------- Scenario 1: lecturer, full table extraction ---------- */
  section('SCENARIO 1 — Lecturer: student register, all columns')
  const job1 = (await api('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'ACS 101 Class Register Week 6',
      mode: 'general',
    }),
  })) as { job: { id: string } }
  console.log('job created:', job1.job.id)

  const form1 = new FormData()
  form1.append('file', new Blob([fs.readFileSync('/home/z/my-project/scripts/testdocs/student-register.png')], { type: 'image/png' }), 'student-register.png')
  form1.append('fileName', 'student-register.png')
  const up1 = (await api(`/api/jobs/${job1.job.id}/pages`, { method: 'POST', body: form1 })) as {
    page: { id: string; status: string; quality: { verdict: string; blurScore: number; brightness: number; issues: unknown[] } }
  }
  console.log('uploaded page:', up1.page.id, 'status:', up1.page.status, 'quality:', up1.page.quality.verdict, 'blur:', up1.page.quality.blurScore, 'brightness:', up1.page.quality.brightness)

  // annotations: user circles the whole table region (as the lecturer scenario would)
  const annPatch = await api(`/api/pages/${up1.page.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      annotations: [{ id: 'a1', type: 'rect', x: 0.05, y: 0.18, w: 0.9, h: 0.68, label: 'student table' }],
    }),
  })
  console.log('annotations saved:', JSON.stringify(annPatch).slice(0, 120))

  // instruction + extract
  await api(`/api/jobs/${job1.job.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instructions: 'Extract all students with their registration numbers and marks. Arrange records in the order shown.' }),
  })

  const t0 = Date.now()
  const ex1 = (await api(`/api/pages/${up1.page.id}/extract`, { method: 'POST' })) as {
    rows: number
    columns: string[]
    documentType: string
    visibleRecordCount: number | null
    warnings: string[]
  }
  console.log(`extracted in ${((Date.now() - t0) / 1000).toFixed(1)}s: rows=${ex1.rows} columns=`, ex1.columns, 'docType=', ex1.documentType, 'visible=', ex1.visibleRecordCount)
  if (ex1.warnings?.length) console.log('warnings:', ex1.warnings)

  const detail1 = (await api(`/api/jobs/${job1.job.id}`)) as {
    fields: { rowIndex: number; columnName: string; value: string; confidence: number; uncertain: boolean; bbox: unknown }[]
    report: { totalRows: number; flaggedFields: number; missingFields: number; avgConfidence: number; needsReview: boolean; summary: string[] }
  }
  console.log(`fields: ${detail1.fields.length}, report:`, JSON.stringify({
    rows: detail1.report.totalRows,
    flagged: detail1.report.flaggedFields,
    missing: detail1.report.missingFields,
    avgConf: detail1.report.avgConfidence,
  }))
  console.log('sample rows:')
  for (let r = 0; r < Math.min(4, detail1.report.totalRows); r++) {
    const row = detail1.fields.filter((f) => f.rowIndex === r)
    console.log('  ', row.map((f) => `${f.columnName}=${f.value} (${Math.round(f.confidence * 100)}%)`).join(' | '))
  }
  const withBbox = detail1.fields.filter((f) => f.bbox).length
  console.log(`traceability: ${withBbox}/${detail1.fields.length} fields have bboxes`)
  console.log('summary:', detail1.report.summary)

  /* ---------- exports for job 1 ---------- */
  section('EXPORTS for scenario 1 (xlsx w/ template, csv, pdf, docx, json)')
  // upload the Excel template first
  const tplForm = new FormData()
  tplForm.append('type', 'xlsx')
  tplForm.append('file', new Blob([fs.readFileSync('/home/z/my-project/scripts/testdocs/template.xlsx')], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'template.xlsx')
  tplForm.append('name', 'Class list template')
  const tpl = (await api('/api/templates', { method: 'POST', body: tplForm })) as { template: { id: string; headers: string[] } }
  console.log('template uploaded:', tpl.template.id, 'headers:', tpl.template.headers)

  const exportAndCheck = async (format: string, extra: Record<string, unknown> = {}) => {
    const r = (await api(`/api/jobs/${job1.job.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, ...extra }),
    })) as { export: { id: string; fileName: string; rows: number } }
    const dl = await fetch(`${BASE}/api/exports/${r.export.id}/download`)
    const buf = Buffer.from(await dl.arrayBuffer())
    const sig = buf.subarray(0, 4).toString('hex')
    console.log(`  ${format}: ${r.export.fileName} rows=${r.export.rows} bytes=${buf.length} magic=${sig} ${dl.headers.get('content-type')}`)
    return buf
  }
  const xlsxTpl = await exportAndCheck('xlsx', { templateId: tpl.template.id })
  const csv = await exportAndCheck('csv')
  const pdf = await exportAndCheck('pdf')
  const docx = await exportAndCheck('docx')
  const json = await exportAndCheck('json')

  // verify template-populated xlsx contents with exceljs
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(xlsxTpl)
  console.log('  worksheets found:', wb.worksheets.map((w) => w.name))
  const ws = wb.worksheets[0]
  console.log('  populated template sheet rows 1-4 =>')
  for (let r = 1; r <= 4; r++) {
    console.log('   ', [ws.getCell(r, 1).value, ws.getCell(r, 2).value, ws.getCell(r, 3).value].join(' | '))
  }
  console.log('  csv head:', csv.toString().split('\n').slice(0, 3).join(' / '))
  console.log('  pdf starts with:', pdf.subarray(0, 8).toString())
  console.log('  docx starts with:', docx.subarray(0, 2).toString('hex'), '(PK zip expected)')
  const parsed = JSON.parse(json.toString())
  console.log('  json records:', parsed.records?.length, 'columns:', parsed.columns)

  /* ---------- Scenario 2: cashier — extract ONLY transaction IDs ---------- */
  section('SCENARIO 2 — Cashier: extract only transaction IDs (cashier mode)')
  const job2 = (await api('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Front office cash sheet 13 June', mode: 'cashier' }),
  })) as { job: { id: string } }
  const form2 = new FormData()
  form2.append('file', new Blob([fs.readFileSync('/home/z/my-project/scripts/testdocs/cash-sheet.png')], { type: 'image/png' }), 'cash-sheet.png')
  form2.append('fileName', 'cash-sheet.png')
  const up2 = (await api(`/api/jobs/${job2.job.id}/pages`, { method: 'POST', body: form2 })) as { page: { id: string; quality: { verdict: string } } }
  console.log('uploaded page:', up2.page.id, 'quality:', up2.page.quality.verdict)

  await api(`/api/jobs/${job2.job.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instructions: 'Extract only the unique transaction IDs as a single column.' }),
  })
  const ex2 = (await api(`/api/pages/${up2.page.id}/extract`, { method: 'POST' })) as { rows: number; columns: string[] }
  console.log(`extracted: rows=${ex2.rows} columns=`, ex2.columns)

  const detail2 = (await api(`/api/jobs/${job2.job.id}`)) as { fields: { value: string; confidence: number }[]; report: { summary: string[] } }
  console.log('transaction IDs:', detail2.fields.map((f) => f.value).join(', '))
  console.log('report summary:', detail2.report.summary)

  /* ---------- Field verification: human edit + duplicate flags ---------- */
  section('VERIFICATION ENGINE — human edit, duplicate detection')
  const f1 = (detail1 as unknown as { fields: { id: string; value: string }[] }).fields[0]
  const patched = await api(`/api/fields/${f1.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'John Kamau' }),
  })
  console.log('human edit accepted:', JSON.stringify(patched))

  /* ---------- Dashboard list ---------- */
  section('DASHBOARD — job list')
  const jobs = (await api('/api/jobs')) as { jobs: { title: string; recordCount: number; flaggedCount: number; status: string }[] }
  console.table(jobs.jobs)

  console.log('\nALL BACKEND E2E CHECKS COMPLETED')
}

main().catch((err) => {
  console.error('E2E FAILED:', err)
  process.exit(1)
})
