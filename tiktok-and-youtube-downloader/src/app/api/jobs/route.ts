import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { createJob, type JobSpec, type Kind } from "@/lib/jobs";
import {
  MAX_INFO_ITEMS,
  MAX_PLAYLIST_ITEMS,
  YtError,
  canonicalPlaylistUrl,
  parseSupportedUrl,
} from "@/lib/ytdlp";

export const dynamic = "force-dynamic";

function fail(message: string, status = 400, code = "ERROR") {
  return NextResponse.json({ error: message, code }, { status });
}

export async function POST(req: Request) {
  if (!rateLimit(req, "jobs", 15)) return fail("Demasiadas solicitudes, espera un minuto.", 429, "RATE");

  const body = (await req.json().catch(() => null)) as {
    url?: string;
    kind?: string;
    quality?: string;
    playlist?: boolean;
    items?: unknown;
  } | null;

  const parsed = parseSupportedUrl(body?.url ?? "");
  if (!parsed) return fail("Enlace no válido.", 400, "INVALID_URL");

  const kind = body?.kind as Kind;
  if (!["video", "audio", "image"].includes(kind)) return fail("Tipo de descarga no válido.");

  const quality = /^\d{3,4}$/.test(String(body?.quality)) ? String(body?.quality) : "best";
  const playlist = body?.playlist === true;

  let items: number[] = [];
  if (playlist) {
    const raw = Array.isArray(body?.items) ? body.items : [];
    items = Array.from(
      new Set(
        raw
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_INFO_ITEMS),
      ),
    ).sort((a, b) => a - b);
    if (!items.length) return fail("Selecciona al menos un elemento de la lista.");
    if (items.length > MAX_PLAYLIST_ITEMS) {
      return fail(`Máximo ${MAX_PLAYLIST_ITEMS} elementos por descarga.`);
    }
  }

  const spec: JobSpec = {
    url: playlist ? canonicalPlaylistUrl(parsed.url, parsed.platform) : parsed.url.toString(),
    platform: parsed.platform,
    kind,
    quality,
    playlist,
    items,
  };

  try {
    const id = await createJob(spec);
    return NextResponse.json({ id });
  } catch (e) {
    if (e instanceof YtError) return fail(e.message, e.code === "BUSY" ? 503 : 400, e.code);
    return fail("No se pudo iniciar la descarga.", 500);
  }
}
