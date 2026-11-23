import { db } from '../src/lib/db'
const BASE = 'http://localhost:3000'
async function main() {
  const page = await db.page.findFirst({ where: { status: 'blocked' }, orderBy: { createdAt: 'desc' } })
  if (!page) throw new Error('no blocked page')
  const res = await fetch(`${BASE}/api/pages/${page.id}/extract`, { method: 'POST' })
  const data = await res.json()
  console.log('extract blocked page → HTTP', res.status, ':', data.error?.slice(0, 110))
  process.exit(0)
}
main()
