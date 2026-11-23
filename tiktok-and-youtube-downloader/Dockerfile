# ---------- Imagen para Render (Next.js + yt-dlp + ffmpeg) ----------
FROM node:22-bookworm-slim

# ffmpeg: unir video+audio y convertir a MP3 · python3: lo necesita yt-dlp
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp (última versión). Se deja escribible para poder autoactualizarse al arrancar.
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod 755 /usr/local/bin/yt-dlp \
 && chown node:node /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && chown -R node:node /app

USER node
ENV NODE_ENV=production \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    NEXT_TELEMETRY_DISABLED=1

# Render inyecta PORT (10000 por defecto). Next.js lo respeta.
EXPOSE 10000
CMD ["sh", "-c", "(yt-dlp -U >/dev/null 2>&1 || true) & exec npm start"]
