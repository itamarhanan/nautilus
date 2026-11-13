import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { requireSql } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { kind?: string };
  const kind = body.kind === "desktop" ? "desktop" : "phone";
  const id = randomUUID();
  const sql = requireSql();
  await sql`INSERT INTO devices (id, kind) VALUES (${id}, ${kind})`;
  return NextResponse.json({ id, kind });
}
