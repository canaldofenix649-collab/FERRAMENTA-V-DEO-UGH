// Service worker: permite instalar como aplicativo e abre a tela mesmo com internet ruim.
// Os dados (/api) sempre vêm do servidor, nunca do cache.
const CACHE = "barbearia-v4";
const ARQUIVOS = ["/", "/index.html", "/app.js", "/style.css", "/icone.svg", "/manifest.webmanifest", "/zipcsv.js"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // rede primeiro (pega sempre a versão nova); se cair a internet, usa a cópia guardada
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html"))),
  );
});
