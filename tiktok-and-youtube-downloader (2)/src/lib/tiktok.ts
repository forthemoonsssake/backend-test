import { Readable } from "node:stream";
import {
  AppError,
  BROWSER_UA,
  safeName,
  type DownloadPayload,
  type MediaOption,
  type ResolveResult,
} from "./common";
import { zipSequence } from "./zip";

interface TikTokInfo {
  id: string;
  title: string;
  author: string | null;
  thumbnail: string | null;
  duration: number | null;
  videoUrl: string | null;
  videoSize?: number;
  audioUrl: string | null;
  audioTitle: string | null;
  images: string[];
  headers: Record<string, string>;
}

const cache = new Map<string, { at: number; info: TikTokInfo }>();
const TTL = 3 * 60 * 1000;

// ---------------------------------------------------------------- helpers

async function expandUrl(raw: string): Promise<string> {
  const u = new URL(raw);
  const h = u.hostname.toLowerCase();
  const isShort = h === "vm.tiktok.com" || h === "vt.tiktok.com" || u.pathname.startsWith("/t/");
  if (!isShort) return raw;
  const res = await fetch(raw, { redirect: "follow", headers: { "user-agent": BROWSER_UA } });
  await res.body?.cancel();
  return res.url || raw;
}

function extractId(url: string): string | null {
  const m = url.match(/\/(?:video|photo)\/(\d{6,25})/);
  return m ? m[1] : null;
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

// ---------------------------------------------------------------- scraping directo

interface RawItem {
  id?: string;
  desc?: string;
  video?: {
    duration?: number;
    cover?: string;
    originCover?: string;
    playAddr?: string;
    bitrateInfo?: {
      CodecType?: string;
      PlayAddr?: { UrlList?: string[]; DataSize?: string | number };
    }[];
  };
  author?: { uniqueId?: string; nickname?: string };
  music?: { playUrl?: string; title?: string };
  imagePost?: {
    images?: { imageURL?: { urlList?: string[] } }[];
    cover?: { imageURL?: { urlList?: string[] } };
  };
}

async function scrape(rawUrl: string): Promise<TikTokInfo> {
  const expanded = await expandUrl(rawUrl);
  const u = new URL(expanded);
  u.search = "";
  const res = await fetch(u.toString(), {
    redirect: "follow",
    headers: {
      "user-agent": BROWSER_UA,
      "accept-language": "en-US,en;q=0.9",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error("TikTok respondió " + res.status);
  const html = await res.text();
  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  const m = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) throw new Error("No se encontraron datos en la página");
  const data = JSON.parse(m[1]);
  const detail = data?.__DEFAULT_SCOPE__?.["webapp.video-detail"];
  const item: RawItem | undefined = detail?.itemInfo?.itemStruct;
  if (!item) {
    const code = detail?.statusCode;
    if (code === 10204 || code === 10216) throw new AppError("El video no existe o fue eliminado.", 404);
    if (code === 10222) throw new AppError("El video es privado.", 422);
    throw new Error("Respuesta sin datos (código " + code + ")");
  }

  const images = (item.imagePost?.images ?? [])
    .map((i) => pickString(i.imageURL?.urlList?.[0]))
    .filter((x): x is string => !!x);

  let videoUrl: string | null = null;
  let videoSize: number | undefined;
  if (!images.length && item.video) {
    const h264 = (item.video.bitrateInfo ?? [])
      .filter((b) => (b.CodecType ?? "").includes("h264") && b.PlayAddr?.UrlList?.[0])
      .sort((a, b) => Number(b.PlayAddr?.DataSize ?? 0) - Number(a.PlayAddr?.DataSize ?? 0));
    if (h264[0]) {
      videoUrl = h264[0].PlayAddr!.UrlList![0];
      videoSize = Number(h264[0].PlayAddr?.DataSize) || undefined;
    } else {
      videoUrl = pickString(item.video.playAddr);
    }
  }
  if (!videoUrl && !images.length) throw new Error("No se encontró el archivo de video");

  return {
    id: item.id ?? extractId(expanded) ?? "tiktok",
    title: item.desc?.trim() || `TikTok ${item.id ?? ""}`.trim(),
    author: item.author?.uniqueId ? "@" + item.author.uniqueId : (item.author?.nickname ?? null),
    thumbnail:
      pickString(item.video?.originCover) ??
      pickString(item.video?.cover) ??
      pickString(item.imagePost?.cover?.imageURL?.urlList?.[0]) ??
      images[0] ??
      null,
    duration: item.video?.duration ?? null,
    videoUrl,
    videoSize,
    audioUrl: pickString(item.music?.playUrl),
    audioTitle: pickString(item.music?.title),
    images,
    headers: {
      "user-agent": BROWSER_UA,
      referer: "https://www.tiktok.com/",
      ...(cookies ? { cookie: cookies } : {}),
    },
  };
}

// ---------------------------------------------------------------- respaldo (tikwm)

interface TikwmData {
  id?: string;
  title?: string;
  cover?: string;
  origin_cover?: string;
  duration?: number;
  play?: string;
  hdplay?: string;
  size?: number;
  hd_size?: number;
  music?: string;
  music_info?: { title?: string };
  images?: string[];
  author?: { unique_id?: string; nickname?: string };
}

async function viaTikwm(rawUrl: string): Promise<TikTokInfo> {
  const res = await fetch("https://www.tikwm.com/api/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": BROWSER_UA },
    body: new URLSearchParams({ url: rawUrl, hd: "1" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("tikwm " + res.status);
  const json = (await res.json()) as { code?: number; msg?: string; data?: TikwmData };
  if (json.code !== 0 || !json.data) throw new Error(json.msg || "tikwm sin datos");
  const d = json.data;
  const abs = (p?: string) => (p ? (p.startsWith("http") ? p : "https://www.tikwm.com" + p) : null);
  return {
    id: d.id ?? "tiktok",
    title: d.title?.trim() || `TikTok ${d.id ?? ""}`,
    author: d.author?.unique_id ? "@" + d.author.unique_id : (d.author?.nickname ?? null),
    thumbnail: abs(d.origin_cover) ?? abs(d.cover),
    duration: d.duration ?? null,
    videoUrl: d.images?.length ? null : (abs(d.hdplay) ?? abs(d.play)),
    videoSize: d.hd_size || d.size || undefined,
    audioUrl: abs(d.music),
    audioTitle: d.music_info?.title ?? null,
    images: d.images ?? [],
    headers: { "user-agent": BROWSER_UA },
  };
}

// ---------------------------------------------------------------- API pública

async function loadTikTok(rawUrl: string): Promise<TikTokInfo> {
  const hit = cache.get(rawUrl);
  if (hit && Date.now() - hit.at < TTL) return hit.info;

  let info: TikTokInfo;
  try {
    info = await scrape(rawUrl);
  } catch (e) {
    if (e instanceof AppError) throw e;
    try {
      info = await viaTikwm(rawUrl);
    } catch (e2) {
      throw new AppError(
        "No se pudo obtener el TikTok (" +
          (e instanceof Error ? e.message : "error") +
          "). Verifica que el enlace sea de un video o galería pública.",
        502,
      );
    }
  }
  cache.set(rawUrl, { at: Date.now(), info });
  if (cache.size > 100) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return info;
}

export function validateTikTokUrl(raw: string) {
  const u = new URL(raw);
  const h = u.hostname.toLowerCase();
  const isShort = h === "vm.tiktok.com" || h === "vt.tiktok.com" || u.pathname.startsWith("/t/");
  if (!isShort && !/\/(video|photo)\/\d+/.test(u.pathname)) {
    if (/^\/@[^/]+\/?$/.test(u.pathname))
      throw new AppError(
        "Los perfiles de TikTok no se pueden descargar completos. Pega el enlace de un video o galería concreta.",
      );
    throw new AppError("No se reconoció un video o galería de TikTok en ese enlace.");
  }
}

export async function resolveTikTok(rawUrl: string): Promise<ResolveResult> {
  validateTikTokUrl(rawUrl);
  const info = await loadTikTok(rawUrl);
  const isImages = info.images.length > 0;
  const options: MediaOption[] = [];
  if (isImages) {
    options.push({
      id: "images-zip",
      label: `Todas las imágenes (${info.images.length})`,
      kind: "zip",
      ext: "zip",
    });
  } else {
    options.push({
      id: "video",
      label: "Video · MP4 sin marca de agua",
      kind: "video",
      ext: "mp4",
      size: info.videoSize,
      note: "Mejor calidad",
    });
  }
  if (info.audioUrl)
    options.push({
      id: "audio",
      label: "Audio original · MP3",
      kind: "audio",
      ext: "mp3",
      note: info.audioTitle ?? undefined,
    });
  if (!isImages && info.thumbnail)
    options.push({ id: "cover", label: "Portada (imagen)", kind: "image", ext: "jpg" });

  return {
    platform: "tiktok",
    type: isImages ? "images" : "video",
    url: rawUrl,
    id: info.id,
    title: info.title,
    author: info.author,
    thumbnail: info.thumbnail,
    duration: info.duration,
    options,
    images: info.images.map((url, i) => ({ index: i + 1, url })),
  };
}

async function upstream(url: string, headers: Record<string, string>, signal?: AbortSignal) {
  const res = await fetch(url, { headers, redirect: "follow", signal });
  if (!res.ok || !res.body)
    throw new AppError("TikTok rechazó la descarga del archivo (" + res.status + ").", 502);
  return res;
}

function extFromType(type: string | null, fallback: string): string {
  if (!type) return fallback;
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("heic")) return "heic";
  if (type.includes("mpeg")) return "mp3";
  if (type.includes("mp4")) return fallback === "mp3" ? "m4a" : "mp4";
  return fallback;
}

export async function openTikTokDownload(
  rawUrl: string,
  q: string,
  signal?: AbortSignal,
): Promise<DownloadPayload> {
  validateTikTokUrl(rawUrl);
  const info = await loadTikTok(rawUrl);
  const base = safeName(info.title, 80);
  const idTag = info.id;

  const toPayload = async (
    url: string,
    name: string,
    defaultExt: string,
    mimeFallback: string,
  ): Promise<DownloadPayload> => {
    const res = await upstream(url, info.headers, signal);
    const type = res.headers.get("content-type");
    const ext = extFromType(type, defaultExt);
    return {
      stream: Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream),
      filename: `${name}.${ext}`,
      mime: type && !type.includes("octet") ? type : mimeFallback,
      size: Number(res.headers.get("content-length")) || undefined,
    };
  };

  if (q === "video") {
    if (!info.videoUrl) throw new AppError("Este contenido no tiene video.", 422);
    return toPayload(info.videoUrl, `${base} [${idTag}]`, "mp4", "video/mp4");
  }
  if (q === "audio") {
    if (!info.audioUrl) throw new AppError("Este contenido no tiene audio.", 422);
    return toPayload(info.audioUrl, `${base} - audio`, "mp3", "audio/mpeg");
  }
  if (q === "cover") {
    if (!info.thumbnail) throw new AppError("No hay portada disponible.", 404);
    return toPayload(info.thumbnail, `${base} - portada`, "jpg", "image/jpeg");
  }
  const im = q.match(/^image:(\d{1,3})$/);
  if (im) {
    const url = info.images[parseInt(im[1], 10) - 1];
    if (!url) throw new AppError("Imagen no encontrada.", 404);
    return toPayload(url, `${base} - ${im[1]}`, "jpg", "image/jpeg");
  }
  if (q === "images-zip") {
    if (!info.images.length) throw new AppError("Este contenido no tiene imágenes.", 422);
    const pad = String(info.images.length).length;
    const stream = zipSequence(
      info.images.map((url, i) => ({
        name: `${String(i + 1).padStart(pad, "0")}.jpg`,
        open: async () => {
          const res = await upstream(url, info.headers, signal);
          return Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
        },
      })),
    );
    return { stream, filename: `${base} [${idTag}].zip`, mime: "application/zip" };
  }
  throw new AppError("Opción de descarga no válida.");
}
