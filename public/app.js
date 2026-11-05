const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");
let current = null; // último resultado gerado
let playing = false;

// ---------- Abas ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $("#form-viral").classList.toggle("hidden", tab.dataset.tab !== "viral");
    $("#form-ugc").classList.toggle("hidden", tab.dataset.tab !== "ugc");
  });
});

// ---------- Prévia da imagem do produto ----------
$("#form-ugc input[type=file]").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = $("#preview-img");
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  $("#drop-text").textContent = file.name;
});

// ---------- Envio dos formulários ----------
async function submit(form, url, options) {
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  statusEl.className = "status";
  statusEl.textContent = "A IA está criando seu vídeo... isso pode levar até um minuto.";
  try {
    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erro ao gerar.");
    current = data;
    statusEl.textContent = "Pronto!";
    render(data);
  } catch (err) {
    statusEl.className = "status error";
    statusEl.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

$("#form-viral").addEventListener("submit", (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  submit(e.target, "/api/viral", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
});

$("#form-ugc").addEventListener("submit", (e) => {
  e.preventDefault();
  submit(e.target, "/api/ugc", { method: "POST", body: new FormData(e.target) });
});

// ---------- Renderização ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const list = (items) => `<ul>${(items || []).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
const card = (title, html) => `<div class="card"><h3>${esc(title)}</h3>${html}</div>`;

function render(data) {
  stop();
  const parts = [];

  if (data.product) {
    const p = data.product;
    parts.push(card(`Produto identificado: ${p.name}`, `
      <p><strong>Categoria:</strong> ${esc(p.category)}<br><strong>Público:</strong> ${esc(p.target_audience)}</p>
      <strong>Benefícios</strong>${list(p.benefits)}
      <strong>Dores que resolve</strong>${list(p.pain_points)}`));
    const inf = data.influencer;
    parts.push(card("Influenciadora (IA)", `
      <p><strong>Persona:</strong> ${esc(inf.persona)}<br><strong>Visual:</strong> ${esc(inf.look)}<br>
      <strong>Voz:</strong> ${esc(inf.voice)}</p>
      <p class="prompt"><strong>Prompt do avatar:</strong> ${esc(inf.avatar_prompt)}</p>`));
  } else {
    parts.push(card(data.title, `<p>${esc(data.why_it_can_go_viral)}</p>`));
  }

  parts.push(card("Ganchos (3 primeiros segundos)", `<p><strong>Escolhido:</strong> ${esc(data.chosen_hook)}</p>${list(data.hooks)}`));

  parts.push(card("Cenas", data.scenes.map((s) => `
    <div class="scene">
      <div class="time">${s.start_seconds}s – ${s.end_seconds}s</div>
      <div><strong>Fala:</strong> ${esc(s.narration)}</div>
      <div><strong>Texto na tela:</strong> ${esc(s.on_screen_text)}</div>
      <div><strong>Visual:</strong> ${esc(s.visual)}</div>
      <div class="prompt">Prompt: ${esc(s.image_prompt)}</div>
    </div>`).join("")));

  parts.push(card("Roteiro completo", `<pre>${esc(data.full_script)}</pre>`));
  parts.push(card("Legenda do post", `<pre>${esc(data.caption)}</pre>
    <p><strong>CTA:</strong> ${esc(data.call_to_action)}</p>
    <div class="tags">${data.hashtags.map((h) => `<span>${esc(h.startsWith("#") ? h : "#" + h)}</span>`).join("")}</div>`));

  if (data.thumbnail_idea) parts.push(card("Thumbnail e trilha", `<p>${esc(data.thumbnail_idea)}</p><p><strong>Música:</strong> ${esc(data.music_mood)}</p>`));
  if (data.ad_angles) parts.push(card("Outros ângulos para testar", list(data.ad_angles)));

  parts.push(`<div class="actions">
    <button id="copy-script" class="secondary">Copiar roteiro</button>
    <button id="download-json" class="secondary">Baixar projeto (JSON)</button>
  </div>`);

  $("#details").innerHTML = parts.join("");
  $("#result").classList.remove("hidden");
  showScene(data.scenes[0], 0);

  $("#copy-script").onclick = () => navigator.clipboard.writeText(data.full_script);
  $("#download-json").onclick = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "projeto-video.json" });
    a.click();
  };
  $("#result").scrollIntoView({ behavior: "smooth" });
}

// ---------- Player de prévia (cenas + voz do navegador) ----------
const GRADIENTS = [
  "linear-gradient(160deg,#3a1030,#12122a)", "linear-gradient(160deg,#0f3443,#34e89e33)",
  "linear-gradient(160deg,#41295a,#2f0743)", "linear-gradient(160deg,#16222a,#3a6073)",
  "linear-gradient(160deg,#5a1a1a,#1a1a40)",
];

function showScene(scene, i) {
  $("#stage-visual").style.background = GRADIENTS[i % GRADIENTS.length];
  $("#stage-visual").textContent = scene ? `🎬 ${scene.visual}` : "";
  $("#stage-text").innerHTML = scene ? `<span class="hl">${esc(scene.on_screen_text)}</span>` : "▶ Prévia";
}

function speak(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return setTimeout(resolve, 2500);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "pt-BR";
    u.rate = 1.1;
    u.onend = u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

async function play() {
  if (!current || playing) return;
  playing = true;
  for (let i = 0; i < current.scenes.length && playing; i++) {
    showScene(current.scenes[i], i);
    await speak(current.scenes[i].narration);
  }
  playing = false;
}

function stop() {
  playing = false;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

$("#play").onclick = play;
$("#stop").onclick = stop;
