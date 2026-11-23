import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Registro de descargas (estadísticas). No guarda datos personales.
export const downloads = pgTable(
  "downloads",
  {
    id: serial("id").primaryKey(),
    platform: text("platform").notNull(), // youtube | tiktok
    type: text("type").notNull(), // video | short | images | playlist
    title: text("title"),
    sourceUrl: text("source_url").notNull(),
    option: text("option").notNull(),
    items: integer("items").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("downloads_created_idx").on(t.createdAt), index("downloads_platform_idx").on(t.platform)],
);
