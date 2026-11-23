"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------ tipos ------------------------------ */

type Platform = "youtube" | "tiktok";
type Kind = "video" | "audio" | "image";

interface SingleInfo {
  type: "single";
  platform: Platform;
  url: string;
  id: string;
  title: string;
  uploader: string;
  duration: number | null;
  thumbnail: string | null;
  heights: number[];
  hasVideo: boolean;
  imageCount: number;
  isShort?: boolean;
  hasPlaylist: boolean;
}

interface Entry {
  index: number;
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
}

interface PlaylistInfo {
  type: "playlist";
  platform: Platform;
  url: string;
  title: string;
  uploader: string;
  entries: Entry[];
  truncated: boolean;
  total: number;
}

type Info = SingleInfo | PlaylistInfo;

interface JobState {
  id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  message: string;
  error?: string;
  fileName?: string;
  size?: number;
  position?: number;
}

const MAX_ITEMS = 50;
const STD_QUALITIES = [2160, 1440, 1080, 720, 480, 360, 240];

/* ----------------------------- utilidades ----------------------------- */

function fmtDuration(s: number | null) {
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtSize(b?: number) {
  if (!b) return "";
  if (b > 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b > 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "Error del servidor");
  return data as T;
}

/* ------------------------------ componente ------------------------------ */

export default function Downloader() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [kind, setKind] = useState<Kind>("video");
  const [quality, setQuality] = useState("best");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [job, setJob] = useState<JobState | null>(null);
  const [starting, setStarting] = useState(false);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (poll.current) clearTimeout(poll.current);
    };
  }, []);

  const busy = starting || job?.status === "queued" || job?.status === "running";

  const loadInfo = useCallback(async (value: string, playlist = false) => {
    setLoading(true);
    setError(null);
    setInfo(null);
    setJob(null);
    try {
      const data = await api<Info>("/api/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value, playlist }),
      });
      setInfo(data);
      setQuality(data.type === "playlist" ? "720" : "best");
      if (data.type === "playlist") {
        setKind("video");
        setSelected(new Set(data.entries.slice(0, MAX_ITEMS).map((e) => e.index)));
      } else {
        setKind(data.hasVideo ? "video" : "image");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo leer el enlace");
    } finally {
      setLoading(false);
    }
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || loading) return;
    loadInfo(url.trim());
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text.trim());
        loadInfo(text.trim());
      }
    } catch {
      setError("No se pudo acceder al portapapeles. Pega el enlace manualmente (Ctrl+V).");
    }
  }

  const qualityOptions = useMemo(() => {
    if (!info) return [];
    if (info.type === "playlist" || info.heights.length === 0) return [1080, 720, 480, 360];
    const max = info.heights[0];
    const opts = STD_QUALITIES.filter((q) => q <= max + 8);
    return opts.length ? opts : [max];
  }, [info]);

  function trackJob(id: string) {
    const tick = async () => {
      try {
        const s = await api<JobState>(`/api/jobs/${id}`);
        if (!alive.current) return;
        setJob(s);
        if (s.status === "done") {
          triggerDownload(id);
          return;
        }
        if (s.status === "error") return;
      } catch (e) {
        if (!alive.current) return;
        setJob({
          id,
          status: "error",
          progress: 0,
          message: "",
          error: e instanceof Error ? e.message : "Se perdió la conexión con el servidor",
        });
        return;
      }
      poll.current = setTimeout(tick, 900);
    };
    tick();
  }

  function triggerDownload(id: string) {
    const a = document.createElement("a");
    a.href = `/api/jobs/${id}/file`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function startDownload() {
    if (!info || busy) return;
    setStarting(true);
    setError(null);
    setJob(null);
    try {
      const { id } = await api<{ id: string }>("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: info.url,
          kind,
          quality,
          playlist: info.type === "playlist",
          items: info.type === "playlist" ? Array.from(selected) : [],
        }),
      });
      setJob({ id, status: "queued", progress: 0, message: "En cola…" });
      trackJob(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo iniciar la descarga");
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!job) return;
    if (poll.current) clearTimeout(poll.current);
    await fetch(`/api/jobs/${job.id}`, { method: "DELETE" }).catch(() => {});
    setJob(null);
  }

  function toggle(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else if (next.size < MAX_ITEMS) next.add(index);
      return next;
    });
  }

  const isPlaylist = info?.type === "playlist";
  const canDownload = !!info && !busy && (!isPlaylist || selected.size > 0);

  /* ------------------------------ render ------------------------------ */

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[900px] -translate-x-1/2 rounded-full bg-fuchsia-600/20 blur-[120px]" />
        <div className="absolute top-60 -right-40 h-[400px] w-[500px] rounded-full bg-cyan-500/15 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-4xl px-4 pb-20 pt-10 sm:pt-16">
        {/* Cabecera */}
        <header className="mb-10 text-center">
          <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs text-slate-300">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            YouTube · Shorts · TikTok · Listas
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">
            Descarga{" "}
            <span className="bg-gradient-to-r from-fuchsia-400 via-pink-400 to-cyan-300 bg-clip-text text-transparent">
              videos, audios e imágenes
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-slate-400">
            Pega el enlace de un video, short, publicación de fotos o lista de reproducción y
            descárgalo en MP4, MP3 o imagen. Sin registro.
          </p>
        </header>

        {/* Formulario */}
        <form
          onSubmit={onSubmit}
          className="rounded-2xl border border-white/10 bg-white/5 p-3 shadow-2xl shadow-black/40 backdrop-blur"
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=…  o  https://www.tiktok.com/@usuario/video/…"
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-900/80 px-4 py-3.5 text-sm text-white placeholder:text-slate-500 focus:border-fuchsia-400/60 focus:outline-none focus:ring-2 focus:ring-fuchsia-400/20"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={paste}
                className="rounded-xl border border-white/10 bg-slate-800 px-4 py-3.5 text-sm font-medium text-slate-200 transition hover:bg-slate-700"
              >
                Pegar
              </button>
              <button
                type="submit"
                disabled={loading || !url.trim()}
                className="flex-1 rounded-xl bg-gradient-to-r from-fuchsia-500 to-pink-500 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-fuchsia-500/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
              >
                {loading ? "Analizando…" : "Buscar"}
              </button>
            </div>
          </div>
        </form>

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          >
            {error}
          </div>
        )}

        {loading && <Skeleton />}

        {/* Resultado */}
        {info && (
          <section className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur">
            <div className="flex flex-col gap-4 p-4 sm:flex-row sm:p-5">
              <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl bg-slate-800 sm:w-64">
                {(info.type === "single" ? info.thumbnail : info.entries[0]?.thumbnail) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={(info.type === "single" ? info.thumbnail : info.entries[0]?.thumbnail) || ""}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                )}
                {info.type === "single" && info.duration ? (
                  <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-xs">
                    {fmtDuration(info.duration)}
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className={`rounded-full px-2.5 py-1 font-medium ${
                      info.platform === "youtube" ? "bg-red-500/20 text-red-300" : "bg-cyan-500/20 text-cyan-300"
                    }`}
                  >
                    {info.platform === "youtube" ? "YouTube" : "TikTok"}
                  </span>
                  {info.type === "playlist" && (
                    <span className="rounded-full bg-fuchsia-500/20 px-2.5 py-1 font-medium text-fuchsia-300">
                      Lista · {info.total} elementos
                    </span>
                  )}
                  {info.type === "single" && info.isShort && (
                    <span className="rounded-full bg-pink-500/20 px-2.5 py-1 font-medium text-pink-300">Short</span>
                  )}
                  {info.type === "single" && !info.hasVideo && (
                    <span className="rounded-full bg-amber-500/20 px-2.5 py-1 font-medium text-amber-300">
                      Fotos · {info.imageCount}
                    </span>
                  )}
                </div>
                <h2 className="line-clamp-2 text-lg font-semibold leading-snug">{info.title}</h2>
                {info.uploader && <p className="mt-1 text-sm text-slate-400">{info.uploader}</p>}

                {info.type === "single" && info.hasPlaylist && (
                  <button
                    onClick={() => loadInfo(info.url, true)}
                    className="mt-3 rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/10 px-3 py-1.5 text-xs font-medium text-fuchsia-200 hover:bg-fuchsia-500/20"
                  >
                    Este video pertenece a una lista → cargar lista completa
                  </button>
                )}
              </div>
            </div>

            {/* Opciones */}
            <div className="border-t border-white/10 p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="inline-flex rounded-xl bg-slate-900/80 p-1">
                  {(
                    [
                      ["video", "Video MP4", info.type === "single" ? info.hasVideo : true],
                      ["audio", "Audio MP3", info.type === "single" ? info.hasVideo : true],
                      [
                        "image",
                        info.type === "playlist"
                          ? "Miniaturas"
                          : info.imageCount > 1
                            ? "Fotos"
                            : "Imagen",
                        true,
                      ],
                    ] as [Kind, string, boolean][]
                  )
                    .filter(([, , enabled]) => enabled)
                    .map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => setKind(k)}
                        disabled={busy}
                        className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                          kind === k
                            ? "bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white shadow"
                            : "text-slate-300 hover:text-white"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                </div>

                {kind === "video" && (
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    Calidad
                    <select
                      value={quality}
                      onChange={(e) => setQuality(e.target.value)}
                      disabled={busy}
                      className="rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white focus:outline-none"
                    >
                      <option value="best">Máxima</option>
                      {qualityOptions.map((q) => (
                        <option key={q} value={q}>
                          {q}p
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <p className="text-xs text-slate-500">
                  {kind === "image" &&
                    (info.type === "single"
                      ? info.imageCount > 1
                        ? "Se descargarán todas las fotos en un ZIP."
                        : "Se descargará la portada en la mayor resolución disponible."
                      : "Se descargarán las miniaturas seleccionadas en un ZIP.")}
                  {kind === "audio" && "Audio en mejor calidad, convertido a MP3."}
                  {kind === "video" && isPlaylist && "Los videos seleccionados se entregan en un ZIP."}
                </p>
              </div>

              {/* Lista */}
              {info.type === "playlist" && (
                <div className="mt-5">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-slate-300">
                      <strong className="text-white">{selected.size}</strong> seleccionados
                      <span className="text-slate-500"> (máx. {MAX_ITEMS})</span>
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          setSelected(new Set(info.entries.slice(0, MAX_ITEMS).map((e) => e.index)))
                        }
                        className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs hover:bg-slate-700"
                      >
                        Seleccionar todo
                      </button>
                      <button
                        onClick={() => setSelected(new Set())}
                        className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs hover:bg-slate-700"
                      >
                        Ninguno
                      </button>
                    </div>
                  </div>
                  <ul className="max-h-96 divide-y divide-white/5 overflow-y-auto rounded-xl border border-white/10 bg-slate-900/60">
                    {info.entries.map((e) => (
                      <li key={`${e.index}-${e.id}`}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-white/5">
                          <input
                            type="checkbox"
                            checked={selected.has(e.index)}
                            onChange={() => toggle(e.index)}
                            className="h-4 w-4 accent-fuchsia-500"
                          />
                          <span className="w-6 text-right text-xs text-slate-500">{e.index}</span>
                          <div className="h-10 w-[72px] shrink-0 overflow-hidden rounded bg-slate-800">
                            {e.thumbnail && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={e.thumbnail}
                                alt=""
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                className="h-full w-full object-cover"
                              />
                            )}
                          </div>
                          <span className="line-clamp-2 min-w-0 flex-1 text-sm">{e.title}</span>
                          <span className="text-xs text-slate-500">{fmtDuration(e.duration)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {info.truncated && (
                    <p className="mt-2 text-xs text-amber-300/80">
                      Se muestran los primeros {info.entries.length} de {info.total} elementos.
                    </p>
                  )}
                </div>
              )}

              {/* Botón / progreso */}
              <div className="mt-5">
                {!busy && job?.status !== "done" && (
                  <button
                    onClick={startDownload}
                    disabled={!canDownload}
                    className="w-full rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-6 py-3.5 text-sm font-bold text-slate-950 shadow-lg shadow-emerald-500/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
                  >
                    ⬇ Descargar
                    {isPlaylist ? ` (${selected.size})` : ""}
                  </button>
                )}

                {job && (job.status === "queued" || job.status === "running") && (
                  <div>
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="text-slate-300">
                        {job.status === "queued" && job.position
                          ? `En cola (posición ${job.position})…`
                          : job.message}
                      </span>
                      <span className="font-mono text-slate-400">{job.progress}%</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-cyan-400 transition-all duration-500"
                        style={{ width: `${Math.max(job.progress, 3)}%` }}
                      />
                    </div>
                    <button onClick={cancel} className="mt-3 text-xs text-slate-400 underline hover:text-white">
                      Cancelar
                    </button>
                  </div>
                )}

                {job?.status === "done" && (
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4">
                    <span className="text-2xl">✅</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-emerald-200">¡Descarga lista!</p>
                      <p className="truncate text-xs text-emerald-100/70">
                        {job.fileName} {job.size ? `· ${fmtSize(job.size)}` : ""}
                      </p>
                    </div>
                    <a
                      href={`/api/jobs/${job.id}/file`}
                      className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950 hover:brightness-110"
                    >
                      Guardar de nuevo
                    </a>
                    <button
                      onClick={() => setJob(null)}
                      className="rounded-lg bg-slate-800 px-4 py-2 text-sm hover:bg-slate-700"
                    >
                      Otra descarga
                    </button>
                  </div>
                )}

                {job?.status === "error" && (
                  <div
                    role="alert"
                    className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
                  >
                    {job.error}
                    <button
                      onClick={startDownload}
                      className="ml-3 rounded bg-red-500/20 px-2 py-1 text-xs hover:bg-red-500/30"
                    >
                      Reintentar
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Info */}
        {!info && !loading && (
          <section className="mt-12 grid gap-4 sm:grid-cols-3">
            {[
              ["🎬", "Videos y Shorts", "MP4 en la calidad que elijas, hasta 4K si el video lo ofrece."],
              ["🎵", "Solo audio", "Extrae el audio y conviértelo a MP3 con la mejor calidad."],
              ["🖼️", "Imágenes y listas", "Miniaturas, carruseles de fotos de TikTok y listas completas en ZIP."],
            ].map(([icon, title, text]) => (
              <div key={title} className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <div className="text-2xl">{icon}</div>
                <h3 className="mt-2 font-semibold">{title}</h3>
                <p className="mt-1 text-sm text-slate-400">{text}</p>
              </div>
            ))}
          </section>
        )}

        <footer className="mt-16 text-center text-xs leading-relaxed text-slate-500">
          Usa esta herramienta solo con contenido propio, de dominio público o con permiso del autor.
          Respeta los derechos de autor y los términos de servicio de cada plataforma. No afiliado a
          YouTube ni TikTok.
        </footer>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mt-6 animate-pulse rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="aspect-video w-full rounded-xl bg-slate-800 sm:w-64" />
        <div className="flex-1 space-y-3">
          <div className="h-4 w-24 rounded bg-slate-800" />
          <div className="h-5 w-3/4 rounded bg-slate-800" />
          <div className="h-4 w-1/3 rounded bg-slate-800" />
        </div>
      </div>
    </div>
  );
}
