import { clearSessionCookie } from "@/lib/server/auth";
import { handled, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = handled(() => {
  const response = json({ loggedOut: true });
  clearSessionCookie(response);
  return Promise.resolve(response);
});
