import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Paquetes con binarios / ESM nativo que deben cargarse tal cual en el servidor
  serverExternalPackages: ["ffmpeg-static", "youtubei.js", "archiver"],
  images: {
    remotePatterns: [],
  },
  poweredByHeader: false,
};

export default nextConfig;
