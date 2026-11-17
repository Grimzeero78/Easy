/**
 * Client-side image engine for the Cloudflare deployment (NEXT_PUBLIC_CF_MODE=1).
 *
 * Cloudflare Workers cannot run sharp (native module) and have hard CPU limits,
 * so in CF mode the browser performs:
 *   1. quality assessment BEFORE upload (same metrics & thresholds as the
 *      server-side engine in quality.ts — blurry/dark images are blocked)
 *   2. document-friendly enhancement (contrast stretch + brightness/saturation)
 *   3. zoomed crops of user-annotated regions, sent along with the extract
 *      request so the vision model can read fine print
 *
 * The sandbox Next.js build does not import this module.
 */

import type { AnnotationShape, ImageQuality, QualityIssue } from '@/lib/types'

const ANALYZE_MAX = 1000
const OUTPUT_MAX = 2000

async function decodeBitmap(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  } catch {
    return await createImageBitmap(blob)
  }
}

function drawToCanvas(src: ImageBitmap | HTMLImageElement, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0, w, h)
  return canvas
}

/** Downscaled grayscale pixel data for quality metrics (mirrors quality.ts). */
function grayscalePixels(bitmap: ImageBitmap): { data: Uint8ClampedArray; w: number; h: number } {
  const scale = Math.min(1, ANALYZE_MAX / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = drawToCanvas(bitmap, w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const img = ctx.getImageData(0, 0, w, h)
  const gray = new Uint8ClampedArray(w * h)
  for (let i = 0, p = 0; i < img.data.length; i += 4, p++) {
    gray[p] = (img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114) | 0
  }
  return { data: gray, w, h }
}

/**
 * Same algorithm and thresholds as `assessQuality` in lib/quality.ts so both
 * deployment modes agree on what is readable.
 */
export async function assessQualityBlob(blob: Blob): Promise<ImageQuality> {
  const bitmap = await decodeBitmap(blob)
  const width = bitmap.width
  const height = bitmap.height
  const { data, w, h } = grayscalePixels(bitmap)

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

  let lapSum = 0
  let lapSumSq = 0
  let lapN = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x
      const v = 4 * data[idx] - data[idx - 1] - data[idx + 1] - data[idx - w] - data[idx + w]
      lapSum += v
      lapSumSq += v * v
      lapN++
    }
  }
  const lapMean = lapSum / Math.max(1, lapN)
  const blurScore = lapSumSq / Math.max(1, lapN) - lapMean * lapMean

  const issues: QualityIssue[] = []
  if (blurScore < 35) {
    issues.push({ code: 'too-blurry', severity: 'fail', message: 'Image is too blurry to read reliably. Retake the picture holding the camera steadier, and wait for focus before capturing.' })
  } else if (blurScore < 120) {
    issues.push({ code: 'soft-focus', severity: 'warn', message: 'Image is somewhat soft. Text may be misread — a sharper picture is recommended.' })
  }
  if (mean < 55) {
    issues.push({ code: 'too-dark', severity: 'fail', message: 'Image is too dark. Retake the picture in better light or enable flash, avoiding glare.' })
  } else if (mean < 80) {
    issues.push({ code: 'dim', severity: 'warn', message: 'Lighting is dim. Some text may be hard to read.' })
  }
  if (mean > 225 && brightFraction > 0.35) {
    issues.push({ code: 'overexposed', severity: 'warn', message: 'Image looks overexposed / washed out. Avoid direct light on the paper.' })
  }
  if (std < 18) {
    issues.push({ code: 'low-contrast', severity: 'warn', message: 'Very low contrast between text and background.' })
  }
  const minSide = Math.min(width, height)
  if (minSide > 0 && minSide < 500) {
    issues.push({ code: 'low-resolution', severity: 'fail', message: 'Resolution is too low (min side ' + minSide + 'px). Move closer or use a higher-resolution camera.' })
  } else if (minSide > 0 && minSide < 700) {
    issues.push({ code: 'borderline-resolution', severity: 'warn', message: 'Resolution is borderline. Move slightly closer for small print.' })
  }
  if (darkFraction > 0.5) {
    issues.push({ code: 'heavy-shadow', severity: 'warn', message: 'A large part of the image is covered by shadow.' })
  }

  const hasFail = issues.some((i) => i.severity === 'fail')
  const hasWarn = issues.some((i) => i.severity === 'warn')
  bitmap.close?.()
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

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Canvas encode failed'))),
      'image/jpeg',
      quality
    )
  })
}

/**
 * Normalized original copy (max 2000px JPEG) — used for quality display and
 * the "Original" side-by-side view.
 */
export async function normalizeToBlob(blob: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await decodeBitmap(blob)
  const scale = Math.min(1, OUTPUT_MAX / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = drawToCanvas(bitmap, w, h)
  const out = await canvasToBlob(canvas, 0.9)
  const width = w
  const height = h
  bitmap.close?.()
  return { blob: out, width, height }
}

/**
 * Enhanced reading copy: per-channel 1-99 percentile contrast stretch
 * (shadow/illumination correction), mild brightness lift and slight
 * desaturation — the browser equivalent of the sharp pipeline in quality.ts.
 */
export async function enhanceToBlob(blob: Blob): Promise<Blob> {
  const bitmap = await decodeBitmap(blob)
  const scale = Math.min(1, OUTPUT_MAX / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = drawToCanvas(bitmap, w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const img = ctx.getImageData(0, 0, w, h)
  const px = img.data

  // per-channel percentile bounds
  const lows: number[] = []
  const highs: number[] = []
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256)
    for (let i = c; i < px.length; i += 4) hist[px[i]]++
    const total = w * h
    let acc = 0
    let low = 0
    let high = 255
    for (let v = 0; v < 256; v++) {
      acc += hist[v]
      if (acc >= total * 0.01) {
        low = v
        break
      }
    }
    acc = 0
    for (let v = 255; v >= 0; v--) {
      acc += hist[v]
      if (acc >= total * 0.01) {
        high = v
        break
      }
    }
    if (high - low < 24) {
      low = 0
      high = 255
    }
    lows.push(low)
    highs.push(high)
  }

  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const stretched = ((px[i + c] - lows[c]) * 255) / (highs[c] - lows[c])
      // brightness lift 1.06
      px[i + c] = Math.max(0, Math.min(255, stretched * 1.06))
    }
    // saturation 0.9
    const luma = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114
    for (let c = 0; c < 3; c++) {
      px[i + c] = Math.max(0, Math.min(255, luma + (px[i + c] - luma) * 0.9))
    }
    px[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const out = await canvasToBlob(canvas, 0.88)
  bitmap.close?.()
  return out
}

export interface RegionCrop {
  label: string
  dataUrl: string
}

/**
 * Zoomed crops of annotated regions (same padding/upscale math as
 * `cropRegions` in quality.ts) so the Worker can give the vision model
 * close-ups without any server-side image decoding.
 */
export async function cropRegionsClient(imageUrl: string, annotations: AnnotationShape[]): Promise<RegionCrop[]> {
  if (!annotations.length) return []
  const res = await fetch(imageUrl)
  if (!res.ok) throw new Error('Could not load page image for annotation crops')
  const bitmap = await decodeBitmap(await res.blob())
  const W = bitmap.width
  const H = bitmap.height
  if (!W || !H) return []

  const out: RegionCrop[] = []
  for (const a of annotations) {
    const padX = Math.max(a.w * 0.12, 8 / W)
    const padY = Math.max(a.h * 0.12, 8 / H)
    const left = Math.max(0, Math.round((a.x - padX) * W))
    const top = Math.max(0, Math.round((a.y - padY) * H))
    const cw = Math.min(W - left, Math.max(16, Math.round((a.w + padX * 2) * W)))
    const ch = Math.min(H - top, Math.max(16, Math.round((a.h + padY * 2) * H)))
    if (cw < 8 || ch < 8) continue

    const longSide = Math.max(cw, ch)
    let tw = cw
    let th = ch
    if (longSide < 900) {
      const scale = Math.min(3, 900 / longSide)
      tw = Math.round(cw * scale)
      th = Math.round(ch * scale)
    }
    const canvas = document.createElement('canvas')
    canvas.width = tw
    canvas.height = th
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, left, top, cw, ch, 0, 0, tw, th)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
    out.push({ label: a.label?.trim() || `${a.type} region ${out.length + 1}` })
    out[out.length - 1].dataUrl = dataUrl
  }
  bitmap.close?.()
  return out
}

/** True when the bundle was built for the Cloudflare deployment. */
export const CF_MODE = process.env.NEXT_PUBLIC_CF_MODE === '1'
