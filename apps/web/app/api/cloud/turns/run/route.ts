import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { requireSql } from "@/lib/db";
import { runTurnInSandbox } from "@/lib/sandbox";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    sessionId?: string;
    prompt?: string;
    baseBundleBase64?: string | null;
    parentCheckpointId?: string | null;
    baseHead?: string | null;
  };
  if (!body.sessionId || !body.prompt) {
    return NextResponse.json({ error: "sessionId and prompt required" }, { status: 400 });
  }
  const baseBundle = body.baseBundleBase64 ? Buffer.from(body.baseBundleBase64, "base64") : null;
  const result = await runTurnInSandbox({ baseBundle, prompt: body.prompt });

  let checkpointId: string | null = null;
  if (result.outBundle) {
    const sql = requireSql();
    checkpointId = randomUUID();
    await sql`
      INSERT INTO checkpoints (id, session_id, parent_checkpoint_id, base_head, head, bundle)
      VALUES (${checkpointId}, ${body.sessionId}, ${body.parentCheckpointId ?? null}, ${body.baseHead ?? null}, ${body.baseHead ?? null}, ${result.outBundle})
    `;
  }

  return NextResponse.json({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    checkpointId,
  });
}
