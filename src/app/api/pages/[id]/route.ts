import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { AnnotationShape } from '@/lib/quality'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/pages/[id] — save annotations drawn on the page (normalized shapes)
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  if (!Array.isArray(body.annotations)) return NextResponse.json({ error: 'annotations must be an array' }, { status: 400 })
  // Light validation
  const annotations: AnnotationShape[] = body.annotations
    .filter((a: Record<string, unknown>) => a && typeof a === 'object')
    .map((a: Record<string, unknown>) => ({
      id: String(a.id ?? crypto.randomUUID()),
      type: (['rect', 'ellipse', 'freehand'].includes(a.type as string) ? a.type : 'rect') as AnnotationShape['type'],
      x: Math.max(0, Math.min(1, Number(a.x) || 0)),
      y: Math.max(0, Math.min(1, Number(a.y) || 0)),
      w: Math.max(0, Math.min(1, Number(a.w) || 0)),
      h: Math.max(0, Math.min(1, Number(a.h) || 0)),
      label: typeof a.label === 'string' ? a.label.slice(0, 200) : '',
      points: Array.isArray(a.points) ? (a.points as number[]).slice(0, 2000) : undefined,
    }))
  const page = await db.page.update({ where: { id }, data: { annotations: JSON.stringify(annotations) } })
  return NextResponse.json({ annotations: JSON.parse(page.annotations) })
}

// DELETE /api/pages/[id] — remove a page (user-controlled deletion)
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const page = await db.page.findUnique({ where: { id } })
  if (!page) return NextResponse.json({ error: 'Page not found' }, { status: 404 })
  await db.page.delete({ where: { id } })
  // Re-index remaining pages to preserve order
  const remaining = await db.page.findMany({ where: { jobId: page.jobId }, orderBy: { order: 'asc' } })
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].order !== i) {
      await db.page.update({ where: { id: remaining[i].id }, data: { order: i } })
    }
  }
  return NextResponse.json({ ok: true })
}
