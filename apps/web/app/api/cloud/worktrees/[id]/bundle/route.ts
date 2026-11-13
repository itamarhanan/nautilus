import { NextResponse, type NextRequest } from "next/server";
import { requireSql } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sql = requireSql();
  // latest checkpoint among sessions of this worktree
  const rows = (await sql`
    SELECT c.bundle, c.head, c.base_head
    FROM checkpoints c
    JOIN sessions s ON s.id = c.session_id
    WHERE s.worktree_id = ${id}
    ORDER BY c.created_at DESC
    LIMIT 1
  `) as Array<{ bundle: Buffer | null; head: string | null; base_head: string | null }>;
  const r = rows[0];
  if (!r) return NextResponse.json({ bundleBase64: null, head: null, baseHead: null });
  return NextResponse.json({
    bundleBase64: r.bundle ? Buffer.from(r.bundle).toString("base64") : null,
    head: r.head,
    baseHead: r.base_head,
  });
}
