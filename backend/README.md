# Backend de YouTube (yt-dlp + ffmpeg)

Servidor Node sin dependencias npm. Usa `yt-dlp` para obtener info/descargar y `ffmpeg` para unir video+audio y convertir a MP3.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado y versión de yt-dlp |
| POST | `/api/info` | Body `{ "url": "..." }` → título, miniatura, calidades disponibles |
| GET | `/api/download?url=&kind=video&height=720&name=` | Descarga MP4 |
| GET | `/api/download?url=&kind=audio&format=mp3\|m4a&name=` | Descarga audio |
| GET | `/api/thumb?url=&name=` | Descarga la miniatura (solo `ytimg.com`) |

## Desplegar en Render

1. Sube este repositorio a GitHub.
2. En Render: **New → Blueprint** y elige el repo (usa `render.yaml` de la raíz), o **New → Web Service** → *Docker* con *Root Directory* `backend`.
3. Variables de entorno:
   - `ALLOWED_ORIGINS`: la URL de tu web (p. ej. `https://mi-sitio.com`). Varias separadas por coma. `*` permite cualquiera.
   - `YOUTUBE_COOKIES` (**muy recomendado**): contenido de tu `cookies.txt` (formato Netscape).
4. Cuando esté desplegado, copia la URL (p. ej. `https://yt-download-backend.onrender.com`) y ponla en el **frontend** como variable `NEXT_PUBLIC_BACKEND_URL` (sin `/` final). Después **vuelve a construir** el frontend, porque las variables `NEXT_PUBLIC_*` se incrustan en el build.

## ⚠️ YouTube bloquea IPs de servidores

Render (y casi todos los hostings) usan IPs de datacenter y YouTube suele pedir "Sign in to confirm you're not a bot". Para evitarlo:

- Exporta cookies de una cuenta **secundaria** (no la tuya principal) con una extensión como "Get cookies.txt LOCALLY" estando logueado en youtube.com, y pégalas en `YOUTUBE_COOKIES` (o súbelas como *Secret File* con nombre `cookies.txt`).
- Alternativa: `YTDLP_PROXY=http://usuario:clave@host:puerto` con un proxy residencial.
- yt-dlp se actualiza solo al arrancar y cada 24 h (`AUTO_UPDATE=false` para desactivarlo).

## Otras variables

| Variable | Por defecto | Descripción |
|---|---|---|
| `MAX_CONCURRENT` | 2 | Descargas simultáneas |
| `MAX_DURATION_SECONDS` | 7200 | Duración máxima del video |
| `RATE_LIMIT_PER_MIN` | 30 | Peticiones por IP y minuto |
| `DOWNLOAD_TIMEOUT_MS` | 900000 | Tiempo máximo por descarga |
| `YTDLP_EXTRA_ARGS` | — | Argumentos extra para yt-dlp |

## Notas

- El plan gratis de Render se duerme tras 15 min sin uso (la primera petición tarda ~1 min) y tiene poca RAM/CPU: mezclar videos de 1080p+ puede ser lento.
- Ejecutar en local: `YTDLP_PATH=/ruta/yt-dlp node server.mjs` (necesita `yt-dlp` y `ffmpeg` instalados).
- Descarga solo contenido del que tengas permiso; las Condiciones de YouTube restringen descargar sin autorización.
