// Adaptador do banco local (arquivo SQLite no computador). Mesma interface do D1.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function bancoLocal(arquivo) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const limpar = (params = []) => params.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v));
  const semProto = (r) => (r ? { ...r } : r);
  return {
    sqlite: db,
    async all(sql, params) { return db.prepare(sql).all(...limpar(params)).map(semProto); },
    async get(sql, params) { return semProto(db.prepare(sql).get(...limpar(params))) ?? null; },
    async run(sql, params) { const r = db.prepare(sql).run(...limpar(params)); return { changes: Number(r.changes) }; },
    async batch(lista) {
      if (!lista.length) return;
      db.exec("BEGIN");
      try {
        for (const [sql, params] of lista) db.prepare(sql).run(...limpar(params));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
