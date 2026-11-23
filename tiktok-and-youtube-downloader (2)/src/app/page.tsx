import Downloader from "@/components/Downloader";

const FEATURES = [
  {
    icon: "🎬",
    title: "Videos y Shorts",
    text: "Hasta 4K en YouTube (si el video lo ofrece) y TikTok en la mejor calidad, sin marca de agua.",
  },
  {
    icon: "📃",
    title: "Playlists completas",
    text: "Carga una playlist, elige los videos y descárgalos en un solo ZIP en MP4, MP3 o M4A.",
  },
  {
    icon: "🖼️",
    title: "Imágenes",
    text: "Galerías de fotos de TikTok (una a una o en ZIP) y miniaturas de YouTube en máxima resolución.",
  },
  {
    icon: "🎵",
    title: "Solo audio",
    text: "Extrae el audio en MP3 (192 kbps) o M4A con la calidad original, ideal para música y podcasts.",
  },
];

const STEPS = [
  { n: "1", title: "Copia el enlace", text: "Desde la app o el navegador, copia la URL del video, short, playlist o galería." },
  { n: "2", title: "Pégalo y busca", text: "Detectamos la plataforma y el tipo de contenido automáticamente." },
  { n: "3", title: "Elige y descarga", text: "Selecciona calidad o formato y la descarga empieza en tu navegador." },
];

const FAQ = [
  {
    q: "¿Qué enlaces se admiten?",
    a: "youtube.com/watch, youtu.be, youtube.com/shorts, youtube.com/playlist, tiktok.com/@usuario/video, tiktok.com/@usuario/photo y los enlaces cortos vm.tiktok.com / vt.tiktok.com.",
  },
  {
    q: "¿Por qué no hay 1080p en algunos videos?",
    a: "Solo se muestran las calidades que YouTube publica para ese video. Para las altas resoluciones, el video y el audio vienen separados y los unimos en el servidor.",
  },
  {
    q: "¿Puedo descargar el perfil completo de un usuario de TikTok?",
    a: "No. TikTok solo permite resolver publicaciones concretas (videos y galerías públicas) de forma fiable.",
  },
  {
    q: "¿Es legal?",
    a: "Descarga únicamente contenido propio, con licencia libre o con permiso de su autor. Respeta los derechos de autor y los términos de cada plataforma. No almacenamos tus descargas.",
  },
];

export default function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Fondo */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="bg-grid absolute inset-0" />
        <div className="absolute -left-40 -top-40 h-[32rem] w-[32rem] rounded-full bg-fuchsia-600/25 blur-[120px]" />
        <div className="absolute -right-40 top-20 h-[28rem] w-[28rem] rounded-full bg-cyan-500/20 blur-[120px]" />
      </div>

      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <a href="/" className="flex items-center gap-2 font-bold tracking-tight">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-fuchsia-500 to-cyan-400 text-lg text-black">
            ⬇
          </span>
          <span className="text-lg">
            Clip<span className="text-fuchsia-400">Grab</span>
          </span>
        </a>
        <nav className="hidden gap-6 text-sm text-white/60 sm:flex">
          <a href="#funciones" className="hover:text-white">Funciones</a>
          <a href="#como-funciona" className="hover:text-white">Cómo funciona</a>
          <a href="#faq" className="hover:text-white">Preguntas</a>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-5">
        <section className="pb-16 pt-10 text-center sm:pt-16">
          <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
            <span className="h-2 w-2 rounded-full bg-emerald-400" /> YouTube · Shorts · Playlists · TikTok
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-extrabold leading-tight tracking-tight sm:text-6xl">
            Descarga videos, shorts, playlists e imágenes{" "}
            <span className="bg-gradient-to-r from-fuchsia-400 to-cyan-300 bg-clip-text text-transparent">
              en segundos
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-white/60 sm:text-lg">
            Pega un enlace de YouTube o TikTok y elige el formato. MP4, MP3 o fotos, sin marca de agua y
            sin registrarte.
          </p>
          <div className="mt-10">
            <Downloader />
          </div>
        </section>

        <section id="funciones" className="scroll-mt-10 py-12">
          <h2 className="mb-8 text-center text-2xl font-bold sm:text-3xl">Todo lo que necesitas</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <div className="mb-3 text-3xl">{f.icon}</div>
                <h3 className="font-semibold">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/55">{f.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="como-funciona" className="scroll-mt-10 py-12">
          <h2 className="mb-8 text-center text-2xl font-bold sm:text-3xl">Cómo funciona</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <div className="mb-3 grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-fuchsia-500 to-cyan-400 font-bold text-black">
                  {s.n}
                </div>
                <h3 className="font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/55">{s.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="faq" className="mx-auto max-w-3xl scroll-mt-10 py-12">
          <h2 className="mb-8 text-center text-2xl font-bold sm:text-3xl">Preguntas frecuentes</h2>
          <div className="space-y-3">
            {FAQ.map((f) => (
              <details key={f.q} className="group rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <summary className="flex cursor-pointer list-none items-center justify-between font-medium">
                  {f.q}
                  <span className="text-white/40 transition group-open:rotate-45">＋</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-white/60">{f.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 py-8 text-center text-xs text-white/40">
        <p className="mx-auto max-w-2xl px-5">
          Este servicio no está afiliado a YouTube ni a TikTok. Úsalo solo con contenido que tengas derecho a
          descargar. Los archivos se transmiten directamente a tu dispositivo y no se almacenan.
        </p>
      </footer>
    </div>
  );
}
