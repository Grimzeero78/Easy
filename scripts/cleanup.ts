import { db } from '../src/lib/db'
async function main() {
  await db.field.deleteMany({})
  await db.page.deleteMany({})
  await db.exportRecord.deleteMany({})
  await db.job.deleteMany({})
  await db.template.deleteMany({})
  console.log('database cleaned')
  process.exit(0)
}
main()
