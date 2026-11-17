import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// GET /api/pages/[id]/image?variant=enhanced|original — serve stored page image
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params
  const variant = req.nextUrl.searchParams.get('variant') === 'original' ? 'original' : 'enhanced'
  const page = await db.page.findUnique({ where: { id } })
  if (!page) return NextResponse.json({ error: 'Page not found' }, { status: 404 })

  const data = variant === 'original' || !page.enhancedData ? page.originalData : page.enhancedData
  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': page.mimeType || 'image/jpeg',
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
