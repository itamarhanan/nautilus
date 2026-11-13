import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { requireSql } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { projectId?: string; worktreeId?: string; title?: string };
  if (!body.projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  const sql = requireSql();
  let worktreeId = body.worktreeId;
  if (!worktreeId) {
    const wts = (await sql`SELECT id FROM worktrees WHERE project_id = ${body.projectId} ORDER BY created_at LIMIT 1`) as Array<{ id: string }>;
    if (wts[0]) worktreeId = wts[0].id;
    else {
      worktreeId = randomUUID();
      await sql`INSERT INTO worktrees (id, project_id, name) VALUES (${worktreeId}, ${body.projectId}, ${"main"})`;
    }
  }
  const id = randomUUID();
  await sql`INSERT INTO sessions (id, project_id, worktree_id) VALUES (${id}, ${body.projectId}, ${worktreeId})`;
  return NextResponse.json({ id, session: { id, projectId: body.projectId, title: body.title ?? null } });
}

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  const sql = requireSql();
  const rows = projectId
    ? ((await sql`SELECT id, project_id, worktree_id, status, created_at FROM sessions WHERE project_id = ${projectId} ORDER BY created_at DESC`) as any[])
    : ((await sql`SELECT id, project_id, worktree_id, status, created_at FROM sessions ORDER BY created_at DESC`) as any[]);
  return NextResponse.json({ sessions: rows.map((r) => ({ id: r.id, projectId: r.project_id, status: r.status, createdAt: r.created_at })) });
}
