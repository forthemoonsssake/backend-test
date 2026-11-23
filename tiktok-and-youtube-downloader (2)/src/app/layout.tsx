import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Descargador de videos YouTube y TikTok — videos, shorts, playlists e imágenes",
  description:
    "Descarga videos, Shorts, playlists de YouTube y videos o galerías de fotos de TikTok sin marca de agua. MP4, MP3 e imágenes, gratis y sin registro.",
  keywords: ["descargar youtube", "descargar tiktok", "tiktok sin marca de agua", "youtube mp3", "descargar playlist", "shorts"],
};

export const viewport: Viewport = {
  themeColor: "#07070d",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-[#07070d] text-white antialiased">{children}</body>
    </html>
  );
}
