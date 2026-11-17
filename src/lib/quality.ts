import sharp from 'sharp'

/**
 * Image processing engine.
 * - Quality assessment BEFORE any AI processing (never silently process bad images)
 * - Document-friendly enhancement (perspective-safe normalization, shadow lift,
 *   contrast stretch, sharpening) to give the vision model the most readable input.
 * - Region cropping for user annotations (circular / rectangular / freehand boxes).
 */

export type QualityVerdict = 'pass' | 'warn' | 'fail'

export interface QualityIssue {
  code: string
  severity: 'warn' | 'fail'
  message: string
}

export interface ImageQuality {
  blurScore: number // variance of Laplacian (higher = sharper)
  brightness: number // mean luma 0-255
  contrast: number // stddev of luma
  width: number
  height: number
  darkFraction: number // fraction of very dark pixels
  brightFraction: number // fraction of blown-out pixels
  verdict: QualityVerdict
  issues: QualityIssue[]
}

const ANALYZE_MAX = 1000 // downscale for analysis speed
const OUTPUT_MAX = 2000 // long-side cap for images sent to AI / shown in UI

// Normalize any incoming image (photo/scan/screenshot) to a clean JPEG and
// produce an enhanced reading copy. EXIF rotation is honored automatically.
export async function preparePageImages(input: Buffer) {
  const base = sharp(input).rotate() // honor EXIF orientation

  // Original (normalized) copy used for quality assessment + side-by-side compare
  const originalBuf = await base
    .clone()
    .resize(OUTPUT_MAX, OUTPUT_MAX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer()
  const meta = await sharp(originalBuf).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0

  // Enhanced copy: robust contrast stretch (shadow/illumination correction),
  // slight midtone lift and mild unsharp mask for printed/handwritten text.
  const enhancedBuf = await sharp(originalBuf)
    .normalise({ lower: 1, upper: 99 })
    .modulate({ brightness: 1.06, saturation: 0.9 })
    .sharpen({ sigma: 1.0 })
    .jpeg({ quality: 88 })
    .toBuffer()

  const quality = await assessQuality(originalBuf, width, height)
  return { originalBuf, enhancedBuf, width, height, quality }
}

export async function assessQuality(buf: Buffer, width: number, height: number): Promise<ImageQuality> {
  // Grayscale raw pixels for luma statistics + Laplacian variance (blur)
  const { data, info } = await sharp(buf)
    .grayscale()
    .resize(ANALYZE_MAX, ANALYZE_MAX, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const w = info.width
  const h = info.height
  let sum = 0
  let sumSq = 0
  let dark = 0
  let bright = 0
  const n = w * h
  for (let i = 0; i < n; i++) {
    const v = data[i]
    sum += v
    sumSq += v * v
    if (v < 40) dark++
    if (v > 232) bright++
  }
  const mean = sum / n
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean))
  const darkFraction = dark / n
  const brightFraction = bright / n

  // Laplacian variance (classic blur metric). Higher = sharper.
  let lapSum = 0
  let lapSumSq = 0
  let lapN = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x
      const v =
        4 * data[idx] - data[idx - 1] - data[idx + 1] - data[idx - w] - data[idx + w]
      lapSum += v
      lapSumSq += v * v
      lapN++
    }
  }
  const lapMean = lapSum / Math.max(1, lapN)
  const blurScore = lapSumSq / Math.max(1, lapN) - lapMean * lapMean

  const issues: QualityIssue[] = []

  if (blurScore < 35) {
    issues.push({
      code: 'too-blurry',
      severity: 'fail',
      message: 'Image is too blurry to read reliably. Retake the picture holding the camera steadier, and wait for focus before capturing.',
    })
  } else if (blurScore < 120) {
    issues.push({
      code: 'soft-focus',
      severity: 'warn',
      message: 'Image is somewhat soft. Text may be misread — a sharper picture is recommended.',
    })
  }

  if (mean < 55) {
    issues.push({
      code: 'too-dark',
      severity: 'fail',
      message: 'Image is too dark. Retake the picture in better light or enable flash, avoiding glare.',
    })
  } else if (mean < 80) {
    issues.push({
      code: 'dim',
      severity: 'warn',
      message: 'Lighting is dim. Some text may be hard to read.',
    })
  }

  if (mean > 225 && brightFraction > 0.35) {
    issues.push({
      code: 'overexposed',
      severity: 'warn',
      message: 'Image looks overexposed / washed out. Avoid direct light on the paper.',
    })
  }

  if (std < 18) {
    issues.push({
      code: 'low-contrast',
      severity: 'warn',
      message: 'Very low contrast between text and background.',
    })
  }

  const minSide = Math.min(width, height)
  if (minSide > 0 && minSide < 500) {
    issues.push({
      code: 'low-resolution',
      severity: 'fail',
      message: 'Resolution is too low (min side ' + minSide + 'px). Move closer or use a higher-resolution camera.',
    })
  } else if (minSide > 0 && minSide < 700) {
    issues.push({
      code: 'borderline-resolution',
      severity: 'warn',
      message: 'Resolution is borderline. Move slightly closer for small print.',
    })
  }

  if (darkFraction > 0.5) {
    issues.push({
      code: 'heavy-shadow',
      severity: 'warn',
      message: 'A large part of the image is covered by shadow.',
    })
  }

  const hasFail = issues.some((i) => i.severity === 'fail')
  const hasWarn = issues.some((i) => i.severity === 'warn')
  return {
    blurScore: Math.round(blurScore * 10) / 10,
    brightness: Math.round(mean * 10) / 10,
    contrast: Math.round(std * 10) / 10,
    width,
    height,
    darkFraction: Math.round(darkFraction * 1000) / 1000,
    brightFraction: Math.round(brightFraction * 1000) / 1000,
    verdict: hasFail ? 'fail' : hasWarn ? 'warn' : 'pass',
    issues,
  }
}

export interface AnnotationShape {
  id: string
  type: 'rect' | 'ellipse' | 'freehand'
  // normalized coordinates 0..1 relative to the enhanced image
  x: number
  y: number
  w: number
  h: number
  label?: string
  points?: number[] // for freehand: flattened x,y pairs (normalized)
}

/**
 * Crop each annotated region (with padding) from the enhanced image and
 * upscale small crops so the vision model can read fine print.
 * Returns JPEG buffers paired with their region description.
 */
export async function cropRegions(
  enhancedBuf: Buffer,
  annotations: AnnotationShape[]
): Promise<{ index: number; label: string; buffer: Buffer }[]> {
  if (!annotations.length) return []
  const meta = await sharp(enhancedBuf).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  if (!W || !H) return []

  const out: { index: number; label: string; buffer: Buffer }[] = []
  for (let i = 0; i < annotations.length; i++) {
    const a = annotations[i]
    const padX = Math.max(a.w * 0.12, 8 / W)
    const padY = Math.max(a.h * 0.12, 8 / H)
    const left = Math.max(0, Math.round((a.x - padX) * W))
    const top = Math.max(0, Math.round((a.y - padY) * H))
    const cw = Math.min(W - left, Math.max(16, Math.round((a.w + padX * 2) * W)))
    const ch = Math.min(H - top, Math.max(16, Math.round((a.h + padY * 2) * H)))
    if (cw < 8 || ch < 8) continue

    let pipe = sharp(enhancedBuf).extract({ left, top, width: cw, height: ch })
    // Upscale small crops for readability
    const longSide = Math.max(cw, ch)
    if (longSide < 900) {
      const scale = Math.min(3, 900 / longSide)
      pipe = pipe.resize(Math.round(cw * scale), Math.round(ch * scale), { kernel: 'lanczos3' })
    }
    const buffer = await pipe.jpeg({ quality: 90 }).toBuffer()
    out.push({ index: out.length, label: a.label?.trim() || `${a.type} region ${out.length + 1}`, buffer })
  }
  return out
}

export function bufToDataUrl(buf: Buffer, mime = 'image/jpeg') {
  return `data:${mime};base64,${buf.toString('base64')}`
}
