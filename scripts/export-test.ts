import { db } from '../src/lib/db'
const BASE = 'http://localhost:3000'
async function main() {
  const tpl = await db.template.findFirst({ where: { type: 'xlsx' }, orderBy: { createdAt: 'desc' } })
  const job = await db.job.findFirst({ where: { fields: { some: {} } }, orderBy: { updatedAt: 'desc' } })
  if (!tpl || !job) throw new Error('missing template or extracted job')
  console.log('using job:', job.title, 'template:', tpl.name)
  const res = await fetch(`${BASE}/api/jobs/${job.id}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'xlsx', templateId: tpl.id }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(JSON.stringify(data))
  console.log('export ok:', data.export.fileName, 'rows:', data.export.rows)
  const dl = await fetch(`${BASE}/api/exports/${data.export.id}/download`)
  const buf = Buffer.from(await dl.arrayBuffer())
  const fs = await import('fs')
  fs.writeFileSync('/tmp/tpl-export.xlsx', buf)
  console.log('saved /tmp/tpl-export.xlsx bytes=', buf.length)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
