import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!url) {
  console.error("Set DATABASE_URL or POSTGRES_URL");
  process.exit(1);
}
const sql = neon(url);
const file = new URL("../apps/web/db/migrations/0001_init.sql", import.meta.url);
const text = readFileSync(file, "utf8");
// Split on semicolons naively; neon supports multiple statements via sql.query? Use sql.query.
await sql.query(text);
console.log("Migration applied.");
