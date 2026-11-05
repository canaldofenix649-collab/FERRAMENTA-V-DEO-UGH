import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = process.env.DATA_DIR || path.resolve("data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "app.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    credits       INTEGER NOT NULL DEFAULT 0,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS generations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('viral', 'ugc')),
    title      TEXT NOT NULL,
    result     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id, id DESC);

  CREATE TABLE IF NOT EXISTS credit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount     INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export interface User {
  id: number;
  name: string;
  email: string;
  credits: number;
  is_admin: number;
  created_at: string;
}

const USER_COLUMNS = "id, name, email, credits, is_admin, created_at";

export function findUserById(id: number): User | undefined {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as User | undefined;
}

export function findUserWithPasswordByEmail(email: string) {
  return db.prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = ?`).get(email) as
    | (User & { password_hash: string })
    | undefined;
}

export function createUser(name: string, email: string, passwordHash: string, credits: number, isAdmin: boolean): User {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO users (name, email, password_hash, credits, is_admin) VALUES (?, ?, ?, ?, ?)")
    .run(name, email, passwordHash, credits, isAdmin ? 1 : 0);
  const id = Number(lastInsertRowid);
  if (credits > 0) logCredits(id, credits, "Créditos de boas-vindas");
  return findUserById(id)!;
}

function logCredits(userId: number, amount: number, reason: string) {
  db.prepare("INSERT INTO credit_log (user_id, amount, reason) VALUES (?, ?, ?)").run(userId, amount, reason);
}

/** Desconta créditos de forma atômica. Retorna false se o saldo for insuficiente. */
export function spendCredits(userId: number, amount: number, reason: string): boolean {
  const { changes } = db
    .prepare("UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?")
    .run(amount, userId, amount);
  if (changes === 0) return false;
  logCredits(userId, -amount, reason);
  return true;
}

export function addCredits(userId: number, amount: number, reason: string): void {
  db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(amount, userId);
  logCredits(userId, amount, reason);
}

export function setAdmin(userId: number, isAdmin: boolean): void {
  db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, userId);
}

export function listUsers(search: string): (User & { generations: number })[] {
  return db
    .prepare(
      `SELECT ${USER_COLUMNS.split(", ").map((c) => "u." + c).join(", ")},
              (SELECT COUNT(*) FROM generations g WHERE g.user_id = u.id) AS generations
       FROM users u
       WHERE u.email LIKE ? OR u.name LIKE ?
       ORDER BY u.id DESC LIMIT 200`,
    )
    .all(`%${search}%`, `%${search}%`) as unknown as (User & { generations: number })[];
}

export function stats() {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM generations) AS generations,
              (SELECT COUNT(*) FROM generations WHERE created_at >= datetime('now', '-1 day')) AS generations_24h`,
    )
    .get() as { users: number; generations: number; generations_24h: number };
}

// ---------- Sessões ----------
export function createSession(tokenHash: string, userId: number, expiresAt: number): void {
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, userId, expiresAt);
}

export function findSessionUser(tokenHash: string): User | undefined {
  const row = db
    .prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .get(tokenHash, Date.now()) as { user_id: number } | undefined;
  return row ? findUserById(row.user_id) : undefined;
}

export function deleteSession(tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function deleteExpiredSessions(): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}

// ---------- Histórico ----------
export function saveGeneration(userId: number, kind: "viral" | "ugc", title: string, result: unknown): number {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO generations (user_id, kind, title, result) VALUES (?, ?, ?, ?)")
    .run(userId, kind, title, JSON.stringify(result));
  return Number(lastInsertRowid);
}

export function listGenerations(userId: number) {
  return db
    .prepare("SELECT id, kind, title, created_at FROM generations WHERE user_id = ? ORDER BY id DESC LIMIT 100")
    .all(userId) as { id: number; kind: string; title: string; created_at: string }[];
}

export function getGeneration(userId: number, id: number): unknown | undefined {
  const row = db.prepare("SELECT result FROM generations WHERE id = ? AND user_id = ?").get(id, userId) as
    | { result: string }
    | undefined;
  return row ? JSON.parse(row.result) : undefined;
}

export function deleteGeneration(userId: number, id: number): boolean {
  return db.prepare("DELETE FROM generations WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

// ---------- Vídeos renderizados (MP4 + PNGs) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    generation_id INTEGER PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,
    status        TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'done', 'error')),
    progress      TEXT NOT NULL DEFAULT '',
    error         TEXT,
    files         TEXT NOT NULL DEFAULT '[]',
    cost          INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export interface VideoRow {
  generation_id: number;
  status: "queued" | "processing" | "done" | "error";
  progress: string;
  error: string | null;
  files: string[];
  cost: number;
}

export function getVideo(generationId: number): VideoRow | undefined {
  const row = db.prepare("SELECT * FROM videos WHERE generation_id = ?").get(generationId) as
    | (Omit<VideoRow, "files"> & { files: string })
    | undefined;
  return row ? { ...row, files: JSON.parse(row.files) } : undefined;
}

export function upsertVideo(generationId: number, fields: Partial<Omit<VideoRow, "generation_id">>): void {
  const current = getVideo(generationId);
  const next = { status: "queued", progress: "", error: null, files: [], cost: 0, ...current, ...fields };
  db.prepare(
    `INSERT INTO videos (generation_id, status, progress, error, files, cost, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(generation_id) DO UPDATE SET status = excluded.status, progress = excluded.progress,
       error = excluded.error, files = excluded.files, cost = excluded.cost, updated_at = excluded.updated_at`,
  ).run(generationId, next.status, next.progress, next.error, JSON.stringify(next.files), next.cost);
}

/** Vídeos que estavam em andamento quando o servidor reiniciou. */
export function unfinishedVideos(): { generation_id: number; user_id: number; cost: number }[] {
  return db
    .prepare(
      `SELECT v.generation_id, g.user_id, v.cost FROM videos v JOIN generations g ON g.id = v.generation_id
       WHERE v.status IN ('queued', 'processing')`,
    )
    .all() as { generation_id: number; user_id: number; cost: number }[];
}

export function getGenerationRow(userId: number, id: number) {
  return db.prepare("SELECT id, kind, title, result FROM generations WHERE id = ? AND user_id = ?").get(id, userId) as
    | { id: number; kind: "viral" | "ugc"; title: string; result: string }
    | undefined;
}
