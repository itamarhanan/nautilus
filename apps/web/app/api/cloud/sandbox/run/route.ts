import { NextResponse, type NextRequest } from "next/server";
import { runInSandbox } from "@/lib/sandbox";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { command?: string; args?: string[] };
  const command = body.command ?? "node";
  const args = body.args ?? ["-e", "console.log('nautilus sandbox ok')"];
  try {
    const result = await runInSandbox(command, args);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
