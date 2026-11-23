import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* Configuración (todo se controla con variables de entorno)           */
/* ------------------------------------------------------------------ */

export const YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";
export const MAX_PLAYLIST_ITEMS = Number(process.env.MAX_PLAYLIST_ITEMS || 50);
export const MAX_INFO_ITEMS = Number(process.env.MAX_INFO_ITEMS || 200);

export type Platform = "youtube" | "tiktok";

export class YtError extends Error {
  code: string;
  constructor(message: string, code = "ERROR") {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Validación de URLs                                                  */
/* ------------------------------------------------------------------ */

export function parseSupportedUrl(
  raw: string,
): { url: URL; platform: Platform } | null {
  let text = String(raw || "").trim();
  if (!text || text.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;

  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  const host = u.hostname.toLowerCase();
  const is = (d: string) => host === d || host.endsWith(`.${d}`);

  if (is("youtube.com") || host === "youtu.be") return { url: u, platform: "youtube" };
  if (is("tiktok.com")) return { url: u, platform: "tiktok" };
  return null;
}

export function youtubeVideoId(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  const idRe = /^[\w-]{11}$/;
  if (host === "youtu.be") {
    const id = u.pathname.split("/")[1];
    return id && idRe.test(id) ? id : null;
  }
  const v = u.searchParams.get("v");
  if (v && idRe.test(v)) return v;
  const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}

/** ¿La URL apunta a una lista / canal / perfil (varios videos)? */
export function isPlaylistLike(u: URL, platform: Platform): boolean {
  const p = u.pathname;
  if (platform === "youtube") {
    if (p.startsWith("/playlist")) return true;
    if (/^\/(@[^/]+|channel\/|c\/|user\/)/.test(p)) return true;
    return false;
  }
  if (/^\/@[^/]+\/?$/.test(p)) return true;
  if (/^\/@[^/]+\/(playlist|collection)\//.test(p)) return true;
  return false;
}

/** URL de video con parámetro list= (video dentro de una lista) */
export function youtubePlaylistId(u: URL): string | null {
  const list = u.searchParams.get("list");
  return list && /^[\w-]+$/.test(list) ? list : null;
}

/* ------------------------------------------------------------------ */
/* Argumentos comunes de yt-dlp                                        */
/* ------------------------------------------------------------------ */

let cookiesPath: string | null | undefined;

function getCookiesFile(): string | null {
  if (cookiesPath !== undefined) return cookiesPath;
  cookiesPath = null;
  try {
    const target = path.join(os.tmpdir(), "ytdlp-cookies.txt");
    const secretFile = process.env.YTDLP_COOKIES_FILE;
    if (secretFile && existsSync(secretFile)) {
      // yt-dlp reescribe el archivo, por eso se copia a /tmp (los Secret Files de Render son de solo lectura)
      copyFileSync(secretFile, target);
      cookiesPath = target;
    } else if (process.env.YT_COOKIES) {
      writeFileSync(target, process.env.YT_COOKIES.replace(/\\n/g, "\n"), { mode: 0o600 });
      cookiesPath = target;
    }
  } catch {
    cookiesPath = null;
  }
  return cookiesPath;
}

export function commonArgs(): string[] {
  const args = [
    "--ignore-config",
    "--no-warnings",
    "--no-colors",
    "--socket-timeout",
    "20",
    "--retries",
    "3",
    "--js-runtimes",
    "node",
  ];
  const cookies = getCookiesFile();
  if (cookies) args.push("--cookies", cookies);
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
  if (process.env.YTDLP_EXTRA_ARGS) {
    args.push(...process.env.YTDLP_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  }
  return args;
}

/* ------------------------------------------------------------------ */
/* Errores amigables                                                   */
/* ------------------------------------------------------------------ */

export function friendlyError(stderr: string): YtError {
  const s = stderr.toLowerCase();
  if (s.includes("not a bot") || s.includes("sign in to confirm")) {
    return new YtError(
      "YouTube bloqueó la IP del servidor (verificación anti-bot). El administrador debe configurar cookies (YT_COOKIES) o un proxy. Mira el README.",
      "BOT_CHECK",
    );
  }
  if (s.includes("private video")) return new YtError("El video es privado.", "PRIVATE");
  if (s.includes("age") && s.includes("restricted"))
    return new YtError("El video tiene restricción de edad (requiere cookies de una cuenta).", "AGE");
  if (s.includes("video unavailable") || s.includes("this video is not available"))
    return new YtError("El video no está disponible.", "UNAVAILABLE");
  if (s.includes("unsupported url"))
    return new YtError("Esa URL no es compatible o no contiene un video descargable.", "UNSUPPORTED");
  if (s.includes("ffmpeg") && s.includes("not found"))
    return new YtError("Falta ffmpeg en el servidor.", "NO_FFMPEG");
  if (s.includes("429") || s.includes("too many requests"))
    return new YtError("Demasiadas solicitudes. Intenta de nuevo en unos minutos.", "RATE");
  if (s.includes("ip address is blocked") || s.includes("blocked it in your country"))
    return new YtError("La plataforma bloqueó la IP o la región del servidor.", "BLOCKED");
  const line = stderr
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("ERROR:"));
  return new YtError(
    line ? line.replace(/^ERROR:\s*/, "").slice(0, 300) : "No se pudo procesar la URL.",
    "ERROR",
  );
}

/* ------------------------------------------------------------------ */
/* Ejecutar yt-dlp                                                     */
/* ------------------------------------------------------------------ */

export function spawnYtdlp(args: string[]): ChildProcess {
  return spawn(/*turbopackIgnore: true*/ YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
}

export function runJson(args: string[], timeoutMs = 90_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawnYtdlp([...commonArgs(), ...args]);
    let out = "";
    let err = "";
    let size = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new YtError("La plataforma tardó demasiado en responder.", "TIMEOUT"));
    }, timeoutMs);

    child.stdout!.on("data", (d: Buffer) => {
      size += d.length;
      if (size > 80 * 1024 * 1024) {
        child.kill("SIGKILL");
        return;
      }
      out += d.toString();
    });
    child.stderr!.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-8000);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new YtError(
          e.code === "ENOENT"
            ? "yt-dlp no está instalado en el servidor."
            : `No se pudo ejecutar yt-dlp: ${e.message}`,
          "NO_YTDLP",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) return reject(friendlyError(err));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new YtError("Respuesta inválida de yt-dlp."));
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Información de video / lista                                        */
/* ------------------------------------------------------------------ */

export interface EntryInfo {
  index: number;
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  url: string;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function ytThumb(id: string, quality = "mqdefault") {
  return `https://i.ytimg.com/vi/${id}/${quality}.jpg`;
}

function bestThumb(r: Raw): string | null {
  if (typeof r.thumbnail === "string") return r.thumbnail;
  if (Array.isArray(r.thumbnails) && r.thumbnails.length) {
    const t = r.thumbnails[r.thumbnails.length - 1];
    if (t?.url) return t.url as string;
  }
  return null;
}

export async function getPlaylistInfo(url: string, platform: Platform) {
  const r = (await runJson(
    [
      "-J",
      "--flat-playlist",
      "--yes-playlist",
      "--playlist-end",
      String(MAX_INFO_ITEMS),
      "--",
      url,
    ],
    120_000,
  )) as Raw;

  const rawEntries: Raw[] = Array.isArray(r.entries) ? r.entries.filter(Boolean) : [];
  const entries: EntryInfo[] = rawEntries.map((e, i) => {
    const id = String(e.id ?? i);
    let thumb = bestThumb(e);
    let entryUrl = String(e.url || e.webpage_url || "");
    if (platform === "youtube") {
      if (!thumb && /^[\w-]{11}$/.test(id)) thumb = ytThumb(id);
      if (!/^https?:/.test(entryUrl)) entryUrl = `https://www.youtube.com/watch?v=${id}`;
    }
    return {
      index: i + 1,
      id,
      title: String(e.title || e.description || `Video ${i + 1}`).slice(0, 160),
      thumbnail: thumb,
      duration: typeof e.duration === "number" ? e.duration : null,
      url: entryUrl,
    };
  });

  return {
    title: String(r.title || "Lista"),
    uploader: String(r.uploader || r.channel || r.uploader_id || ""),
    entries,
    truncated: Number(r.playlist_count || 0) > entries.length,
    total: Number(r.playlist_count || entries.length),
  };
}

export async function getVideoInfo(url: string) {
  const r = (await runJson(["-J", "--no-playlist", "--", url])) as Raw;
  const formats: Raw[] = Array.isArray(r.formats) ? r.formats : [];
  const heights = Array.from(
    new Set(
      formats
        .filter((f) => f.vcodec && f.vcodec !== "none" && typeof f.height === "number")
        .map((f) => f.height as number),
    ),
  ).sort((a, b) => b - a);

  return {
    id: String(r.id || ""),
    title: String(r.title || r.description || "Video").slice(0, 200),
    uploader: String(r.uploader || r.channel || ""),
    duration: typeof r.duration === "number" ? r.duration : null,
    thumbnail: bestThumb(r),
    heights,
  };
}

/** Para videos con list=… devuelve la URL canónica de la lista. */
export function canonicalPlaylistUrl(u: URL, platform: Platform): string {
  if (platform === "youtube" && !isPlaylistLike(u, platform)) {
    const list = youtubePlaylistId(u);
    if (list) return `https://www.youtube.com/playlist?list=${list}`;
  }
  return u.toString();
}
