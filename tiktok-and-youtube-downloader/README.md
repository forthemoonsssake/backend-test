# Descargador de videos, Shorts, TikTok e imágenes

Next.js (frontend + API) + **yt-dlp** + **ffmpeg**. Se despliega en Render con Docker.

## Cómo funciona
1. `POST /api/info` – lee el enlace (video, short, foto de TikTok, lista, canal/perfil).
2. `POST /api/jobs` – crea una descarga en cola (`video` MP4, `audio` MP3 o `image`).
3. `GET /api/jobs/:id` – progreso (la web consulta cada ~1 s).
4. `GET /api/jobs/:id/file` – entrega el archivo (o un ZIP si son varios). Se borra solo a los 15 min.

## Variables de entorno
| Variable | Para qué sirve | Por defecto |
|---|---|---|
| `YT_COOKIES` | Contenido del `cookies.txt` (formato Netscape). Necesario para YouTube en servidores | – |
| `YTDLP_COOKIES_FILE` | Alternativa: ruta de un *Secret File* de Render (`/etc/secrets/cookies.txt`) | – |
| `YTDLP_PROXY` | Proxy (`http://user:pass@host:port`) | – |
| `YTDLP_EXTRA_ARGS` | Argumentos extra para yt-dlp | – |
| `MAX_CONCURRENT_JOBS` | Descargas simultáneas | 2 |
| `MAX_PLAYLIST_ITEMS` | Máximo de elementos por descarga de lista | 50 |
| `JOB_TTL_MINUTES` | Minutos que se conserva un archivo listo | 15 |

## Desarrollo local
```bash
# requisitos: Node 20+, ffmpeg y yt-dlp en el PATH
npm install
npm run dev
```
