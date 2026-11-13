import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    device: null,
    projects: [],
    lifecycle: { status: "ready" },
    activeProject: null,
  });
}
