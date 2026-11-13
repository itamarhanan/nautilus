import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { requireSql } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { code?: string; deviceId?: string };
  if (!body.code) return NextResponse.json({ error: "code required" }, { status: 400 });
  const codeHash = createHash("sha256").update(body.code).digest("hex");
  const sql = requireSql();
  const rows = (await sql`
    SELECT device_id, expires_at, consumed_at FROM pairings WHERE code_hash = ${codeHash}
  `) as Array<{ device_id: string; expires_at: string; consumed_at: string | null }>;
  const row = rows[0];
  if (!row) return NextResponse.json({ error: "invalid code" }, { status: 404 });
  if (row.consumed_at) return NextResponse.json({ error: "code used" }, { status: 410 });
  if (new Date(row.expires_at) < new Date()) return NextResponse.json({ error: "code expired" }, { status: 410 });
  await sql`UPDATE pairings SET consumed_at = now() WHERE code_hash = ${codeHash}`;
  if (body.deviceId) {
    await sql`UPDATE devices SET linked_to = ${row.device_id} WHERE id = ${body.deviceId}`;
  }
  return NextResponse.json({ linkedDeviceId: row.device_id });
}
