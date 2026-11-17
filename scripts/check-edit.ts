import { db } from '../src/lib/db'
async function main() {
  const f = await db.field.findFirst({ where: { columnName: 'Quantity', value: { contains: 'verified' } } })
  console.log('saved field:', f ? `value="${f.value}" edited=${f.edited} uncertain=${f.uncertain}` : 'NOT FOUND')
  process.exit(0)
}
main()
