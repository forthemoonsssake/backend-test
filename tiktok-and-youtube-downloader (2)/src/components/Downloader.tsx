"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaOption, ResolveResult } from "@/lib/common";

const MAX_ZIP = 50;

function fmtDuration(s: number | null | undefined) {
  if (s == null) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtSize(b?: number) {
  if (!b) return "";
  if (b > 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + " GB";
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + " MB";
  return Math.max(1, Math.round(b / 1024)) + " KB";
}

const TYPE_LABEL: Record<ResolveResult["type"], string> = {
  video: "Video",
  short: "Short",
  images: "Galería de imágenes",
  playlist: "Playlist",
};

function dlHref(url: string, q: string, items?: string[]) {
  const p = new URLSearchParams({ url, q });
  if (items?.length) p.set("items", items.join(","));
  return `/api/download?${p.toString()}`;
}

const KIND_ICON: Record<MediaOption["kind"], string> = {
  video: "🎬",
  audio: "🎵",
  image: "🖼️",
  zip: "📦",
};

export default function Downloader() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plQuality, setPlQuality] = useState("mp4:720");
  const [stats, setStats] = useState<{ total: number } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  const resolve = useCallback(async (raw: string) => {
    const url = raw.trim();
    if (!url) {
      setError("Pega primero un enlace de YouTube o TikTok.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo procesar el enlace.");
      const r = data as ResolveResult;
      setResult(r);
      setSelected(new Set(r.items?.slice(0, MAX_ZIP).map((i) => i.id) ?? []));
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "Error desconocido.");
    } finally {
      setLoading(false);
    }
  }, []);

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setInput(text);
      if (text.trim()) void resolve(text);
    } catch {
      setError("No se pudo leer el portapapeles. Pega el enlace manualmente (Ctrl+V).");
    }
  };

  const plItems = result?.items ?? [];
  const allSelected = plItems.length > 0 && plItems.slice(0, MAX_ZIP).every((i) => selected.has(i.id));
  const selectedIds = useMemo(() => plItems.filter((i) => selected.has(i.id)).map((i) => i.id), [plItems, selected]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="w-full">
      {/* Barra de entrada */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void resolve(input);
        }}
        className="mx-auto flex w-full max-w-3xl flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 shadow-2xl shadow-fuchsia-500/10 backdrop-blur sm:flex-row"
      >
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lg">🔗</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Pega aquí el enlace de YouTube o TikTok…"
            className="h-14 w-full rounded-xl border border-white/10 bg-black/40 pl-12 pr-4 text-base text-white placeholder:text-white/40 outline-none transition focus:border-fuchsia-400/70 focus:ring-2 focus:ring-fuchsia-500/30"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-label="Enlace del video"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={paste}
            className="h-14 rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-medium text-white/80 transition hover:bg-white/10"
          >
            Pegar
          </button>
          <button
            type="submit"
            disabled={loading}
            className="h-14 flex-1 rounded-xl bg-gradient-to-r from-fuchsia-500 to-cyan-400 px-6 text-base font-semibold text-black transition hover:brightness-110 disabled:opacity-60 sm:flex-none"
          >
            {loading ? "Buscando…" : "Buscar"}
          </button>
        </div>
      </form>

      <p className="mx-auto mt-3 max-w-3xl text-center text-xs text-white/50">
        Videos, Shorts, playlists, galerías de fotos de TikTok, audio (MP3) y miniaturas. Sin registro.
      </p>

      {stats && stats.total > 0 && (
        <p className="mt-2 text-center text-xs text-white/40">
          {stats.total.toLocaleString("es")} descargas realizadas
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="mx-auto mt-6 flex max-w-3xl items-start gap-3 rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200"
        >
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      )}

      {loading && (
        <div className="mx-auto mt-6 max-w-3xl animate-pulse rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex gap-4">
            <div className="h-24 w-40 rounded-xl bg-white/10" />
            <div className="flex-1 space-y-3">
              <div className="h-4 w-3/4 rounded bg-white/10" />
              <div className="h-4 w-1/2 rounded bg-white/10" />
              <div className="h-4 w-1/3 rounded bg-white/10" />
            </div>
          </div>
        </div>
      )}

      {result && !loading && (
        <div ref={resultRef} className="mx-auto mt-8 w-full max-w-3xl scroll-mt-6">
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur">
            {/* Cabecera */}
            <div className="flex flex-col gap-4 p-5 sm:flex-row">
              <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl bg-black/50 sm:w-56">
                {result.thumbnail && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={result.thumbnail}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                )}
                {result.duration != null && (
                  <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium">
                    {fmtDuration(result.duration)}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className={`rounded-full px-2.5 py-1 font-semibold ${
                      result.platform === "youtube"
                        ? "bg-red-500/20 text-red-300"
                        : "bg-cyan-400/20 text-cyan-200"
                    }`}
                  >
                    {result.platform === "youtube" ? "YouTube" : "TikTok"}
                  </span>
                  <span className="rounded-full bg-white/10 px-2.5 py-1 text-white/70">
                    {TYPE_LABEL[result.type]}
                  </span>
                  {result.type === "playlist" && (
                    <span className="rounded-full bg-white/10 px-2.5 py-1 text-white/70">
                      {result.totalItems ?? plItems.length} videos
                    </span>
                  )}
                  {result.type === "images" && (
                    <span className="rounded-full bg-white/10 px-2.5 py-1 text-white/70">
                      {result.images?.length} fotos
                    </span>
                  )}
                </div>
                <h2 className="line-clamp-3 text-lg font-semibold leading-snug">{result.title}</h2>
                {result.author && <p className="mt-1 text-sm text-white/55">{result.author}</p>}
                {result.playlistId && (
                  <button
                    onClick={() => {
                      const u = `https://www.youtube.com/playlist?list=${result.playlistId}`;
                      setInput(u);
                      void resolve(u);
                    }}
                    className="mt-3 rounded-lg border border-fuchsia-400/40 bg-fuchsia-500/10 px-3 py-1.5 text-xs font-medium text-fuchsia-200 transition hover:bg-fuchsia-500/20"
                  >
                    📃 Este video pertenece a una playlist — cargar playlist completa
                  </button>
                )}
              </div>
            </div>

            {/* Opciones de video/short/tiktok */}
            {result.type !== "playlist" && (
              <div className="border-t border-white/10 p-5">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
                  Elige un formato
                </h3>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {result.options.map((o) => (
                    <li key={o.id}>
                      <a
                        href={dlHref(result.url, o.id)}
                        target="_blank"
                        rel="noopener"
                        className="group flex items-center gap-3 rounded-xl border border-white/10 bg-black/30 p-3 transition hover:border-fuchsia-400/60 hover:bg-fuchsia-500/10"
                      >
                        <span className="text-xl">{KIND_ICON[o.kind]}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {o.label}
                            {o.note && o.kind === "video" && (
                              <span className="ml-2 rounded bg-fuchsia-500/20 px-1.5 py-0.5 text-[10px] text-fuchsia-200">
                                {o.note}
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-xs text-white/45">
                            {o.ext.toUpperCase()}
                            {o.size ? ` · ${fmtSize(o.size)}` : ""}
                            {o.note && o.kind !== "video" ? ` · ${o.note}` : ""}
                          </span>
                        </span>
                        <span className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold transition group-hover:bg-gradient-to-r group-hover:from-fuchsia-500 group-hover:to-cyan-400 group-hover:text-black">
                          Descargar
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
                {result.platform === "youtube" && (
                  <p className="mt-3 text-xs text-white/40">
                    Los videos se unen con el audio en el servidor; la descarga empieza enseguida y el
                    tamaño final puede variar ligeramente.
                  </p>
                )}
              </div>
            )}

            {/* Galería TikTok */}
            {result.type === "images" && result.images && (
              <div className="border-t border-white/10 p-5">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
                  Imágenes individuales
                </h3>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {result.images.map((im) => (
                    <a
                      key={im.index}
                      href={dlHref(result.url, `image:${im.index}`)}
                      target="_blank"
                      rel="noopener"
                      className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-white/10 bg-black/40"
                      title={`Descargar imagen ${im.index}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={im.url}
                        alt={`Imagen ${im.index}`}
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        className="h-full w-full object-cover transition group-hover:scale-105"
                      />
                      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 text-center text-xs font-medium opacity-0 transition group-hover:opacity-100">
                        ⬇ #{im.index}
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Playlist */}
            {result.type === "playlist" && (
              <div className="border-t border-white/10 p-5">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <label className="block text-sm">
                    <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-white/50">
                      Formato (se entrega en un ZIP)
                    </span>
                    <select
                      value={plQuality}
                      onChange={(e) => setPlQuality(e.target.value)}
                      className="h-11 w-full rounded-lg border border-white/10 bg-black/50 px-3 text-sm outline-none focus:border-fuchsia-400/70 sm:w-64"
                    >
                      {result.options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <a
                    href={selectedIds.length && selectedIds.length <= MAX_ZIP ? dlHref(result.url, plQuality, selectedIds) : undefined}
                    target="_blank"
                    rel="noopener"
                    aria-disabled={!selectedIds.length || selectedIds.length > MAX_ZIP}
                    className={`inline-flex h-11 items-center justify-center rounded-xl bg-gradient-to-r from-fuchsia-500 to-cyan-400 px-5 text-sm font-semibold text-black transition hover:brightness-110 ${
                      !selectedIds.length || selectedIds.length > MAX_ZIP ? "pointer-events-none opacity-40" : ""
                    }`}
                  >
                    📦 Descargar {selectedIds.length} {selectedIds.length === 1 ? "video" : "videos"} (ZIP)
                  </a>
                </div>
                {selectedIds.length > MAX_ZIP && (
                  <p className="mb-3 text-xs text-amber-300">
                    Máximo {MAX_ZIP} videos por ZIP. Desmarca algunos para continuar.
                  </p>
                )}
                <div className="mb-2 flex items-center justify-between text-xs text-white/50">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(allSelected ? new Set() : new Set(plItems.slice(0, MAX_ZIP).map((i) => i.id)))
                      }
                      className="h-4 w-4 accent-fuchsia-500"
                    />
                    Seleccionar {Math.min(plItems.length, MAX_ZIP)} primeros
                  </label>
                  <span>
                    {selectedIds.length} de {plItems.length} seleccionados
                  </span>
                </div>
                <ul className="max-h-[28rem] divide-y divide-white/5 overflow-y-auto rounded-xl border border-white/10 bg-black/30">
                  {plItems.map((it) => (
                    <li key={it.id} className="flex items-center gap-3 p-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(it.id)}
                        onChange={() => toggle(it.id)}
                        className="h-4 w-4 shrink-0 accent-fuchsia-500"
                        aria-label={`Seleccionar ${it.title}`}
                      />
                      <span className="w-6 shrink-0 text-right text-xs text-white/35">{it.index}</span>
                      {it.thumbnail && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={it.thumbnail}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="h-12 w-20 shrink-0 rounded object-cover"
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{it.title}</span>
                        <span className="block truncate text-xs text-white/40">
                          {[it.author, fmtDuration(it.duration)].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <button
                        onClick={() => {
                          const u = `https://www.youtube.com/watch?v=${it.id}`;
                          setInput(u);
                          void resolve(u);
                        }}
                        className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-white/70 transition hover:bg-white/10"
                      >
                        Abrir
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
