import { NextRequest } from "next/server";
import { runTurnInSandbox } from "@/lib/sandbox";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { prompt?: string; baseBundleBase64?: string | null };
  const prompt = body.prompt ?? "";
  const baseBundle = body.baseBundleBase64 ? Buffer.from(body.baseBundleBase64, "base64") : null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      send({ type: "start", prompt });
      try {
        const result = await runTurnInSandbox({ baseBundle, prompt });
        send({ type: "result", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, hasBundle: !!result.outBundle });
      } catch (err) {
        send({ type: "error", message: String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
