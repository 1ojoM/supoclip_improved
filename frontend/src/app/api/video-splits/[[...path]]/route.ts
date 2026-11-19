import { NextResponse } from "next/server";
import { createProxyResponse, fetchBackend } from "@/server/backend-api";
import { getServerSession } from "@/server/session";

async function proxy(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const session = await getServerSession();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { path = [] } = await params;
  const suffix = path.join("/");
  if (suffix && !/^parts\/[0-9a-f-]{36}(?:\/file)?$/.test(suffix) && suffix !== "inspect" && !/^[0-9a-f-]{36}\/cancel$/.test(suffix)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if ((request.method === "POST" && suffix.startsWith("parts/")) || (request.method === "GET" && (suffix === "inspect" || suffix.endsWith("/cancel")))) return new Response(null, { status: 405 });
  if (request.method === "DELETE" && !/^parts\/[0-9a-f-]{36}$/.test(suffix)) return new Response(null, { status: 405 });
  if (request.method === "GET" && /^parts\/[0-9a-f-]{36}$/.test(suffix)) return new Response(null, { status: 405 });
  const upstream = await fetchBackend(`/video-splits${suffix ? `/${suffix}` : ""}`, {
    method: request.method,
    userId: session.user.id,
    cache: "no-store",
    signal: request.signal,
    ...(request.method === "POST" ? { body: await request.text(), headers: { "Content-Type": "application/json" } } : {}),
  });
  return createProxyResponse(upstream);
}

export const GET = proxy;
export const POST = proxy;

export const DELETE = proxy;
