import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";

export async function GET() {
  const sql = getSql();
  let db: "ok" | "unconfigured" | "error" = "unconfigured";
  if (sql) {
    try {
      await sql`SELECT 1`;
      db = "ok";
    } catch {
      db = "error";
    }
  }
  return NextResponse.json({ status: "ok", db });
}
