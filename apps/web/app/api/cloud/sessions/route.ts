import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { requireSql } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { projectId?: string; worktreeId?: string };
  if (!body.projectId || !body.worktreeId) {
    return NextResponse.json({ error: "projectId and worktreeId required" }, { status: 400 });
  }
  const id = randomUUID();
  const sql = requireSql();
  await sql`INSERT INTO sessions (id, project_id, worktree_id) VALUES (${id}, ${body.projectId}, ${body.worktreeId})`;
  return NextResponse.json({ id });
}
