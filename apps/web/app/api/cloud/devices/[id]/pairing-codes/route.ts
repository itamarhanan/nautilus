import { NextResponse, type NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { requireSql } from "@/lib/db";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sql = requireSql();
  const code = randomBytes(16).toString("hex");
  const codeHash = createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await sql`INSERT INTO pairings (code_hash, device_id, expires_at) VALUES (${codeHash}, ${id}, ${expiresAt})`;
  return NextResponse.json({ code, expiresAt });
}
