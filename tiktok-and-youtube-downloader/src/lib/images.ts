import { writeFile } from "node:fs/promises";
import path from "node:path";
import { YtError, ytThumb } from "./ytdlp";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Solo https y nunca hosts locales / IPs literales (evita SSRF). */
export function isSafeRemoteUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^[\d.]+$/.test(h) || h.includes(":")) return false;
    return true;
  } catch {
    return false;
  }
}

/** Resuelve links cortos de TikTok (vm.tiktok.com, vt.tiktok.com, /t/xxxx). */
export async function resolveTikTokUrl(url: URL): Promise<URL> {
  const host = url.hostname.toLowerCase();
  const short =
    host === "vm.tiktok.com" || host === "vt.tiktok.com" || url.pathname.startsWith("/t/");
  if (!short) return url;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    res.body?.cancel().catch(() => {});
    const final = new URL(res.url);
    if (final.hostname.toLowerCase().endsWith("tiktok.com")) return final;
  } catch {
    /* si falla, seguimos con la URL original */
  }
  return url;
}

export function isTikTokPhotoUrl(url: URL) {
  return /\/photo\/\d+/.test(url.pathname);
}

export interface PhotoPost {
  id: string;
  title: string;
  author: string;
  images: string[];
}

/** Lee las fotos de una publicación tipo carrusel de TikTok (/photo/...). */
export async function getTikTokPhotoPost(url: URL): Promise<PhotoPost> {
  let html = "";
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        "accept-language": "en-US,en;q=0.9",
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!new URL(res.url).hostname.toLowerCase().endsWith("tiktok.com")) {
      throw new YtError("Redirección inesperada.");
    }
    html = await res.text();
  } catch (e) {
    if (e instanceof YtError) throw e;
    throw new YtError("No se pudo abrir la publicación de TikTok.", "TIKTOK_FETCH");
  }

  const m = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) {
    throw new YtError(
      "TikTok no entregó los datos de la publicación (posible bloqueo de IP).",
      "TIKTOK_BLOCK",
    );
  }

  try {
    const data = JSON.parse(m[1]);
    const item = data?.["__DEFAULT_SCOPE__"]?.["webapp.video-detail"]?.itemInfo?.itemStruct;
    const imgs: string[] = (item?.imagePost?.images ?? [])
      .map((i: { imageURL?: { urlList?: string[] } }) => i?.imageURL?.urlList?.[0])
      .filter((u: unknown): u is string => typeof u === "string" && isSafeRemoteUrl(u));
    if (!imgs.length) throw new Error("sin imágenes");
    return {
      id: String(item.id || ""),
      title: String(item.desc || "TikTok").slice(0, 160),
      author: String(item.author?.uniqueId || ""),
      images: imgs,
    };
  } catch {
    throw new YtError("No se encontraron imágenes en esa publicación de TikTok.", "TIKTOK_PARSE");
  }
}

/** Mejor miniatura de YouTube disponible para un id. */
export async function bestYouTubeThumb(id: string): Promise<string> {
  for (const q of ["maxresdefault", "sddefault", "hqdefault"]) {
    const u = ytThumb(id, q);
    try {
      const res = await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(8000) });
      if (res.ok) return u;
    } catch {
      /* siguiente */
    }
  }
  return ytThumb(id, "hqdefault");
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
};

/** Descarga una imagen remota a `dir/baseName.ext` y devuelve la ruta. */
export async function downloadImage(url: string, dir: string, baseName: string) {
  if (!isSafeRemoteUrl(url)) throw new YtError("URL de imagen no permitida.");
  const res = await fetch(url, {
    headers: { "user-agent": UA, referer: "https://www.tiktok.com/" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new YtError(`No se pudo descargar la imagen (${res.status}).`);
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) throw new YtError("El recurso no es una imagen.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 30 * 1024 * 1024) throw new YtError("La imagen es demasiado grande.");
  const file = path.join(/*turbopackIgnore: true*/ dir, `${baseName}.${EXT[type] || "jpg"}`);
  await writeFile(file, buf);
  return file;
}
