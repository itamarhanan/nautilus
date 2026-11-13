import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { requireSql } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { name?: string; ownerDeviceId?: string };
  if (!body.name || !body.ownerDeviceId) {
    return NextResponse.json({ error: "name and ownerDeviceId required" }, { status: 400 });
  }
  const id = randomUUID();
  const sql = requireSql();
  await sql`INSERT INTO projects (id, owner_device_id, name) VALUES (${id}, ${body.ownerDeviceId}, ${body.name})`;
  return NextResponse.json({ id, name: body.name });
}

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("ownerDeviceId");
  const sql = requireSql();
  const rows = owner
    ? ((await sql`SELECT id, name, created_at FROM projects WHERE owner_device_id = ${owner} ORDER BY created_at DESC`) as any[])
    : ((await sql`SELECT id, name, created_at FROM projects ORDER BY created_at DESC`) as any[]);
  return NextResponse.json({ projects: rows });
}
