import type { Readable } from "node:stream";
import { ZipArchive } from "archiver";

export interface ZipEntry {
  name: string;
  /** Abre el contenido del archivo. Devuelve null para omitirlo. */
  open: () => Promise<Readable | null>;
}

/**
 * Crea un ZIP en streaming (sin compresión, los videos ya están comprimidos).
 * Los archivos se abren y escriben de uno en uno para no saturar memoria/red.
 */
export function zipSequence(entries: ZipEntry[], onEntryDone?: (name: string, ok: boolean) => void): Readable {
  const archive = new ZipArchive({ store: true });
  let current: Readable | null = null;
  let closed = false;
  archive.on("close", () => {
    closed = true;
    current?.destroy();
  });
  archive.on("error", () => {
    closed = true;
    current?.destroy();
  });
  archive.on("warning", () => {});

  (async () => {
    for (const entry of entries) {
      if (closed) return;
      let ok = false;
      try {
        const s = await entry.open();
        if (!s) {
          onEntryDone?.(entry.name, false);
          continue;
        }
        current = s;
        await new Promise<void>((resolve, reject) => {
          const done = () => resolve();
          archive.once("entry", done);
          s.once("error", (e) => {
            archive.off("entry", done);
            reject(e);
          });
          archive.append(s, { name: entry.name });
        });
        ok = true;
      } catch (e) {
        console.error("[zip] entrada omitida:", entry.name, e instanceof Error ? e.message : e);
      }
      current = null;
      onEntryDone?.(entry.name, ok);
    }
    if (!closed) await archive.finalize();
  })().catch((e) => archive.destroy(e instanceof Error ? e : new Error(String(e))));

  return archive;
}
