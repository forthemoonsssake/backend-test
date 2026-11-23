import type { Readable } from "node:stream";

export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type Platform = "youtube" | "tiktok";
export type MediaType = "video" | "short" | "images" | "playlist";

export interface MediaOption {
  /** Valor que se envía como `q` a /api/download */
  id: string;
  label: string;
  kind: "video" | "audio" | "image" | "zip";
  ext: string;
  size?: number;
  note?: string;
}

export interface PlaylistItem {
  id: string;
  index: number;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  author: string | null;
}

export interface ResolveResult {
  platform: Platform;
  type: MediaType;
  url: string;
  id: string;
  title: string;
  author: string | null;
  thumbnail: string | null;
  duration: number | null;
  options: MediaOption[];
  images?: { index: number; url: string }[];
  items?: PlaylistItem[];
  totalItems?: number;
  /** Si una URL de video pertenece además a una playlist */
  playlistId?: string;
}

export interface DownloadPayload {
  stream: Readable;
  filename: string;
  mime: string;
  size?: number;
  cleanup?: () => void;
}

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function safeName(input: string, max = 100): string {
  const cleaned = input
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return cleaned || "descarga";
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
    filename,
  ).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

export function detectPlatform(raw: string): Platform | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (
    h === "youtu.be" ||
    h === "youtube.com" ||
    h.endsWith(".youtube.com") ||
    h === "youtube-nocookie.com" ||
    h.endsWith(".youtube-nocookie.com")
  )
    return "youtube";
  if (h === "tiktok.com" || h.endsWith(".tiktok.com")) return "tiktok";
  return null;
}

export function normalizeInputUrl(raw: string): string {
  const trimmed = raw.trim();
  // Permitir pegar texto con una URL dentro
  const match = trimmed.match(/https?:\/\/[^\s]+/i);
  if (match) return match[0];
  if (/^(www\.|m\.)?(youtube\.com|youtu\.be|tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i.test(trimmed))
    return "https://" + trimmed;
  return trimmed;
}
