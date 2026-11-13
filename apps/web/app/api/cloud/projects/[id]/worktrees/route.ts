import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { requireSql } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = body.name ?? "main";
  const wtId = randomUUID();
  const sql = requireSql();
  await sql`INSERT INTO worktrees (id, project_id, name) VALUES (${wtId}, ${id}, ${name})`;
  return NextResponse.json({ id: wtId, name });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sql = requireSql();
  const rows = (await sql`SELECT id, name, base_head, created_at FROM worktrees WHERE project_id = ${id} ORDER BY created_at`) as any[];
  return NextResponse.json({ worktrees: rows });
}
