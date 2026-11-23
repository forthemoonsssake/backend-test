import { NextResponse } from "next/server";
import { AppError, detectPlatform, normalizeInputUrl } from "@/lib/common";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { resolveTikTok } from "@/lib/tiktok";
import { resolveYouTube } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rl = rateLimit("resolve:" + clientIp(req), 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Demasiadas solicitudes. Intenta de nuevo en ${rl.retryAfter}s.` },
      { status: 429, headers: { "retry-after": String(rl.retryAfter) } },
    );
  }

  let body: { url?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  }
  const url = normalizeInputUrl(typeof body.url === "string" ? body.url : "");
  if (!url) return NextResponse.json({ error: "Pega un enlace de YouTube o TikTok." }, { status: 400 });

  const platform = detectPlatform(url);
  if (!platform) {
    return NextResponse.json(
      { error: "Solo se admiten enlaces de YouTube y TikTok." },
      { status: 400 },
    );
  }

  try {
    const result = platform === "youtube" ? await resolveYouTube(url) : await resolveTikTok(url);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[resolve]", e);
    return NextResponse.json({ error: "Error inesperado al procesar el enlace." }, { status: 500 });
  }
}
