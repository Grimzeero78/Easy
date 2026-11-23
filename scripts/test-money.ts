/**
 * Unit tests for the money engine + exporter TOTAL-row integration.
 * Run: bun scripts/test-money.ts
 */
import { parseMoney, computeMoneyTotals, formatMoney, type MoneyRecord } from '../src/lib/money'
import { buildCsv, buildTxt, buildJson, buildXlsx, buildPdf, buildDocx, type ExportInput } from '../src/lib/exporters'
import type { MoneyTotals } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`, extra ?? '')
  }
}

/* ---------- 1. parseMoney battery ---------- */
console.log('\n== parseMoney ==')
const cases: [string | null, number | null, string | null][] = [
  ['1,234.56', 1234.56, null],
  ['KSh 1,500', 1500, 'KES'],
  ['ksh.1500', 1500, 'KES'],
  ['1500/=', 1500, null],
  ['1500/-', 1500, null],
  ['$1,200.50', 1200.5, 'USD'],
  ['EUR 99', 99, 'EUR'],
  ['€5', 5, 'EUR'],
  ['(1,200.00)', -1200, null],
  ['-250', -250, null],
  ['250.00 ksh', 250, 'KES'],
  ['TZS 3000', 3000, 'TZS'],
  ['UGX 50,000', 50000, 'UGX'],
  ['KES 0.00', 0, 'KES'],
  ['R 100', null, null], // single-letter currency deliberately ambiguous -> rejected
  ['12/05/2024', null, null], // date
  ['12.05.2024', null, null], // dotted date
  ['0722 123 456', null, null], // phone
  ['0700456123', null, null], // long account/phone
  ['R-001', null, null], // receipt id
  ['ACS001', null, null],
  ['unreadable', null, null],
  ['', null, null],
  [null, null, null],
  ['   ', null, null],
  ['2024', 2024, null], // parseable, weak (not strong)
  ['1 500,00', 1500, null],
  ['KSh -100', -100, 'KES'],
]
for (const [input, expectVal, expectCur] of cases) {
  const m = parseMoney(input)
  const okVal = expectVal === null ? m === null : m != null && m.value === expectVal
  const okCur = expectCur === null ? m === null || m.currency === null : m != null && m.currency === expectCur
  check(`parse ${JSON.stringify(input)} -> ${expectVal}${expectCur ? ' ' + expectCur : ''}`, okVal && okCur, m)
}
check('2024 is weak evidence', parseMoney('2024')?.strong === false)
check('$1,200.50 is strong', parseMoney('$1,200.50')?.strong === true)

/* ---------- 2. computeMoneyTotals on a cashier-style job ---------- */
console.log('\n== computeMoneyTotals ==')
const columns = ['Receipt No', 'Customer', 'Amount', 'Quantity', 'Price USD']
const records: MoneyRecord[] = [
  { values: { 'Receipt No': 'R-001', Customer: 'Jane', Amount: 'KSh 1,500', Quantity: '2', 'Price USD': '$10.50' }, duplicate: false },
  { values: { 'Receipt No': 'R-002', Customer: 'Omondi', Amount: '1500/=', Quantity: '1', 'Price USD': '$9.99' }, duplicate: false },
  { values: { 'Receipt No': 'R-001', Customer: 'Jane', Amount: 'KSh 1,500', Quantity: '2', 'Price USD': '$10.50' }, duplicate: true },
  { values: { 'Receipt No': 'R-004', Customer: 'Amina', Amount: '2,250.50', Quantity: '3', 'Price USD': '(12.00)' }, duplicate: false },
  { values: { 'Receipt No': 'R-005', Customer: 'Peter', Amount: 'unreadable', Quantity: '1', 'Price USD': '€5' }, duplicate: false },
]
const mt = computeMoneyTotals(columns, records)

check('detects exactly 2 money columns', mt.columns.length === 2, mt.columns)
const amount = mt.columns.find((c) => c.columnName === 'Amount')
const price = mt.columns.find((c) => c.columnName === 'Price USD')
check('Amount is Column 3', amount?.columnIndex === 3)
check('Price USD is Column 5', price?.columnIndex === 5)
check('Quantity NOT detected as money', !mt.columns.some((c) => c.columnName === 'Quantity'))
check('Receipt No NOT detected as money', !mt.columns.some((c) => c.columnName === 'Receipt No'))

check('Amount total = 6750.50', amount?.total === 6750.5, amount?.total)
check('Amount unique total (excl. dup row) = 5250.50', amount?.uniqueTotal === 5250.5, amount?.uniqueTotal)
check('Amount currency = KES', amount?.currency === 'KES')
check('Amount counted = 4', amount?.countedValues === 4, amount?.countedValues)
check('Amount skipped = 1 (unreadable)', amount?.skippedValues === 1)
check('Amount duplicate counted = 1', amount?.duplicateValuesCounted === 1)
check('Amount formatted', amount?.formatted === 'KES 6,750.50', amount?.formatted)

check('Price USD total = 23.99', price?.total === 23.99, price?.total)
check('Price USD currency = USD (dominant)', price?.currency === 'USD')
check('mixed-currency warning raised for Price USD', mt.warnings.some((w) => w.includes('Price USD') && w.includes('mixes currencies')))

check('no grand total across KES + USD columns', mt.grandTotal === null)
check('grand-total mixed warning present', mt.warnings.some((w) => w.includes('do not share one currency')))

/* ---------- 3. single-column grand total ---------- */
console.log('\n== grand total (single money column) ==')
const mt2 = computeMoneyTotals(
  ['Item', 'Amount'],
  [
    { values: { Item: 'A', Amount: 'KSh 100' }, duplicate: false },
    { values: { Item: 'B', Amount: 'KSh 250.50' }, duplicate: false },
  ]
)
check('grand total = 350.50', mt2.grandTotal === 350.5, mt2.grandTotal)
check('grand formatted = KES 350.50', mt2.formattedGrandTotal === 'KES 350.50', mt2.formattedGrandTotal)

/* ---------- 4. no money columns -> null totals ---------- */
console.log('\n== no money columns ==')
const mt3 = computeMoneyTotals(
  ['Student', 'Reg No'],
  [
    { values: { Student: 'Jane', 'Reg No': '2023-001' }, duplicate: false },
    { values: { Student: 'John', 'Reg No': '2023-002' }, duplicate: false },
  ]
)
check('no columns detected', mt3.columns.length === 0)
check('no-money note emitted', mt3.warnings.some((w) => w.startsWith('No monetary column')))

/* ---------- 5. exporter TOTAL rows ---------- */
console.log('\n== exporters ==')
const exportInput: ExportInput = {
  title: 'Cash Sheet — Monday',
  columns: ['Receipt No', 'Customer', 'Amount', 'Price USD'],
  records: records.map((r) => ({
    pageIndex: 0,
    rowIndex: 0,
    values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, v ?? ''])),
  })),
  reportSummary: ['Money total — Column 3 "Amount": KES 6,750.50 across 4 record(s).'],
  moneyTotals: mt as MoneyTotals,
}

const csv = buildCsv(exportInput)
check('csv has TOTAL line', /TOTAL,,6750\.50,23\.99/.test(csv), csv.split('\r\n').at(-2))

const txt = buildTxt(exportInput)
check('txt has TOTAL row', txt.includes('TOTAL'), txt.split('\n').slice(-4).join(' | '))

const jsonStr = buildJson(exportInput, {})
const json = JSON.parse(jsonStr)
check('json has moneyTotals object', json.moneyTotals?.columns?.length === 2)
check('json money total value', json.moneyTotals.columns[1].total === 23.99)

const xlsx = await buildXlsx(exportInput)
check('xlsx signature PK', xlsx.subarray(0, 2).toString() === 'PK')

const pdf = await buildPdf(exportInput)
check('pdf signature %PDF', pdf.subarray(0, 4).toString() === '%PDF')

const docx = await buildDocx(exportInput)
check('docx signature PK', docx.subarray(0, 2).toString() === 'PK')

/* summary */
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
