import PDFDocument from 'pdfkit'
import fs from 'fs'
const doc = new PDFDocument({ size: 'A4' })
doc.pipe(fs.createWriteStream('/home/z/my-project/scripts/testdocs/multipage.pdf'))
doc.font('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf').fontSize(20).text('Stock Register — Page 1', 60, 60)
doc.font('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf').fontSize(14)
const rows1 = [['Sugar 1kg', '24', '105'], ['Maize 2kg', '40', '180'], ['Cooking oil 1L', '12', '350']]
let y = 120
doc.text('Product        Qty        Price', 60, y)
rows1.forEach((r) => {
  y += 40
  doc.text(r.join('            '), 60, y)
})
doc.addPage()
doc.font('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf').fontSize(20).text('Stock Register — Page 2', 60, 60)
doc.fontSize(14)
y = 120
doc.text('Product        Qty        Price', 60, y)
const rows2 = [['Rice 5kg', '18', '620'], ['Tea 250g', '30', '210']]
rows2.forEach((r) => {
  y += 40
  doc.text(r.join('            '), 60, y)
})
doc.end()
await new Promise((r) => setTimeout(r, 500))
console.log('multipage.pdf written')
