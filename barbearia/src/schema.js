// Estrutura do banco. É criada sozinha no primeiro acesso (no Cloudflare e no computador).
export const VERSAO_SCHEMA = 4;

export const TABELAS = [
  `CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessoes (token_hash TEXT PRIMARY KEY, expira INTEGER NOT NULL, colaborador_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS tentativas (chave TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, ate INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS colaboradores (
    id TEXT PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT, email TEXT,
    pct_comissao REAL NOT NULL DEFAULT 50, ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT, pin_hash TEXT)`,
  `CREATE TABLE IF NOT EXISTS clientes (
    id TEXT PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT, email TEXT, observacoes TEXT, criado_em TEXT)`,
  `CREATE TABLE IF NOT EXISTS servicos (
    id TEXT PRIMARY KEY, nome TEXT NOT NULL, descricao TEXT, preco REAL NOT NULL DEFAULT 0,
    duracao_min INTEGER DEFAULT 30, pct_comissao REAL NOT NULL DEFAULT 50, ativo INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS produtos (
    id TEXT PRIMARY KEY, nome TEXT NOT NULL, descricao TEXT, preco REAL NOT NULL DEFAULT 0, custo REAL DEFAULT 0,
    estoque INTEGER DEFAULT 0, estoque_minimo INTEGER DEFAULT 0, categoria TEXT, ativo INTEGER NOT NULL DEFAULT 1)`,
  // tipo: service (corte), income (entrada), expense (saída), commission (comissão extra)
  // categoria das saídas: taxa | comissao_paga (pagamento de comissão ou vale) | outra
  `CREATE TABLE IF NOT EXISTS transacoes (
    id TEXT PRIMARY KEY, data_hora TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('service','income','expense','commission')),
    categoria TEXT, descricao TEXT, valor REAL NOT NULL DEFAULT 0, comissao REAL NOT NULL DEFAULT 0,
    forma_pagamento TEXT, taxa_pct REAL, taxa_valor REAL NOT NULL DEFAULT 0,
    cliente_id TEXT REFERENCES clientes(id) ON DELETE SET NULL,
    colaborador_id TEXT REFERENCES colaboradores(id) ON DELETE SET NULL,
    produto_id TEXT REFERENCES produtos(id) ON DELETE SET NULL,
    vinculo_id TEXT, origem TEXT NOT NULL DEFAULT 'app', lancado_por TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_tr_data ON transacoes(data_hora)`,
  `CREATE INDEX IF NOT EXISTS idx_tr_colab ON transacoes(colaborador_id, data_hora)`,
  `CREATE INDEX IF NOT EXISTS idx_tr_cliente ON transacoes(cliente_id, data_hora)`,
  `CREATE INDEX IF NOT EXISTS idx_tr_vinculo ON transacoes(vinculo_id)`,
  `CREATE TABLE IF NOT EXISTS caixa (
    id TEXT PRIMARY KEY, dia TEXT NOT NULL UNIQUE, abertura REAL DEFAULT 0, fechamento REAL,
    aberto_em TEXT, fechado_em TEXT, observacoes TEXT)`,
  `CREATE TABLE IF NOT EXISTS fiados (
    id TEXT PRIMARY KEY, data TEXT NOT NULL,
    cliente_id TEXT REFERENCES clientes(id) ON DELETE SET NULL,
    colaborador_id TEXT REFERENCES colaboradores(id) ON DELETE SET NULL,
    valor REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending', descricao TEXT, forma_pagamento TEXT, pago_em TEXT)`,
  `CREATE TABLE IF NOT EXISTS contas (
    id TEXT PRIMARY KEY, descricao TEXT NOT NULL, valor REAL NOT NULL, vencimento TEXT, pago_em TEXT,
    status TEXT NOT NULL DEFAULT 'pending', categoria TEXT, observacoes TEXT, recorrente INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS planos (
    id TEXT PRIMARY KEY, cliente_id TEXT REFERENCES clientes(id) ON DELETE CASCADE,
    plano TEXT, preco REAL, servicos_inclusos TEXT, cortes_maximos INTEGER,
    inicio TEXT, termino TEXT, status TEXT NOT NULL DEFAULT 'active', observacoes TEXT)`,
  `CREATE TABLE IF NOT EXISTS metas (
    id TEXT PRIMARY KEY, titulo TEXT, tipo TEXT, meta REAL, descricao TEXT, inicio TEXT, termino TEXT,
    status TEXT, alcancada_em TEXT, colaborador_id TEXT REFERENCES colaboradores(id) ON DELETE SET NULL)`,
  // celulares inscritos para receber notificações (colaborador_id NULL = dono)
  `CREATE TABLE IF NOT EXISTS push_inscricoes (
    endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, colaborador_id TEXT, criado_em TEXT)`,
  `CREATE TABLE IF NOT EXISTS agendamentos (
    id TEXT PRIMARY KEY, agendado_para TEXT, cliente_id TEXT REFERENCES clientes(id) ON DELETE SET NULL,
    colaborador_id TEXT REFERENCES colaboradores(id) ON DELETE SET NULL, status TEXT, observacoes TEXT)`,
];

// Colunas que versões anteriores do banco local não tinham.
const COLUNAS_NOVAS = [
  ["colaboradores", "pin_hash", "TEXT"],
  ["sessoes", "colaborador_id", "TEXT"],
  ["transacoes", "lancado_por", "TEXT"],
];

// Colunas de cada tabela de dados (usadas no backup, na restauração e na importação).
export const COLUNAS = {
  colaboradores: ["id", "nome", "telefone", "email", "pct_comissao", "ativo", "criado_em", "pin_hash"],
  clientes: ["id", "nome", "telefone", "email", "observacoes", "criado_em"],
  servicos: ["id", "nome", "descricao", "preco", "duracao_min", "pct_comissao", "ativo"],
  produtos: ["id", "nome", "descricao", "preco", "custo", "estoque", "estoque_minimo", "categoria", "ativo"],
  transacoes: ["id", "data_hora", "tipo", "categoria", "descricao", "valor", "comissao", "forma_pagamento", "taxa_pct", "taxa_valor", "cliente_id", "colaborador_id", "produto_id", "vinculo_id", "origem", "lancado_por"],
  caixa: ["id", "dia", "abertura", "fechamento", "aberto_em", "fechado_em", "observacoes"],
  fiados: ["id", "data", "cliente_id", "colaborador_id", "valor", "status", "descricao", "forma_pagamento", "pago_em"],
  contas: ["id", "descricao", "valor", "vencimento", "pago_em", "status", "categoria", "observacoes", "recorrente"],
  planos: ["id", "cliente_id", "plano", "preco", "servicos_inclusos", "cortes_maximos", "inicio", "termino", "status", "observacoes"],
  metas: ["id", "titulo", "tipo", "meta", "descricao", "inicio", "termino", "status", "alcancada_em", "colaborador_id"],
  agendamentos: ["id", "agendado_para", "cliente_id", "colaborador_id", "status", "observacoes"],
};
// Ordem respeitando as ligações entre tabelas (cadastros antes dos lançamentos).
export const ORDEM_TABELAS = Object.keys(COLUNAS);

let pronto = false;
/** Cria/atualiza o banco se precisar. Custa 1 consulta quando já está em dia. */
export async function garantirSchema(db) {
  if (pronto) return;
  let versao = 0;
  try {
    const r = await db.get("SELECT valor FROM config WHERE chave = 'schema_versao'");
    versao = r ? Number(r.valor) : 0;
  } catch { versao = 0; }
  if (versao < VERSAO_SCHEMA) {
    await db.batch(TABELAS.map((sql) => [sql, []]));
    for (const [tabela, coluna, def] of COLUNAS_NOVAS) {
      const cols = (await db.all(`PRAGMA table_info(${tabela})`)).map((c) => c.name);
      if (!cols.includes(coluna)) await db.run(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${def}`);
    }
    await db.run("INSERT INTO config (chave, valor) VALUES ('schema_versao', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", [String(VERSAO_SCHEMA)]);
  }
  pronto = true;
}
