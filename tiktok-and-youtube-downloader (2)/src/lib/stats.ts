import { db } from "@/db";
import { downloads } from "@/db/schema";

export async function logDownload(row: {
  platform: string;
  type: string;
  title?: string | null;
  sourceUrl: string;
  option: string;
  items?: number;
}) {
  try {
    await db.insert(downloads).values({
      platform: row.platform,
      type: row.type,
      title: row.title?.slice(0, 300) ?? null,
      sourceUrl: row.sourceUrl.slice(0, 500),
      option: row.option,
      items: row.items ?? 1,
    });
  } catch (e) {
    console.error("[stats] no se pudo registrar la descarga:", e instanceof Error ? e.message : e);
  }
}
