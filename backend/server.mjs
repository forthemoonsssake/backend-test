// Backend de descargas de YouTube (yt-dlp + ffmpeg). Sin dependencias npm.
import http from "node:http";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT || 10000);
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const MAX_DURATION = Number(process.env.MAX_DURATION_SECONDS || 7200);
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 15 * 60 * 1000);
const AUTO_UPDATE = (process.env.AUTO_UPDATE || "true") === "true";
const COOKIES_PATH = path.join(tmpdir(), "yt-cookies.txt");
let hasCookies = false;
let activeDownloads = 0;
let ytdlpVersion = "unknown";

/* ---------- utilidades ---------- */

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

function parseYouTubeUrl(input) {
  try {
    const u = new URL(String(input || "").trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!YT_HOSTS.has(u.hostname.toLowerCase())) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ""))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition,Content-Length");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const hits = new Map();
function rateLimited(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_LIMIT_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    const fresh = list.filter((t) => now - t < 60_000);
    if (fresh.length) hits.set(ip, fresh);
    else hits.delete(ip);
  }
}, 60_000).unref();

function baseArgs() {
  const args = ["--no-playlist", "--no-warnings", "--no-progress", "--js-runtimes", "node"];
  if (hasCookies) args.push("--cookies", COOKIES_PATH);
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
  if (process.env.YTDLP_EXTRA_ARGS) args.push(...process.env.YTDLP_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  return args;
}

function run(args, { timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, child });
    });
    run.last = child;
  });
}

function friendlyError(stderr) {
  const s = stderr.toLowerCase();
  if (s.includes("sign in to confirm") || s.includes("not a bot"))
    return "YouTube bloqueó la solicitud del servidor (verificación anti-bot). El administrador debe configurar cookies (YOUTUBE_COOKIES).";
  if (s.includes("private video")) return "Este video es privado.";
  if (s.includes("age") && s.includes("confirm your age")) return "Este video tiene restricción de edad.";
  if (s.includes("video unavailable") || s.includes("this video is not available"))
    return "El video no está disponible.";
  if (s.includes("live event") || s.includes("is live")) return "Las transmisiones en vivo no se pueden descargar.";
  if (s.includes("copyright")) return "El video está bloqueado por derechos de autor.";
  if (s.includes("unsupported url") || s.includes("is not a valid url")) return "Enlace no soportado.";
  if (s.includes("enoent")) return "yt-dlp no está instalado en el servidor.";
  return "No se pudo procesar el video. Inténtalo de nuevo más tarde.";
}

function safeName(name) {
  const cleaned = String(name || "youtube")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return cleaned || "youtube";
}

function contentDisposition(name, ext) {
  const full = `${safeName(name)}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full)}`;
}

/* ---------- /api/info ---------- */

function buildInfo(j) {
  const formats = Array.isArray(j.formats) ? j.formats : [];
  const size = (f) => f.filesize || f.filesize_approx || 0;
  const videoFmts = formats.filter((f) => f.vcodec && f.vcodec !== "none" && f.height);
  const audioFmts = formats.filter((f) => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none");
  const bestAudio = audioFmts.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
  const audioSize = bestAudio ? size(bestAudio) : 0;

  const byHeight = new Map();
  for (const f of videoFmts) {
    const cur = byHeight.get(f.height);
    if (!cur || (f.tbr || 0) > (cur.tbr || 0)) byHeight.set(f.height, f);
  }
  const videos = [...byHeight.entries()]
    .filter(([h]) => h >= 144)
    .sort((a, b) => b[0] - a[0])
    .map(([height, f]) => ({
      height,
      label: height >= 2160 ? `${height}p (4K)` : height >= 1440 ? `${height}p (2K)` : `${height}p`,
      fps: f.fps || undefined,
      size: size(f) ? size(f) + audioSize : undefined,
    }));

  return {
    id: j.id,
    title: j.title || "",
    channel: j.channel || j.uploader || "",
    thumbnail: j.thumbnail || `https://i.ytimg.com/vi/${j.id}/hqdefault.jpg`,
    duration: j.duration || 0,
    views: j.view_count || 0,
    likes: j.like_count || 0,
    isShort: typeof j.webpage_url === "string" && j.webpage_url.includes("/shorts/"),
    videos,
    audio: [
      { format: "mp3", label: "MP3", size: undefined },
      { format: "m4a", label: "M4A (mejor calidad)", size: audioSize || undefined },
    ],
  };
}

async function handleInfo(req, res, rawUrl) {
  const url = parseYouTubeUrl(rawUrl);
  if (!url) return sendJson(res, 400, { error: "Pega un enlace válido de YouTube." });
  const r = await run([...baseArgs(), "-J", "--", url], { timeout: 60_000 });
  if (r.code !== 0) {
    console.error("[info] yt-dlp error:", r.stderr.slice(-800));
    return sendJson(res, 502, { error: friendlyError(r.stderr) });
  }
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return sendJson(res, 502, { error: "Respuesta inválida de yt-dlp." });
  }
  if (json.is_live) return sendJson(res, 422, { error: "Las transmisiones en vivo no se pueden descargar." });
  if (json.duration && json.duration > MAX_DURATION)
    return sendJson(res, 422, {
      error: `El video supera el límite de ${Math.round(MAX_DURATION / 60)} minutos de este servidor.`,
    });
  return sendJson(res, 200, buildInfo(json));
}

/* ---------- /api/download ---------- */

async function handleDownload(req, res, params) {
  const url = parseYouTubeUrl(params.get("url"));
  if (!url) return sendJson(res, 400, { error: "Enlace de YouTube inválido." });
  const kind = params.get("kind");
  const name = params.get("name") || "youtube";

  let fmtArgs;
  let ext;
  if (kind === "video") {
    const h = Number.parseInt(params.get("height") || "", 10);
    if (!Number.isInteger(h) || h < 100 || h > 4320) return sendJson(res, 400, { error: "Calidad inválida." });
    fmtArgs = [
      "-f",
      `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
      "--merge-output-format",
      "mp4",
    ];
    ext = "mp4";
  } else if (kind === "audio") {
    const f = params.get("format");
    if (f === "mp3") {
      fmtArgs = ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"];
      ext = "mp3";
    } else if (f === "m4a") {
      fmtArgs = ["-f", "ba[ext=m4a]/ba/b"];
      ext = "m4a";
    } else return sendJson(res, 400, { error: "Formato de audio inválido." });
  } else {
    return sendJson(res, 400, { error: "Tipo de descarga inválido." });
  }

  if (activeDownloads >= MAX_CONCURRENT)
    return sendJson(res, 429, { error: "El servidor está ocupado. Inténtalo de nuevo en unos segundos." });

  activeDownloads++;
  let dir = "";
  let child = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeDownloads--;
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  res.on("close", release);

  try {
    dir = await mkdtemp(path.join(tmpdir(), "ytdl-"));
    const args = [
      ...baseArgs(),
      ...fmtArgs,
      "--concurrent-fragments",
      "4",
      "--retries",
      "5",
      "--match-filter",
      `!is_live & duration<=${MAX_DURATION}`,
      "-o",
      path.join(dir, "out.%(ext)s"),
      "--",
      url,
    ];
    const result = await new Promise((resolve) => {
      child = spawn(YTDLP, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), DOWNLOAD_TIMEOUT_MS);
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, stderr: String(e) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });

    if (res.destroyed || res.writableEnded) return;
    if (result.code !== 0) {
      console.error("[download] yt-dlp error:", result.stderr.slice(-800));
      return sendJson(res, 502, { error: friendlyError(result.stderr) });
    }

    const files = (await readdir(dir)).filter((f) => !/\.(part|ytdl|temp)$/.test(f));
    const file = files.find((f) => f.endsWith(`.${ext}`)) || files[0];
    if (!file) return sendJson(res, 502, { error: "No se generó ningún archivo (¿el video excede el límite?)." });
    const full = path.join(dir, file);
    const { size } = await stat(full);
    const realExt = path.extname(file).slice(1) || ext;
    const MIMES = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", m4a: "audio/mp4", opus: "audio/ogg" };
    res.writeHead(200, {
      "Content-Type": MIMES[realExt] || "application/octet-stream",
      "Content-Length": size,
      "Content-Disposition": contentDisposition(name, realExt),
      "Cache-Control": "no-store",
    });
    createReadStream(full).on("error", () => res.destroy()).pipe(res);
  } catch (e) {
    console.error("[download] error:", e);
    if (!res.headersSent) sendJson(res, 500, { error: "Error interno del servidor." });
    else res.destroy();
  }
}

/* ---------- /api/thumb (solo i.ytimg.com) ---------- */

async function handleThumb(req, res, params) {
  let u;
  try {
    u = new URL(params.get("url") || "");
  } catch {
    return sendJson(res, 400, { error: "URL inválida." });
  }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || !(h === "i.ytimg.com" || h.endsWith(".ytimg.com") || h === "yt3.ggpht.com")) {
    return sendJson(res, 400, { error: "URL no permitida." });
  }
  const r = await fetch(u, { redirect: "error" }).catch(() => null);
  if (!r || !r.ok) return sendJson(res, 502, { error: "No se pudo obtener la imagen." });
  const type = r.headers.get("content-type") || "image/jpeg";
  const ext = type.includes("webp") ? "webp" : type.includes("png") ? "png" : "jpg";
  const buf = Buffer.from(await r.arrayBuffer());
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": buf.length,
    "Content-Disposition": contentDisposition(params.get("name") || "miniatura", ext),
  });
  res.end(buf);
}

/* ---------- servidor ---------- */

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (url.pathname === "/health" || url.pathname === "/") {
      return sendJson(res, 200, { ok: true, service: "yt-backend", ytdlp: ytdlpVersion, cookies: hasCookies });
    }
    if (url.pathname === "/api/info" && (req.method === "POST" || req.method === "GET")) {
      if (rateLimited(req)) return sendJson(res, 429, { error: "Demasiadas solicitudes. Espera un momento." });
      let target = url.searchParams.get("url");
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        target = body.url;
      }
      return await handleInfo(req, res, target);
    }
    if (url.pathname === "/api/download" && req.method === "GET") {
      if (rateLimited(req)) return sendJson(res, 429, { error: "Demasiadas solicitudes. Espera un momento." });
      return await handleDownload(req, res, url.searchParams);
    }
    if (url.pathname === "/api/thumb" && req.method === "GET") {
      return await handleThumb(req, res, url.searchParams);
    }
    return sendJson(res, 404, { error: "No encontrado." });
  } catch (e) {
    console.error("[server] error:", e);
    if (!res.headersSent) sendJson(res, 400, { error: "Solicitud inválida." });
    else res.destroy();
  }
});

async function setupCookies() {
  try {
    if (process.env.YOUTUBE_COOKIES) {
      await writeFile(COOKIES_PATH, process.env.YOUTUBE_COOKIES.replace(/\\n/g, "\n"), { mode: 0o600 });
      hasCookies = true;
    } else if (existsSync("/etc/secrets/cookies.txt")) {
      await copyFile("/etc/secrets/cookies.txt", COOKIES_PATH);
      hasCookies = true;
    }
  } catch (e) {
    console.error("No se pudieron cargar las cookies:", e);
  }
}

async function updateYtDlp() {
  if (!AUTO_UPDATE) return;
  const r = await run(["-U"], { timeout: 120_000 });
  console.log("[yt-dlp -U]", (r.stdout || r.stderr).trim().split("\n").pop());
  await refreshVersion();
}

async function refreshVersion() {
  const v = await run(["--version"], { timeout: 15_000 });
  if (v.code === 0) ytdlpVersion = v.stdout.trim();
}

await setupCookies();
await refreshVersion();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend escuchando en :${PORT} (yt-dlp ${ytdlpVersion}, cookies: ${hasCookies})`);
});
updateYtDlp().catch(() => {});
setInterval(() => updateYtDlp().catch(() => {}), 24 * 60 * 60 * 1000).unref();
