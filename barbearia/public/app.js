// Interface do app de gestão da barbearia (sem frameworks).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const brl = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dataBR = (d) => (d ? d.slice(0, 10).split("-").reverse().join("/") : "");
const diaMes = (d) => (d ? d.slice(8, 10) + "/" + d.slice(5, 7) : "");
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const mesNome = (m) => MESES[Number(m.slice(5, 7)) - 1] + "/" + m.slice(2, 4);
const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const FORMAS = { cash: "Dinheiro", pix: "PIX", debit_card: "Débito", credit_card: "Crédito", plan: "Plano", other: "Outro", fiado: "Fiado" };
const TIPOS = { service: "Serviço", income: "Entrada", expense: "Saída", commission: "Comissão extra" };

let base = null; // colaboradores, serviços, clientes, produtos, taxas
let hoje = "";
let abaAtual = "caixa";
let papel = null; // "dono" ou "barbeiro"
let eu = null;    // { id, nome } quando é barbeiro
const ABAS_BARBEIRO = ["caixa", "meus"];

// ---------- API ----------
async function api(caminho, opcoes = {}) {
  const o = { ...opcoes, headers: { ...(opcoes.headers || {}) } };
  if (o.body && typeof o.body === "object" && !(o.body instanceof Blob) && !(o.body instanceof ArrayBuffer)) {
    o.body = JSON.stringify(o.body);
    o.headers["Content-Type"] = "application/json";
  }
  const r = await fetch("/api" + caminho, o);
  const dados = await r.json().catch(() => ({}));
  if (r.status === 401 && caminho !== "/login") { iniciar(); throw new Error(dados.erro || "Entre de novo."); }
  if (!r.ok) throw new Error(dados.erro || "Algo deu errado.");
  return dados;
}
const post = (c, body) => api(c, { method: "POST", body });

let timerAviso;
function aviso(msg, ruim = false) {
  const el = $("#aviso");
  el.textContent = msg;
  el.className = "aviso ver" + (ruim ? " ruim" : "");
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => (el.className = "aviso"), 2600);
}
async function tentar(fn) {
  try { return await fn(); } catch (e) { aviso(e.message, true); }
}

// ---------- datas ----------
function somaDias(d, n) {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function periodo(chave) {
  const ano = hoje.slice(0, 4), mes = hoje.slice(0, 7);
  const dow = new Date(hoje + "T12:00:00Z").getUTCDay();
  const seg = somaDias(hoje, -((dow + 6) % 7));
  switch (chave) {
    case "hoje": return [hoje, hoje];
    case "semana": return [seg, somaDias(seg, 6)];
    case "semana_passada": return [somaDias(seg, -7), somaDias(seg, -1)];
    case "mes": return [mes + "-01", hoje];
    case "mes_passado": { const fim = somaDias(mes + "-01", -1); return [fim.slice(0, 7) + "-01", fim]; }
    case "30d": return [somaDias(hoje, -29), hoje];
    case "ano": return [ano + "-01-01", hoje];
    default: return ["2000-01-01", hoje];
  }
}
function seletorPeriodo(id, atual, opcoes = ["hoje", "semana", "semana_passada", "mes", "mes_passado", "30d", "ano", "tudo"]) {
  const nomes = { hoje: "Hoje", semana: "Esta semana", semana_passada: "Semana passada", mes: "Este mês", mes_passado: "Mês passado", "30d": "Últimos 30 dias", ano: "Este ano", tudo: "Tudo", livre: "Escolher datas" };
  return `<div class="linha">
    <select id="${id}" style="width:auto">${[...opcoes, "livre"].map((o) => `<option value="${o}" ${o === atual.chave ? "selected" : ""}>${nomes[o]}</option>`).join("")}</select>
    <span id="${id}-livre" class="linha" ${atual.chave === "livre" ? "" : "hidden"}>
      <input type="date" id="${id}-de" value="${atual.de}" style="width:auto"> até <input type="date" id="${id}-ate" value="${atual.ate}" style="width:auto">
    </span>
  </div>`;
}
function ligarPeriodo(id, estado, aoMudar) {
  const sel = $("#" + id);
  sel.onchange = () => {
    estado.chave = sel.value;
    if (sel.value !== "livre") [estado.de, estado.ate] = periodo(sel.value);
    $("#" + id + "-livre").hidden = sel.value !== "livre";
    aoMudar();
  };
  $("#" + id + "-de").onchange = (e) => { estado.de = e.target.value; aoMudar(); };
  $("#" + id + "-ate").onchange = (e) => { estado.ate = e.target.value; aoMudar(); };
}

// ---------- diálogo de formulário ----------
function abrirDialogo(titulo, campos, aoSalvar, extra = "") {
  const dlg = $("#dialogo"), form = $("#dialogo-form");
  form.innerHTML = `<h2>${esc(titulo)}</h2>${extra}
    <div class="campos">${campos.map(campoHtml).join("")}</div>
    <p class="erro" id="dlg-erro"></p>
    <div class="linha"><span class="espaco"></span><button class="btn" value="cancelar" formnovalidate>Cancelar</button><button class="btn primario" value="salvar" id="dlg-salvar">Salvar</button></div>`;
  form.onsubmit = async (e) => {
    if (e.submitter?.value !== "salvar") return;
    e.preventDefault();
    const dados = {};
    for (const c of campos) {
      const el = form.elements[c.nome];
      if (!el) continue;
      if (c.tipo === "checkbox") dados[c.nome] = el.checked ? 1 : 0;
      else if (c.tipo === "multi") dados[c.nome] = $$(`input[name="${c.nome}"]:checked`, form).map((x) => x.value);
      else dados[c.nome] = el.value;
    }
    $("#dlg-salvar").disabled = true;
    try {
      await aoSalvar(dados);
      dlg.close();
    } catch (err) {
      $("#dlg-erro").textContent = err.message;
    } finally {
      $("#dlg-salvar").disabled = false;
    }
  };
  dlg.showModal();
  setTimeout(() => form.querySelector("input:not([type=checkbox]),select,textarea")?.focus(), 30);
}
function campoHtml(c) {
  const v = c.valor ?? "";
  const largo = c.largo ? ' style="grid-column:1/-1"' : "";
  if (c.tipo === "select") {
    return `<label${largo}>${esc(c.rotulo)}<select name="${c.nome}">${c.opcoes.map(([val, txt]) => `<option value="${esc(val)}" ${String(val) === String(v) ? "selected" : ""}>${esc(txt)}</option>`).join("")}</select></label>`;
  }
  if (c.tipo === "checkbox") return `<label${largo}><input type="checkbox" name="${c.nome}" ${v ? "checked" : ""}>${esc(c.rotulo)}</label>`;
  if (c.tipo === "textarea") return `<label style="grid-column:1/-1">${esc(c.rotulo)}<textarea name="${c.nome}" rows="2">${esc(v)}</textarea></label>`;
  if (c.tipo === "multi") {
    const sel = new Set(c.valor || []);
    return `<div style="grid-column:1/-1"><label>${esc(c.rotulo)}</label><div class="chips">${c.opcoes.map(([val, txt]) => `<label class="chip" style="margin:0"><input type="checkbox" name="${c.nome}" value="${esc(val)}" ${sel.has(val) ? "checked" : ""}>${esc(txt)}</label>`).join("")}</div></div>`;
  }
  if (c.tipo === "pin") return `<label${largo}>${esc(c.rotulo)}<input name="${c.nome}" type="password" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" autocomplete="new-password"></label>`;
  return `<label${largo}>${esc(c.rotulo)}<input name="${c.nome}" type="${c.tipo || "text"}" value="${esc(v)}" ${c.tipo === "number" ? 'step="0.01" inputmode="decimal"' : ""} ${c.obrigatorio ? "required" : ""}></label>`;
}
function confirmar(msg) { return window.confirm(msg); }

const opcoesClientes = (vazio = "Sem cliente") => [["", vazio], ...base.clientes.map((c) => [c.id, c.nome])];
const opcoesColabs = (vazio = "—", todos = false) => [["", vazio], ...base.colaboradores.filter((c) => todos || c.ativo).map((c) => [c.id, c.nome])];
const opcoesFormas = (semPlano = true) => Object.entries(FORMAS).filter(([k]) => k !== "fiado" && (!semPlano || k !== "plan"));
const nomeColab = (id) => base.colaboradores.find((c) => c.id === id)?.nome || "";
const primeiroNome = (n) => (n || "").trim().split(/\s+/)[0];

async function recarregarBase() {
  base = await api("/base");
  $("#nome-barbearia").textContent = base.nome;
  document.title = base.nome + " · Gestão";
}

// ---------- entrada ----------
async function iniciar() {
  const e = await api("/estado");
  hoje = e.hoje;
  if (!e.logado) return mostrarEntrada(e);
  papel = e.papel; eu = e.eu;
  await recarregarBase();
  $("#tela-entrada").hidden = true;
  $("#app").hidden = false;
  $$("#abas button").forEach((b) => (b.hidden = papel === "barbeiro" ? !ABAS_BARBEIRO.includes(b.dataset.aba) : b.dataset.aba === "meus"));
  $("#quem-sou").textContent = eu ? primeiroNome(eu.nome) : "";
  abrirAba(location.hash.slice(1) || "caixa");
}
let estadoEntrada = null, entradaComo = null; // null = dono; id = barbeiro
try { entradaComo = localStorage.getItem("entrada_como") || null; } catch {}
function mostrarEntrada(e) {
  if (e && typeof e === "object") estadoEntrada = e;
  const est = estadoEntrada || { configurado: true, acessos: [] };
  $("#app").hidden = true;
  $("#tela-entrada").hidden = false;
  const acessos = est.configurado ? est.acessos || [] : [];
  if (entradaComo && !acessos.some((a) => a.id === entradaComo)) entradaComo = null;
  $("#entrada-quem").innerHTML = acessos.length
    ? `<p class="sutil">Quem está entrando?</p><div class="chips" style="justify-content:center">${acessos.map((a) => `<button type="button" class="chip ${entradaComo === a.id ? "sel" : ""}" data-quem="${a.id}">${esc(a.nome)}</button>`).join("")}<button type="button" class="chip ${entradaComo ? "" : "sel"}" data-quem="">Dono</button></div>`
    : "";
  $$("[data-quem]").forEach((b) => (b.onclick = () => { entradaComo = b.dataset.quem || null; mostrarEntrada(); $("#form-entrada").senha.focus(); }));
  const campo = $("#form-entrada").senha;
  $("#campo-nome").hidden = est.configurado;
  $("#rotulo-senha").firstChild.textContent = entradaComo ? "Seu PIN" : est.configurado ? "Senha do dono" : "Crie a senha do dono";
  campo.inputMode = entradaComo ? "numeric" : "text";
  campo.autocomplete = entradaComo ? "off" : "current-password";
  $("#entrada-texto").textContent = est.configurado ? "" : "Primeiro acesso: crie a senha do dono. Ela protege todos os dados da barbearia.";
  $("#btn-entrada").textContent = est.configurado ? "Entrar" : "Criar senha e entrar";
  $("#form-entrada").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    $("#erro-entrada").textContent = "";
    try {
      if (!est.configurado) await post("/senha/criar", { senha: f.senha.value, nome: f.nome.value });
      else {
        await post("/login", { senha: f.senha.value, colaborador_id: entradaComo });
        try { entradaComo ? localStorage.setItem("entrada_como", entradaComo) : localStorage.removeItem("entrada_como"); } catch {}
      }
      f.reset();
      iniciar();
    } catch (err) { $("#erro-entrada").textContent = err.message; }
  };
}
$("#btn-sair").onclick = async () => { await post("/logout"); history.replaceState(null, "", "/"); iniciar(); };

// ---------- abas ----------
const ABAS = {};
$("#abas").onclick = (e) => { const b = e.target.closest("button[data-aba]"); if (b) abrirAba(b.dataset.aba); };
function abrirAba(nome) {
  if (!ABAS[nome] || (papel === "barbeiro" && !ABAS_BARBEIRO.includes(nome)) || (papel === "dono" && nome === "meus")) nome = "caixa";
  abaAtual = nome;
  history.replaceState(null, "", "#" + nome);
  $$("#abas button").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === nome));
  $("#abas button.ativa")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  $("#conteudo").innerHTML = '<p class="vazio">Carregando…</p>';
  tentar(() => ABAS[nome]($("#conteudo")));
}

// ======================= CAIXA (lançar) =======================
const novo = { tipo: "service", colab: null, servicos: [], forma: "cash", cliente: "", valor: "", valorEditado: false };
ABAS.caixa = async (el) => {
  const ativos = base.colaboradores.filter((c) => c.ativo);
  if (!novo.colab || !ativos.some((c) => c.id === novo.colab)) novo.colab = ativos[0]?.id || null;
  el.innerHTML = `<div class="grade">
    <section class="cartao" id="novo-lanc"></section>
    <div class="pilha"><section class="cartao" id="hoje-resumo"></section><section class="cartao" id="hoje-lista"></section></div>
  </div>`;
  desenharNovo();
  await atualizarHoje();
};

function desenharNovo() {
  const el = $("#novo-lanc");
  const ativos = base.colaboradores.filter((c) => c.ativo);
  const servs = base.servicos.filter((s) => s.ativo);
  const tipoBtn = (t, txt) => `<button class="chip ${novo.tipo === t ? "sel" : ""}" data-tipo="${t}">${txt}</button>`;
  let corpo = "";
  const colabChips = (rot = "Quem fez") => `<label>${rot}</label><div class="chips" id="ch-colab">${ativos.map((c) => `<button class="chip ${novo.colab === c.id ? "sel" : ""}" data-id="${c.id}">${esc(primeiroNome(c.nome))}</button>`).join("")}</div>`;
  const formaChips = (lista) => `<label>Pagamento</label><div class="chips" id="ch-forma">${lista.map((f) => `<button class="chip ${novo.forma === f ? "sel" : ""}" data-f="${f}">${FORMAS[f]}</button>`).join("")}</div>`;
  const clienteSel = (rot = "Cliente (opcional)") => `<label>${rot}<div class="linha" style="flex-wrap:nowrap"><select id="n-cliente">${opcoesClientes().map(([v, t]) => `<option value="${v}" ${v === novo.cliente ? "selected" : ""}>${esc(t)}</option>`).join("")}</select><button class="btn pequeno" id="n-cliente-novo" title="Novo cliente" style="margin-top:4px">+ novo</button></div></label>`;

  if (novo.tipo === "service") {
    const total = calcTotal();
    const planoCliente = novo.cliente && base.planos.find((p) => p.cliente_id === novo.cliente);
    corpo = `${papel === "dono" ? colabChips() : ""}
      <label>Serviços (toque para somar)</label>
      <div class="chips" id="ch-serv">${servs.map((s) => { const n = novo.servicos.filter((x) => x === s.id).length; return `<button class="chip ${n ? "sel" : ""}" data-id="${s.id}">${esc(s.nome)}${n > 1 ? ` ×${n}` : ""}<small>${brl(s.preco)}</small></button>`; }).join("")}</div>
      ${novo.servicos.length ? `<button class="btn fantasma pequeno" id="limpar-serv">Limpar serviços</button>` : ""}
      ${formaChips(["cash", "pix", "debit_card", "credit_card", "plan", "fiado", "other"])}
      ${clienteSel(novo.forma === "fiado" || novo.forma === "plan" ? "Cliente" : "Cliente (opcional)")}
      ${planoCliente && novo.forma !== "plan" ? `<p class="pequeno-txt sutil">Esse cliente tem plano ativo. Para usar o plano, escolha a forma "Plano".</p>` : ""}
      ${novo.forma === "plan" ? `<p class="pequeno-txt sutil">Corte do plano: entra R$ 0 no caixa, mas a comissão do barbeiro é contada.</p>` : `<label>Valor cobrado<input id="n-valor" type="number" step="0.01" inputmode="decimal" value="${novo.valorEditado ? esc(novo.valor) : total || ""}" placeholder="0,00"></label>`}
      <button class="btn primario largo" id="n-lancar">${novo.forma === "fiado" ? "Anotar fiado" : "Lançar"} <span class="num">${novo.forma === "plan" ? "" : brl(novo.valorEditado ? novo.valor : total)}</span></button>`;
  } else if (novo.tipo === "income") {
    corpo = `<label>Produto vendido (opcional)<select id="n-produto"><option value="">— nenhum —</option>${base.produtos.filter((p) => p.ativo).map((p) => `<option value="${p.id}" data-preco="${p.preco}">${esc(p.nome)} · ${brl(p.preco)} · estoque ${p.estoque}</option>`).join("")}</select></label>
      <label>Descrição<input id="n-desc" placeholder="Ex.: gorjeta, venda de pomada"></label>
      <label>Valor<input id="n-valor" type="number" step="0.01" inputmode="decimal"></label>
      ${formaChips(["cash", "pix", "debit_card", "credit_card", "other"])}
      ${clienteSel()}
      <button class="btn primario largo" id="n-lancar">Lançar entrada</button>`;
  } else if (novo.tipo === "expense") {
    corpo = `<label>Descrição<input id="n-desc" placeholder="Ex.: café, material de limpeza"></label>
      <label>Valor<input id="n-valor" type="number" step="0.01" inputmode="decimal"></label>
      ${formaChips(["cash", "pix", "debit_card", "credit_card", "other"])}
      <p class="pequeno-txt sutil">Para pagar comissão ou dar vale a um barbeiro, use a aba Comissões.</p>
      <button class="btn primario largo" id="n-lancar">Lançar saída</button>`;
  }
  el.innerHTML = `<div class="linha entre"><h2>Novo lançamento</h2></div>
    ${papel === "dono" ? `<div class="chips">${tipoBtn("service", "Corte / serviço")}${tipoBtn("income", "Entrada / venda")}${tipoBtn("expense", "Saída")}</div>` : ""}${corpo}`;

  $$("[data-tipo]", el).forEach((b) => (b.onclick = () => { novo.tipo = b.dataset.tipo; novo.forma = "cash"; novo.valorEditado = false; desenharNovo(); }));
  $$("#ch-colab .chip", el).forEach((b) => (b.onclick = () => { novo.colab = b.dataset.id; desenharNovo(); }));
  $$("#ch-forma .chip", el).forEach((b) => (b.onclick = () => {
    novo.forma = b.dataset.f;
    if (novo.forma === "plan" && novo.cliente) {
      const p = base.planos.find((x) => x.cliente_id === novo.cliente);
      if (p && !novo.servicos.length) novo.servicos = JSON.parse(p.servicos_inclusos || "[]").slice(0, 1);
    }
    desenharNovo();
  }));
  $$("#ch-serv .chip", el).forEach((b) => {
    b.onclick = () => { novo.servicos.push(b.dataset.id); novo.valorEditado = false; desenharNovo(); };
    b.oncontextmenu = (e) => { e.preventDefault(); const i = novo.servicos.lastIndexOf(b.dataset.id); if (i >= 0) novo.servicos.splice(i, 1); novo.valorEditado = false; desenharNovo(); };
  });
  $("#limpar-serv", el)?.addEventListener("click", () => { novo.servicos = []; novo.valorEditado = false; desenharNovo(); });
  const cli = $("#n-cliente", el);
  if (cli) cli.onchange = () => { novo.cliente = cli.value; if (novo.tipo === "service") desenharNovo(); };
  $("#n-cliente-novo", el)?.addEventListener("click", () => editarCliente(null, (id) => { novo.cliente = id; desenharNovo(); }));
  const val = $("#n-valor", el);
  if (val && novo.tipo === "service") val.oninput = () => { novo.valor = val.value; novo.valorEditado = true; $("#n-lancar .num").textContent = brl(val.value); };
  const prod = $("#n-produto", el);
  if (prod) prod.onchange = () => { const o = prod.selectedOptions[0]; if (o.dataset.preco) $("#n-valor").value = o.dataset.preco; };
  $("#n-lancar", el).onclick = lancarNovo;
}
function calcTotal() {
  return novo.servicos.reduce((s, id) => s + (base.servicos.find((x) => x.id === id)?.preco || 0), 0);
}
async function lancarNovo() {
  const btn = $("#n-lancar");
  btn.disabled = true;
  try {
    const cliente_id = $("#n-cliente")?.value || null;
    if (novo.tipo === "service") {
      const valor = novo.forma === "plan" ? 0 : $("#n-valor").value;
      const r = await post("/transacoes", { tipo: "service", colaborador_id: novo.colab, servicos: novo.servicos, forma_pagamento: novo.forma, cliente_id, valor });
      aviso(r.fiado ? "Fiado anotado" : "Lançado!");
      novo.servicos = []; novo.valorEditado = false; novo.cliente = ""; novo.forma = "cash";
    } else {
      await post("/transacoes", { tipo: novo.tipo, descricao: $("#n-desc").value, valor: $("#n-valor").value, forma_pagamento: novo.forma, cliente_id, produto_id: $("#n-produto")?.value || null });
      aviso("Lançado!");
      if ($("#n-produto")?.value) await recarregarBase();
    }
    desenharNovo();
    await atualizarHoje();
  } catch (e) { aviso(e.message, true); } finally { if (document.body.contains(btn)) btn.disabled = false; }
}

async function atualizarHoje() {
  if (papel === "barbeiro") return atualizarHojeBarbeiro();
  const [res, lista, cx] = await Promise.all([api(`/resumo?de=${hoje}&ate=${hoje}`), api(`/transacoes?de=${hoje}&sem_taxas=1`), api("/caixa")]);
  const g = res.geral;
  const caixaTxt = !cx.caixa
    ? `<button class="btn pequeno" id="cx-abrir">Abrir caixa</button>`
    : cx.caixa.fechado_em
      ? `<span class="etiqueta">Fechado às ${cx.caixa.fechado_em.slice(11)} com ${brl(cx.caixa.fechamento)}</span> <button class="btn pequeno fantasma" id="cx-abrir">Reabrir</button>`
      : `<span class="etiqueta ok">Aberto</span> <span class="sutil pequeno-txt">gaveta deve ter ${brl(cx.esperado_na_gaveta)}</span> <button class="btn pequeno" id="cx-fechar">Fechar caixa</button>`;
  $("#hoje-resumo").innerHTML = `<div class="linha entre"><h2>Hoje · ${dataBR(hoje)}</h2><div class="linha">${caixaTxt}</div></div>
    <div class="kpis">
      <div class="kpi"><div class="rot">Cortes</div><div class="val">${g.cortes}</div><div class="det">${g.cortes_plano ? g.cortes_plano + " de plano" : "&nbsp;"}</div></div>
      <div class="kpi destaque"><div class="rot">Faturado</div><div class="val">${brl(g.faturamento)}</div><div class="det">ticket ${brl(g.ticket_medio)}</div></div>
      <div class="kpi"><div class="rot">Comissões</div><div class="val">${brl(g.comissoes)}</div></div>
      <div class="kpi"><div class="rot">Fica p/ barbearia</div><div class="val">${brl(g.lucro)}</div><div class="det">depois de comissões e despesas</div></div>
    </div>
    ${res.porColaborador.filter((c) => c.cortes).map((c) => `<div class="linha entre pequeno-txt" style="margin-top:8px"><span>${esc(c.nome)}</span><span class="num">${c.cortes} cortes · ${brl(c.faturado)} · comissão ${brl(c.comissao)}</span></div>`).join("")}`;
  $("#cx-abrir")?.addEventListener("click", () => abrirDialogo("Abrir caixa", [{ nome: "abertura", rotulo: "Dinheiro na gaveta (troco)", tipo: "number", valor: 0 }], async (d) => { await post("/caixa/abrir", d); atualizarHoje(); }));
  $("#cx-fechar")?.addEventListener("click", () => abrirDialogo("Fechar caixa", [
    { nome: "fechamento", rotulo: "Dinheiro contado na gaveta", tipo: "number", valor: cx.esperado_na_gaveta },
    { nome: "observacoes", rotulo: "Observações", tipo: "textarea" },
  ], async (d) => { await post("/caixa/fechar", d); aviso("Caixa fechado"); atualizarHoje(); },
  `<p class="sutil pequeno-txt">Abertura ${brl(cx.caixa.abertura)} + dinheiro que entrou ${brl(cx.dinheiro_entrou)} − saídas em dinheiro ${brl(cx.dinheiro_saiu)} = <b>${brl(cx.esperado_na_gaveta)}</b></p>`));

  $("#hoje-lista").innerHTML = `<h2>Lançamentos de hoje</h2>${lista.length ? lista.map(linhaLanc).join("") : '<p class="vazio">Nada lançado hoje ainda.</p>'}`;
  ligarApagar($("#hoje-lista"), atualizarHoje);
}
function linhaLanc(t) {
  const sinal = t.tipo === "expense" ? "neg" : t.tipo === "commission" ? "" : "pos";
  const valor = t.tipo === "commission" ? `+${brl(t.comissao)} com.` : (t.tipo === "expense" ? "−" : "") + brl(t.valor);
  const desc = t.descricao || (t.tipo === "service" ? "Serviço" : TIPOS[t.tipo]);
  const det = [papel === "dono" && t.colaborador && primeiroNome(t.colaborador), t.cliente, FORMAS[t.forma_pagamento], t.comissao && t.tipo !== "commission" ? "comissão " + brl(t.comissao) : ""].filter(Boolean).join(" · ");
  return `<div class="lanc"><span class="hora">${t.data_hora.slice(11)}</span><div class="info"><div>${esc(desc)}</div><div class="sutil pequeno-txt">${esc(det)}</div></div>
    <span class="num ${sinal}">${valor}</span>${podeApagar(t) ? `<button class="btn fantasma pequeno perigo" data-apagar="${t.id}" title="Apagar">✕</button>` : ""}</div>`;
}
function podeApagar(t) {
  if (papel === "dono") return true;
  return !!eu && t.lancado_por === eu.id && t.data_hora.slice(0, 10) === hoje;
}
async function atualizarHojeBarbeiro() {
  const r = await api(`/meu?de=${hoje}`);
  $("#hoje-resumo").innerHTML = `<h2>Seu dia · ${dataBR(hoje)}</h2>
    <div class="kpis">
      <div class="kpi"><div class="rot">Cortes</div><div class="val">${r.cortes}</div><div class="det">${r.cortes_plano ? r.cortes_plano + " de plano" : "&nbsp;"}</div></div>
      <div class="kpi"><div class="rot">Você faturou</div><div class="val">${brl(r.faturado)}</div></div>
      <div class="kpi destaque"><div class="rot">Sua comissão</div><div class="val pos">${brl(r.comissao)}</div></div>
    </div>`;
  $("#hoje-lista").innerHTML = `<h2>Seus lançamentos de hoje</h2>${r.lista.length ? r.lista.map(linhaLanc).join("") : '<p class="vazio">Nada lançado hoje ainda.</p>'}
    <p class="sutil pequeno-txt">Lançou errado? Apague no ✕ e lance de novo. Só dá para apagar o que você lançou hoje.</p>`;
  ligarApagar($("#hoje-lista"), atualizarHoje);
}

// ======================= MEUS NÚMEROS (barbeiro) =======================
const pMeu = { chave: "semana", de: "", ate: "" };
ABAS.meus = async (el) => {
  if (!pMeu.de) [pMeu.de, pMeu.ate] = periodo("semana");
  el.innerHTML = `<div class="pilha"><div class="linha entre"><h2>Meus números</h2>${seletorPeriodo("per-meu", pMeu, ["hoje", "semana", "semana_passada", "mes", "mes_passado"])}</div><div id="meu-corpo"></div></div>`;
  const desenhar = async () => {
    const r = await api(`/meu?de=${pMeu.de}&ate=${pMeu.ate}`);
    $("#meu-corpo").innerHTML = `<div class="pilha"><div class="kpis">
        <div class="kpi"><div class="rot">Cortes</div><div class="val">${r.cortes}</div><div class="det">${r.cortes_plano} de plano</div></div>
        <div class="kpi"><div class="rot">Faturou</div><div class="val">${brl(r.faturado)}</div></div>
        <div class="kpi"><div class="rot">Comissão</div><div class="val">${brl(r.comissao)}</div></div>
        <div class="kpi destaque"><div class="rot">A receber</div><div class="val">${brl(r.saldo)}</div><div class="det">já recebeu ${brl(r.pago)}</div></div>
      </div><section class="cartao">${r.lista.map(linhaLanc).join("") || '<p class="vazio">Nada nesse período.</p>'}</section></div>`;
    ligarApagar($("#meu-corpo"), desenhar);
  };
  ligarPeriodo("per-meu", pMeu, desenhar);
  await desenhar();
};

function ligarApagar(el, depois) {
  $$("[data-apagar]", el).forEach((b) => (b.onclick = async () => {
    if (!confirmar("Apagar este lançamento?")) return;
    await tentar(async () => { await api("/transacoes/" + b.dataset.apagar, { method: "DELETE" }); aviso("Apagado"); depois(); });
  }));
}

// ======================= PAINEL =======================
const pPainel = { chave: "mes", de: "", ate: "" };
ABAS.painel = async (el) => {
  if (!pPainel.de) [pPainel.de, pPainel.ate] = periodo("mes");
  el.innerHTML = `<div class="pilha"><div class="linha entre"><h2>Painel</h2>${seletorPeriodo("per-painel", pPainel)}</div><div id="painel-corpo"></div><section class="cartao" id="painel-meses"></section></div>`;
  ligarPeriodo("per-painel", pPainel, desenharPainel);
  await Promise.all([desenharPainel(), desenharMeses()]);
};
async function desenharPainel() {
  const r = await api(`/resumo?de=${pPainel.de}&ate=${pPainel.ate}`);
  const g = r.geral;
  const maxDia = Math.max(1, ...r.porDia.map((d) => d.faturamento));
  const totForma = r.porForma.reduce((s, f) => s + f.valor, 0) || 1;
  const maxDow = Math.max(1, ...r.porDiaSemana.map((d) => d.media_dia));
  const maxHora = Math.max(1, ...r.porHora.map((h) => h.cortes));
  $("#painel-corpo").innerHTML = `<div class="pilha">
    <div class="kpis">
      <div class="kpi destaque"><div class="rot">Faturamento</div><div class="val">${brl(g.faturamento)}</div><div class="det">serviços ${brl(g.servicos)} · extras ${brl(g.entradas)}</div></div>
      <div class="kpi"><div class="rot">Cortes</div><div class="val">${g.cortes}</div><div class="det">${g.cortes_plano} de plano · ticket ${brl(g.ticket_medio)}</div></div>
      <div class="kpi"><div class="rot">Comissões</div><div class="val">${brl(g.comissoes)}</div><div class="det">já pagas ${brl(g.comissoes_pagas)}</div></div>
      <div class="kpi"><div class="rot">Despesas</div><div class="val">${brl(g.despesas + g.taxas)}</div><div class="det">contas ${brl(g.contas_pagas)} · caixa ${brl(g.saidas_caixa)} · taxas ${brl(g.taxas)}</div></div>
      <div class="kpi destaque"><div class="rot">Sobrou para a barbearia</div><div class="val ${g.lucro < 0 ? "neg" : "pos"}">${brl(g.lucro)}</div><div class="det">faturamento − comissões − despesas</div></div>
    </div>
    ${r.porDia.length > 1 ? `<section class="cartao"><h3>Faturamento por dia</h3><div class="barras">${r.porDia.slice(-45).map((d) => `<div class="b" title="${dataBR(d.dia)}: ${brl(d.faturamento)} · ${d.cortes} cortes"><i style="height:${(d.faturamento / maxDia) * 100}%"></i><span>${d.dia.slice(8)}</span></div>`).join("")}</div></section>` : ""}
    <div class="grade">
      <section class="cartao"><h3>Por barbeiro</h3><div class="tabela-wrap"><table><thead><tr><th>Nome</th><th class="dir">Cortes</th><th class="dir">Faturou</th><th class="dir">Comissão</th></tr></thead><tbody>
        ${r.porColaborador.filter((c) => c.cortes).map((c) => `<tr><td>${esc(c.nome)}</td><td class="dir num">${c.cortes}</td><td class="dir num">${brl(c.faturado)}</td><td class="dir num">${brl(c.comissao)}</td></tr>`).join("") || '<tr><td colspan="4" class="vazio">Sem cortes no período</td></tr>'}
      </tbody></table></div></section>
      <section class="cartao"><h3>Formas de pagamento</h3>${r.porForma.map((f) => `<div style="margin-bottom:10px"><div class="linha entre pequeno-txt"><span>${FORMAS[f.forma] || f.forma} <span class="sutil">(${f.n})</span></span><span class="num">${brl(f.valor)} · ${Math.round((f.valor / totForma) * 100)}%</span></div><div class="barra-h"><i style="width:${(f.valor / totForma) * 100}%"></i></div></div>`).join("") || '<p class="vazio">—</p>'}</section>
      <section class="cartao"><h3>Média por dia da semana</h3>${r.porDiaSemana.map((d) => `<div style="margin-bottom:10px"><div class="linha entre pequeno-txt"><span>${DIAS[d.dow]} <span class="sutil">(${d.dias} dias)</span></span><span class="num">${brl(d.media_dia)}/dia · ${Math.round(d.cortes / d.dias)} cortes</span></div><div class="barra-h"><i style="width:${(d.media_dia / maxDow) * 100}%"></i></div></div>`).join("") || '<p class="vazio">—</p>'}</section>
      <section class="cartao"><h3>Movimento por horário</h3><div class="barras">${r.porHora.map((h) => `<div class="b" title="${h.hora}h: ${h.cortes} cortes · ${brl(h.valor)}"><i style="height:${(h.cortes / maxHora) * 100}%"></i><span>${h.hora}h</span></div>`).join("")}</div></section>
      <section class="cartao"><h3>Serviços mais feitos</h3><div class="tabela-wrap"><table><tbody>${r.topServicos.map((s) => `<tr><td>${esc(s.nome)}</td><td class="dir num">${s.n}×</td><td class="dir num">${brl(s.valor)}</td></tr>`).join("")}</tbody></table></div>
        <p class="sutil pequeno-txt">Os lançamentos antigos sem descrição aparecem como "(sem descrição)".</p></section>
    </div></div>`;
}
async function desenharMeses() {
  const meses = await api("/meses");
  const max = Math.max(1, ...meses.map((m) => m.faturamento));
  $("#painel-meses").innerHTML = `<h3>Mês a mês (todo o histórico)</h3>
    <div class="barras">${meses.map((m) => `<div class="b" title="${mesNome(m.mes)}: ${brl(m.faturamento)}"><i style="height:${(m.faturamento / max) * 100}%"></i><span>${mesNome(m.mes)}</span></div>`).join("")}</div>
    <div class="tabela-wrap" style="margin-top:12px"><table><thead><tr><th>Mês</th><th class="dir">Cortes</th><th class="dir">Faturamento</th><th class="dir">Comissões</th><th class="dir esconde-cel">Taxas</th><th class="dir esconde-cel">Despesas</th><th class="dir">Sobrou</th></tr></thead><tbody>
    ${meses.slice().reverse().map((m) => `<tr><td>${mesNome(m.mes)}</td><td class="dir num">${m.cortes}</td><td class="dir num">${brl(m.faturamento)}</td><td class="dir num">${brl(m.comissoes)}</td><td class="dir num esconde-cel">${brl(m.taxas)}</td><td class="dir num esconde-cel">${brl(m.despesas)}</td><td class="dir num ${m.lucro < 0 ? "neg" : "pos"}">${brl(m.lucro)}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="sutil pequeno-txt">Despesas = saídas do caixa + contas a pagar quitadas no mês. Pagamentos de comissão e vales não entram aqui porque a comissão já foi descontada.</p>`;
}

// ======================= COMISSÕES =======================
const pCom = { chave: "semana", de: "", ate: "" };
ABAS.comissoes = async (el) => {
  if (!pCom.de) [pCom.de, pCom.ate] = periodo("semana");
  el.innerHTML = `<div class="pilha"><div class="linha entre"><h2>Comissões</h2>${seletorPeriodo("per-com", pCom)}</div><div id="com-corpo"></div></div>`;
  ligarPeriodo("per-com", pCom, desenharComissoes);
  await desenharComissoes();
};
async function desenharComissoes() {
  const r = await api(`/resumo?de=${pCom.de}&ate=${pCom.ate}`);
  const faixa = `${diaMes(pCom.de)} a ${diaMes(pCom.ate)}`;
  $("#com-corpo").innerHTML = `<div class="grade">${r.porColaborador.map((c) => `
    <section class="cartao">
      <div class="linha entre"><h2>${esc(c.nome)}</h2>${c.ativo ? "" : '<span class="etiqueta">inativo</span>'}</div>
      <div class="kpis">
        <div class="kpi"><div class="rot">Cortes</div><div class="val">${c.cortes}</div></div>
        <div class="kpi"><div class="rot">Faturou</div><div class="val">${brl(c.faturado)}</div></div>
        <div class="kpi"><div class="rot">Comissão</div><div class="val">${brl(c.comissao)}</div></div>
        <div class="kpi destaque"><div class="rot">Falta pagar</div><div class="val ${c.saldo > 0 ? "" : "pos"}">${brl(c.saldo)}</div><div class="det">já pago ${brl(c.pago)}</div></div>
      </div>
      <div class="linha" style="margin-top:12px">
        <button class="btn primario pequeno" data-pagar="${c.id}" data-valor="${Math.max(0, c.saldo)}">Pagar comissão</button>
        <button class="btn pequeno" data-vale="${c.id}">Dar vale</button>
        <button class="btn pequeno fantasma" data-extra="${c.id}">+ Comissão extra</button>
        <button class="btn pequeno fantasma" data-extrato="${c.id}">Ver extrato</button>
      </div>
    </section>`).join("")}</div>
    <p class="sutil pequeno-txt">"Falta pagar" considera só o período escolhido: comissão gerada menos pagamentos e vales lançados nele.</p>`;
  const nome = (id) => r.porColaborador.find((c) => c.id === id).nome;
  $$("[data-pagar]").forEach((b) => (b.onclick = () => abrirDialogo(`Pagar comissão · ${nome(b.dataset.pagar)}`, [
    { nome: "valor", rotulo: "Valor pago", tipo: "number", valor: b.dataset.valor },
    { nome: "forma_pagamento", rotulo: "Pago em", tipo: "select", opcoes: opcoesFormas(), valor: "cash" },
    { nome: "descricao", rotulo: "Descrição", valor: `Pagamento de comissão - ${nome(b.dataset.pagar)} (${faixa})`, largo: true },
  ], async (d) => { await post("/transacoes", { ...d, tipo: "expense", categoria: "comissao_paga", colaborador_id: b.dataset.pagar }); aviso("Pagamento registrado"); desenharComissoes(); })));
  $$("[data-vale]").forEach((b) => (b.onclick = () => abrirDialogo(`Vale · ${nome(b.dataset.vale)}`, [
    { nome: "valor", rotulo: "Valor", tipo: "number" },
    { nome: "forma_pagamento", rotulo: "Pago em", tipo: "select", opcoes: opcoesFormas(), valor: "cash" },
    { nome: "descricao", rotulo: "Descrição", valor: `Vale - ${nome(b.dataset.vale)}`, largo: true },
  ], async (d) => { await post("/transacoes", { ...d, tipo: "expense", categoria: "comissao_paga", colaborador_id: b.dataset.vale }); aviso("Vale registrado"); desenharComissoes(); })));
  $$("[data-extra]").forEach((b) => (b.onclick = () => abrirDialogo(`Comissão extra · ${nome(b.dataset.extra)}`, [
    { nome: "comissao", rotulo: "Valor a mais para o barbeiro", tipo: "number" },
    { nome: "descricao", rotulo: "Motivo", valor: "Comissão extra", largo: true },
  ], async (d) => { await post("/transacoes", { ...d, tipo: "commission", colaborador_id: b.dataset.extra }); aviso("Comissão extra lançada"); desenharComissoes(); })));
  $$("[data-extrato]").forEach((b) => (b.onclick = async () => {
    const lista = await api(`/transacoes?de=${pCom.de}&ate=${pCom.ate}&colaborador_id=${b.dataset.extrato}&limite=2000`);
    const dlg = $("#dialogo"), form = $("#dialogo-form");
    form.innerHTML = `<h2>${esc(nome(b.dataset.extrato))} · ${faixa}</h2><div style="max-height:60dvh;overflow:auto">${lista.map(linhaLanc).join("") || '<p class="vazio">Nada no período.</p>'}</div><div class="linha"><span class="espaco"></span><button class="btn" value="fechar">Fechar</button></div>`;
    form.onsubmit = null;
    ligarApagar(form, () => { dlg.close(); desenharComissoes(); });
    dlg.showModal();
  }));
}

// ======================= CLIENTES =======================
let buscaCli = "";
ABAS.clientes = async (el) => {
  const lista = await api("/clientes/historico");
  el.innerHTML = `<div class="pilha"><div class="linha entre"><h2>Clientes <span class="sutil">(${lista.length})</span></h2><button class="btn primario" id="cli-novo">+ Novo cliente</button></div>
    <input id="cli-busca" placeholder="Buscar por nome ou telefone" value="${esc(buscaCli)}">
    <section class="cartao"><div class="tabela-wrap"><table><thead><tr><th>Nome</th><th class="esconde-cel">Telefone</th><th class="dir">Visitas</th><th class="dir esconde-cel">Gastou</th><th class="dir">Última</th><th></th></tr></thead><tbody id="cli-tbody"></tbody></table></div></section>
    <p class="sutil pequeno-txt">No app antigo a maioria dos cortes era lançada sem cliente. Escolher o cliente ao lançar ajuda a saber quem sumiu e quem é fiel.</p></div>`;
  const desenhar = () => {
    const b = buscaCli.toLowerCase();
    const f = lista.filter((c) => !b || c.nome.toLowerCase().includes(b) || (c.telefone || "").includes(b));
    $("#cli-tbody").innerHTML = f.map((c) => {
      const dias = c.ultima_visita ? Math.round((new Date(hoje) - new Date(c.ultima_visita)) / 864e5) : null;
      return `<tr><td>${esc(c.nome)} ${c.plano ? '<span class="etiqueta ok">plano</span>' : ""} ${c.fiado_aberto ? `<span class="etiqueta ruim">deve ${brl(c.fiado_aberto)}</span>` : ""}</td>
        <td class="esconde-cel">${c.telefone ? `<a href="https://wa.me/${zap(c.telefone)}" target="_blank" rel="noopener" style="color:var(--ouro-2)">${esc(c.telefone)}</a>` : ""}</td>
        <td class="dir num">${c.visitas}</td><td class="dir num esconde-cel">${brl(c.gasto)}</td>
        <td class="dir">${c.ultima_visita ? `${dataBR(c.ultima_visita)}${dias > 30 ? ` <span class="etiqueta alerta">${dias}d</span>` : ""}` : "—"}</td>
        <td class="dir"><button class="btn pequeno fantasma" data-ed="${c.id}">Editar</button></td></tr>`;
    }).join("") || '<tr><td colspan="6" class="vazio">Nenhum cliente encontrado.</td></tr>';
    $$("[data-ed]").forEach((b) => (b.onclick = () => editarCliente(lista.find((c) => c.id === b.dataset.ed), () => abrirAba("clientes"))));
  };
  $("#cli-busca").oninput = (e) => { buscaCli = e.target.value; desenhar(); };
  $("#cli-novo").onclick = () => editarCliente(null, () => abrirAba("clientes"));
  desenhar();
};
function zap(tel) {
  let d = String(tel).replace(/\D/g, "");
  if (d.length <= 11) d = "55" + d;
  return d;
}
function editarCliente(c, depois) {
  abrirDialogo(c ? "Editar cliente" : "Novo cliente", [
    { nome: "nome", rotulo: "Nome", valor: c?.nome, obrigatorio: true },
    { nome: "telefone", rotulo: "Telefone / WhatsApp", tipo: "tel", valor: c?.telefone },
    ...(papel === "dono" ? [{ nome: "email", rotulo: "E-mail", tipo: "email", valor: c?.email },
    { nome: "observacoes", rotulo: "Observações", tipo: "textarea", valor: c?.observacoes }] : []),
  ], async (d) => {
    const r = c ? await api("/clientes/" + c.id, { method: "PUT", body: d }) : await post("/clientes", d);
    await recarregarBase();
    aviso("Cliente salvo");
    depois?.(r.id);
  }, c ? `<p><button type="button" class="btn pequeno perigo" id="cli-apagar">Apagar cliente</button></p>` : "");
  $("#cli-apagar")?.addEventListener("click", async () => {
    if (!confirmar(`Apagar ${c.nome}? Os lançamentos continuam, só ficam sem cliente.`)) return;
    await tentar(async () => { await api("/clientes/" + c.id, { method: "DELETE" }); await recarregarBase(); $("#dialogo").close(); aviso("Cliente apagado"); depois?.(); });
  });
}

// ======================= FIADO =======================
ABAS.fiados = async (el) => {
  const lista = await api("/fiados");
  const abertos = lista.filter((f) => f.status !== "paid"), pagos = lista.filter((f) => f.status === "paid");
  const nomeCli = (id) => base.clientes.find((c) => c.id === id)?.nome || "—";
  const linha = (f) => `<tr><td>${dataBR(f.data)}</td><td>${esc(nomeCli(f.cliente_id))}</td><td class="esconde-cel">${esc(f.descricao || "")}</td><td class="esconde-cel">${esc(primeiroNome(nomeColab(f.colaborador_id)))}</td><td class="dir num">${brl(f.valor)}</td>
    <td class="dir">${f.status === "paid" ? `<span class="etiqueta ok">pago ${dataBR(f.pago_em)}</span>` : `<button class="btn primario pequeno" data-receber="${f.id}">Receber</button> <button class="btn fantasma pequeno perigo" data-del="${f.id}">✕</button>`}</td></tr>`;
  el.innerHTML = `<div class="pilha"><div class="linha entre"><h2>Fiado</h2><button class="btn primario" id="fi-novo">+ Anotar fiado</button></div>
    <div class="kpis"><div class="kpi destaque"><div class="rot">Em aberto</div><div class="val">${brl(abertos.reduce((s, f) => s + f.valor, 0))}</div><div class="det">${abertos.length} fiado(s)</div></div>
    <div class="kpi"><div class="rot">Já recebido</div><div class="val">${brl(pagos.reduce((s, f) => s + f.valor, 0))}</div><div class="det">${pagos.length} fiado(s)</div></div></div>
    <section class="cartao"><h3>Em aberto</h3><div class="tabela-wrap"><table><tbody>${abertos.map(linha).join("") || '<tr><td class="vazio">Ninguém devendo.</td></tr>'}</tbody></table></div></section>
    <section class="cartao"><h3>Pagos</h3><div class="tabela-wrap"><table><tbody>${pagos.map(linha).join("")}</tbody></table></div></section></div>`;
  $("#fi-novo").onclick = () => abrirDialogo("Anotar fiado", [
    { nome: "cliente_id", rotulo: "Cliente", tipo: "select", opcoes: opcoesClientes("Escolha…") },
    { nome: "colaborador_id", rotulo: "Quem fez", tipo: "select", opcoes: opcoesColabs() },
    { nome: "valor", rotulo: "Valor", tipo: "number" },
    { nome: "data", rotulo: "Data", tipo: "date", valor: hoje },
    { nome: "descricao", rotulo: "O que foi feito", largo: true },
  ], async (d) => { if (!d.cliente_id) throw new Error("Escolha o cliente."); await post("/fiados", d); aviso("Fiado anotado"); abrirAba("fiados"); });
  $$("[data-receber]").forEach((b) => (b.onclick = () => abrirDialogo("Receber fiado", [
    { nome: "forma_pagamento", rotulo: "Recebido em", tipo: "select", opcoes: opcoesFormas(), valor: "pix" },
  ], async (d) => { await post(`/fiados/${b.dataset.receber}/receber`, d); aviso("Recebido e lançado no caixa"); abrirAba("fiados"); },
  `<p class="sutil pequeno-txt">O valor entra no caixa de hoje como serviço, com a comissão do barbeiro.</p>`)));
  $$("[data-del]").forEach((b) => (b.onclick = async () => { if (confirmar("Apagar este fiado?")) await tentar(async () => { await api("/fiados/" + b.dataset.del, { method: "DELETE" }); abrirAba("fiados"); }); }));
};

// ======================= CONTAS =======================
const CATS = ["aluguel", "agua", "luz", "internet", "imposto", "fornecedor", "produtos", "manutencao", "marketing", "outros"];
ABAS.contas = async (el) => {
  const lista = await api("/contas");
  const pend = lista.filter((c) => c.status !== "paid"), pagas = lista.filter((c) => c.status === "paid").sort((a, b) => (b.pago_em || "").localeCompare(a.pago_em || ""));
  const vencidas = pend.filter((c) => c.vencimento && c.vencimento < hoje);
  const linha = (c) => {
    const st = c.status === "paid" ? `<span class="etiqueta ok">paga ${dataBR(c.pago_em)}</span>` : c.vencimento < hoje ? '<span class="etiqueta ruim">vencida</span>' : c.vencimento <= somaDias(hoje, 5) ? '<span class="etiqueta alerta">vence logo</span>' : "";
    return `<tr><td>${dataBR(c.vencimento)}</td><td>${esc(c.descricao)} ${c.recorrente ? '<span class="etiqueta">mensal</span>' : ""}</td><td class="esconde-cel sutil">${esc(c.categoria || "")}</td><td class="dir num">${brl(c.valor)}</td>
      <td>${st}</td><td class="dir">${c.status === "paid" ? `<button class="btn fantasma pequeno" data-reabrir="${c.id}">Desfazer</button>` : `<button class="btn primario pequeno" data-pagar="${c.id}">Paguei</button>`} <button class="btn fantasma pequeno" data-ed="${c.id}">Editar</button></td></tr>`;
  };
  el.innerHTML = `<div class="pilha"><div class="linha entre"><h2>Contas a pagar</h2><button class="btn primario" id="ct-nova">+ Nova conta</button></div>
    <div class="kpis"><div class="kpi destaque"><div class="rot">A pagar</div><div class="val">${brl(pend.reduce((s, c) => s + c.valor, 0))}</div><div class="det">${pend.length} conta(s)</div></div>
    <div class="kpi"><div class="rot">Vencidas</div><div class="val ${vencidas.length ? "neg" : ""}">${brl(vencidas.reduce((s, c) => s + c.valor, 0))}</div><div class="det">${vencidas.length} conta(s)</div></div></div>
    <section class="cartao"><h3>Pendentes</h3><div class="tabela-wrap"><table><tbody>${pend.map(linha).join("") || '<tr><td class="vazio">Tudo pago!</td></tr>'}</tbody></table></div></section>
    <section class="cartao"><h3>Pagas</h3><div class="tabela-wrap"><table><tbody>${pagas.map(linha).join("")}</tbody></table></div></section>
    <p class="sutil pequeno-txt">Ao marcar uma conta mensal como paga, a do mês seguinte já é criada.</p></div>`;
  const editar = (c) => abrirDialogo(c ? "Editar conta" : "Nova conta", [
    { nome: "descricao", rotulo: "Descrição", valor: c?.descricao, obrigatorio: true },
    { nome: "valor", rotulo: "Valor", tipo: "number", valor: c?.valor },
    { nome: "vencimento", rotulo: "Vencimento", tipo: "date", valor: c?.vencimento || hoje },
    { nome: "categoria", rotulo: "Categoria", tipo: "select", opcoes: CATS.map((x) => [x, x]), valor: c?.categoria || "outros" },
    { nome: "recorrente", rotulo: "Repete todo mês", tipo: "checkbox", valor: c ? c.recorrente : 1 },
    { nome: "observacoes", rotulo: "Observações", tipo: "textarea", valor: c?.observacoes },
  ], async (d) => { c ? await api("/contas/" + c.id, { method: "PUT", body: d }) : await post("/contas", d); aviso("Conta salva"); abrirAba("contas"); },
  c ? `<p><button type="button" class="btn pequeno perigo" id="ct-apagar">Apagar conta</button></p>` : "");
  $("#ct-nova").onclick = () => editar(null);
  $$("[data-ed]").forEach((b) => (b.onclick = () => {
    const c = lista.find((x) => x.id === b.dataset.ed);
    editar(c);
    $("#ct-apagar").onclick = async () => { if (confirmar("Apagar esta conta?")) await tentar(async () => { await api("/contas/" + c.id, { method: "DELETE" }); $("#dialogo").close(); abrirAba("contas"); }); };
  }));
  $$("[data-pagar]").forEach((b) => (b.onclick = () => tentar(async () => { await post(`/contas/${b.dataset.pagar}/pagar`); aviso("Conta paga"); abrirAba("contas"); })));
  $$("[data-reabrir]").forEach((b) => (b.onclick = () => tentar(async () => { await post(`/contas/${b.dataset.reabrir}/reabrir`); abrirAba("contas"); })));
};

// ======================= PLANOS =======================
ABAS.planos = async (el) => {
  const lista = await api("/planos/uso");
  const ativos = lista.filter((p) => p.status === "active");
  el.innerHTML = `<div class="pilha"><div class="linha entre"><h2>Planos mensais</h2><button class="btn primario" id="pl-novo">+ Novo plano</button></div>
    <div class="kpis"><div class="kpi destaque"><div class="rot">Planos ativos</div><div class="val">${ativos.length}</div></div>
    <div class="kpi"><div class="rot">Receita mensal dos planos</div><div class="val">${brl(ativos.reduce((s, p) => s + (p.preco || 0), 0))}</div></div></div>
    <section class="cartao"><div class="tabela-wrap"><table><thead><tr><th>Cliente</th><th class="dir">Preço</th><th>Uso no mês</th><th class="esconde-cel">Último pgto.</th><th></th></tr></thead><tbody>
    ${lista.map((p) => {
      const servs = JSON.parse(p.servicos_inclusos || "[]").map((id) => base.servicos.find((s) => s.id === id)?.nome).filter(Boolean).join(", ");
      const estourou = p.cortes_maximos && p.usados_mes >= p.cortes_maximos;
      return `<tr><td>${esc(p.cliente || "—")} ${p.status === "active" ? "" : '<span class="etiqueta">cancelado</span>'}<div class="sutil pequeno-txt">${esc(servs || p.plano || "")}</div></td>
        <td class="dir num">${brl(p.preco)}</td>
        <td>${p.status === "active" ? `<span class="etiqueta ${estourou ? "ruim" : "ok"}">${p.usados_mes}${p.cortes_maximos ? " de " + p.cortes_maximos : ""}</span>` : ""}</td>
        <td class="esconde-cel">${dataBR(p.ultimo_pagamento) || "—"}</td>
        <td class="dir">${p.status === "active" ? `<button class="btn primario pequeno" data-mens="${p.id}">Recebi mensalidade</button>` : ""} <button class="btn fantasma pequeno" data-ed="${p.id}">Editar</button></td></tr>`;
    }).join("") || '<tr><td colspan="5" class="vazio">Nenhum plano.</td></tr>'}
    </tbody></table></div></section>
    <p class="sutil pequeno-txt">Para usar um corte do plano, lance o serviço no Caixa com a forma de pagamento "Plano".</p></div>`;
  const editar = (p) => abrirDialogo(p ? "Editar plano" : "Novo plano", [
    { nome: "cliente_id", rotulo: "Cliente", tipo: "select", opcoes: opcoesClientes("Escolha…"), valor: p?.cliente_id },
    { nome: "plano", rotulo: "Nome do plano", valor: p?.plano || "Plano Mensal" },
    { nome: "preco", rotulo: "Preço mensal", tipo: "number", valor: p?.preco },
    { nome: "cortes_maximos", rotulo: "Cortes por mês (vazio = ilimitado)", tipo: "number", valor: p?.cortes_maximos },
    { nome: "inicio", rotulo: "Início", tipo: "date", valor: p?.inicio || hoje },
    { nome: "status", rotulo: "Situação", tipo: "select", opcoes: [["active", "Ativo"], ["cancelled", "Cancelado"]], valor: p?.status || "active" },
    { nome: "servicos_inclusos", rotulo: "Serviços inclusos", tipo: "multi", opcoes: base.servicos.filter((s) => s.ativo).map((s) => [s.id, s.nome]), valor: JSON.parse(p?.servicos_inclusos || "[]") },
    { nome: "observacoes", rotulo: "Observações", tipo: "textarea", valor: p?.observacoes },
  ], async (d) => {
    if (!d.cliente_id) throw new Error("Escolha o cliente.");
    if (d.status === "cancelled" && !p?.termino) d.termino = hoje;
    p ? await api("/planos/" + p.id, { method: "PUT", body: d }) : await post("/planos", d);
    await recarregarBase(); aviso("Plano salvo"); abrirAba("planos");
  });
  $("#pl-novo").onclick = () => editar(null);
  $$("[data-ed]").forEach((b) => (b.onclick = () => editar(lista.find((p) => p.id === b.dataset.ed))));
  $$("[data-mens]").forEach((b) => (b.onclick = () => {
    const p = lista.find((x) => x.id === b.dataset.mens);
    abrirDialogo(`Mensalidade · ${p.cliente}`, [
      { nome: "valor", rotulo: "Valor", tipo: "number", valor: p.preco },
      { nome: "forma_pagamento", rotulo: "Recebido em", tipo: "select", opcoes: opcoesFormas(), valor: "pix" },
    ], async (d) => { await post(`/planos/${p.id}/mensalidade`, d); aviso("Mensalidade lançada no caixa"); abrirAba("planos"); });
  }));
};

// ======================= LANÇAMENTOS =======================
const pLanc = { chave: "semana", de: "", ate: "", tipo: "", colab: "" };
ABAS.lancamentos = async (el) => {
  if (!pLanc.de) [pLanc.de, pLanc.ate] = periodo("semana");
  el.innerHTML = `<div class="pilha"><div class="linha entre"><h2>Lançamentos</h2><a class="btn pequeno" href="/api/exportar/transacoes.csv">Baixar tudo em planilha (CSV)</a></div>
    <div class="linha">${seletorPeriodo("per-lanc", pLanc)}
      <select id="f-tipo" style="width:auto"><option value="">Todos os tipos</option>${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}" ${pLanc.tipo === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      <select id="f-colab" style="width:auto">${opcoesColabs("Todos os barbeiros", true).map(([v, t]) => `<option value="${v}" ${pLanc.colab === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
    </div><section class="cartao" id="lanc-lista"></section></div>`;
  const desenhar = async () => {
    const lista = await api(`/transacoes?de=${pLanc.de}&ate=${pLanc.ate}&tipo=${pLanc.tipo}&colaborador_id=${pLanc.colab}&limite=3000`);
    $("#lanc-lista").innerHTML = `<p class="sutil pequeno-txt">${lista.length} lançamento(s)${lista.length >= 3000 ? " (mostrando os 3000 mais recentes)" : ""}</p>${lista.map(linhaLanc).join("") || '<p class="vazio">Nada nesse período.</p>'}`;
    ligarApagar($("#lanc-lista"), desenhar);
  };
  ligarPeriodo("per-lanc", pLanc, desenhar);
  $("#f-tipo").onchange = (e) => { pLanc.tipo = e.target.value; desenhar(); };
  $("#f-colab").onchange = (e) => { pLanc.colab = e.target.value; desenhar(); };
  await desenhar();
};

// ======================= CADASTROS =======================
ABAS.cadastros = async (el) => {
  await recarregarBase();
  el.innerHTML = `<div class="pilha">
    <section class="cartao"><div class="linha entre"><h2>Barbeiros</h2><button class="btn primario pequeno" id="nv-colab">+ Novo</button></div><div class="tabela-wrap"><table><tbody>
      ${base.colaboradores.map((c) => `<tr><td>${esc(c.nome)} ${c.ativo ? "" : '<span class="etiqueta">inativo</span>'} ${c.tem_pin && c.ativo ? '<span class="etiqueta ok">usa o app</span>' : ""}<div class="sutil pequeno-txt">${esc(c.telefone || "")}</div></td><td class="dir">comissão padrão ${c.pct_comissao}%</td><td class="dir"><button class="btn fantasma pequeno" data-colab="${c.id}">Editar</button></td></tr>`).join("")}
    </tbody></table></div><p class="sutil pequeno-txt">A comissão de cada corte segue o percentual do serviço. O percentual padrão do barbeiro só é usado quando o valor é digitado sem escolher um serviço.</p></section>
    <section class="cartao"><div class="linha entre"><h2>Serviços e preços</h2><button class="btn primario pequeno" id="nv-serv">+ Novo</button></div><div class="tabela-wrap"><table><thead><tr><th>Serviço</th><th class="dir">Preço</th><th class="dir">Comissão</th><th></th></tr></thead><tbody>
      ${base.servicos.map((s) => `<tr><td>${esc(s.nome)} ${s.ativo ? "" : '<span class="etiqueta">inativo</span>'}</td><td class="dir num">${brl(s.preco)}</td><td class="dir">${s.pct_comissao}%</td><td class="dir"><button class="btn fantasma pequeno" data-serv="${s.id}">Editar</button></td></tr>`).join("")}
    </tbody></table></div></section>
    <section class="cartao"><div class="linha entre"><h2>Produtos</h2><button class="btn primario pequeno" id="nv-prod">+ Novo</button></div><div class="tabela-wrap"><table><thead><tr><th>Produto</th><th class="dir">Preço</th><th class="dir esconde-cel">Custo</th><th class="dir">Estoque</th><th></th></tr></thead><tbody>
      ${base.produtos.map((p) => `<tr><td>${esc(p.nome)} ${p.ativo ? "" : '<span class="etiqueta">inativo</span>'}</td><td class="dir num">${brl(p.preco)}</td><td class="dir num esconde-cel">${brl(p.custo)}</td><td class="dir">${p.estoque}${p.estoque <= p.estoque_minimo ? ' <span class="etiqueta ruim">repor</span>' : ""}</td><td class="dir"><button class="btn fantasma pequeno" data-prod="${p.id}">Editar</button></td></tr>`).join("") || '<tr><td class="vazio">Nenhum produto.</td></tr>'}
    </tbody></table></div></section></div>`;
  const salvar = (tabela, item) => async (d) => {
    item ? await api(`/${tabela}/${item.id}`, { method: "PUT", body: d }) : await post("/" + tabela, d);
    aviso("Salvo"); abrirAba("cadastros");
  };
  const apagarBtn = (txt) => `<p><button type="button" class="btn pequeno perigo" id="cad-apagar">${txt}</button></p>`;
  const ligarApagarCad = (tabela, item) => {
    $("#cad-apagar")?.addEventListener("click", async () => {
      if (!confirmar(`Apagar ${item.nome}?`)) return;
      await tentar(async () => { const r = await api(`/${tabela}/${item.id}`, { method: "DELETE" }); $("#dialogo").close(); aviso(r.desativado ? "Tem histórico: foi desativado em vez de apagado" : "Apagado"); abrirAba("cadastros"); });
    });
  };
  const edColab = (c) => { abrirDialogo(c ? "Editar barbeiro" : "Novo barbeiro", [
    { nome: "nome", rotulo: "Nome", valor: c?.nome, obrigatorio: true },
    { nome: "telefone", rotulo: "Telefone", tipo: "tel", valor: c?.telefone },
    { nome: "email", rotulo: "E-mail", tipo: "email", valor: c?.email },
    { nome: "pct_comissao", rotulo: "Comissão padrão (%)", tipo: "number", valor: c?.pct_comissao ?? 50 },
    { nome: "ativo", rotulo: "Ativo (aparece no caixa)", tipo: "checkbox", valor: c ? c.ativo : 1 },
    { nome: "pin", rotulo: c?.tem_pin ? "Novo PIN (vazio = manter o atual)" : "PIN de acesso ao app (4 a 6 números)", tipo: "pin" },
    ...(c?.tem_pin ? [{ nome: "remover_pin", rotulo: "Tirar o acesso dele ao app", tipo: "checkbox", valor: 0 }] : []),
  ], salvar("colaboradores", c), `<p class="sutil pequeno-txt">Com um PIN, o barbeiro entra no app pelo celular. Ele só lança os próprios cortes e vê os próprios números. Ele não vê o caixa geral, os colegas, as contas nem o lucro.</p>${c ? apagarBtn("Apagar barbeiro") : ""}`); if (c) ligarApagarCad("colaboradores", c); };
  const edServ = (s) => { abrirDialogo(s ? "Editar serviço" : "Novo serviço", [
    { nome: "nome", rotulo: "Nome", valor: s?.nome, obrigatorio: true },
    { nome: "preco", rotulo: "Preço", tipo: "number", valor: s?.preco },
    { nome: "pct_comissao", rotulo: "Comissão do barbeiro (%)", tipo: "number", valor: s?.pct_comissao ?? 50 },
    { nome: "duracao_min", rotulo: "Duração (min)", tipo: "number", valor: s?.duracao_min ?? 30 },
    { nome: "ativo", rotulo: "Ativo (aparece no caixa)", tipo: "checkbox", valor: s ? s.ativo : 1 },
  ], salvar("servicos", s), s ? apagarBtn("Apagar serviço") : ""); if (s) ligarApagarCad("servicos", s); };
  const edProd = (p) => { abrirDialogo(p ? "Editar produto" : "Novo produto", [
    { nome: "nome", rotulo: "Nome", valor: p?.nome, obrigatorio: true },
    { nome: "preco", rotulo: "Preço de venda", tipo: "number", valor: p?.preco },
    { nome: "custo", rotulo: "Custo", tipo: "number", valor: p?.custo },
    { nome: "estoque", rotulo: "Estoque", tipo: "number", valor: p?.estoque ?? 0 },
    { nome: "estoque_minimo", rotulo: "Avisar quando chegar em", tipo: "number", valor: p?.estoque_minimo ?? 2 },
    { nome: "categoria", rotulo: "Categoria", valor: p?.categoria },
    { nome: "ativo", rotulo: "Ativo", tipo: "checkbox", valor: p ? p.ativo : 1 },
    { nome: "descricao", rotulo: "Descrição", tipo: "textarea", valor: p?.descricao },
  ], salvar("produtos", p), p ? apagarBtn("Apagar produto") : ""); if (p) ligarApagarCad("produtos", p); };
  $("#nv-colab").onclick = () => edColab(null);
  $("#nv-serv").onclick = () => edServ(null);
  $("#nv-prod").onclick = () => edProd(null);
  $$("[data-colab]").forEach((b) => (b.onclick = () => edColab(base.colaboradores.find((x) => x.id === b.dataset.colab))));
  $$("[data-serv]").forEach((b) => (b.onclick = () => edServ(base.servicos.find((x) => x.id === b.dataset.serv))));
  $$("[data-prod]").forEach((b) => (b.onclick = () => edProd(base.produtos.find((x) => x.id === b.dataset.prod))));
};

// ======================= DADOS E AJUSTES =======================
ABAS.ajustes = async (el) => {
  const bk = await api("/backups");
  const t = base.taxas;
  el.innerHTML = `<div class="grade">
    <section class="cartao"><h2>Trazer dados do app antigo</h2>
      <p class="sutil">Envie o arquivo <b>.zip</b> exportado do app antigo (o mesmo com transacoes.csv, clientes.csv etc.). Pode enviar de novo depois com uma exportação mais nova: nada é duplicado, e o que você lançou aqui não é apagado. Um backup é feito antes.</p>
      <input type="file" id="imp-arquivo" accept=".zip,.csv" multiple>
      <button class="btn primario largo" id="imp-enviar" style="margin-top:10px">Importar</button>
      <div id="imp-resultado"></div></section>
    <section class="cartao"><h2>Backup</h2>
      <p class="sutil">O app faz um backup automático por dia (guarda os 60 mais recentes) na pasta <code>${esc(bk.pasta)}</code>. Guarde também uma cópia fora do computador (pen drive, Google Drive).</p>
      <div class="linha"><a class="btn primario" href="/api/backup/baixar">Baixar backup agora</a><a class="btn" href="/api/exportar/transacoes.csv">Planilha de lançamentos (CSV)</a></div>
      <details style="margin-top:12px"><summary class="sutil">Backups salvos (${bk.lista.length})</summary><ul class="pequeno-txt">${bk.lista.slice(0, 30).map((b) => `<li>${esc(b.arquivo)} <span class="sutil">${(b.tamanho / 1024).toFixed(0)} KB</span></li>`).join("")}</ul></details></section>
    <section class="cartao"><h2>Taxas da maquininha</h2>
      <p class="sutil pequeno-txt">Descontadas automaticamente em cada lançamento (aparecem como saída "Taxa").</p>
      <form id="f-taxas"><div class="campos">
        <label>Débito (%)<input name="debit_card" type="number" step="0.01" value="${t.debit_card}"></label>
        <label>Crédito (%)<input name="credit_card" type="number" step="0.01" value="${t.credit_card}"></label>
        <label>PIX (%)<input name="pix" type="number" step="0.01" value="${t.pix}"></label>
      </div><button class="btn">Salvar taxas</button></form></section>
    <section class="cartao"><h2>Barbearia e senha</h2>
      <form id="f-nome"><label>Nome da barbearia<input name="nome" value="${esc(base.nome)}"></label><button class="btn">Salvar nome</button></form>
      <form id="f-senha" style="margin-top:16px"><div class="campos">
        <label>Senha atual<input name="senha_atual" type="password" autocomplete="current-password"></label>
        <label>Nova senha<input name="nova_senha" type="password" minlength="4" autocomplete="new-password"></label>
      </div><button class="btn">Trocar senha</button></form></section>
  </div>`;
  $("#imp-enviar").onclick = async () => {
    const arquivos = [...$("#imp-arquivo").files];
    if (!arquivos.length) return aviso("Escolha o arquivo .zip", true);
    const btn = $("#imp-enviar");
    btn.disabled = true; btn.textContent = "Importando…";
    try {
      let r;
      if (arquivos.length === 1 && arquivos[0].name.toLowerCase().endsWith(".zip")) {
        r = await api("/importar", { method: "POST", body: await arquivos[0].arrayBuffer(), headers: { "Content-Type": "application/zip" } });
      } else {
        const mapa = {};
        for (const f of arquivos) mapa[f.name] = await f.text();
        r = await api("/importar", { method: "POST", body: JSON.stringify(mapa), headers: { "Content-Type": "application/json" } });
      }
      await recarregarBase();
      $("#imp-resultado").innerHTML = `<p class="pos" style="margin-top:12px"><b>Importação concluída.</b></p><ul class="pequeno-txt">${Object.entries(r.importado).map(([k, v]) => `<li>${esc(k)}: <b>${v}</b></li>`).join("")}</ul><p class="sutil pequeno-txt">Backup de antes da importação: ${esc(r.backup)}</p>`;
      aviso("Dados importados!");
    } catch (e) { aviso(e.message, true); } finally { btn.disabled = false; btn.textContent = "Importar"; }
  };
  const salvarCfg = (sel, montar, msg) => ($(sel).onsubmit = async (e) => {
    e.preventDefault();
    await tentar(async () => { await post("/config", montar(e.target)); await recarregarBase(); aviso(msg); });
  });
  salvarCfg("#f-taxas", (f) => ({ taxas: { debit_card: f.debit_card.value, credit_card: f.credit_card.value, pix: f.pix.value } }), "Taxas salvas");
  salvarCfg("#f-nome", (f) => ({ nome: f.nome.value }), "Nome salvo");
  $("#f-senha").onsubmit = async (e) => {
    e.preventDefault();
    await tentar(async () => { await post("/config", { senha_atual: e.target.senha_atual.value, nova_senha: e.target.nova_senha.value }); e.target.reset(); aviso("Senha trocada"); });
  };
};

iniciar().catch((e) => aviso(e.message, true));
