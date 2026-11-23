export const dynamic = "force-dynamic";

export async function GET() {
  // La app no necesita base de datos para funcionar (ideal para Render).
  // Si hay DATABASE_URL configurada, se comprueba también.
  if (!process.env.DATABASE_URL) return Response.json({ ok: true });
  try {
    const { db } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
