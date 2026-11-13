import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { requireSql } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    parentCheckpointId?: string | null;
    baseHead?: string | null;
    head?: string | null;
    bundleBase64?: string | null;
  };
  const cpId = randomUUID();
  const bundle = body.bundleBase64 ? Buffer.from(body.bundleBase64, "base64") : null;
  const sql = requireSql();
  await sql`
    INSERT INTO checkpoints (id, session_id, parent_checkpoint_id, base_head, head, bundle)
    VALUES (${cpId}, ${id}, ${body.parentCheckpointId ?? null}, ${body.baseHead ?? null}, ${body.head ?? null}, ${bundle})
  `;
  return NextResponse.json({ id: cpId });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sql = requireSql();
  const rows = (await sql`
    SELECT id, parent_checkpoint_id, base_head, head, created_at
    FROM checkpoints WHERE session_id = ${id} ORDER BY created_at DESC
  `) as any[];
  return NextResponse.json({ checkpoints: rows });
}
