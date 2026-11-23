import { ZipArchive } from "archiver";
import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  YtError,
  commonArgs,
  friendlyError,
  getPlaylistInfo,
  getVideoInfo,
  spawnYtdlp,
  youtubeVideoId,
  type Platform,
} from "./ytdlp";
import {
  bestYouTubeThumb,
  downloadImage,
  getTikTokPhotoPost,
  isTikTokPhotoUrl,
  resolveTikTokUrl,
} from "./images";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

export type Kind = "video" | "audio" | "image";

export interface JobSpec {
  url: string;
  platform: Platform;
  kind: Kind;
  quality: string; // "best" | "1080" | "720" ...
  playlist: boolean;
  items: number[]; // índices (1-based) elegidos de la lista
}

interface Job {
  id: string;
  spec: JobSpec;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  message: string;
  error?: string;
  errorCode?: string;
  dir: string;
  filePath?: string;
  fileName?: string;
  size?: number;
  mime?: string;
  createdAt: number;
  finishedAt?: number;
  child?: ChildProcess;
  cancelled?: boolean;
}

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS || 2);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 20);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MINUTES || 15) * 60_000;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MINUTES || 30) * 60_000;
const BASE_DIR = path.join(os.tmpdir(), "dl-jobs");

interface Store {
  jobs: Map<string, Job>;
  queue: string[];
  active: number;
  sweeper?: NodeJS.Timeout;
  initialized: boolean;
}

const g = globalThis as typeof globalThis & { __dlStore?: Store };
const store: Store = (g.__dlStore ??= {
  jobs: new Map(),
  queue: [],
  active: 0,
  initialized: false,
});

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

export async function createJob(spec: JobSpec) {
  await ensureInit();
  if (store.queue.length >= MAX_QUEUE) {
    throw new YtError("El servidor está ocupado. Intenta de nuevo en un momento.", "BUSY");
  }
  const id = randomUUID();
  const job: Job = {
    id,
    spec,
    status: "queued",
    progress: 0,
    message: "En cola…",
    dir: path.join(BASE_DIR, id),
    createdAt: Date.now(),
  };
  store.jobs.set(id, job);
  store.queue.push(id);
  pump();
  return id;
}

export function getJob(id: string) {
  return store.jobs.get(id);
}

export function publicJob(job: Job) {
  const position = job.status === "queued" ? store.queue.indexOf(job.id) + 1 : 0;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    errorCode: job.errorCode,
    fileName: job.fileName,
    size: job.size,
    position,
  };
}

export function cancelJob(job: Job) {
  job.cancelled = true;
  job.child?.kill("SIGKILL");
  if (job.status === "queued" || job.status === "running") {
    job.status = "error";
    job.error = "Cancelado.";
    job.errorCode = "CANCELLED";
    job.finishedAt = Date.now();
  }
}

/* ------------------------------------------------------------------ */
/* Cola y mantenimiento                                                */
/* ------------------------------------------------------------------ */

async function ensureInit() {
  if (store.initialized) return;
  store.initialized = true;
  await rm(BASE_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(BASE_DIR, { recursive: true });
  store.sweeper = setInterval(sweep, 60_000);
  store.sweeper.unref?.();
}

function sweep() {
  const now = Date.now();
  for (const job of store.jobs.values()) {
    if (job.status === "running" && now - job.createdAt > JOB_TIMEOUT_MS) cancelJob(job);
    if (
      (job.status === "done" || job.status === "error") &&
      job.finishedAt &&
      now - job.finishedAt > JOB_TTL_MS
    ) {
      rm(job.dir, { recursive: true, force: true }).catch(() => {});
      store.jobs.delete(job.id);
    }
  }
}

function pump() {
  while (store.active < MAX_CONCURRENT && store.queue.length) {
    const id = store.queue.shift()!;
    const job = store.jobs.get(id);
    if (!job || job.status !== "queued") continue;
    store.active++;
    run(job).finally(() => {
      store.active--;
      pump();
    });
  }
}

async function run(job: Job) {
  job.status = "running";
  job.message = "Preparando…";
  const filesDir = path.join(job.dir, "files");
  try {
    await mkdir(filesDir, { recursive: true });
    if (job.spec.kind === "image") await runImages(job, filesDir);
    else await runYtdlp(job, filesDir);
    if (job.cancelled) return;
    await finalize(job, filesDir);
    job.status = "done";
    job.progress = 100;
    job.message = "¡Listo!";
  } catch (e) {
    if (job.cancelled) return;
    job.status = "error";
    job.error = e instanceof Error ? e.message : "Error desconocido.";
    job.errorCode = e instanceof YtError ? e.code : "ERROR";
  } finally {
    job.finishedAt = Date.now();
    job.child = undefined;
    if (job.status === "error") rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Video / audio con yt-dlp                                            */
/* ------------------------------------------------------------------ */

function formatArgs(kind: Kind, quality: string): string[] {
  if (kind === "audio") {
    return ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"];
  }
  const sort =
    quality === "best" ? "res,vcodec:h264,acodec:aac" : `res:${quality},vcodec:h264,acodec:aac`;
  return ["-f", "bv*+ba/b", "-S", sort, "--merge-output-format", "mp4"];
}

function runYtdlp(job: Job, filesDir: string): Promise<void> {
  const { spec } = job;
  const total = spec.playlist ? Math.max(1, spec.items.length) : 1;
  const streams = spec.kind === "video" && spec.platform === "youtube" ? 2 : 1;

  const template = spec.playlist
    ? "%(playlist_index)03d - %(title).80B [%(id)s].%(ext)s"
    : spec.platform === "tiktok"
      ? "%(uploader|tiktok)s - %(id)s.%(ext)s"
      : "%(title).100B [%(id)s].%(ext)s";

  const args = [
    ...commonArgs(),
    "--newline",
    "--no-mtime",
    "-N",
    "4",
    ...(spec.playlist
      ? ["--yes-playlist", "--playlist-items", spec.items.join(","), "-i"]
      : ["--no-playlist"]),
    ...formatArgs(spec.kind, spec.quality),
    "-o",
    path.join(filesDir, template),
    "--",
    spec.url,
  ];

  return new Promise((resolve, reject) => {
    const child = spawnYtdlp(args);
    job.child = child;
    job.message = "Descargando…";

    let itemIdx = 1;
    let streamIdx = 0;
    let pct = 0;
    let err = "";
    let outBuf = "";
    let spawnError: Error | null = null;

    const update = () => {
      const s = Math.max(1, Math.min(streamIdx, streams));
      const within = (s - 1 + pct / 100) / streams;
      const overall = Math.round((((itemIdx - 1) + within) / total) * 95);
      job.progress = Math.max(job.progress, Math.min(95, overall));
    };

    const handle = (line: string) => {
      const item = line.match(/Downloading item (\d+) of (\d+)/);
      if (item) {
        itemIdx = Number(item[1]);
        streamIdx = 0;
        pct = 0;
        job.message = `Descargando ${itemIdx} de ${total}…`;
      }
      if (line.startsWith("[download] Destination:")) streamIdx++;
      const p = line.match(/^\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (p) {
        pct = Number(p[1]);
        update();
      }
      if (/^\[(Merger|ExtractAudio|VideoRemuxer|FixupM3u8|ffmpeg)\]/.test(line)) {
        job.message = spec.playlist ? `Procesando ${itemIdx} de ${total}…` : "Procesando…";
      }
    };

    child.stdout!.on("data", (d: Buffer) => {
      outBuf += d.toString();
      const lines = outBuf.split("\n");
      outBuf = lines.pop() ?? "";
      lines.forEach(handle);
    });
    child.stderr!.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-8000);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      spawnError = e;
      reject(
        new YtError(
          e.code === "ENOENT"
            ? "yt-dlp no está instalado en el servidor."
            : `No se pudo ejecutar yt-dlp: ${e.message}`,
          "NO_YTDLP",
        ),
      );
    });
    child.on("close", async (code) => {
      if (spawnError) return;
      if (job.cancelled) return resolve();
      const files = await listFiles(filesDir);
      if (files.length === 0) return reject(friendlyError(err));
      if (code !== 0 && !spec.playlist) return reject(friendlyError(err));
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Imágenes                                                            */
/* ------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, "0");

async function collectImages(spec: JobSpec): Promise<{ url: string; name: string }[]> {
  const url = new URL(spec.url);

  if (spec.playlist) {
    const info = await getPlaylistInfo(spec.url, spec.platform);
    const wanted = new Set(spec.items);
    const chosen = info.entries.filter((e) => wanted.has(e.index));
    const out: { url: string; name: string }[] = [];
    for (const e of chosen) {
      if (spec.platform === "youtube" && /^[\w-]{11}$/.test(e.id)) {
        out.push({ url: await bestYouTubeThumb(e.id), name: `${pad(e.index)}_youtube_${e.id}` });
      } else if (e.thumbnail) {
        out.push({ url: e.thumbnail, name: `${pad(e.index)}_${spec.platform}_${e.id}` });
      }
    }
    return out;
  }

  if (spec.platform === "youtube") {
    const id = youtubeVideoId(url);
    if (!id) throw new YtError("No se pudo identificar el video de YouTube.");
    return [{ url: await bestYouTubeThumb(id), name: `youtube_${id}` }];
  }

  const resolved = await resolveTikTokUrl(url);
  if (isTikTokPhotoUrl(resolved)) {
    const post = await getTikTokPhotoPost(resolved);
    return post.images.map((u, i) => ({
      url: u,
      name: `tiktok_${post.id || "foto"}_${pad(i + 1)}`,
    }));
  }
  const info = await getVideoInfo(resolved.toString());
  if (!info.thumbnail) throw new YtError("Este video no tiene portada disponible.");
  return [{ url: info.thumbnail, name: `tiktok_${info.id}_portada` }];
}

async function runImages(job: Job, filesDir: string) {
  job.message = "Buscando imágenes…";
  const images = await collectImages(job.spec);
  if (!images.length) throw new YtError("No se encontraron imágenes.");

  let ok = 0;
  let lastErr: unknown;
  for (let i = 0; i < images.length; i++) {
    if (job.cancelled) return;
    job.message = images.length > 1 ? `Descargando imagen ${i + 1} de ${images.length}…` : "Descargando imagen…";
    try {
      await downloadImage(images[i].url, filesDir, images[i].name);
      ok++;
    } catch (e) {
      lastErr = e;
    }
    job.progress = Math.round(((i + 1) / images.length) * 95);
  }
  if (!ok) throw lastErr instanceof Error ? lastErr : new YtError("No se pudieron descargar las imágenes.");
}

/* ------------------------------------------------------------------ */
/* Resultado final (archivo único o ZIP)                               */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  opus: "audio/ogg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heic: "image/heic",
  zip: "application/zip",
};

async function listFiles(dir: string) {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => !/\.(part|ytdl|temp|tmp)$/i.test(n) && !n.includes(".temp."));
}

function zipFiles(dir: string, files: string[], out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(out);
    const archive = new ZipArchive({ store: true });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    for (const f of files.sort()) archive.file(path.join(dir, f), { name: f });
    archive.finalize().catch(reject);
  });
}

async function finalize(job: Job, filesDir: string) {
  const files = await listFiles(filesDir);
  if (!files.length) throw new YtError("No se generó ningún archivo.");

  let filePath: string;
  let fileName: string;

  if (files.length === 1) {
    fileName = files[0];
    filePath = path.join(filesDir, fileName);
  } else {
    job.message = "Creando ZIP…";
    const label = job.spec.kind === "image" ? "imagenes" : job.spec.playlist ? "lista" : "archivos";
    fileName = `${job.spec.platform}-${label}.zip`;
    filePath = path.join(job.dir, fileName);
    await zipFiles(filesDir, files, filePath);
  }

  const st = await stat(filePath);
  job.filePath = filePath;
  job.fileName = fileName;
  job.size = st.size;
  job.mime = MIME[path.extname(fileName).slice(1).toLowerCase()] || "application/octet-stream";
}
