import { db } from '../src/lib/db'
async function main() {
  const f = await db.field.findFirst({ where: { columnName: 'No.', rowIndex: 0 } })
  if (!f) throw new Error('not found')
  await db.field.update({ where: { id: f.id }, data: { value: '1', edited: false, uncertain: false, missing: false, reason: null } })
  console.log('fixed No. field back to 1')
  process.exit(0)
}
main()
