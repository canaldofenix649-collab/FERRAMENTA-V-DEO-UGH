// Banco de dados da barbearia (SQLite embutido no Node, sem instalar nada).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DATA_DIR = process.env.DATA_DIR || path.resolve(import.meta.dirname, "dados");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
fs.mkdirSync(BACKUP_DIR, { recursive: true });

export const DB_FILE = path.join(DATA_DIR, "barbearia.db");
export const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT);
  CREATE TABLE IF NOT EXISTS sessoes (token_hash TEXT PRIMARY KEY, expira INTEGER NOT NULL);

  CREATE TABLE IF NOT EXISTS colaboradores (
    id TEXT PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT, email TEXT,
    pct_comissao REAL NOT NULL DEFAULT 50, ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT
  );
  CREATE TABLE IF NOT EXISTS clientes (
    id TEXT PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT, email TEXT, observacoes TEXT, criado_em TEXT
  );
  CREATE TABLE IF NOT EXISTS servicos (
    id TEXT PRIMARY KEY, nome TEXT NOT NULL, descricao TEXT, preco REAL NOT NULL DEFAULT 0,
    duracao_min INTEGER DEFAULT 30, pct_comissao REAL NOT NULL DEFAULT 50, ativo INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS produtos (
    id TEXT PRIMARY KEY, nome TEXT NOT NULL, descricao TEXT, preco REAL NOT NULL DEFAULT 0, custo REAL DEFAULT 0,
    estoque INTEGER DEFAULT 0, estoque_minimo INTEGER DEFAULT 0, categoria TEXT, ativo INTEGER NOT NULL DEFAULT 1
  );

  -- Cada lançamento do caixa.
  -- tipo: service (corte/serviço), income (entrada extra), expense (saída), commission (comissão extra)
  -- categoria (só para saídas): taxa, comissao_paga (pagamento de comissão ou vale), outra
  CREATE TABLE IF NOT EXISTS transacoes (
    id TEXT PRIMARY KEY,
    data_hora TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('service','income','expense','commission')),
    categoria TEXT,
    descricao TEXT,
    valor REAL NOT NULL DEFAULT 0,
    comissao REAL NOT NULL DEFAULT 0,
    forma_pagamento TEXT,
    taxa_pct REAL,
    taxa_valor REAL NOT NULL DEFAULT 0,
    cliente_id TEXT REFERENCES clientes(id) ON DELETE SET NULL,
    colaborador_id TEXT REFERENCES colaboradores(id) ON DELETE SET NULL,
    produto_id TEXT REFERENCES produtos(id) ON DELETE SET NULL,
    vinculo_id TEXT,
    origem TEXT NOT NULL DEFAULT 'app'
  );
  CREATE INDEX IF NOT EXISTS idx_tr_data ON transacoes(data_hora);
  CREATE INDEX IF NOT EXISTS idx_tr_colab ON transacoes(colaborador_id, data_hora);
  CREATE INDEX IF NOT EXISTS idx_tr_cliente ON transacoes(cliente_id, data_hora);

  CREATE TABLE IF NOT EXISTS caixa (
    id TEXT PRIMARY KEY, dia TEXT NOT NULL UNIQUE, abertura REAL DEFAULT 0, fechamento REAL,
    aberto_em TEXT, fechado_em TEXT, observacoes TEXT
  );
  CREATE TABLE IF NOT EXISTS fiados (
    id TEXT PRIMARY KEY, data TEXT NOT NULL,
    cliente_id TEXT REFERENCES clientes(id) ON DELETE SET NULL,
    colaborador_id TEXT REFERENCES colaboradores(id) ON DELETE SET NULL,
    valor REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending', descricao TEXT,
    forma_pagamento TEXT, pago_em TEXT
  );
  CREATE TABLE IF NOT EXISTS contas (
    id TEXT PRIMARY KEY, descricao TEXT NOT NULL, valor REAL NOT NULL, vencimento TEXT,
    pago_em TEXT, status TEXT NOT NULL DEFAULT 'pending', categoria TEXT, observacoes TEXT,
    recorrente INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS planos (
    id TEXT PRIMARY KEY, cliente_id TEXT REFERENCES clientes(id) ON DELETE CASCADE,
    plano TEXT, preco REAL, servicos_inclusos TEXT, cortes_maximos INTEGER,
    inicio TEXT, termino TEXT, status TEXT NOT NULL DEFAULT 'active', observacoes TEXT
  );
  CREATE TABLE IF NOT EXISTS metas (
    id TEXT PRIMARY KEY, titulo TEXT, tipo TEXT, meta REAL, descricao TEXT, inicio TEXT, termino TEXT,
    status TEXT, alcancada_em TEXT, colaborador_id TEXT REFERENCES colaboradores(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS agendamentos (
    id TEXT PRIMARY KEY, agendado_para TEXT, cliente_id TEXT REFERENCES clientes(id) ON DELETE SET NULL,
    colaborador_id TEXT REFERENCES colaboradores(id) ON DELETE SET NULL, status TEXT, observacoes TEXT
  );
`);

export function getConfig(chave, padrao = null) {
  const r = db.prepare("SELECT valor FROM config WHERE chave = ?").get(chave);
  return r ? r.valor : padrao;
}
export function setConfig(chave, valor) {
  db.prepare("INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor")
    .run(chave, String(valor));
}

export function transacao(fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Copia o banco inteiro para a pasta de backups. Mantém os 60 mais recentes. */
export function fazerBackup(motivo = "auto") {
  const carimbo = agoraBrasilia().replace(/[: ]/g, "-");
  const arquivo = path.join(BACKUP_DIR, `barbearia-${carimbo}-${motivo}.db`);
  if (fs.existsSync(arquivo)) fs.rmSync(arquivo);
  db.exec(`VACUUM INTO '${arquivo.replace(/'/g, "''")}'`);
  const todos = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort();
  for (const velho of todos.slice(0, Math.max(0, todos.length - 60))) fs.rmSync(path.join(BACKUP_DIR, velho));
  return arquivo;
}

/** "AAAA-MM-DD HH:MM" no horário de Brasília. */
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
