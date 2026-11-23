import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { downloads } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await db
      .select({
        platform: downloads.platform,
        count: sql<number>`count(*)::int`,
        items: sql<number>`coalesce(sum(${downloads.items}), 0)::int`,
      })
      .from(downloads)
      .groupBy(downloads.platform);
    const total = rows.reduce((a, r) => a + r.items, 0);
    return NextResponse.json({
      total,
      youtube: rows.find((r) => r.platform === "youtube")?.items ?? 0,
      tiktok: rows.find((r) => r.platform === "tiktok")?.items ?? 0,
    });
  } catch {
    return NextResponse.json({ total: 0, youtube: 0, tiktok: 0 });
  }
}
