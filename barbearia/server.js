// Servidor do app de gestão da barbearia. Só usa o que já vem no Node (22.13+).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, DB_FILE, BACKUP_DIR, getConfig, setConfig, transacao, fazerBackup, agoraBrasilia, hojeBrasilia } from "./db.js";
import { importarZip, importarArquivos } from "./importar.js";

const PORT = Number(process.env.PORT || 3100);
const PUBLIC = path.join(import.meta.dirname, "public");
const SESSAO_DIAS = 60;
const uuid = () => crypto.randomUUID();
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// ---------- senha e sessão ----------
function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  return sal.toString("hex") + ":" + crypto.scryptSync(senha, sal, 64).toString("hex");
}
function confereSenha(senha, salvo) {
  const [sal, hash] = (salvo || "").split(":");
  if (!sal || !hash) return false;
  const esperado = Buffer.from(hash, "hex");
  return crypto.timingSafeEqual(crypto.scryptSync(senha, Buffer.from(sal, "hex"), esperado.length), esperado);
}
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
function criarSessao(res) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessoes (token_hash, expira) VALUES (?, ?)").run(hashToken(token), Date.now() + SESSAO_DIAS * 864e5);
  res.setHeader("Set-Cookie", `sessao=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSAO_DIAS * 86400}`);
}
function tokenDo(req) {
  const m = /(?:^|;\s*)sessao=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
function logado(req) {
  const t = tokenDo(req);
  if (!t) return false;
  const s = db.prepare("SELECT expira FROM sessoes WHERE token_hash = ?").get(hashToken(t));
  return !!s && s.expira > Date.now();
}
const tentativas = new Map();

// ---------- utilidades HTTP ----------
class Erro extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
function json(res, status, dados) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(dados));
}
async function corpo(req, limite = 20 * 1024 * 1024) {
  const partes = [];
  let total = 0;
  for await (const p of req) {
    total += p.length;
    if (total > limite) throw new Erro(413, "Arquivo grande demais.");
    partes.push(p);
  }
  return Buffer.concat(partes);
}
async function corpoJson(req) {
  const b = await corpo(req, 1024 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString("utf8")); } catch { throw new Erro(400, "Dados inválidos."); }
}
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

// ---------- cadastros simples (CRUD genérico) ----------
const CADASTROS = {
  clientes: { campos: ["nome", "telefone", "email", "observacoes"], ordem: "nome COLLATE NOCASE" },
  colaboradores: { campos: ["nome", "telefone", "email", "pct_comissao", "ativo"], ordem: "ativo DESC, nome COLLATE NOCASE" },
  servicos: { campos: ["nome", "descricao", "preco", "duracao_min", "pct_comissao", "ativo"], ordem: "ativo DESC, nome COLLATE NOCASE" },
  produtos: { campos: ["nome", "descricao", "preco", "custo", "estoque", "estoque_minimo", "categoria", "ativo"], ordem: "ativo DESC, nome COLLATE NOCASE" },
  contas: { campos: ["descricao", "valor", "vencimento", "categoria", "observacoes", "recorrente"], ordem: "status = 'paid', vencimento" },
  fiados: { campos: ["data", "cliente_id", "colaborador_id", "valor", "descricao"], ordem: "status = 'paid', data DESC" },
  planos: { campos: ["cliente_id", "plano", "preco", "servicos_inclusos", "cortes_maximos", "inicio", "termino", "status", "observacoes"], ordem: "status <> 'active', inicio DESC" },
  metas: { campos: ["titulo", "tipo", "meta", "descricao", "inicio", "termino", "status", "colaborador_id"], ordem: "inicio DESC" },
};
const OBRIGATORIO = { clientes: "nome", colaboradores: "nome", servicos: "nome", produtos: "nome", contas: "descricao", fiados: "valor", planos: "cliente_id", metas: "titulo" };

function salvarCadastro(tabela, dados) {
  const cfg = CADASTROS[tabela];
  const valores = {};
  for (const c of cfg.campos) {
    if (!(c in dados)) continue;
    let v = dados[c];
    if (typeof v === "string") v = v.trim();
    if (v === "") v = null;
    if (typeof v === "boolean") v = v ? 1 : 0;
    if (Array.isArray(v)) v = JSON.stringify(v);
    valores[c] = v;
  }
  const obrig = OBRIGATORIO[tabela];
  if (!dados.id && (valores[obrig] == null)) throw new Erro(400, `Preencha o campo "${obrig.replace("_id", "")}".`);
  if (dados.id) {
    const cols = Object.keys(valores);
    if (!cols.length) return dados.id;
    const r = db.prepare(`UPDATE ${tabela} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => valores[c]), dados.id);
    if (!r.changes) throw new Erro(404, "Registro não encontrado.");
    return dados.id;
  }
  const id = uuid();
  if (tabela === "clientes" || tabela === "colaboradores") valores.criado_em = hojeBrasilia();
  if (tabela === "fiados") valores.data ??= hojeBrasilia();
  const cols = Object.keys(valores);
  db.prepare(`INSERT INTO ${tabela} (id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`).run(id, ...cols.map((c) => valores[c]));
  return id;
}

// ---------- taxas da maquininha ----------
const TAXAS_PADRAO = { debit_card: 1.99, credit_card: 4.98, pix: 0.49 };
const NOME_TAXA = { debit_card: "Débito", credit_card: "Crédito", pix: "PIX" };
function taxas() {
  try { return { ...TAXAS_PADRAO, ...JSON.parse(getConfig("taxas", "{}")) }; } catch { return TAXAS_PADRAO; }
}

/** Grava um lançamento e, se houver taxa de cartão/PIX, a saída da taxa junto (igual ao app antigo). */
function lancar(t) {
  const id = uuid();
  const data_hora = t.data_hora || agoraBrasilia();
  const pct = t.tipo === "service" || t.tipo === "income" ? Number(taxas()[t.forma_pagamento] || 0) : 0;
  const taxa = r2((t.valor * pct) / 100);
  db.prepare(`INSERT INTO transacoes (id,data_hora,tipo,categoria,descricao,valor,comissao,forma_pagamento,taxa_pct,taxa_valor,cliente_id,colaborador_id,produto_id,vinculo_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, data_hora, t.tipo, t.categoria ?? null, t.descricao ?? null, r2(t.valor), r2(t.comissao), t.forma_pagamento ?? null,
      pct || null, taxa, t.cliente_id ?? null, t.colaborador_id ?? null, t.produto_id ?? null, t.vinculo_id ?? null);
  if (taxa > 0) {
    db.prepare(`INSERT INTO transacoes (id,data_hora,tipo,categoria,descricao,valor,forma_pagamento,taxa_pct,vinculo_id) VALUES (?,?,'expense','taxa',?,?,?,?,?)`)
      .run(uuid(), data_hora, `Taxa ${NOME_TAXA[t.forma_pagamento]} (${String(pct).replace(".", ",")}%)`, taxa, t.forma_pagamento, pct, id);
  }
  return id;
}

function novoLancamento(d) {
  const tipo = d.tipo;
  if (!["service", "income", "expense", "commission"].includes(tipo)) throw new Erro(400, "Tipo de lançamento inválido.");
  const colab = d.colaborador_id ? db.prepare("SELECT * FROM colaboradores WHERE id = ?").get(d.colaborador_id) : null;
  if (tipo === "service") {
    if (!colab) throw new Erro(400, "Escolha quem fez o serviço.");
    const ids = Array.isArray(d.servicos) ? d.servicos : [];
    const servs = ids.map((id) => db.prepare("SELECT * FROM servicos WHERE id = ?").get(id)).filter(Boolean);
    if (!servs.length && !(Number(d.valor) > 0)) throw new Erro(400, "Escolha pelo menos um serviço ou digite o valor.");
    const forma = d.forma_pagamento || "cash";
    const tabela = servs.reduce((s, x) => s + x.preco, 0);
    const valorCobrado = forma === "plan" ? 0 : d.valor != null && d.valor !== "" ? Number(d.valor) : tabela;
    // comissão: percentual de cada serviço sobre o preço de tabela (no plano também, como no app antigo);
    // se o valor cobrado for diferente da tabela, a comissão acompanha na mesma proporção.
    let comissao = servs.length
      ? servs.reduce((s, x) => s + (x.preco * x.pct_comissao) / 100, 0)
      : (valorCobrado * colab.pct_comissao) / 100;
    if (servs.length && forma !== "plan" && tabela > 0 && valorCobrado !== tabela) comissao *= valorCobrado / tabela;
    if (d.comissao != null && d.comissao !== "") comissao = Number(d.comissao);
    const nomes = servs.map((s) => s.nome.trim()).join(" + ");
    const descricao = d.descricao || (forma === "plan" ? `Plano Mensal - ${nomes || "serviço"}` : servs.length > 1 ? `Combo: ${nomes}` : nomes || null);
    if (forma === "fiado") {
      if (!d.cliente_id) throw new Erro(400, "Para fiado, escolha o cliente.");
      if (!(valorCobrado > 0)) throw new Erro(400, "Digite o valor do fiado.");
      return { fiado: salvarCadastro("fiados", { cliente_id: d.cliente_id, colaborador_id: colab.id, valor: valorCobrado, descricao: nomes || d.descricao }) };
    }
    return { id: lancar({ tipo, descricao, valor: valorCobrado, comissao, forma_pagamento: forma, cliente_id: d.cliente_id || null, colaborador_id: colab.id }) };
  }
  if (tipo === "commission") {
    if (!colab) throw new Erro(400, "Escolha o colaborador.");
    return { id: lancar({ tipo, descricao: d.descricao || "Comissão extra", valor: 0, comissao: Number(d.comissao || d.valor), forma_pagamento: d.forma_pagamento, colaborador_id: colab.id }) };
  }
  if (!(Number(d.valor) > 0)) throw new Erro(400, "Digite o valor.");
  if (tipo === "income") {
    let produto = null;
    if (d.produto_id) {
      produto = db.prepare("SELECT * FROM produtos WHERE id = ?").get(d.produto_id);
      if (produto) db.prepare("UPDATE produtos SET estoque = estoque - ? WHERE id = ?").run(Number(d.quantidade || 1), produto.id);
    }
    return { id: lancar({ tipo, descricao: d.descricao || (produto ? `Venda: ${produto.nome.trim()}` : "Entrada"), valor: Number(d.valor), comissao: Number(d.comissao || 0), forma_pagamento: d.forma_pagamento || "cash", cliente_id: d.cliente_id || null, colaborador_id: colab?.id ?? null, produto_id: produto?.id ?? null }) };
  }
  // saída
  const categoria = d.categoria === "comissao_paga" ? "comissao_paga" : "outra";
  if (categoria === "comissao_paga" && !colab) throw new Erro(400, "Escolha o colaborador que recebeu.");
  return { id: lancar({ tipo, categoria, descricao: d.descricao || (categoria === "comissao_paga" ? `Pagamento de comissão - ${colab.nome}` : "Saída"), valor: Number(d.valor), forma_pagamento: d.forma_pagamento || "cash", colaborador_id: colab?.id ?? null }) };
}

// ---------- relatórios ----------
// Regras de conta (corrigem o resumo antigo, que descontava comissão e taxa duas vezes):
//  faturamento = serviços + entradas extras
//  comissões   = comissão gerada nos serviços + comissões extras (o que a barbearia DEVE aos barbeiros)
//  pagamentos de comissão/vale NÃO entram como despesa: só abatem o saldo a pagar de cada barbeiro
//  taxas       = saídas da categoria "taxa"
//  despesas    = outras saídas do caixa + contas a pagar quitadas no período
function resumo(de, ate) {
  const p = [de + " 00:00", ate + " 23:59"];
  const g = db.prepare(`SELECT
      COUNT(CASE WHEN tipo='service' THEN 1 END) cortes,
      COALESCE(SUM(CASE WHEN tipo='service' THEN valor END),0) servicos,
      COALESCE(SUM(CASE WHEN tipo='income' THEN valor END),0) entradas,
      COALESCE(SUM(CASE WHEN tipo IN ('service','commission','income') THEN comissao END),0) comissoes,
      COALESCE(SUM(CASE WHEN tipo='expense' AND categoria='taxa' THEN valor END),0) taxas,
      COALESCE(SUM(CASE WHEN tipo='expense' AND categoria='outra' THEN valor END),0) saidas,
      COALESCE(SUM(CASE WHEN tipo='expense' AND categoria='comissao_paga' THEN valor END),0) comissoes_pagas,
      COUNT(CASE WHEN tipo='service' AND forma_pagamento='plan' THEN 1 END) cortes_plano
    FROM transacoes WHERE data_hora BETWEEN ? AND ?`).get(...p);
  const contasPagas = db.prepare("SELECT COALESCE(SUM(valor),0) v FROM contas WHERE status='paid' AND pago_em BETWEEN ? AND ?").get(de, ate).v;
  const faturamento = g.servicos + g.entradas;
  const despesas = g.saidas + contasPagas;
  const cortesPagos = g.cortes - g.cortes_plano;
  const geral = {
    cortes: g.cortes, cortes_plano: g.cortes_plano, servicos: r2(g.servicos), entradas: r2(g.entradas), faturamento: r2(faturamento),
    comissoes: r2(g.comissoes), comissoes_pagas: r2(g.comissoes_pagas), taxas: r2(g.taxas), saidas_caixa: r2(g.saidas),
    contas_pagas: r2(contasPagas), despesas: r2(despesas),
    lucro: r2(faturamento - g.comissoes - g.taxas - despesas),
    ticket_medio: cortesPagos ? r2(g.servicos / cortesPagos) : 0,
  };
  const porColaborador = db.prepare(`SELECT c.id, c.nome, c.ativo,
      COUNT(CASE WHEN t.tipo='service' THEN 1 END) cortes,
      COALESCE(SUM(CASE WHEN t.tipo='service' THEN t.valor END),0) faturado,
      COALESCE(SUM(CASE WHEN t.tipo IN ('service','commission','income') THEN t.comissao END),0) comissao,
      COALESCE(SUM(CASE WHEN t.tipo='expense' AND t.categoria='comissao_paga' THEN t.valor END),0) pago
    FROM colaboradores c LEFT JOIN transacoes t ON t.colaborador_id = c.id AND t.data_hora BETWEEN ? AND ?
    GROUP BY c.id HAVING cortes > 0 OR c.ativo = 1 ORDER BY faturado DESC`).all(...p)
    .map((x) => ({ ...x, faturado: r2(x.faturado), comissao: r2(x.comissao), pago: r2(x.pago), saldo: r2(x.comissao - x.pago) }));
  const porForma = db.prepare(`SELECT COALESCE(forma_pagamento,'other') forma, COUNT(*) n, COALESCE(SUM(valor),0) valor
    FROM transacoes WHERE tipo IN ('service','income') AND data_hora BETWEEN ? AND ? GROUP BY 1 ORDER BY valor DESC`).all(...p)
    .map((x) => ({ ...x, valor: r2(x.valor) }));
  const porDia = db.prepare(`SELECT substr(data_hora,1,10) dia,
      COUNT(CASE WHEN tipo='service' THEN 1 END) cortes,
      COALESCE(SUM(CASE WHEN tipo IN ('service','income') THEN valor END),0) faturamento,
      COALESCE(SUM(CASE WHEN tipo IN ('service','commission','income') THEN comissao END),0) comissoes
    FROM transacoes WHERE data_hora BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`).all(...p)
    .map((x) => ({ ...x, faturamento: r2(x.faturamento), comissoes: r2(x.comissoes) }));
  const porDiaSemana = db.prepare(`SELECT CAST(strftime('%w', substr(data_hora,1,10)) AS INTEGER) dow,
      COUNT(DISTINCT substr(data_hora,1,10)) dias, COUNT(*) cortes, COALESCE(SUM(valor),0) valor
    FROM transacoes WHERE tipo='service' AND data_hora BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`).all(...p)
    .map((x) => ({ ...x, valor: r2(x.valor), media_dia: x.dias ? r2(x.valor / x.dias) : 0 }));
  const porHora = db.prepare(`SELECT CAST(substr(data_hora,12,2) AS INTEGER) hora, COUNT(*) cortes, COALESCE(SUM(valor),0) valor
    FROM transacoes WHERE tipo='service' AND data_hora BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`).all(...p)
    .map((x) => ({ ...x, valor: r2(x.valor) }));
  const topServicos = db.prepare(`SELECT COALESCE(NULLIF(descricao,''),'(sem descrição)') nome, COUNT(*) n, COALESCE(SUM(valor),0) valor
    FROM transacoes WHERE tipo='service' AND data_hora BETWEEN ? AND ? GROUP BY 1 ORDER BY n DESC LIMIT 10`).all(...p)
    .map((x) => ({ ...x, valor: r2(x.valor) }));
  return { de, ate, geral, porColaborador, porForma, porDia, porDiaSemana, porHora, topServicos };
}

function mesAMes() {
  const meses = db.prepare(`SELECT substr(data_hora,1,7) mes,
      COUNT(CASE WHEN tipo='service' THEN 1 END) cortes,
      COALESCE(SUM(CASE WHEN tipo IN ('service','income') THEN valor END),0) faturamento,
      COALESCE(SUM(CASE WHEN tipo IN ('service','commission','income') THEN comissao END),0) comissoes,
      COALESCE(SUM(CASE WHEN tipo='expense' AND categoria='taxa' THEN valor END),0) taxas,
      COALESCE(SUM(CASE WHEN tipo='expense' AND categoria='outra' THEN valor END),0) saidas
    FROM transacoes GROUP BY 1 ORDER BY 1`).all();
  const contas = new Map(db.prepare(`SELECT substr(pago_em,1,7) mes, SUM(valor) v FROM contas WHERE status='paid' AND pago_em IS NOT NULL GROUP BY 1`).all().map((x) => [x.mes, x.v]));
  return meses.map((m) => {
    const despesas = m.saidas + (contas.get(m.mes) || 0);
    return { mes: m.mes, cortes: m.cortes, faturamento: r2(m.faturamento), comissoes: r2(m.comissoes), taxas: r2(m.taxas), despesas: r2(despesas), lucro: r2(m.faturamento - m.comissoes - m.taxas - despesas) };
  });
}

function listaTransacoes(q) {
  const where = ["t.data_hora BETWEEN ? AND ?"];
  const params = [(q.de || hojeBrasilia()) + " 00:00", (q.ate || q.de || hojeBrasilia()) + " 23:59"];
  if (q.tipo) { where.push("t.tipo = ?"); params.push(q.tipo); }
  if (q.colaborador_id) { where.push("t.colaborador_id = ?"); params.push(q.colaborador_id); }
  if (q.cliente_id) { where.push("t.cliente_id = ?"); params.push(q.cliente_id); }
  if (q.sem_taxas) where.push("NOT (t.tipo='expense' AND t.categoria='taxa')");
  return db.prepare(`SELECT t.*, c.nome cliente, k.nome colaborador FROM transacoes t
    LEFT JOIN clientes c ON c.id = t.cliente_id LEFT JOIN colaboradores k ON k.id = t.colaborador_id
    WHERE ${where.join(" AND ")} ORDER BY t.data_hora DESC, t.rowid DESC LIMIT ${Math.min(Number(q.limite) || 500, 5000)}`).all(...params);
}

function clientesComHistorico() {
  return db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM transacoes t WHERE t.cliente_id=c.id AND t.tipo='service') visitas,
      (SELECT COALESCE(SUM(valor),0) FROM transacoes t WHERE t.cliente_id=c.id AND t.tipo IN ('service','income')) gasto,
      (SELECT MAX(substr(data_hora,1,10)) FROM transacoes t WHERE t.cliente_id=c.id AND t.tipo='service') ultima_visita,
      (SELECT COALESCE(SUM(valor),0) FROM fiados f WHERE f.cliente_id=c.id AND f.status='pending') fiado_aberto,
      (SELECT plano FROM planos p WHERE p.cliente_id=c.id AND p.status='active' LIMIT 1) plano
    FROM clientes c ORDER BY c.nome COLLATE NOCASE`).all();
}

function planosComUso() {
  const mes = hojeBrasilia().slice(0, 7);
  return db.prepare(`SELECT p.*, c.nome cliente,
      (SELECT COUNT(*) FROM transacoes t WHERE t.cliente_id=p.cliente_id AND t.tipo='service' AND t.forma_pagamento='plan' AND substr(t.data_hora,1,7)=?) usados_mes,
      (SELECT MAX(substr(data_hora,1,10)) FROM transacoes t WHERE t.cliente_id=p.cliente_id AND t.tipo='income' AND t.descricao LIKE 'Pagamento Plano%') ultimo_pagamento
    FROM planos p LEFT JOIN clientes c ON c.id=p.cliente_id ORDER BY p.status <> 'active', c.nome COLLATE NOCASE`).all(mes);
}

function exportarCsv() {
  const linhas = db.prepare(`SELECT t.id, t.data_hora, t.tipo, t.categoria, t.descricao, t.valor, t.comissao, t.forma_pagamento, t.taxa_pct, t.taxa_valor,
      c.nome cliente, k.nome colaborador FROM transacoes t LEFT JOIN clientes c ON c.id=t.cliente_id LEFT JOIN colaboradores k ON k.id=t.colaborador_id
    ORDER BY t.data_hora`).all();
  const cols = ["id", "data_hora", "tipo", "categoria", "descricao", "valor", "comissao", "forma_pagamento", "taxa_pct", "taxa_valor", "cliente", "colaborador"];
  const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return "﻿" + [cols.join(","), ...linhas.map((l) => cols.map((c) => esc(l[c])).join(","))].join("\n");
}

// ---------- rotas ----------
async function api(req, res, url) {
  const m = req.method;
  const rota = url.pathname.replace(/^\/api/, "");
  const q = Object.fromEntries(url.searchParams);

  if (rota === "/estado" && m === "GET") {
    return json(res, 200, { configurado: !!getConfig("senha"), logado: logado(req), nome: getConfig("nome_barbearia", "Minha Barbearia"), hoje: hojeBrasilia() });
  }
  if (rota === "/senha/criar" && m === "POST") {
    if (getConfig("senha")) throw new Erro(400, "A senha já foi criada.");
    const { senha, nome } = await corpoJson(req);
    if (!senha || String(senha).length < 4) throw new Erro(400, "A senha precisa ter pelo menos 4 caracteres.");
    setConfig("senha", hashSenha(String(senha)));
    if (nome) setConfig("nome_barbearia", String(nome).trim());
    criarSessao(res);
    return json(res, 200, { ok: true });
  }
  if (rota === "/login" && m === "POST") {
    const ip = req.socket.remoteAddress;
    const t = tentativas.get(ip) || { n: 0, ate: 0 };
    if (t.ate > Date.now()) throw new Erro(429, "Muitas tentativas. Espere um minuto.");
    const { senha } = await corpoJson(req);
    if (!confereSenha(String(senha || ""), getConfig("senha"))) {
      t.n++;
      if (t.n >= 5) { t.n = 0; t.ate = Date.now() + 60_000; }
      tentativas.set(ip, t);
      throw new Erro(401, "Senha incorreta.");
    }
    tentativas.delete(ip);
    criarSessao(res);
    return json(res, 200, { ok: true });
  }
  if (rota === "/logout" && m === "POST") {
    const t = tokenDo(req);
    if (t) db.prepare("DELETE FROM sessoes WHERE token_hash = ?").run(hashToken(t));
    res.setHeader("Set-Cookie", "sessao=; Path=/; Max-Age=0");
    return json(res, 200, { ok: true });
  }

  if (!logado(req)) throw new Erro(401, "Entre com a senha.");

  if (rota === "/base" && m === "GET") {
    return json(res, 200, {
      colaboradores: db.prepare(`SELECT * FROM colaboradores ORDER BY ${CADASTROS.colaboradores.ordem}`).all(),
      servicos: db.prepare(`SELECT * FROM servicos ORDER BY ${CADASTROS.servicos.ordem}`).all(),
      produtos: db.prepare(`SELECT * FROM produtos ORDER BY ${CADASTROS.produtos.ordem}`).all(),
      clientes: db.prepare("SELECT id, nome, telefone FROM clientes ORDER BY nome COLLATE NOCASE").all(),
      planos: db.prepare("SELECT id, cliente_id, plano, servicos_inclusos, cortes_maximos FROM planos WHERE status='active'").all(),
      taxas: taxas(),
      nome: getConfig("nome_barbearia", "Minha Barbearia"),
    });
  }
  if (rota === "/resumo" && m === "GET") {
    const hoje = hojeBrasilia();
    return json(res, 200, resumo(q.de || hoje.slice(0, 8) + "01", q.ate || hoje));
  }
  if (rota === "/meses" && m === "GET") return json(res, 200, mesAMes());
  if (rota === "/transacoes" && m === "GET") return json(res, 200, listaTransacoes(q));
  if (rota === "/transacoes" && m === "POST") {
    const d = await corpoJson(req);
    return json(res, 200, transacao(() => novoLancamento(d)));
  }
  let mt = /^\/transacoes\/([\w-]+)$/.exec(rota);
  if (mt && m === "DELETE") {
    transacao(() => {
      db.prepare("DELETE FROM transacoes WHERE vinculo_id = ?").run(mt[1]);
      db.prepare("DELETE FROM transacoes WHERE id = ?").run(mt[1]);
    });
    return json(res, 200, { ok: true });
  }

  if (rota === "/clientes/historico" && m === "GET") return json(res, 200, clientesComHistorico());
  if (rota === "/planos/uso" && m === "GET") return json(res, 200, planosComUso());

  // Caixa do dia
  if (rota === "/caixa" && m === "GET") {
    const dia = q.dia || hojeBrasilia();
    const cx = db.prepare("SELECT * FROM caixa WHERE dia = ?").get(dia) || null;
    const din = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN tipo IN ('service','income') THEN valor END),0) entrou,
        COALESCE(SUM(CASE WHEN tipo='expense' THEN valor END),0) saiu
      FROM transacoes WHERE forma_pagamento='cash' AND data_hora BETWEEN ? AND ?`).get(dia + " 00:00", dia + " 23:59");
    const esperado = cx ? r2((cx.abertura || 0) + din.entrou - din.saiu) : null;
    return json(res, 200, { dia, caixa: cx, dinheiro_entrou: r2(din.entrou), dinheiro_saiu: r2(din.saiu), esperado_na_gaveta: esperado });
  }
  if (rota === "/caixa/abrir" && m === "POST") {
    const { abertura } = await corpoJson(req);
    const dia = hojeBrasilia();
    db.prepare(`INSERT INTO caixa (id, dia, abertura, aberto_em) VALUES (?,?,?,?) ON CONFLICT(dia) DO UPDATE SET abertura = excluded.abertura, fechado_em = NULL, fechamento = NULL`)
      .run(uuid(), dia, Number(abertura) || 0, agoraBrasilia());
    return json(res, 200, { ok: true });
  }
  if (rota === "/caixa/fechar" && m === "POST") {
    const { fechamento, observacoes } = await corpoJson(req);
    const r = db.prepare("UPDATE caixa SET fechamento = ?, fechado_em = ?, observacoes = ? WHERE dia = ?").run(Number(fechamento) || 0, agoraBrasilia(), observacoes || null, hojeBrasilia());
    if (!r.changes) throw new Erro(400, "O caixa de hoje ainda não foi aberto.");
    return json(res, 200, { ok: true });
  }

  // Fiado: receber
  mt = /^\/fiados\/([\w-]+)\/receber$/.exec(rota);
  if (mt && m === "POST") {
    const { forma_pagamento } = await corpoJson(req);
    const f = db.prepare("SELECT * FROM fiados WHERE id = ?").get(mt[1]);
    if (!f) throw new Erro(404, "Fiado não encontrado.");
    if (f.status === "paid") throw new Erro(400, "Esse fiado já foi pago.");
    const colab = f.colaborador_id ? db.prepare("SELECT * FROM colaboradores WHERE id = ?").get(f.colaborador_id) : null;
    transacao(() => {
      lancar({ tipo: "service", descricao: `Pagamento de fiado - ${f.descricao || "Serviço"}`, valor: f.valor, comissao: colab ? (f.valor * colab.pct_comissao) / 100 : 0,
        forma_pagamento: forma_pagamento || "cash", cliente_id: f.cliente_id, colaborador_id: f.colaborador_id });
      db.prepare("UPDATE fiados SET status='paid', pago_em=?, forma_pagamento=? WHERE id=?").run(hojeBrasilia(), forma_pagamento || "cash", f.id);
    });
    return json(res, 200, { ok: true });
  }
  // Conta: pagar / reabrir
  mt = /^\/contas\/([\w-]+)\/pagar$/.exec(rota);
  if (mt && m === "POST") {
    const c = db.prepare("SELECT * FROM contas WHERE id = ?").get(mt[1]);
    if (!c) throw new Erro(404, "Conta não encontrada.");
    transacao(() => {
      db.prepare("UPDATE contas SET status='paid', pago_em=? WHERE id=?").run(hojeBrasilia(), c.id);
      // conta recorrente: já cria a do mês seguinte
      if (c.recorrente && c.vencimento) {
        const [a, mm, d] = c.vencimento.split("-").map(Number);
        const prox = new Date(Date.UTC(a, mm, Math.min(d, 28))).toISOString().slice(0, 10);
        const existe = db.prepare("SELECT 1 FROM contas WHERE descricao = ? AND vencimento = ?").get(c.descricao, prox);
        if (!existe) db.prepare("INSERT INTO contas (id,descricao,valor,vencimento,status,categoria,recorrente) VALUES (?,?,?,?,'pending',?,1)").run(uuid(), c.descricao, c.valor, prox, c.categoria);
      }
    });
    return json(res, 200, { ok: true });
  }
  mt = /^\/contas\/([\w-]+)\/reabrir$/.exec(rota);
  if (mt && m === "POST") {
    db.prepare("UPDATE contas SET status='pending', pago_em=NULL WHERE id=?").run(mt[1]);
    return json(res, 200, { ok: true });
  }
  // Plano: registrar pagamento da mensalidade
  mt = /^\/planos\/([\w-]+)\/mensalidade$/.exec(rota);
  if (mt && m === "POST") {
    const { forma_pagamento, valor } = await corpoJson(req);
    const p = db.prepare("SELECT p.*, c.nome FROM planos p LEFT JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?").get(mt[1]);
    if (!p) throw new Erro(404, "Plano não encontrado.");
    const id = transacao(() => lancar({ tipo: "income", descricao: `Pagamento Plano Mensal - ${(p.nome || "").trim()}`, valor: Number(valor) || p.preco || 0, comissao: 0, forma_pagamento: forma_pagamento || "pix", cliente_id: p.cliente_id }));
    return json(res, 200, { id });
  }

  // Configurações
  if (rota === "/config" && m === "POST") {
    const d = await corpoJson(req);
    if (d.nome) setConfig("nome_barbearia", String(d.nome).trim());
    if (d.taxas) setConfig("taxas", JSON.stringify({ debit_card: Number(d.taxas.debit_card) || 0, credit_card: Number(d.taxas.credit_card) || 0, pix: Number(d.taxas.pix) || 0 }));
    if (d.nova_senha) {
      if (!confereSenha(String(d.senha_atual || ""), getConfig("senha"))) throw new Erro(400, "Senha atual incorreta.");
      if (String(d.nova_senha).length < 4) throw new Erro(400, "A nova senha precisa ter pelo menos 4 caracteres.");
      setConfig("senha", hashSenha(String(d.nova_senha)));
    }
    return json(res, 200, { ok: true });
  }

  // Importação e backup
  if (rota === "/importar" && m === "POST") {
    const buf = await corpo(req, 50 * 1024 * 1024);
    const tipo = req.headers["content-type"] || "";
    let r;
    if (tipo.includes("json")) r = importarArquivos(JSON.parse(buf.toString("utf8")));
    else r = importarZip(buf);
    return json(res, 200, r);
  }
  if (rota === "/backups" && m === "GET") {
    const lista = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort().reverse()
      .map((f) => ({ arquivo: f, tamanho: fs.statSync(path.join(BACKUP_DIR, f)).size }));
    return json(res, 200, { pasta: BACKUP_DIR, lista });
  }
  if (rota === "/backup" && m === "POST") return json(res, 200, { arquivo: path.basename(fazerBackup("manual")) });
  if (rota === "/backup/baixar" && m === "GET") {
    const arq = fazerBackup("download");
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${path.basename(arq)}"` });
    return fs.createReadStream(arq).pipe(res);
  }
  if (rota === "/exportar/transacoes.csv" && m === "GET") {
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="lancamentos-${hojeBrasilia()}.csv"` });
    return res.end(exportarCsv());
  }

  // CRUD genérico
  mt = /^\/(\w+)(?:\/([\w-]+))?$/.exec(rota);
  if (mt && CADASTROS[mt[1]]) {
    const [, tabela, id] = mt;
    if (m === "GET" && !id) return json(res, 200, db.prepare(`SELECT * FROM ${tabela} ORDER BY ${CADASTROS[tabela].ordem}`).all());
    if (m === "POST" && !id) {
      const d = await corpoJson(req);
      return json(res, 200, { id: salvarCadastro(tabela, d) });
    }
    if (m === "PUT" && id) {
      const d = await corpoJson(req);
      return json(res, 200, { id: salvarCadastro(tabela, { ...d, id }) });
    }
    if (m === "DELETE" && id) {
      if (tabela === "colaboradores" || tabela === "servicos" || tabela === "produtos") {
        // não apaga quem tem histórico: só desativa
        const usado = tabela === "servicos" ? false : db.prepare(`SELECT 1 FROM transacoes WHERE ${tabela === "colaboradores" ? "colaborador_id" : "produto_id"} = ? LIMIT 1`).get(id);
        if (usado) {
          db.prepare(`UPDATE ${tabela} SET ativo = 0 WHERE id = ?`).run(id);
          return json(res, 200, { ok: true, desativado: true });
        }
      }
      db.prepare(`DELETE FROM ${tabela} WHERE id = ?`).run(id);
      return json(res, 200, { ok: true });
    }
  }
  throw new Erro(404, "Rota não encontrada.");
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    let arq = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!arq.startsWith(PUBLIC)) throw new Erro(403, "Proibido.");
    if (!fs.existsSync(arq) || fs.statSync(arq).isDirectory()) arq = path.join(PUBLIC, "index.html");
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(arq)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(arq).pipe(res);
  } catch (e) {
    if (!(e instanceof Erro)) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { erro: e instanceof Erro ? e.message : "Erro interno: " + e.message });
    else res.end();
  }
});

// Backup automático: um por dia (na primeira vez que o app abre no dia e depois a cada 6h).
function backupDiario() {
  const hoje = hojeBrasilia();
  if (getConfig("ultimo_backup") !== hoje) {
    try { fazerBackup("diario"); setConfig("ultimo_backup", hoje); } catch (e) { console.error("Falha no backup:", e.message); }
  }
}
backupDiario();
setInterval(backupDiario, 6 * 3600 * 1000).unref();
db.prepare("DELETE FROM sessoes WHERE expira < ?").run(Date.now());

servidor.listen(PORT, () => {
  console.log(`\n  Gestão da barbearia rodando em http://localhost:${PORT}`);
  console.log(`  Banco de dados: ${DB_FILE}`);
  console.log(`  Backups automáticos: ${BACKUP_DIR}\n`);
});
