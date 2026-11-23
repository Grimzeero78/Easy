import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// DELETE /api/templates/[id]
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params
  await db.template.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
