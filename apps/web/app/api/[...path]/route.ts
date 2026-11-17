import { forward } from "@/lib/runner/forward";
import { authenticate } from "@/lib/server/auth";
import { handled } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Everything the gateway does not answer itself goes to the runner, with the
// caller the gateway authenticated named in a header the runner trusts only
// next to the runner key.
const handler = handled(async (request: Request) => {
  const auth = await authenticate(request);
  return forward(request, auth, new URL(request.url).pathname);
});

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
