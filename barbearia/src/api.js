// API do app de gestão. Roda igual no Cloudflare (Worker + D1) e no computador (Node + SQLite).
// Recebe um Request padrão e devolve um Response padrão.
//
// Limites do plano grátis do Cloudflare que guiam este código:
//  - até 50 consultas ao banco por acesso  -> cada rota faz poucas consultas e grava em lote
//  - até 100 valores (?) por consulta      -> importação usa SQL com valores escritos (escapados)
//  - pouco tempo de CPU por acesso         -> o .zip é lido no navegador e chega aqui em partes
import { garantirSchema, COLUNAS, ORDEM_TABELAS } from "./schema.js";

const SESSAO_DIAS = 60;
const PBKDF2_ITER = 20000;
const uuid = () => crypto.randomUUID();
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const deHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

export class Erro extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// ---------- datas (horário de Brasília) ----------
export function agoraBrasilia() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
export const hojeBrasilia = () => agoraBrasilia().slice(0, 10);

// ---------- senha, PIN e sessão ----------
async function pbkdf2(senha, sal, iter) {
  const chave = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iter }, chave, 256));
}
async function hashSenha(senha) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${hex(sal)}$${await pbkdf2(senha, sal, PBKDF2_ITER)}`;
}
async function confereSenha(senha, salvo) {
  const [tipo, iter, sal, hash] = String(salvo || "").split("$");
  if (tipo !== "pbkdf2" || !hash) return false;
  const calc = await pbkdf2(senha, deHex(sal), Number(iter));
  let dif = calc.length ^ hash.length;
  for (let i = 0; i < Math.min(calc.length, hash.length); i++) dif |= calc.charCodeAt(i) ^ hash.charCodeAt(i);
  return dif === 0;
}
const sha256 = async (t) => hex(await crypto.subtle.digest("SHA-256", enc.encode(t)));
function tokenDo(req) {
  const m = /(?:^|;\s*)sessao=([a-f0-9]{64})/.exec(req.headers.get("cookie") || "");
  return m ? m[1] : null;
}

// ---------- utilidades ----------
const TIPO_JSON = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const json = (dados, status = 200, extra = {}) => new Response(JSON.stringify(dados), { status, headers: { ...TIPO_JSON, ...extra } });
async function corpoJson(req) {
  const t = await req.text();
  if (!t) return {};
  try { return JSON.parse(t); } catch { throw new Erro(400, "Dados inválidos."); }
}
/** Valor escrito direto no SQL, com escape (usado só na importação/restauração em lote). */
function lit(v) {
  if (v === null || v === undefined || v === "") return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return "'" + String(v).replace(/\u0000/g, "").replace(/'/g, "''") + "'";
}
/** INSERT ... ON CONFLICT DO UPDATE em lotes de até ~90 KB por comando. */
function upsertEmLotes(tabela, cols, linhas, conflito = "id") {
  const atualiza = cols.filter((c) => c !== conflito && c !== "id").map((c) => `${c}=excluded.${c}`).join(", ");
  const cab = `INSERT INTO ${tabela} (${cols.join(",")}) VALUES `;
  const fim = ` ON CONFLICT(${conflito}) DO ${atualiza ? "UPDATE SET " + atualiza : "NOTHING"}`;
  const comandos = [];
  let atual = [], tam = 0;
  for (const l of linhas) {
    const v = "(" + cols.map((c) => lit(l[c])).join(",") + ")";
    if (tam + v.length > 90_000 && atual.length) { comandos.push([cab + atual.join(",") + fim, []]); atual = []; tam = 0; }
    atual.push(v); tam += v.length + 1;
  }
  if (atual.length) comandos.push([cab + atual.join(",") + fim, []]);
  return comandos;
}

// ---------- configurações ----------
const getConfig = async (db, chave, padrao = null) => (await db.get("SELECT valor FROM config WHERE chave = ?", [chave]))?.valor ?? padrao;
const setConfigSql = (chave, valor) => ["INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", [chave, String(valor)]];
const TAXAS_PADRAO = { debit_card: 1.99, credit_card: 4.98, pix: 0.49 };
const NOME_TAXA = { debit_card: "Débito", credit_card: "Crédito", pix: "PIX" };
async function taxas(db) {
  try { return { ...TAXAS_PADRAO, ...JSON.parse(await getConfig(db, "taxas", "{}")) }; } catch { return TAXAS_PADRAO; }
}

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

/** Monta o comando para salvar um cadastro. Devolve [id, comando]. */
async function cadastroSql(tabela, dados) {
  const cfg = CADASTROS[tabela];
  const valores = {};
  if (tabela === "colaboradores") {
    const pin = String(dados.pin ?? "").trim();
    if (dados.remover_pin) valores.pin_hash = null;
    else if (pin) {
      if (!/^\d{4,6}$/.test(pin)) throw new Erro(400, "O PIN precisa ter de 4 a 6 números.");
      valores.pin_hash = await hashSenha(pin);
    }
  }
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
  if (dados.id) {
    if (obrig in valores && valores[obrig] == null) throw new Erro(400, `Preencha o campo "${obrig.replace("_id", "")}".`);
    const cols = Object.keys(valores);
    if (!cols.length) return [dados.id, null];
    return [dados.id, [`UPDATE ${tabela} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...cols.map((c) => valores[c]), dados.id]]];
  }
  if (valores[obrig] == null) throw new Erro(400, `Preencha o campo "${obrig.replace("_id", "")}".`);
  const id = uuid();
  if (tabela === "clientes" || tabela === "colaboradores") valores.criado_em = hojeBrasilia();
  if (tabela === "fiados") valores.data ??= hojeBrasilia();
  const cols = Object.keys(valores);
  return [id, [`INSERT INTO ${tabela} (id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`, [id, ...cols.map((c) => valores[c])]]];
}
async function salvarCadastro(db, tabela, dados) {
  const [id, cmd] = await cadastroSql(tabela, dados);
  if (cmd) {
    const r = await db.run(...cmd);
    if (dados.id && !r.changes) throw new Erro(404, "Registro não encontrado.");
  }
  return id;
}

// ---------- lançamentos ----------
/** Comandos para gravar um lançamento + a saída da taxa de cartão/PIX (igual ao app antigo). */
function lancamentoSql(t, taxasAtuais) {
  const id = uuid();
  const data_hora = t.data_hora || agoraBrasilia();
  const pct = t.tipo === "service" || t.tipo === "income" ? Number(taxasAtuais[t.forma_pagamento] || 0) : 0;
  const taxa = r2((t.valor * pct) / 100);
  const cmds = [[
    `INSERT INTO transacoes (id,data_hora,tipo,categoria,descricao,valor,comissao,forma_pagamento,taxa_pct,taxa_valor,cliente_id,colaborador_id,produto_id,vinculo_id,lancado_por)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, data_hora, t.tipo, t.categoria ?? null, t.descricao ?? null, r2(t.valor), r2(t.comissao), t.forma_pagamento ?? null,
      pct || null, taxa, t.cliente_id ?? null, t.colaborador_id ?? null, t.produto_id ?? null, t.vinculo_id ?? null, t.lancado_por ?? null],
  ]];
  if (taxa > 0) {
    cmds.push([
      `INSERT INTO transacoes (id,data_hora,tipo,categoria,descricao,valor,forma_pagamento,taxa_pct,vinculo_id,lancado_por) VALUES (?,?,'expense','taxa',?,?,?,?,?,?)`,
      [uuid(), data_hora, `Taxa ${NOME_TAXA[t.forma_pagamento]} (${String(pct).replace(".", ",")}%)`, taxa, t.forma_pagamento, pct, id, t.lancado_por ?? null],
    ]);
  }
  return { id, cmds };
}

async function novoLancamento(db, d) {
  const tipo = d.tipo;
  if (!["service", "income", "expense", "commission"].includes(tipo)) throw new Erro(400, "Tipo de lançamento inválido.");
  const colab = d.colaborador_id ? await db.get("SELECT * FROM colaboradores WHERE id = ?", [d.colaborador_id]) : null;
  const tx = await taxas(db);
  const gravar = async (t, extras = []) => {
    const { id, cmds } = lancamentoSql(t, tx);
    await db.batch([...cmds, ...extras]);
    return { id };
  };
  if (tipo === "service") {
    if (!colab) throw new Erro(400, "Escolha quem fez o serviço.");
    const ids = (Array.isArray(d.servicos) ? d.servicos : []).slice(0, 30).map(String);
    let servs = [];
    if (ids.length) {
      const unicos = [...new Set(ids)];
      const achados = await db.all(`SELECT * FROM servicos WHERE id IN (${unicos.map(() => "?").join(",")})`, unicos);
      servs = ids.map((id) => achados.find((s) => s.id === id)).filter(Boolean);
    }
    if (!servs.length && !(Number(d.valor) > 0)) throw new Erro(400, "Escolha pelo menos um serviço ou digite o valor.");
    const forma = d.forma_pagamento || "cash";
    const tabela = servs.reduce((s, x) => s + x.preco, 0);
    const valorCobrado = forma === "plan" ? 0 : d.valor != null && d.valor !== "" ? Number(d.valor) : tabela;
    if (!(valorCobrado >= 0)) throw new Erro(400, "Valor inválido.");
    // comissão: % de cada serviço sobre o preço de tabela (no plano também, como no app antigo);
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
      return { fiado: await salvarCadastro(db, "fiados", { cliente_id: d.cliente_id, colaborador_id: colab.id, valor: valorCobrado, descricao: nomes || d.descricao }) };
    }
    return gravar({ tipo, descricao, valor: valorCobrado, comissao, forma_pagamento: forma, cliente_id: d.cliente_id || null, colaborador_id: colab.id, lancado_por: d.lancado_por });
  }
  if (tipo === "commission") {
    if (!colab) throw new Erro(400, "Escolha o colaborador.");
    return gravar({ tipo, descricao: d.descricao || "Comissão extra", valor: 0, comissao: Number(d.comissao || d.valor), forma_pagamento: d.forma_pagamento, colaborador_id: colab.id });
  }
  if (!(Number(d.valor) > 0)) throw new Erro(400, "Digite o valor.");
  if (tipo === "income") {
    const produto = d.produto_id ? await db.get("SELECT * FROM produtos WHERE id = ?", [d.produto_id]) : null;
    const extras = produto ? [["UPDATE produtos SET estoque = estoque - ? WHERE id = ?", [Number(d.quantidade || 1), produto.id]]] : [];
    return gravar({ tipo, descricao: d.descricao || (produto ? `Venda: ${produto.nome.trim()}` : "Entrada"), valor: Number(d.valor), comissao: Number(d.comissao || 0), forma_pagamento: d.forma_pagamento || "cash", cliente_id: d.cliente_id || null, colaborador_id: colab?.id ?? null, produto_id: produto?.id ?? null }, extras);
  }
  const categoria = d.categoria === "comissao_paga" ? "comissao_paga" : "outra";
  if (categoria === "comissao_paga" && !colab) throw new Erro(400, "Escolha o colaborador que recebeu.");
  return gravar({ tipo, categoria, descricao: d.descricao || (categoria === "comissao_paga" ? `Pagamento de comissão - ${colab.nome}` : "Saída"), valor: Number(d.valor), forma_pagamento: d.forma_pagamento || "cash", colaborador_id: colab?.id ?? null });
}

async function apagarLancamento(db, id) {
  await db.batch([["DELETE FROM transacoes WHERE vinculo_id = ?", [id]], ["DELETE FROM transacoes WHERE id = ?", [id]]]);
}

// ---------- relatórios ----------
// faturamento = serviços + entradas; comissões = geradas nos cortes + extras;
// pagamento de comissão/vale NÃO é despesa (só abate o saldo do barbeiro);
// despesas = outras saídas do caixa + contas quitadas no período; taxas à parte.
async function resumo(db, de, ate) {
  const p = [de + " 00:00", ate + " 23:59"];
  const [g, contas, porColaborador, porForma, porDia, porDiaSemana, porHora, topServicos] = await Promise.all([
    db.get(`SELECT
      COUNT(CASE WHEN tipo='service' THEN 1 END) cortes,
      COALESCE(SUM(CASE WHEN tipo='service' THEN valor END),0) servicos,
      COALESCE(SUM(CASE WHEN tipo='income' THEN valor END),0) entradas,
      COALESCE(SUM(CASE WHEN tipo IN ('service','commission','income') THEN comissao END),0) comissoes,
      COALESCE(SUM(CASE WHEN tipo='expense' AND categoria='taxa' THEN valor END),0) taxas,
      COALESCE(SUM(CASE WHEN tipo='expense' AND categoria='outra' THEN valor END),0) saidas,
      COALESCE(SUM(CASE WHEN tipo='expense' AND categoria='comissao_paga' THEN valor END),0) comissoes_pagas,
      COUNT(CASE WHEN tipo='service' AND forma_pagamento='plan' THEN 1 END) cortes_plano
      FROM transacoes WHERE data_hora BETWEEN ? AND ?`, p),
    db.get("SELECT COALESCE(SUM(valor),0) v FROM contas WHERE status='paid' AND pago_em BETWEEN ? AND ?", [de, ate]),
    db.all(`SELECT c.id, c.nome, c.ativo,
      COUNT(CASE WHEN t.tipo='service' THEN 1 END) cortes,
      COALESCE(SUM(CASE WHEN t.tipo='service' THEN t.valor END),0) faturado,
      COALESCE(SUM(CASE WHEN t.tipo IN ('service','commission','income') THEN t.comissao END),0) comissao,
      COALESCE(SUM(CASE WHEN t.tipo='expense' AND t.categoria='comissao_paga' THEN t.valor END),0) pago
      FROM colaboradores c LEFT JOIN transacoes t ON t.colaborador_id = c.id AND t.data_hora BETWEEN ? AND ?
      GROUP BY c.id HAVING cortes > 0 OR c.ativo = 1 ORDER BY faturado DESC`, p),
    db.all(`SELECT COALESCE(forma_pagamento,'other') forma, COUNT(*) n, COALESCE(SUM(valor),0) valor
      FROM transacoes WHERE tipo IN ('service','income') AND data_hora BETWEEN ? AND ? GROUP BY 1 ORDER BY valor DESC`, p),
    db.all(`SELECT substr(data_hora,1,10) dia,
      COUNT(CASE WHEN tipo='service' THEN 1 END) cortes,
      COALESCE(SUM(CASE WHEN tipo IN ('service','income') THEN valor END),0) faturamento,
      COALESCE(SUM(CASE WHEN tipo IN ('service','commission','income') THEN comissao END),0) comissoes
      FROM transacoes WHERE data_hora BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`, p),
    db.all(`SELECT CAST(strftime('%w', substr(data_hora,1,10)) AS INTEGER) dow,
      COUNT(DISTINCT substr(data_hora,1,10)) dias, COUNT(*) cortes, COALESCE(SUM(valor),0) valor
      FROM transacoes WHERE tipo='service' AND data_hora BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`, p),
    db.all(`SELECT CAST(substr(data_hora,12,2) AS INTEGER) hora, COUNT(*) cortes, COALESCE(SUM(valor),0) valor
      FROM transacoes WHERE tipo='service' AND data_hora BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`, p),
    db.all(`SELECT COALESCE(NULLIF(descricao,''),'(sem descrição)') nome, COUNT(*) n, COALESCE(SUM(valor),0) valor
      FROM transacoes WHERE tipo='service' AND data_hora BETWEEN ? AND ? GROUP BY 1 ORDER BY n DESC LIMIT 10`, p),
  ]);
  const faturamento = g.servicos + g.entradas;
  const despesas = g.saidas + contas.v;
  const cortesPagos = g.cortes - g.cortes_plano;
  return {
    de, ate,
    geral: {
      cortes: g.cortes, cortes_plano: g.cortes_plano, servicos: r2(g.servicos), entradas: r2(g.entradas), faturamento: r2(faturamento),
      comissoes: r2(g.comissoes), comissoes_pagas: r2(g.comissoes_pagas), taxas: r2(g.taxas), saidas_caixa: r2(g.saidas),
      contas_pagas: r2(contas.v), despesas: r2(despesas), lucro: r2(faturamento - g.comissoes - g.taxas - despesas),
      ticket_medio: cortesPagos ? r2(g.servicos / cortesPagos) : 0,
    },
    porColaborador: porColaborador.map((x) => ({ ...x, faturado: r2(x.faturado), comissao: r2(x.comissao), pago: r2(x.pago), saldo: r2(x.comissao - x.pago) })),
    porForma: porForma.map((x) => ({ ...x, valor: r2(x.valor) })),
    porDia: porDia.map((x) => ({ ...x, faturamento: r2(x.faturamento), comissoes: r2(x.comissoes) })),
    porDiaSemana: porDiaSemana.map((x) => ({ ...x, valor: r2(x.valor), media_dia: x.dias ? r2(x.valor / x.dias) : 0 })),
    porHora: porHora.map((x) => ({ ...x, valor: r2(x.valor) })),
    topServicos: topServicos.map((x) => ({ ...x, valor: r2(x.valor) })),
  };
}

async function mesAMes(db) {
  const [meses, contas] = await Promise.all([
    db.all(`SELECT substr(data_hora,1,7) mes,
      COUNT(CASE WHEN tipo='service' THEN 1 END) cortes,
      COALESCE(SUM(CASE WHEN tipo IN ('service','income') THEN valor END),0) faturamento,
      COALESCE(SUM(CASE WHEN tipo IN ('service','commission','income') THEN comissao END),0) comissoes,
      COALESCE(SUM(CASE WHEN tipo='expense' AND categoria='taxa' THEN valor END),0) taxas,
      COALESCE(SUM(CASE WHEN tipo='expense' AND categoria='outra' THEN valor END),0) saidas
      FROM transacoes GROUP BY 1 ORDER BY 1`),
    db.all("SELECT substr(pago_em,1,7) mes, SUM(valor) v FROM contas WHERE status='paid' AND pago_em IS NOT NULL GROUP BY 1"),
  ]);
  const porMes = new Map(contas.map((x) => [x.mes, x.v]));
  return meses.map((m) => {
    const despesas = m.saidas + (porMes.get(m.mes) || 0);
    return { mes: m.mes, cortes: m.cortes, faturamento: r2(m.faturamento), comissoes: r2(m.comissoes), taxas: r2(m.taxas), despesas: r2(despesas), lucro: r2(m.faturamento - m.comissoes - m.taxas - despesas) };
  });
}

async function listaTransacoes(db, q) {
  const hoje = hojeBrasilia();
  const where = ["t.data_hora BETWEEN ? AND ?"];
  const params = [(q.de || hoje) + " 00:00", (q.ate || q.de || hoje) + " 23:59"];
  if (q.tipo) { where.push("t.tipo = ?"); params.push(q.tipo); }
  if (q.colaborador_id) { where.push("t.colaborador_id = ?"); params.push(q.colaborador_id); }
  if (q.cliente_id) { where.push("t.cliente_id = ?"); params.push(q.cliente_id); }
  if (q.sem_taxas) where.push("NOT (t.tipo='expense' AND t.categoria='taxa')");
  return db.all(`SELECT t.*, c.nome cliente, k.nome colaborador FROM transacoes t
    LEFT JOIN clientes c ON c.id = t.cliente_id LEFT JOIN colaboradores k ON k.id = t.colaborador_id
    WHERE ${where.join(" AND ")} ORDER BY t.data_hora DESC, t.rowid DESC LIMIT ${Math.min(Number(q.limite) || 500, 5000)}`, params);
}

const clientesComHistorico = (db) => db.all(`SELECT c.*, h.visitas, h.gasto, h.ultima_visita,
    COALESCE((SELECT SUM(valor) FROM fiados f WHERE f.cliente_id=c.id AND f.status='pending'),0) fiado_aberto,
    (SELECT plano FROM planos p WHERE p.cliente_id=c.id AND p.status='active' LIMIT 1) plano
  FROM clientes c LEFT JOIN (
    SELECT cliente_id, COUNT(CASE WHEN tipo='service' THEN 1 END) visitas, COALESCE(SUM(valor),0) gasto,
      MAX(CASE WHEN tipo='service' THEN substr(data_hora,1,10) END) ultima_visita
    FROM transacoes WHERE cliente_id IS NOT NULL AND tipo IN ('service','income') GROUP BY cliente_id
  ) h ON h.cliente_id = c.id ORDER BY c.nome COLLATE NOCASE`).then((l) => l.map((c) => ({ ...c, visitas: c.visitas || 0, gasto: c.gasto || 0 })));

const planosComUso = (db) => db.all(`SELECT p.*, c.nome cliente,
    (SELECT COUNT(*) FROM transacoes t WHERE t.cliente_id=p.cliente_id AND t.tipo='service' AND t.forma_pagamento='plan' AND substr(t.data_hora,1,7)=?) usados_mes,
    (SELECT MAX(substr(data_hora,1,10)) FROM transacoes t WHERE t.cliente_id=p.cliente_id AND t.tipo='income' AND t.descricao LIKE 'Pagamento Plano%') ultimo_pagamento
  FROM planos p LEFT JOIN clientes c ON c.id=p.cliente_id ORDER BY p.status <> 'active', c.nome COLLATE NOCASE`, [hojeBrasilia().slice(0, 7)]);

// ---------- leitura em partes (backup e planilha são montados no navegador) ----------
// Assim cada acesso processa no máximo ~1000 linhas, não importa o tamanho do banco.
async function dadosParte(db, tabela, depois, limite) {
  if (!COLUNAS[tabela]) throw new Erro(400, "Tabela desconhecida.");
  const lim = Math.min(Math.max(Number(limite) || 1000, 1), 1000);
  const linhas = await db.all(`SELECT rowid AS _r, ${COLUNAS[tabela].join(",")} FROM ${tabela} WHERE rowid > ? ORDER BY rowid LIMIT ${lim}`, [Number(depois) || 0]);
  const proximo = linhas.length === lim ? linhas[linhas.length - 1]._r : null;
  return { tabela, linhas: linhas.map(({ _r, ...l }) => l), proximo };
}

/** Restaura (mescla) uma parte de um backup: mesma id = atualiza; id nova = cria. */
async function restaurarLote(db, tabela, linhas) {
  if (!COLUNAS[tabela]) throw new Erro(400, "Tabela desconhecida no backup.");
  if (!Array.isArray(linhas) || linhas.length > 1000) throw new Erro(400, "Lote inválido.");
  const cols = COLUNAS[tabela];
  const validas = linhas.filter((l) => l && typeof l.id === "string" && l.id);
  await db.batch(upsertEmLotes(tabela, cols, validas, tabela === "caixa" ? "dia" : "id"));
  return validas.length;
}

// ---------- importação do app antigo (CSV já lido no navegador, em partes) ----------
const txt = (v) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const num = (v) => (txt(v) == null ? null : Number(String(v).replace(",", ".")));
const bool = (v) => (["t", "true", "1", "sim"].includes(String(v).trim().toLowerCase()) ? 1 : 0);
const chaveNome = (nome) => (nome || "").trim().toLowerCase().replace(/\s+/g, " ");
const listaIds = (v) => JSON.stringify(String(v || "").replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean));
export function categoriaSaida(descricao) {
  const d = (descricao || "").toLowerCase();
  if (d.startsWith("taxa ")) return "taxa";
  if (d.startsWith("pagamento de comissão") || d.startsWith("pagamento de comissao") || d.startsWith("vale")) return "comissao_paga";
  return "outra";
}
export const ARQUIVOS_IMPORTACAO = ["colaboradores.csv", "clientes.csv", "servicos.csv", "produtos.csv", "transacoes.csv", "caixa.csv", "fiados.csv", "contas-a-pagar.csv", "planos-clientes.csv", "metas.csv", "agendamentos.csv"];

export async function importarLote(db, arquivo, linhas) {
  if (!ARQUIVOS_IMPORTACAO.includes(arquivo)) return { arquivo, total: 0, criados: {} };
  if (!Array.isArray(linhas) || linhas.length > 1000) throw new Erro(400, "Lote inválido.");
  linhas = linhas.filter((r) => r && txt(r.id));
  const criados = {};
  const cmds = [];
  const simples = {
    "colaboradores.csv": () => ["colaboradores", ["id", "nome", "telefone", "email", "pct_comissao", "ativo", "criado_em"],
      linhas.map((r) => ({ id: r.id, nome: (r.nome || "").trim() || "(sem nome)", telefone: txt(r.telefone), email: txt(r.email), pct_comissao: num(r.pct_comissao) ?? 50, ativo: bool(r.ativo), criado_em: txt(r.criado_em) }))],
    "clientes.csv": () => ["clientes", ["id", "nome", "telefone", "email", "observacoes", "criado_em"],
      linhas.map((r) => ({ id: r.id, nome: (r.nome || "").trim() || "(sem nome)", telefone: txt(r.telefone), email: txt(r.email), observacoes: txt(r.observacoes), criado_em: txt(r.criado_em) }))],
    "servicos.csv": () => ["servicos", COLUNAS.servicos,
      linhas.map((r) => ({ id: r.id, nome: (r.nome || "").trim(), descricao: txt(r.descricao), preco: num(r.preco) ?? 0, duracao_min: num(r.duracao_min) ?? 30, pct_comissao: num(r.pct_comissao) ?? 50, ativo: bool(r.ativo) }))],
    "produtos.csv": () => ["produtos", COLUNAS.produtos,
      linhas.map((r) => ({ id: r.id, nome: (r.nome || "").trim(), descricao: txt(r.descricao), preco: num(r.preco) ?? 0, custo: num(r.custo) ?? 0, estoque: num(r.estoque) ?? 0, estoque_minimo: num(r.estoque_minimo) ?? 0, categoria: txt(r.categoria), ativo: bool(r.ativo) }))],
  };
  if (simples[arquivo]) {
    const [tabela, cols, dados] = simples[arquivo]();
    await db.batch(upsertEmLotes(tabela, cols, dados));
    return { arquivo, total: dados.length, criados };
  }

  // Os CSVs citam cliente/colaborador/produto pelo NOME: transformo em id (e crio quem faltar).
  const [cli, col, prod] = await Promise.all(["clientes", "colaboradores", "produtos"].map((t) => db.all(`SELECT id, nome FROM ${t}`)));
  const mapa = (l) => new Map(l.map((x) => [chaveNome(x.nome), x.id]));
  const clientes = mapa(cli), colabs = mapa(col), produtos = mapa(prod);
  const novosCli = [], novosCol = [];
  const idCliente = (nome) => {
    if (!txt(nome)) return null;
    let id = clientes.get(chaveNome(nome));
    if (!id) { id = uuid(); clientes.set(chaveNome(nome), id); novosCli.push({ id, nome: nome.trim(), criado_em: hojeBrasilia() }); }
    return id;
  };
  const idColab = (nome) => {
    if (!txt(nome)) return null;
    let id = colabs.get(chaveNome(nome));
    if (!id) { id = uuid(); colabs.set(chaveNome(nome), id); novosCol.push({ id, nome: nome.trim(), ativo: 0, pct_comissao: 50 }); }
    return id;
  };

  let tabela, dados, conflito = "id";
  switch (arquivo) {
    case "transacoes.csv":
      tabela = "transacoes";
      dados = linhas.map((r) => ({
        id: r.id, data_hora: r.data_hora, tipo: r.tipo, categoria: r.tipo === "expense" ? categoriaSaida(r.descricao) : null, descricao: txt(r.descricao),
        valor: num(r.valor) ?? 0, comissao: num(r.comissao) ?? 0, forma_pagamento: txt(r.forma_pagamento), taxa_pct: num(r.taxa_pct), taxa_valor: num(r.taxa_valor) ?? 0,
        cliente_id: idCliente(r.cliente), colaborador_id: idColab(r.colaborador), produto_id: txt(r.produto) ? produtos.get(chaveNome(r.produto)) ?? null : null,
        vinculo_id: null, origem: "importado", lancado_por: null,
      })).filter((x) => ["service", "income", "expense", "commission"].includes(x.tipo) && x.data_hora);
      break;
    case "caixa.csv":
      tabela = "caixa"; conflito = "dia";
      dados = linhas.filter((r) => txt(r.dia)).map((r) => ({ id: r.id, dia: r.dia, abertura: num(r.abertura) ?? 0, fechamento: num(r.fechamento), aberto_em: txt(r.aberto_em), fechado_em: txt(r.fechado_em), observacoes: txt(r.observacoes) }));
      break;
    case "fiados.csv":
      tabela = "fiados";
      dados = linhas.map((r) => ({ id: r.id, data: r.data, cliente_id: idCliente(r.cliente), colaborador_id: idColab(r.colaborador), valor: num(r.valor) ?? 0, status: r.status || "pending", descricao: txt(r.descricao), forma_pagamento: txt(r.forma_pagamento), pago_em: txt(r.pago_em) }));
      break;
    case "contas-a-pagar.csv":
      tabela = "contas";
      dados = linhas.map((r) => ({ id: r.id, descricao: (r.descricao || "").trim() || "(sem descrição)", valor: num(r.valor) ?? 0, vencimento: txt(r.vencimento), pago_em: txt(r.pago_em), status: r.status || "pending", categoria: txt(r.categoria), observacoes: txt(r.observacoes), recorrente: bool(r.recorrente) }));
      break;
    case "planos-clientes.csv":
      tabela = "planos";
      dados = linhas.map((r) => ({ id: r.id, cliente_id: idCliente(r.cliente), plano: txt(r.plano), preco: num(r.preco), servicos_inclusos: listaIds(r.servicos_inclusos), cortes_maximos: num(r.cortes_maximos), inicio: txt(r.inicio), termino: txt(r.termino), status: r.status || "active", observacoes: txt(r.observacoes) }));
      break;
    case "metas.csv":
      tabela = "metas";
      dados = linhas.map((r) => ({ id: r.id, titulo: txt(r.titulo), tipo: txt(r.tipo), meta: num(r.meta), descricao: txt(r.descricao), inicio: txt(r.inicio), termino: txt(r.termino), status: txt(r.status), alcancada_em: txt(r.alcancada_em), colaborador_id: idColab(r.colaborador) }));
      break;
    case "agendamentos.csv":
      tabela = "agendamentos";
      dados = linhas.map((r) => ({ id: r.id, agendado_para: txt(r.agendado_para), cliente_id: idCliente(r.cliente), colaborador_id: idColab(r.colaborador), status: txt(r.status), observacoes: txt(r.observacoes) }));
      break;
  }
  if (novosCli.length) { cmds.push(...upsertEmLotes("clientes", ["id", "nome", "criado_em"], novosCli)); criados["clientes criados a partir dos lançamentos"] = novosCli.length; }
  if (novosCol.length) { cmds.push(...upsertEmLotes("colaboradores", ["id", "nome", "ativo", "pct_comissao"], novosCol)); criados["colaboradores criados a partir dos lançamentos"] = novosCol.length; }
  cmds.push(...upsertEmLotes(tabela, COLUNAS[tabela], dados, conflito));
  await db.batch(cmds);
  return { arquivo, total: dados.length, criados };
}

// ---------- área do barbeiro ----------
// Só lança os próprios serviços, vê os próprios números e apaga o que ele mesmo lançou no dia.
async function resumoBarbeiro(db, colabId, de, ate) {
  const p = [de + " 00:00", ate + " 23:59", colabId];
  const LIMITE_LISTA = 300;
  const somas = `COUNT(CASE WHEN tipo='service' THEN 1 END) cortes,
      COUNT(CASE WHEN tipo='service' AND forma_pagamento='plan' THEN 1 END) cortes_plano,
      COALESCE(SUM(CASE WHEN tipo='service' THEN valor END),0) faturado,
      COALESCE(SUM(CASE WHEN tipo IN ('service','commission','income') THEN comissao END),0) comissao,
      COALESCE(SUM(CASE WHEN tipo='expense' AND categoria='comissao_paga' THEN valor END),0) pago`;
  const [g, meses, pagamentos, lista] = await Promise.all([
    db.get(`SELECT ${somas}, COUNT(CASE WHEN NOT (tipo='expense' AND categoria='comissao_paga') THEN 1 END) n_lanc
      FROM transacoes WHERE data_hora BETWEEN ? AND ? AND colaborador_id = ?`, p),
    db.all(`SELECT substr(data_hora,1,7) mes, ${somas}
      FROM transacoes WHERE data_hora BETWEEN ? AND ? AND colaborador_id = ? GROUP BY 1 ORDER BY 1 DESC`, p),
    db.all(`SELECT id, data_hora, descricao, valor, forma_pagamento FROM transacoes
      WHERE data_hora BETWEEN ? AND ? AND colaborador_id = ? AND tipo='expense' AND categoria='comissao_paga' ORDER BY data_hora DESC LIMIT 200`, p),
    db.all(`SELECT t.id, t.data_hora, t.tipo, t.categoria, t.descricao, t.valor, t.comissao, t.forma_pagamento, t.lancado_por, c.nome cliente
      FROM transacoes t LEFT JOIN clientes c ON c.id = t.cliente_id
      WHERE t.data_hora BETWEEN ? AND ? AND t.colaborador_id = ? AND NOT (t.tipo='expense' AND t.categoria='comissao_paga')
      ORDER BY t.data_hora DESC, t.rowid DESC LIMIT ${LIMITE_LISTA}`, p),
  ]);
  const fmt = (x) => ({ cortes: x.cortes, cortes_plano: x.cortes_plano, faturado: r2(x.faturado), comissao: r2(x.comissao), pago: r2(x.pago), saldo: r2(x.comissao - x.pago) });
  return {
    de, ate, ...fmt(g),
    meses: meses.map((m) => ({ mes: m.mes, ...fmt(m) })),
    pagamentos: pagamentos.map((x) => ({ ...x, valor: r2(x.valor) })),
    lista, lista_total: g.n_lanc,
  };
}

async function apiBarbeiro(req, db, rota, m, q, colab) {
  const hoje = hojeBrasilia();
  if (rota === "/base" && m === "GET") {
    const [servicos, clientes, planos, nome] = await Promise.all([
      db.all("SELECT id, nome, preco, pct_comissao, ativo FROM servicos WHERE ativo = 1 ORDER BY nome COLLATE NOCASE"),
      db.all("SELECT id, nome FROM clientes ORDER BY nome COLLATE NOCASE"),
      db.all("SELECT id, cliente_id, plano, servicos_inclusos, cortes_maximos FROM planos WHERE status='active'"),
      getConfig(db, "nome_barbearia", "Minha Barbearia"),
    ]);
    return json({ colaboradores: [{ id: colab.id, nome: colab.nome, pct_comissao: colab.pct_comissao, ativo: 1 }], servicos, produtos: [], clientes, planos, nome });
  }
  if (rota === "/meu" && m === "GET") return json(await resumoBarbeiro(db, colab.id, q.de || hoje, q.ate || q.de || hoje));
  if (rota === "/transacoes" && m === "POST") {
    const d = await corpoJson(req);
    if (d.tipo !== "service") throw new Erro(403, "Só o dono lança entradas e saídas.");
    // vale sempre quem está logado e a tabela de preços, não o que vier do celular
    return json(await novoLancamento(db, { tipo: "service", servicos: d.servicos, forma_pagamento: d.forma_pagamento, cliente_id: d.cliente_id, valor: d.valor, colaborador_id: colab.id, lancado_por: colab.id }));
  }
  const mt = /^\/transacoes\/([\w-]+)$/.exec(rota);
  if (mt && m === "DELETE") {
    const t = await db.get("SELECT id, lancado_por, data_hora FROM transacoes WHERE id = ?", [mt[1]]);
    if (!t || t.lancado_por !== colab.id || t.data_hora.slice(0, 10) !== hoje) throw new Erro(403, "Você só pode apagar o que você mesmo lançou hoje. Para outros casos, fale com o dono.");
    await apagarLancamento(db, t.id);
    return json({ ok: true });
  }
  if (rota === "/clientes" && m === "POST") {
    const d = await corpoJson(req);
    return json({ id: await salvarCadastro(db, "clientes", { nome: d.nome, telefone: d.telefone }) });
  }
  throw new Erro(403, "Essa área é só do dono.");
}

// ---------- proteção contra chute de senha/PIN (guardada no banco) ----------
async function checarBloqueio(db, chaves) {
  if (!chaves.length) return;
  const r = await db.get(`SELECT MAX(ate) ate FROM tentativas WHERE chave IN (${chaves.map(() => "?").join(",")})`, chaves);
  if (r?.ate && r.ate > Date.now()) throw new Erro(429, "Muitas tentativas erradas. Espere alguns minutos e tente de novo.");
}
function falhaSql(chave, limite, minutos) {
  return [`INSERT INTO tentativas (chave, n, ate) VALUES (?, 1, 0)
    ON CONFLICT(chave) DO UPDATE SET n = CASE WHEN n + 1 >= ? THEN 0 ELSE n + 1 END,
    ate = CASE WHEN n + 1 >= ? THEN ? ELSE ate END`, [chave, limite, limite, Date.now() + minutos * 60_000]];
}

/**
 * Trata uma chamada em /api/*.
 * ctx: { db, ambiente: "cloudflare" | "local", ip, extras?: { listarBackups, baixarBackupArquivo, fazerBackup } }
 */
export async function tratarApi(req, ctx) {
  try {
    return await rotear(req, ctx);
  } catch (e) {
    if (!(e instanceof Erro)) console.error(e);
    return json({ erro: e instanceof Erro ? e.message : "Erro interno: " + (e?.message || e) }, e?.status || 500);
  }
}

async function rotear(req, ctx) {
  const { db } = ctx;
  await garantirSchema(db);
  const url = new URL(req.url);
  const m = req.method;
  const rota = url.pathname.replace(/^\/api/, "");
  const q = Object.fromEntries(url.searchParams);
  const https = url.protocol === "https:";
  const cookie = (token, idade) => `sessao=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${idade}${https ? "; Secure" : ""}`;
  const criarSessao = async (colaboradorId = null) => {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    await db.batch([
      ["INSERT INTO sessoes (token_hash, expira, colaborador_id) VALUES (?, ?, ?)", [await sha256(token), Date.now() + SESSAO_DIAS * 864e5, colaboradorId]],
      ["DELETE FROM sessoes WHERE expira < ?", [Date.now()]],
    ]);
    return cookie(token, SESSAO_DIAS * 86400);
  };
  const quem = async () => {
    const t = tokenDo(req);
    if (!t) return null;
    const s = await db.get(`SELECT s.expira, s.colaborador_id, c.id, c.nome, c.pct_comissao, c.ativo, c.pin_hash
      FROM sessoes s LEFT JOIN colaboradores c ON c.id = s.colaborador_id WHERE s.token_hash = ?`, [await sha256(t)]);
    if (!s || s.expira <= Date.now()) return null;
    if (!s.colaborador_id) return { dono: true };
    if (!s.id || !s.ativo || !s.pin_hash) return null; // desativado ou sem PIN: perde o acesso na hora
    return { dono: false, colab: { id: s.id, nome: s.nome, pct_comissao: s.pct_comissao } };
  };

  if (rota === "/estado" && m === "GET") {
    const [u, senha, nome, acessos] = await Promise.all([
      quem(), getConfig(db, "senha"), getConfig(db, "nome_barbearia", "Minha Barbearia"),
      db.all("SELECT id, nome FROM colaboradores WHERE ativo = 1 AND pin_hash IS NOT NULL ORDER BY nome COLLATE NOCASE"),
    ]);
    return json({
      configurado: !!senha, logado: !!u, papel: u ? (u.dono ? "dono" : "barbeiro") : null,
      eu: u && !u.dono ? { id: u.colab.id, nome: u.colab.nome } : null,
      nome, hoje: hojeBrasilia(), ambiente: ctx.ambiente,
      acessos: acessos.map((c) => ({ id: c.id, nome: c.nome.trim().split(/\s+/)[0] })),
    });
  }
  if (rota === "/senha/criar" && m === "POST") {
    if (await getConfig(db, "senha")) throw new Erro(400, "A senha já foi criada.");
    const { senha, nome } = await corpoJson(req);
    if (!senha || String(senha).length < 6) throw new Erro(400, "A senha do dono precisa ter pelo menos 6 caracteres.");
    const cmds = [setConfigSql("senha", await hashSenha(String(senha)))];
    if (nome) cmds.push(setConfigSql("nome_barbearia", String(nome).trim()));
    await db.batch(cmds);
    return json({ ok: true }, 200, { "Set-Cookie": await criarSessao() });
  }
  if (rota === "/login" && m === "POST") {
    const ip = ctx.ip || "?";
    const { senha, colaborador_id } = await corpoJson(req);
    const chaveConta = colaborador_id ? "colab:" + String(colaborador_id) : "dono";
    await checarBloqueio(db, ["ip:" + ip, chaveConta]);
    let ok = false, colabId = null;
    if (colaborador_id) {
      const c = await db.get("SELECT id, pin_hash, ativo FROM colaboradores WHERE id = ?", [String(colaborador_id)]);
      ok = !!(c && c.ativo && c.pin_hash && (await confereSenha(String(senha || ""), c.pin_hash)));
      colabId = c?.id ?? null;
    } else {
      ok = await confereSenha(String(senha || ""), await getConfig(db, "senha"));
    }
    if (!ok) {
      await db.batch([falhaSql("ip:" + ip, 10, 5), colaborador_id ? falhaSql(chaveConta, 6, 15) : falhaSql(chaveConta, 8, 15)]);
      throw new Erro(401, colaborador_id ? "PIN incorreto." : "Senha incorreta.");
    }
    await db.run("DELETE FROM tentativas WHERE chave IN (?, ?)", ["ip:" + ip, chaveConta]);
    return json({ ok: true }, 200, { "Set-Cookie": await criarSessao(colabId) });
  }
  if (rota === "/logout" && m === "POST") {
    const t = tokenDo(req);
    if (t) await db.run("DELETE FROM sessoes WHERE token_hash = ?", [await sha256(t)]);
    return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
  }

  const u = await quem();
  if (!u) throw new Erro(401, "Entre de novo.");
  if (!u.dono) return apiBarbeiro(req, db, rota, m, q, u.colab);

  // ================= daqui para baixo: só o dono =================
  const hoje = hojeBrasilia();
  if (rota === "/base" && m === "GET") {
    const [colaboradores, servicos, produtos, clientes, planos, tx, nome, ultimoBackup] = await Promise.all([
      db.all(`SELECT * FROM colaboradores ORDER BY ${CADASTROS.colaboradores.ordem}`),
      db.all(`SELECT * FROM servicos ORDER BY ${CADASTROS.servicos.ordem}`),
      db.all(`SELECT * FROM produtos ORDER BY ${CADASTROS.produtos.ordem}`),
      db.all("SELECT id, nome, telefone FROM clientes ORDER BY nome COLLATE NOCASE"),
      db.all("SELECT id, cliente_id, plano, servicos_inclusos, cortes_maximos FROM planos WHERE status='active'"),
      taxas(db), getConfig(db, "nome_barbearia", "Minha Barbearia"), getConfig(db, "ultimo_backup"),
    ]);
    return json({ colaboradores: colaboradores.map(({ pin_hash, ...c }) => ({ ...c, tem_pin: !!pin_hash })), servicos, produtos, clientes, planos, taxas: tx, nome, ultimo_backup: ultimoBackup });
  }
  if (rota === "/resumo" && m === "GET") return json(await resumo(db, q.de || hoje.slice(0, 8) + "01", q.ate || hoje));
  if (rota === "/meses" && m === "GET") return json(await mesAMes(db));
  if (rota === "/transacoes" && m === "GET") return json(await listaTransacoes(db, q));
  if (rota === "/transacoes" && m === "POST") return json(await novoLancamento(db, await corpoJson(req)));
  let mt = /^\/transacoes\/([\w-]+)$/.exec(rota);
  if (mt && m === "DELETE") { await apagarLancamento(db, mt[1]); return json({ ok: true }); }

  if (rota === "/clientes/historico" && m === "GET") return json(await clientesComHistorico(db));
  if (rota === "/planos/uso" && m === "GET") return json(await planosComUso(db));

  // Caixa do dia
  if (rota === "/caixa" && m === "GET") {
    const dia = q.dia || hoje;
    const [cx, din] = await Promise.all([
      db.get("SELECT * FROM caixa WHERE dia = ?", [dia]),
      db.get(`SELECT COALESCE(SUM(CASE WHEN tipo IN ('service','income') THEN valor END),0) entrou,
        COALESCE(SUM(CASE WHEN tipo='expense' THEN valor END),0) saiu
        FROM transacoes WHERE forma_pagamento='cash' AND data_hora BETWEEN ? AND ?`, [dia + " 00:00", dia + " 23:59"]),
    ]);
    return json({ dia, caixa: cx, dinheiro_entrou: r2(din.entrou), dinheiro_saiu: r2(din.saiu), esperado_na_gaveta: cx ? r2((cx.abertura || 0) + din.entrou - din.saiu) : null });
  }
  if (rota === "/caixa/abrir" && m === "POST") {
    const { abertura } = await corpoJson(req);
    await db.run(`INSERT INTO caixa (id, dia, abertura, aberto_em) VALUES (?,?,?,?) ON CONFLICT(dia) DO UPDATE SET abertura = excluded.abertura, fechado_em = NULL, fechamento = NULL`,
      [uuid(), hoje, Number(abertura) || 0, agoraBrasilia()]);
    return json({ ok: true });
  }
  if (rota === "/caixa/fechar" && m === "POST") {
    const { fechamento, observacoes } = await corpoJson(req);
    const r = await db.run("UPDATE caixa SET fechamento = ?, fechado_em = ?, observacoes = ? WHERE dia = ?", [Number(fechamento) || 0, agoraBrasilia(), observacoes || null, hoje]);
    if (!r.changes) throw new Erro(400, "O caixa de hoje ainda não foi aberto.");
    return json({ ok: true });
  }

  // Fiado: receber (entra no caixa como serviço, com a comissão do barbeiro)
  mt = /^\/fiados\/([\w-]+)\/receber$/.exec(rota);
  if (mt && m === "POST") {
    const { forma_pagamento } = await corpoJson(req);
    const f = await db.get("SELECT f.*, c.pct_comissao FROM fiados f LEFT JOIN colaboradores c ON c.id = f.colaborador_id WHERE f.id = ?", [mt[1]]);
    if (!f) throw new Erro(404, "Fiado não encontrado.");
    if (f.status === "paid") throw new Erro(400, "Esse fiado já foi pago.");
    const forma = forma_pagamento || "cash";
    const { cmds } = lancamentoSql({ tipo: "service", descricao: `Pagamento de fiado - ${f.descricao || "Serviço"}`, valor: f.valor, comissao: f.pct_comissao != null ? (f.valor * f.pct_comissao) / 100 : 0,
      forma_pagamento: forma, cliente_id: f.cliente_id, colaborador_id: f.colaborador_id }, await taxas(db));
    await db.batch([...cmds, ["UPDATE fiados SET status='paid', pago_em=?, forma_pagamento=? WHERE id=? AND status <> 'paid'", [hoje, forma, f.id]]]);
    return json({ ok: true });
  }
  // Conta: pagar (se for mensal, já cria a do mês seguinte) / desfazer
  mt = /^\/contas\/([\w-]+)\/pagar$/.exec(rota);
  if (mt && m === "POST") {
    const c = await db.get("SELECT * FROM contas WHERE id = ?", [mt[1]]);
    if (!c) throw new Erro(404, "Conta não encontrada.");
    const cmds = [["UPDATE contas SET status='paid', pago_em=? WHERE id=?", [hoje, c.id]]];
    if (c.recorrente && c.vencimento) {
      const [a, mm, d] = c.vencimento.split("-").map(Number);
      const prox = new Date(Date.UTC(a, mm, Math.min(d, 28))).toISOString().slice(0, 10);
      const existe = await db.get("SELECT 1 x FROM contas WHERE descricao = ? AND vencimento = ?", [c.descricao, prox]);
      if (!existe) cmds.push(["INSERT INTO contas (id,descricao,valor,vencimento,status,categoria,recorrente) VALUES (?,?,?,?,'pending',?,1)", [uuid(), c.descricao, c.valor, prox, c.categoria]]);
    }
    await db.batch(cmds);
    return json({ ok: true });
  }
  mt = /^\/contas\/([\w-]+)\/reabrir$/.exec(rota);
  if (mt && m === "POST") {
    await db.run("UPDATE contas SET status='pending', pago_em=NULL WHERE id=?", [mt[1]]);
    return json({ ok: true });
  }
  // Plano: mensalidade recebida
  mt = /^\/planos\/([\w-]+)\/mensalidade$/.exec(rota);
  if (mt && m === "POST") {
    const { forma_pagamento, valor } = await corpoJson(req);
    const p = await db.get("SELECT p.*, c.nome FROM planos p LEFT JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?", [mt[1]]);
    if (!p) throw new Erro(404, "Plano não encontrado.");
    const { id, cmds } = lancamentoSql({ tipo: "income", descricao: `Pagamento Plano Mensal - ${(p.nome || "").trim()}`, valor: Number(valor) || p.preco || 0, comissao: 0, forma_pagamento: forma_pagamento || "pix", cliente_id: p.cliente_id }, await taxas(db));
    await db.batch(cmds);
    return json({ id });
  }

  // Configurações
  if (rota === "/config" && m === "POST") {
    const d = await corpoJson(req);
    const cmds = [];
    if (d.nome) cmds.push(setConfigSql("nome_barbearia", String(d.nome).trim()));
    if (d.taxas) cmds.push(setConfigSql("taxas", JSON.stringify({ debit_card: Number(d.taxas.debit_card) || 0, credit_card: Number(d.taxas.credit_card) || 0, pix: Number(d.taxas.pix) || 0 })));
    if (d.nova_senha) {
      if (!(await confereSenha(String(d.senha_atual || ""), await getConfig(db, "senha")))) throw new Erro(400, "Senha atual incorreta.");
      if (String(d.nova_senha).length < 6) throw new Erro(400, "A nova senha precisa ter pelo menos 6 caracteres.");
      cmds.push(setConfigSql("senha", await hashSenha(String(d.nova_senha))));
      cmds.push(["DELETE FROM sessoes WHERE colaborador_id IS NULL AND token_hash <> ?", [await sha256(tokenDo(req))]]);
    }
    await db.batch(cmds);
    return json({ ok: true });
  }

  // Importação, backup e restauração (sempre em partes)
  if (rota === "/importar/lote" && m === "POST") {
    const { arquivo, linhas } = await corpoJson(req);
    return json(await importarLote(db, String(arquivo || ""), linhas));
  }
  if (rota === "/restaurar/lote" && m === "POST") {
    const { tabela, linhas, config } = await corpoJson(req);
    if (Array.isArray(config)) {
      const ok = config.filter((c) => ["nome_barbearia", "taxas"].includes(c?.chave));
      await db.batch(ok.map((c) => setConfigSql(c.chave, c.valor)));
    }
    return json({ total: tabela ? await restaurarLote(db, String(tabela), linhas) : 0 });
  }
  if (rota === "/dados" && m === "GET") return json(await dadosParte(db, String(q.tabela || ""), q.depois, q.limite));
  if (rota === "/dados/config" && m === "GET") {
    return json({ app: "gestao-barbearia", versao: 1, gerado_em: agoraBrasilia(), tabelas: ORDEM_TABELAS,
      config: await db.all("SELECT chave, valor FROM config WHERE chave IN ('nome_barbearia','taxas')") });
  }
  if (rota === "/backup/feito" && m === "POST") { await db.run(...setConfigSql("ultimo_backup", hoje)); return json({ ok: true }); }
  if (rota === "/backups" && m === "GET") return json(ctx.extras?.listarBackups ? await ctx.extras.listarBackups() : { lista: [] });
  mt = /^\/backups\/([\w.-]+)$/.exec(rota);
  if (mt && m === "GET" && ctx.extras?.baixarBackup) {
    const r = await ctx.extras.baixarBackup(mt[1]);
    if (!r) throw new Erro(404, "Backup não encontrado.");
    return r;
  }

  // CRUD genérico dos cadastros
  mt = /^\/(\w+)(?:\/([\w-]+))?$/.exec(rota);
  if (mt && CADASTROS[mt[1]]) {
    const [, tabela, id] = mt;
    if (m === "GET" && !id) {
      const lista = await db.all(`SELECT * FROM ${tabela} ORDER BY ${CADASTROS[tabela].ordem}`);
      return json(tabela === "colaboradores" ? lista.map(({ pin_hash, ...c }) => ({ ...c, tem_pin: !!pin_hash })) : lista);
    }
    if (m === "POST" && !id) return json({ id: await salvarCadastro(db, tabela, await corpoJson(req)) });
    if (m === "PUT" && id) return json({ id: await salvarCadastro(db, tabela, { ...(await corpoJson(req)), id }) });
    if (m === "DELETE" && id) {
      if (tabela === "colaboradores" || tabela === "produtos") {
        // quem tem histórico não é apagado: só desativado (e perde o acesso)
        const usado = await db.get(`SELECT 1 x FROM transacoes WHERE ${tabela === "colaboradores" ? "colaborador_id" : "produto_id"} = ? LIMIT 1`, [id]);
        if (usado) {
          await db.run(`UPDATE ${tabela} SET ativo = 0 WHERE id = ?`, [id]);
          return json({ ok: true, desativado: true });
        }
      }
      await db.run(`DELETE FROM ${tabela} WHERE id = ?`, [id]);
      return json({ ok: true });
    }
  }
  throw new Erro(404, "Rota não encontrada.");
}
