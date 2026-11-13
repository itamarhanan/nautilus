import { neon } from "@neondatabase/serverless";

// Lazily create a sql tagged-template function from DATABASE_URL.
// Returns null when no database is configured (e.g. local dev without Neon).
export function getSql(): any {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) return null;
  return neon(url);
}

export function requireSql(): any {
  const sql = getSql();
  if (!sql) throw new Error("DATABASE_URL is not configured");
  return sql;
}
