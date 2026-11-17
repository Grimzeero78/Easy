import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { preparePageImages } from '@/lib/quality'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Params = { params: Promise<{ id: string }> }

// POST /api/jobs/[id]/pages — upload one page image (FormData: file, fileName)
// Runs the quality gate BEFORE the page is accepted for AI processing.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params
  const job = await db.job.findUnique({ where: { id }, include: { pages: true } })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'Missing file' }, { status: 400 })
  const fileName = (form.get('fileName') as string) || file.name || 'page.jpg'

  try {
    const input = Buffer.from(await file.arrayBuffer())
    const { originalBuf, enhancedBuf, width, height, quality } = await preparePageImages(input)

    const order = job.pages.length
    const page = await db.page.create({
      data: {
        jobId: id,
        order,
        fileName,
        mimeType: 'image/jpeg',
        width,
        height,
        originalData: originalBuf,
        enhancedData: enhancedBuf,
        qualityJson: JSON.stringify(quality),
        annotations: '[]',
        // Quality gate: failed images are stored for review but BLOCKED from AI processing
        status: quality.verdict === 'fail' ? 'blocked' : 'uploaded',
      },
    })

    return NextResponse.json({
      page: {
        id: page.id,
        order: page.order,
        fileName: page.fileName,
        width,
        height,
        status: page.status,
        quality,
      },
    })
  } catch (err) {
    return NextResponse.json({ error: `Could not process image: ${(err as Error).message}` }, { status: 400 })
  }
}
