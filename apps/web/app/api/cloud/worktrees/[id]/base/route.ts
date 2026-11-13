import { NextResponse, type NextRequest } from "next/server";
import { requireSql } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { baseHead?: string | null; bundleBase64?: string | null };
  const bundle = body.bundleBase64 ? Buffer.from(body.bundleBase64, "base64") : null;
  const sql = requireSql();
  await sql`UPDATE worktrees SET base_head = ${body.baseHead ?? null}, base_bundle = ${bundle} WHERE id = ${id}`;
  return NextResponse.json({ ok: true });
}
