import { NextResponse } from "next/server";
import { cancelJob, getJob, publicJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "Descarga no encontrada o expirada." }, { status: 404 });
  return NextResponse.json(publicJob(job));
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ ok: true });
  cancelJob(job);
  return NextResponse.json({ ok: true });
}
