import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import ffmpegStatic from "ffmpeg-static";

export function ffmpegBin(): string {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv) return fromEnv;
  if (ffmpegStatic && existsSync(ffmpegStatic)) return ffmpegStatic;
  return "ffmpeg";
}

/**
 * Une un stream de video y uno de audio (sin recodificar) y devuelve un MP4
 * fragmentado por stdout, de modo que la descarga empieza de inmediato.
 */
export function muxStreams(video: Readable, audio: Readable): Readable {
  const p = spawn(/*turbopackIgnore: true*/ 
    ffmpegBin(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:3",
      "-i",
      "pipe:4",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c",
      "copy",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore", "pipe", "pipe"] },
  );
  const inV = p.stdio[3] as Writable;
  const inA = p.stdio[4] as Writable;
  inV.on("error", () => {});
  inA.on("error", () => {});
  const out = p.stdout as Readable;
  // Si falla una fuente, abortar la salida (en vez de entregar un archivo truncado "completo")
  const fail = (e: Error) => {
    p.kill("SIGKILL");
    out.destroy(e);
  };
  video.on("error", fail);
  audio.on("error", fail);
  video.pipe(inV);
  audio.pipe(inA);
  p.on("error", (e) => out.destroy(e));
  out.on("close", () => {
    p.kill("SIGKILL");
    video.destroy();
    audio.destroy();
  });
  return out;
}

/** Convierte un stream de audio cualquiera a MP3 (192 kbps). */
export function encodeMp3(audio: Readable): Readable {
  const p = spawn(/*turbopackIgnore: true*/ 
    ffmpegBin(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      "-f",
      "mp3",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const stdin = p.stdin as Writable;
  stdin.on("error", () => {});
  const out = p.stdout as Readable;
  audio.on("error", (e) => {
    p.kill("SIGKILL");
    out.destroy(e);
  });
  audio.pipe(stdin);
  p.on("error", (e) => out.destroy(e));
  out.on("close", () => {
    p.kill("SIGKILL");
    audio.destroy();
  });
  return out;
}
