import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/fields/[id] — human verification: correct a value or accept an alternative.
// User corrections clear the uncertain flag (human verified) and mark the field as edited.
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const field = await db.field.findUnique({ where: { id } })
  if (!field) return NextResponse.json({ error: 'Field not found' }, { status: 404 })

  const data: { value?: string; uncertain?: boolean; missing?: boolean; edited?: boolean; reason?: string | null } = { edited: true }

  if (typeof body.value === 'string') {
    const v = body.value
    data.value = v
    data.uncertain = false
    data.missing = v.trim() === ''
    data.reason = v.trim() === '' ? field.reason : null
  } else if (typeof body.acceptAlternative === 'string') {
    data.value = body.acceptAlternative
    data.uncertain = false
    data.missing = false
    data.reason = null
  }

  const updated = await db.field.update({ where: { id }, data })
  return NextResponse.json({
    field: {
      id: updated.id,
      value: updated.value,
      uncertain: updated.uncertain,
      missing: updated.missing,
      edited: updated.edited,
    },
  })
}
