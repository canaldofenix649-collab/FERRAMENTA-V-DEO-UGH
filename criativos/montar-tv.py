#!/usr/bin/env python3
"""Junta os criativos numa playlist única para a TV (tv-negueba.html).

Rode de novo sempre que mudar algum criativo:  python3 criativos/montar-tv.py
"""
import base64
import json
import pathlib

AQUI = pathlib.Path(__file__).parent

# (arquivo, duração de uma volta completa em segundos)
PLAYLIST = [
    ("depilacao-cera.html", 42),   # Cera no nariz e ouvido (pelos no nariz e no ouvido)
    ("tabela-precos.html", 46),    # Tabela de preços com a novidade
]

ESCONDE_BOTAO = "<style>#fs{display:none!important}body{cursor:none}</style>"

itens = []
for nome, dur in PLAYLIST:
    html = (AQUI / nome).read_text(encoding="utf-8") + ESCONDE_BOTAO
    itens.append({"b64": base64.b64encode(html.encode("utf-8")).decode(), "dur": dur})

pagina = """<title>TV Negueba Show</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
:root { --bg: #5e070d; --fg: #ffffff; color-scheme: dark; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); overflow: hidden; font-family: Arial, sans-serif;
  padding-left: max(0px, env(safe-area-inset-left, 0px)); padding-right: max(0px, env(safe-area-inset-right, 0px)); }
iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; background: var(--bg); opacity: 0; transition: opacity .5s; }
iframe.on { opacity: 1; z-index: 2; }
#fs { position: fixed; z-index: 20; top: calc(16px + env(safe-area-inset-top, 0px)); right: max(16px, env(safe-area-inset-right, 0px));
  font: 700 14px Arial, sans-serif; color: var(--fg); background: rgba(122,9,17,.9);
  border: 1px solid rgba(255,255,255,.6); border-radius: 999px; padding: 10px 18px; cursor: pointer; transition: opacity .4s; }
#fs:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
body.idle #fs { opacity: 0; pointer-events: none; }
body.idle { cursor: none; }
</style>
<iframe id="a" title="Criativo"></iframe>
<iframe id="b" title="Criativo"></iframe>
<button id="fs" type="button">Tela cheia</button>
<script>
(function () {
  const ITENS = __ITENS__;
  const dec = s => new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));
  const html = ITENS.map(it => dec(it.b64));
  const frames = [document.getElementById('a'), document.getElementById('b')];
  let atual = 0, quadro = 0;
  function mostrar() { frames[quadro].classList.add('on'); frames[1 - quadro].classList.remove('on'); }
  function agendar() {
    const d = ITENS[atual].dur * 1000, prox = (atual + 1) % ITENS.length;
    // prepara o próximo um pouco antes, para não piscar em branco
    setTimeout(() => { frames[1 - quadro].srcdoc = html[prox]; }, Math.max(0, d - 900));
    setTimeout(() => { quadro = 1 - quadro; atual = prox; mostrar(); agendar(); }, d);
  }
  frames[0].srcdoc = html[0]; mostrar(); agendar();

  document.getElementById('fs').addEventListener('click', () => {
    const p = document.fullscreenElement ? document.exitFullscreen() : (document.documentElement.requestFullscreen ? document.documentElement.requestFullscreen() : null);
    if (p && p.catch) p.catch(() => {});
  });
  async function wake() { try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) {} }
  wake(); document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  let t;
  function poke() { document.body.classList.remove('idle'); clearTimeout(t); t = setTimeout(() => document.body.classList.add('idle'), 3000); }
  addEventListener('mousemove', poke); addEventListener('keydown', poke); poke();
})();
</script>
"""

(AQUI / "tv-negueba.html").write_text(pagina.replace("__ITENS__", json.dumps(itens)), encoding="utf-8")
print("tv-negueba.html gerado com", len(itens), "criativos")
