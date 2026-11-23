/**
 * Generates realistic test documents for E2E testing:
 * 1. student-register.png — printed class register table
 * 2. cash-sheet.png — cashier daily cash collection sheet
 * 3. template.xlsx — Excel template with No. / Student Name / Registration Number headers
 */
import sharp from 'sharp'
import ExcelJS from 'exceljs'
import { mkdirSync } from 'fs'

const OUT = '/home/z/my-project/scripts/testdocs'
mkdirSync(OUT, { recursive: true })

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function tableSvg(opts: {
  title: string
  subtitle: string
  headers: string[]
  rows: string[][]
  colWidths: number[]
  width: number
  height: number
}): string {
  const { title, subtitle, headers, rows, colWidths, width, height } = opts
  const marginX = 60
  let y = 90
  const parts: string[] = []
  parts.push(`<rect width="${width}" height="${height}" fill="#f5f4ef"/>`)
  parts.push(`<rect x="40" y="40" width="${width - 80}" height="${height - 80}" fill="#ffffff" stroke="#d8d5cc"/>`)
  parts.push(
    `<text x="${marginX}" y="${y}" font-family="DejaVu Sans" font-size="30" font-weight="bold" fill="#111">${esc(title)}</text>`
  )
  y += 34
  parts.push(`<text x="${marginX}" y="${y}" font-family="DejaVu Sans" font-size="16" fill="#444">${esc(subtitle)}</text>`)
  y += 40

  // header row
  let x = marginX
  parts.push(`<rect x="${marginX - 10}" y="${y - 22}" width="${width - marginX * 2 + 20}" height="34" fill="#e7e5de"/>`)
  headers.forEach((h, i) => {
    parts.push(
      `<text x="${x}" y="${y + 2}" font-family="DejaVu Sans" font-size="16" font-weight="bold" fill="#222">${esc(h)}</text>`
    )
    x += colWidths[i]
  })
  y += 24
  // rule
  parts.push(`<line x1="${marginX - 10}" y1="${y}" x2="${width - marginX - 10}" y2="${y}" stroke="#999" stroke-width="1.5"/>`)

  // data rows
  rows.forEach((row, ri) => {
    y += 38
    let x = marginX
    row.forEach((cell, ci) => {
      parts.push(
        `<text x="${x}" y="${y}" font-family="DejaVu Sans Mono" font-size="15" fill="#1a1a1a">${esc(cell)}</text>`
      )
      x += colWidths[ci]
    })
    // light row separator
    parts.push(`<line x1="${marginX - 10}" y1="${y + 14}" x2="${width - marginX - 10}" y2="${y + 14}" stroke="#e2e0d8" stroke-width="1"/>`)
    if (ri === rows.length - 1) y += 30
  })

  parts.push(
    `<text x="${marginX}" y="${Math.min(height - 60, y + 20)}" font-family="DejaVu Sans" font-size="13" fill="#777">Prepared by: J. Mwangi     Checked by: ____________</text>`
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`
}

async function main() {
  // 1. Student register — 12 rows
  const students = [
    ['1', 'John Kamau', 'ACS001', '78'],
    ['2', 'Peter Otieno', 'ACS002', '85'],
    ['3', 'Mary Wanjiku', 'ACS003', '90'],
    ['4', 'Grace Achieng', 'ACS004', '66'],
    ['5', 'Samuel Mutua', 'ACS005', '72'],
    ['6', 'Faith Njeri', 'ACS006', '81'],
    ['7', 'Brian Kiptoo', 'ACS007', '58'],
    ['8', 'Lucy Chebet', 'ACS008', '88'],
    ['9', 'Dennis Ouma', 'ACS009', '74'],
    ['10', 'Alice Muthoni', 'ACS010', '92'],
    ['11', 'Kevin Njoroge', 'ACS011', '69'],
    ['12', 'Susan Wairimu', 'ACS012', '77'],
  ]
  const svg1 = tableSvg({
    title: 'ACS 101 — Class Register',
    subtitle: 'Department of Computer Science · Week 6 · Lecturer: J. Mwangi',
    headers: ['No.', 'Student Name', 'Registration Number', 'Marks'],
    rows: students,
    colWidths: [70, 280, 300, 150],
    width: 900,
    height: 760,
  })
  await sharp(Buffer.from(svg1)).png().toFile(`${OUT}/student-register.png`)
  console.log('student-register.png written')

  // 2. Cash collection sheet — cashier mode test
  const txns = [
    ['TXN-20431', '2,500.00', '12/06/2026', 'School fees — A. Bwire'],
    ['TXN-20432', '1,200.00', '12/06/2026', 'Stationery sale'],
    ['TXN-20433', '800.00', '12/06/2026', 'Uniform deposit'],
    ['TXN-20434', '3,150.00', '12/06/2026', 'School fees — M. Kilonzo'],
    ['TXN-20435', '450.00', '13/06/2026', 'Library fine'],
    ['TXN-20436', '2,000.00', '13/06/2026', 'Transport levy'],
    ['TXN-20437', '1,750.00', '13/06/2026', 'School fees — P. Wafula'],
    ['TXN-20438', '620.00', '13/06/2026', 'Lab materials'],
  ]
  const svg2 = tableSvg({
    title: 'Daily Cash Collection Sheet',
    subtitle: 'Front Office — KES · Cashier: R. Nduta',
    headers: ['Transaction ID', 'Amount', 'Date', 'Description'],
    rows: txns,
    colWidths: [230, 170, 190, 300],
    width: 950,
    height: 620,
  })
  await sharp(Buffer.from(svg2)).png().toFile(`${OUT}/cash-sheet.png`)
  console.log('cash-sheet.png written')

  // 3. Excel template with headers No. / Student Name / Registration Number
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Class List')
  ws.columns = [
    { header: 'No.', key: 'no', width: 8 },
    { header: 'Student Name', key: 'name', width: 30 },
    { header: 'Registration Number', key: 'reg', width: 26 },
  ]
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }
  const out = await wb.xlsx.writeBuffer()
  const fs = await import('fs')
  fs.writeFileSync(`${OUT}/template.xlsx`, Buffer.from(out))
  console.log('template.xlsx written')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
