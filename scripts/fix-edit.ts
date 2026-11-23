import { db } from '../src/lib/db'
async function main() {
  await db.field.updateMany({ where: { columnName: 'Quantity', value: { contains: 'verified' } }, data: { value: '24', edited: false } })
  console.log('restored')
  process.exit(0)
}
main()
