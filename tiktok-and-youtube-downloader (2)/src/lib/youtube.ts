import vm from "node:vm";
import { Readable } from "node:stream";
import { Innertube, Platform } from "youtubei.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import {
  AppError,
  safeName,
  type DownloadPayload,
  type MediaOption,
  type PlaylistItem,
  type ResolveResult,
} from "./common";
import { encodeMp3, muxStreams } from "./ffmpeg";

// youtubei.js necesita un evaluador JS para descifrar las URLs de YouTube.
// Se ejecuta en un contexto aislado de `vm` (sin acceso a require/process).
Platform.shim.eval = async (data) =>
  vm.runInNewContext("(function(){" + data.output + "\n})()", Object.create(null), {
    timeout: 20000,
  });

type Info = Awaited<ReturnType<Innertube["getBasicInfo"]>>;
interface YTFormat {
  itag: number;
  mime_type: string;
  has_video?: boolean;
  has_audio?: boolean;
  height?: number;
  fps?: number;
  bitrate: number;
  content_length?: number;
}
type Client = "IOS" | "TV";

const CLIENTS: Client[] = ["IOS", "TV"];
const IOS_UA = "com.google.ios.youtube/20.11.6 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)";
const CHUNK = 1024 * 1024; // tramos pequeños: YouTube corta los rangos grandes sin PO token
const MAX_PLAYLIST_ITEMS = 200;

// Proxy opcional (YOUTUBE_PROXY=http://usuario:clave@host:puerto). Recomendado cuando el
// servidor está en un datacenter, porque YouTube limita/bloquea esas IPs.
const proxyAgent = process.env.YOUTUBE_PROXY ? new ProxyAgent(process.env.YOUTUBE_PROXY) : undefined;

/* eslint-disable @typescript-eslint/no-explicit-any */
const ytFetch: typeof fetch = ((input: any, init?: any) =>
  proxyAgent
    ? (undiciFetch as any)(input, { ...init, dispatcher: proxyAgent })
    : fetch(input, init)) as typeof fetch;
/* eslint-enable @typescript-eslint/no-explicit-any */

let ytPromise: Promise<Innertube> | null = null;
function getYT(): Promise<Innertube> {
  if (!ytPromise) {
    ytPromise = Innertube.create({
      cookie: process.env.YOUTUBE_COOKIE || undefined,
      po_token: process.env.YOUTUBE_PO_TOKEN || undefined,
      visitor_data: process.env.YOUTUBE_VISITOR_DATA || undefined,
      fetch: ytFetch,
    }).catch((e) => {
      ytPromise = null;
      throw e;
    });
  }
  return ytPromise;
}

// ---------------------------------------------------------------- URLs

export interface ParsedYouTube {
  videoId: string | null;
  listId: string | null;
  isShort: boolean;
  isPlaylistPage: boolean;
}

const ID_RE = /^[\w-]{11}$/;

export function parseYouTube(raw: string): ParsedYouTube {
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  let videoId: string | null = null;
  let isShort = false;

  if (host === "youtu.be") {
    videoId = path.slice(1).split("/")[0] || null;
  } else if (path === "/watch") {
    videoId = u.searchParams.get("v");
  } else {
    const m = path.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
    if (m) {
      videoId = m[2];
      isShort = m[1] === "shorts";
    }
  }
  if (videoId && !ID_RE.test(videoId)) videoId = null;
  const listId = u.searchParams.get("list");
  return { videoId, listId, isShort, isPlaylistPage: path === "/playlist" };
}

// ---------------------------------------------------------------- errores

function friendlyError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/not a bot|sign in to confirm/i.test(msg))
    return new AppError(
      "YouTube pidió verificación anti-bot para este servidor. Configura la variable YOUTUBE_COOKIE e inténtalo de nuevo.",
      502,
    );
  if (/private/i.test(msg)) return new AppError("El video es privado.", 422);
  if (/age/i.test(msg) && /restrict|verify|confirm/i.test(msg))
    return new AppError("El video tiene restricción de edad y no se puede descargar.", 422);
  if (/unavailable|not available|removed/i.test(msg))
    return new AppError("El video no está disponible.", 404);
  return new AppError("No se pudo obtener la información de YouTube: " + msg.slice(0, 200), 502);
}

// ---------------------------------------------------------------- info

const infoCache = new Map<string, { at: number; info: Info; client: Client }>();
const INFO_TTL = 4 * 60 * 1000;

async function loadInfo(videoId: string): Promise<{ info: Info; client: Client }> {
  const cached = infoCache.get(videoId);
  if (cached && Date.now() - cached.at < INFO_TTL) return cached;

  const yt = await getYT();
  let lastErr: unknown = null;
  for (const client of CLIENTS) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });
      const status = info.playability_status?.status;
      if (status && status !== "OK") {
        const reason = info.playability_status?.reason ?? status;
        lastErr = new Error(reason);
        continue;
      }
      if (!info.streaming_data?.adaptive_formats?.length) {
        lastErr = new Error("Sin formatos disponibles");
        continue;
      }
      const entry = { at: Date.now(), info, client };
      infoCache.set(videoId, entry);
      if (infoCache.size > 100) {
        const first = infoCache.keys().next().value;
        if (first) infoCache.delete(first);
      }
      return entry;
    } catch (e) {
      lastErr = e;
    }
  }
  throw friendlyError(lastErr);
}

function adaptive(info: Info): YTFormat[] {
  return (info.streaming_data?.adaptive_formats ?? []) as unknown as YTFormat[];
}

function codecRank(f: YTFormat): number {
  const m = f.mime_type;
  if (m.includes("avc1")) return 0;
  if (m.includes("av01")) return 1;
  return 2; // vp9 u otros
}

function videoHeights(info: Info): number[] {
  const set = new Set<number>();
  for (const f of adaptive(info)) if (f.has_video && f.height && f.height >= 144) set.add(f.height);
  return [...set].sort((a, b) => b - a);
}

function pickVideo(info: Info, maxH: number): YTFormat | null {
  const heights = videoHeights(info);
  if (!heights.length) return null;
  const target = heights.find((h) => h <= maxH) ?? heights[heights.length - 1];
  const cands = adaptive(info)
    .filter((f) => f.has_video && f.height === target)
    .sort((a, b) => codecRank(a) - codecRank(b) || b.bitrate - a.bitrate);
  return cands[0] ?? null;
}

function pickAudio(info: Info, preferM4a = true): YTFormat | null {
  const audios = adaptive(info).filter((f) => f.has_audio && !f.has_video);
  if (!audios.length) return null;
  const sorted = [...audios].sort((a, b) => {
    if (preferM4a) {
      const am = a.mime_type.includes("mp4a") ? 0 : 1;
      const bm = b.mime_type.includes("mp4a") ? 0 : 1;
      if (am !== bm) return am - bm;
    }
    return b.bitrate - a.bitrate;
  });
  return sorted[0];
}

function buildOptions(info: Info): MediaOption[] {
  const opts: MediaOption[] = [];
  const audio = pickAudio(info);
  for (const h of videoHeights(info)) {
    const v = pickVideo(info, h);
    const size =
      v?.content_length && audio?.content_length ? v.content_length + audio.content_length : undefined;
    const fps = v?.fps && v.fps > 30 ? ` ${v.fps}fps` : "";
    opts.push({
      id: `mp4:${h}`,
      label: `${h}p${fps}`,
      kind: "video",
      ext: "mp4",
      size,
      note: h >= 2160 ? "4K" : h >= 1440 ? "2K" : h >= 1080 ? "Full HD" : h >= 720 ? "HD" : undefined,
    });
  }
  opts.push({
    id: "mp3",
    label: "Solo audio · MP3",
    kind: "audio",
    ext: "mp3",
    note: "192 kbps",
  });
  opts.push({
    id: "m4a",
    label: "Solo audio · M4A",
    kind: "audio",
    ext: "m4a",
    size: audio?.content_length,
    note: "Calidad original",
  });
  opts.push({ id: "thumb", label: "Miniatura (imagen)", kind: "image", ext: "jpg" });
  return opts;
}

// ---------------------------------------------------------------- resolve

const thumbUrl = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

export async function resolveYouTube(rawUrl: string): Promise<ResolveResult> {
  const p = parseYouTube(rawUrl);
  if (p.videoId && !p.isPlaylistPage) {
    const { info } = await loadInfo(p.videoId);
    const b = info.basic_info;
    return {
      platform: "youtube",
      type: p.isShort ? "short" : "video",
      url: rawUrl,
      id: p.videoId,
      title: b.title ?? "Sin título",
      author: b.author ?? null,
      thumbnail: thumbUrl(p.videoId),
      duration: b.duration ?? null,
      options: buildOptions(info),
      playlistId: p.listId && /^(PL|UU|OLAK|FL|LL)/.test(p.listId) ? p.listId : undefined,
    };
  }
  if (p.listId) return resolvePlaylist(rawUrl, p.listId);
  throw new AppError("No se reconoció un video, short o playlist de YouTube en ese enlace.");
}

interface PlaylistNode {
  type: string;
  // PlaylistVideo
  id?: string;
  title?: { text?: string };
  duration?: { seconds?: number };
  thumbnails?: { url: string }[];
  author?: { name?: string };
  // LockupView (formato nuevo de YouTube)
  content_id?: string;
  content_type?: string;
  content_image?: { image?: { url: string }[]; overlays?: unknown[] };
  metadata?: {
    title?: { text?: string };
    metadata?: { metadata_rows?: { metadata_parts?: { text?: { text?: string } }[] }[] };
  };
}

function findClock(node: unknown, depth = 0): number | null {
  if (depth > 6 || node == null) return null;
  if (typeof node === "string") {
    const m = node.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
    if (m) return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3];
    return null;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) {
      const r = findClock(v, depth + 1);
      if (r != null) return r;
    }
  }
  return null;
}

function toPlaylistItem(n: PlaylistNode, index: number): PlaylistItem | null {
  if (n.type === "PlaylistVideo" && n.id && ID_RE.test(n.id)) {
    return {
      id: n.id,
      index,
      title: n.title?.text ?? "Video",
      thumbnail: n.thumbnails?.[0]?.url ?? thumbUrl(n.id),
      duration: n.duration?.seconds ?? null,
      author: n.author?.name ?? null,
    };
  }
  if (n.type === "LockupView" && n.content_type === "VIDEO" && n.content_id && ID_RE.test(n.content_id)) {
    return {
      id: n.content_id,
      index,
      title: n.metadata?.title?.text ?? "Video",
      thumbnail: thumbUrl(n.content_id),
      duration: findClock(n.content_image?.overlays),
      author: n.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text?.text ?? null,
    };
  }
  return null;
}

export async function resolvePlaylist(rawUrl: string, listId: string): Promise<ResolveResult> {
  const yt = await getYT();
  let pl;
  try {
    pl = await yt.getPlaylist(listId);
  } catch (e) {
    throw new AppError(
      "No se pudo cargar la playlist (¿es privada o es un Mix automático?): " +
        (e instanceof Error ? e.message.slice(0, 120) : ""),
      422,
    );
  }
  const items: PlaylistItem[] = [];
  const collect = (nodes: unknown[]) => {
    for (const n of nodes as PlaylistNode[]) {
      const item = toPlaylistItem(n, items.length + 1);
      if (item) items.push(item);
    }
  };
  collect(pl.items as unknown[]);
  let guard = 0;
  while (pl.has_continuation && items.length < MAX_PLAYLIST_ITEMS && guard++ < 20) {
    try {
      pl = await pl.getContinuation();
      collect(pl.items as unknown[]);
    } catch {
      break;
    }
  }
  if (!items.length) throw new AppError("La playlist está vacía o no es accesible.", 422);

  const totalDigits = String(pl.info.total_items ?? "").replace(/\D/g, "");
  const total = totalDigits ? parseInt(totalDigits, 10) : items.length;
  const options: MediaOption[] = [
    ...[1080, 720, 480, 360].map<MediaOption>((h) => ({
      id: `mp4:${h}`,
      label: `Video hasta ${h}p`,
      kind: "video",
      ext: "zip",
    })),
    { id: "mp3", label: "Solo audio · MP3", kind: "audio", ext: "zip" },
    { id: "m4a", label: "Solo audio · M4A", kind: "audio", ext: "zip" },
  ];
  return {
    platform: "youtube",
    type: "playlist",
    url: rawUrl,
    id: listId,
    title: pl.info.title ?? "Playlist",
    author: pl.info.author?.name ?? null,
    thumbnail: items[0].thumbnail,
    duration: null,
    options,
    items: items.slice(0, MAX_PLAYLIST_ITEMS),
    totalItems: total,
  };
}

// ---------------------------------------------------------------- download

export type YTQuality =
  | { mode: "mp4"; height: number }
  | { mode: "mp3" }
  | { mode: "m4a" }
  | { mode: "thumb" };

export function parseQuality(q: string): YTQuality {
  if (q === "mp3") return { mode: "mp3" };
  if (q === "m4a") return { mode: "m4a" };
  if (q === "thumb") return { mode: "thumb" };
  const m = q.match(/^mp4:(\d{3,4})$/);
  if (m) return { mode: "mp4", height: parseInt(m[1], 10) };
  throw new AppError("Opción de descarga no válida.");
}

/**
 * Descarga un formato por tramos (YouTube limita la velocidad de las
 * peticiones únicas grandes) y lo expone como un stream de Node.
 */
async function formatStream(
  _info: Info,
  _client: Client,
  f: YTFormat,
  signal?: AbortSignal,
): Promise<Readable> {
  let url: string;
  try {
    const yt = await getYT();
    url = await (f as unknown as { decipher(p: unknown): Promise<string> }).decipher(yt.session.player);
  } catch (e) {
    throw friendlyError(e);
  }
  const total = f.content_length;
  const headers = { "user-agent": IOS_UA, accept: "*/*" };

  async function* gen() {
    let pos = 0;
    while (!signal?.aborted) {
      const end = (total ? Math.min(pos + CHUNK, total) : pos + CHUNK) - 1;
      let res: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await ytFetch(`${url}&range=${pos}-${end}`, { headers, signal });
        if (res.ok && res.body) break;
        await res.body?.cancel();
        if (res.status === 404) break;
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
      if (!res || !res.ok || !res.body)
        throw new AppError(`YouTube rechazó la descarga (${res?.status ?? "sin respuesta"}).`, 502);
      let got = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.byteLength;
        yield chunk;
      }
      pos += got;
      if (got === 0 || (total ? pos >= total : got < CHUNK)) return;
    }
  }
  return Readable.from(gen(), { objectMode: false });
}

export async function openYouTubeDownload(
  videoId: string,
  q: string,
  opts: { prefix?: string; signal?: AbortSignal } = {},
): Promise<DownloadPayload> {
  const quality = parseQuality(q);
  const { info, client } = await loadInfo(videoId);
  const base = (opts.prefix ?? "") + safeName(info.basic_info.title ?? videoId);

  if (quality.mode === "thumb") {
    for (const name of ["maxresdefault", "sddefault", "hqdefault"]) {
      const r = await ytFetch(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`);
      if (r.ok && r.body) {
        return {
          stream: Readable.fromWeb(r.body as unknown as import("node:stream/web").ReadableStream),
          filename: `${base}.jpg`,
          mime: "image/jpeg",
          size: Number(r.headers.get("content-length")) || undefined,
        };
      }
    }
    throw new AppError("No se encontró la miniatura.", 404);
  }

  if (quality.mode === "m4a" || quality.mode === "mp3") {
    const a = pickAudio(info, true);
    if (!a) throw new AppError("Este video no tiene pista de audio descargable.", 422);
    const src = await formatStream(info, client, a, opts.signal);
    if (quality.mode === "m4a") {
      const isM4a = a.mime_type.includes("mp4a");
      return {
        stream: src,
        filename: `${base}.${isM4a ? "m4a" : "webm"}`,
        mime: isM4a ? "audio/mp4" : "audio/webm",
        size: a.content_length,
      };
    }
    return { stream: encodeMp3(src), filename: `${base}.mp3`, mime: "audio/mpeg" };
  }

  const v = pickVideo(info, quality.height);
  const a = pickAudio(info, true);
  if (!v || !a) throw new AppError("No hay formatos de video disponibles para este contenido.", 422);
  const [vs, as] = await Promise.all([
    formatStream(info, client, v, opts.signal),
    formatStream(info, client, a, opts.signal),
  ]);
  return { stream: muxStreams(vs, as), filename: `${base}.mp4`, mime: "video/mp4" };
}

export function youtubeThumb(id: string) {
  return thumbUrl(id);
}
