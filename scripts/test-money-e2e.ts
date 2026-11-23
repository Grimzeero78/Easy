/**
 * E2E test for the money-summation feature against the running dev server.
 * Flow: cashier job -> upload cash-sheet.png -> AI extraction ->
 *       verify report.moneyTotals -> export csv/xlsx -> check TOTAL row.
 * Run: bun scripts/test-money-e2e.ts
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
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 400)}`)
  return json as Record<string, unknown>
}

async function main() {
  const fs = await import('fs')

  const job = (
    await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cash sheet totals test', mode: 'cashier' }),
    })
  ) as { job: { id: string } }
  console.log('job:', job.job.id)

  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync('/home/z/my-project/scripts/testdocs/cash-sheet.png')], { type: 'image/png' }), 'cash-sheet.png')
  form.append('fileName', 'cash-sheet.png')
  const up = (await api(`/api/jobs/${job.job.id}/pages`, { method: 'POST', body: form })) as {
    page: { id: string; status: string; quality: { verdict: string } }
  }
  console.log('page:', up.page.id, 'status:', up.page.status, 'quality:', up.page.quality.verdict)
  if (up.page.status === 'blocked') throw new Error('quality gate blocked the test document')

  await api(`/api/jobs/${job.job.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instructions: 'Extract every transaction: transaction ID, customer name and the amount of money paid. Keep amounts exactly as written including currency.',
    }),
  })

  const t0 = Date.now()
  const ex = (await api(`/api/pages/${up.page.id}/extract`, { method: 'POST' })) as {
    rows: number
    columns: string[]
    documentType: string
  }
  console.log(`extracted in ${((Date.now() - t0) / 1000).toFixed(1)}s rows=${ex.rows} columns=`, ex.columns, 'docType=', ex.documentType)

  const detail = (await api(`/api/jobs/${job.job.id}`)) as {
    fields: { value: string | null; columnName: string }[]
    report: {
      moneyTotals: {
        columns: { columnIndex: number; columnName: string; total: number; formatted: string; countedValues: number }[]
        grandTotal: number | null
        formattedGrandTotal: string | null
        warnings: string[]
      } | null
      summary: string[]
    }
  }

  console.log('\n--- money totals in report ---')
  const mt = detail.report.moneyTotals
  if (!mt || mt.columns.length === 0) {
    console.log('NO money totals detected. fields sample:', detail.fields.slice(0, 12))
    console.log('summary:', detail.report.summary)
    throw new Error('moneyTotals missing from report')
  }
  for (const c of mt.columns) {
    console.log(`Column ${c.columnIndex} "${c.columnName}": ${c.formatted} (${c.countedValues} values)`)
  }
  console.log('grand total:', mt.formattedGrandTotal)
  if (mt.warnings.length) console.log('warnings:', mt.warnings)

  const moneyLines = detail.report.summary.filter((s) => s.includes('Money total') || s.includes('GRAND TOTAL'))
  console.log('summary money lines:', moneyLines)
  if (!moneyLines.length) throw new Error('summary lacks money-total lines')

  console.log('\n--- exports with TOTAL row ---')
  const csvExp = (
    await api(`/api/jobs/${job.job.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'csv' }),
    })
  ) as { export: { id: string; fileName: string } }
  const dl = await fetch(`${BASE}/api/exports/${csvExp.export.id}/download`)
  const csvText = await dl.text()
  console.log('csv:\n' + csvText)
  if (!csvText.includes('TOTAL')) throw new Error('csv missing TOTAL row')

  const xlsxExp = (
    await api(`/api/jobs/${job.job.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'xlsx' }),
    })
  ) as { export: { id: string } }
  const xBuf = Buffer.from(await (await fetch(`${BASE}/api/exports/${xlsxExp.export.id}/download`)).arrayBuffer())
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(xBuf)
  const ws = wb.worksheets[0]
  console.log('xlsx last rows:')
  for (let r = Math.max(1, ws.rowCount - 2); r <= ws.rowCount; r++) {
    console.log('  row', r, ':', [1, 2, 3, 4].map((c) => JSON.stringify(ws.getCell(r, c).value)).join(' '))
  }
  const totalCell = ws.getCell(ws.rowCount, 1).value
  if (String(totalCell).trim() !== 'TOTAL') throw new Error(`xlsx missing TOTAL row (found ${JSON.stringify(totalCell)})`)

  // cleanup
  await api(`/api/jobs/${job.job.id}`, { method: 'DELETE' })
  console.log('\nE2E MONEY TOTALS: ALL CHECKS PASSED (job cleaned up)')
}

main().catch((err) => {
  console.error('E2E FAILED:', err)
  process.exit(1)
})
