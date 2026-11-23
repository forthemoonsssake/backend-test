import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import {
  YtError,
  canonicalPlaylistUrl,
  getPlaylistInfo,
  getVideoInfo,
  isPlaylistLike,
  parseSupportedUrl,
  youtubePlaylistId,
  youtubeVideoId,
  ytThumb,
} from "@/lib/ytdlp";
import { getTikTokPhotoPost, isTikTokPhotoUrl, resolveTikTokUrl } from "@/lib/images";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function fail(message: string, status = 400, code = "ERROR") {
  return NextResponse.json({ error: message, code }, { status });
}

export async function POST(req: Request) {
  if (!rateLimit(req, "info", 20)) return fail("Demasiadas solicitudes, espera un minuto.", 429, "RATE");

  const body = (await req.json().catch(() => null)) as { url?: string; playlist?: boolean } | null;
  const parsed = parseSupportedUrl(body?.url ?? "");
  if (!parsed) return fail("Pega un enlace válido de YouTube o TikTok.", 400, "INVALID_URL");

  const { platform } = parsed;
  try {
    let url = parsed.url;
    if (platform === "tiktok") url = await resolveTikTokUrl(url);

    const wantPlaylist = body?.playlist === true || isPlaylistLike(url, platform);

    if (wantPlaylist) {
      const canonical = canonicalPlaylistUrl(url, platform);
      const info = await getPlaylistInfo(canonical, platform);
      if (!info.entries.length) return fail("La lista está vacía o es privada.", 404, "EMPTY");
      return NextResponse.json({ type: "playlist", platform, url: canonical, ...info });
    }

    if (platform === "tiktok" && isTikTokPhotoUrl(url)) {
      const post = await getTikTokPhotoPost(url);
      return NextResponse.json({
        type: "single",
        platform,
        url: url.toString(),
        id: post.id,
        title: post.title,
        uploader: post.author,
        duration: null,
        thumbnail: post.images[0],
        heights: [],
        hasVideo: false,
        imageCount: post.images.length,
        hasPlaylist: false,
      });
    }

    const info = await getVideoInfo(url.toString());
    const ytId = platform === "youtube" ? youtubeVideoId(url) : null;
    return NextResponse.json({
      type: "single",
      platform,
      url: url.toString(),
      ...info,
      thumbnail: info.thumbnail ?? (ytId ? ytThumb(ytId, "hqdefault") : null),
      hasVideo: true,
      imageCount: 1,
      isShort: url.pathname.startsWith("/shorts/"),
      hasPlaylist: platform === "youtube" && !!youtubePlaylistId(url),
    });
  } catch (e) {
    if (e instanceof YtError) {
      const status = e.code === "UNSUPPORTED" || e.code === "UNAVAILABLE" ? 404 : 502;
      return fail(e.message, status, e.code);
    }
    return fail("Error inesperado al leer el enlace.", 500);
  }
}
