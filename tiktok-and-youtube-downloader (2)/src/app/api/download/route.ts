import { Readable } from "node:stream";
import {
  AppError,
  contentDisposition,
  detectPlatform,
  normalizeInputUrl,
  safeName,
  type DownloadPayload,
} from "@/lib/common";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { logDownload } from "@/lib/stats";
import { openTikTokDownload } from "@/lib/tiktok";
import { zipSequence } from "@/lib/zip";
import {
  openYouTubeDownload,
  parseQuality,
  parseYouTube,
  resolvePlaylist,
} from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ACTIVE = Number(process.env.MAX_CONCURRENT_DOWNLOADS ?? 8);
const MAX_ZIP_ITEMS = Number(process.env.MAX_PLAYLIST_ZIP_ITEMS ?? 50);
let active = 0;

function errorResponse(req: Request, message: string, status: number) {
  const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
  if (!wantsHtml) return Response.json({ error: message }, { status });
  const esc = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No se pudo descargar</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b12;color:#e8e8f0;font-family:system-ui,sans-serif">
<div style="max-width:440px;padding:32px;text-align:center"><div style="font-size:42px">⚠️</div><h1 style="font-size:20px;margin:12px 0">No se pudo completar la descarga</h1>
<p style="color:#a3a3b8;line-height:1.5">${esc}</p><p><a href="/" style="color:#ff5c8a">← Volver al inicio</a></p></div></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const url = normalizeInputUrl(sp.get("url") ?? "");
  const q = sp.get("q") ?? "";
  const platform = detectPlatform(url);
  if (!platform || !q) return errorResponse(req, "Solicitud de descarga inválida.", 400);

  const ip = clientIp(req);
  const rl = rateLimit("dl:" + ip, 20, 60_000);
  if (!rl.ok) return errorResponse(req, `Demasiadas descargas seguidas. Espera ${rl.retryAfter}s.`, 429);

  if (active >= MAX_ACTIVE)
    return errorResponse(req, "El servidor está ocupado con otras descargas. Inténtalo en unos segundos.", 503);

  active++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      active--;
    }
  };

  try {
    let payload: DownloadPayload;
    let type = "video";
    let items = 1;

    if (platform === "tiktok") {
      payload = await openTikTokDownload(url, q, req.signal);
      type = q.startsWith("images") || q.startsWith("image:") ? "images" : "video";
    } else {
      const p = parseYouTube(url);
      if (p.listId && (p.isPlaylistPage || !p.videoId)) {
        const zipRl = rateLimit("zip:" + ip, 4, 10 * 60_000);
        if (!zipRl.ok)
          return (release(), errorResponse(req, "Límite de descargas de playlists alcanzado. Intenta más tarde.", 429));
        const quality = parseQuality(q);
        if (quality.mode === "thumb") throw new AppError("Opción no válida para playlists.");
        const playlist = await resolvePlaylist(url, p.listId);
        let list = playlist.items ?? [];
        const only = (sp.get("items") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (only.length) {
          const set = new Set(only);
          list = list.filter((i) => set.has(i.id));
        }
        if (!list.length) throw new AppError("No hay videos seleccionados.");
        if (list.length > MAX_ZIP_ITEMS)
          throw new AppError(
            `Puedes descargar hasta ${MAX_ZIP_ITEMS} videos por ZIP. Selecciona menos videos.`,
          );
        const ext = quality.mode === "mp4" ? "mp4" : quality.mode;
        const pad = String(list.length).length;
        const stream = zipSequence(
          list.map((it, n) => ({
            name: `${String(n + 1).padStart(Math.max(pad, 2), "0")} - ${safeName(it.title, 80)}.${ext}`,
            open: async () => (await openYouTubeDownload(it.id, q, { signal: req.signal })).stream,
          })),
        );
        payload = {
          stream,
          filename: `${safeName(playlist.title, 80)}.zip`,
          mime: "application/zip",
        };
        type = "playlist";
        items = list.length;
      } else if (p.videoId) {
        payload = await openYouTubeDownload(p.videoId, q, { signal: req.signal });
        type = p.isShort ? "short" : "video";
      } else {
        throw new AppError("No se reconoció el enlace de YouTube.");
      }
    }

    void logDownload({ platform, type, title: payload.filename, sourceUrl: url, option: q, items });

    const stream = payload.stream;
    stream.once("close", () => {
      release();
      payload.cleanup?.();
    });
    stream.once("error", () => stream.destroy());

    const headers: Record<string, string> = {
      "content-type": payload.mime,
      "content-disposition": contentDisposition(payload.filename),
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    };
    if (payload.size) headers["content-length"] = String(payload.size);

    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { headers });
  } catch (e) {
    release();
    if (e instanceof AppError) return errorResponse(req, e.message, e.status);
    console.error("[download]", e);
    return errorResponse(req, "Error inesperado durante la descarga.", 500);
  }
}
