import { NextRequest } from "next/server";
import { requireSql } from "@/lib/db";
import { runTurnInSandbox } from "@/lib/sandbox";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { prompt?: string };
  const prompt = body.prompt ?? "";
  const sql = requireSql();
  const rows = (await sql`
    SELECT s.project_id, s.worktree_id, w.base_head, w.base_bundle
    FROM sessions s JOIN worktrees w ON w.id = s.worktree_id
    WHERE s.id = ${id}
  `) as Array<{ project_id: string; worktree_id: string; base_head: string | null; base_bundle: Buffer | null }>;
  const r = rows[0];
  if (!r) return new Response("session not found", { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      send({ type: "start", prompt });
      try {
        const result = await runTurnInSandbox({ baseBundle: r.base_bundle, prompt });
        send({ type: "result", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, hasBundle: !!result.outBundle });
        if (result.outBundle) {
          const cpId = crypto.randomUUID();
          await sql`
            INSERT INTO checkpoints (id, session_id, parent_checkpoint_id, base_head, head, bundle)
            VALUES (${cpId}, ${id}, NULL, ${r.base_head}, ${r.base_head}, ${result.outBundle})
          `;
          // update worktree base
          await sql`UPDATE worktrees SET base_head = ${r.base_head}, base_bundle = ${result.outBundle} WHERE id = ${r.worktree_id}`;
          send({ type: "checkpoint", id: cpId });
        }
      } catch (err) {
        send({ type: "error", message: String(err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}
