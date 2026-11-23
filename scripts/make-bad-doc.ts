import sharp from 'sharp'
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500">
  <rect width="900" height="500" fill="#ffffff"/>
  <text x="60" y="100" font-family="DejaVu Sans" font-size="22" fill="#111">Student List Test</text>
  <text x="60" y="180" font-family="DejaVu Sans" font-size="18" fill="#111">1. Test Student One REG001 80</text>
  <text x="60" y="240" font-family="DejaVu Sans" font-size="18" fill="#111">2. Test Student Two REG002 90</text>
</svg>`
// blur heavily + darken to force quality FAIL
await sharp(Buffer.from(svg)).blur(6).linear(0.12, 0).jpeg().toFile('/home/z/my-project/scripts/testdocs/bad-dark-blurry.jpg')
console.log('bad image written')
