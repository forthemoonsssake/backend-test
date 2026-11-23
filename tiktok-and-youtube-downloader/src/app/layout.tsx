import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Descargador de videos, Shorts, TikTok e imágenes",
  description:
    "Descarga videos, Shorts, listas de reproducción e imágenes de YouTube y TikTok en MP4, MP3 o JPG.",
};

export const viewport: Viewport = {
  themeColor: "#020617",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
