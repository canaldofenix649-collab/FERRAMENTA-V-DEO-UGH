// Rodar no computador (sem internet): node server.js  ->  http://localhost:3100
// Usa a mesma API do Cloudflare, com o banco num arquivo local e backup diário em arquivo.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { tratarApi, hojeBrasilia, agoraBrasilia } from "./src/api.js";
import { bancoLocal } from "./src/db-node.js";
import { garantirSchema } from "./src/schema.js";

const PORT = Number(process.env.PORT || 3100);
const PUBLIC = path.join(import.meta.dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, "dados");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DB_FILE = path.join(DATA_DIR, "barbearia.db");
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const db = bancoLocal(DB_FILE);
await garantirSchema(db);

function fazerBackup(motivo) {
  const arq = path.join(BACKUP_DIR, `barbearia-${agoraBrasilia().replace(/[: ]/g, "-")}-${motivo}.db`);
  if (fs.existsSync(arq)) fs.rmSync(arq);
  db.sqlite.exec(`VACUUM INTO '${arq.replace(/'/g, "''")}'`);
  const todos = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort();
  for (const velho of todos.slice(0, Math.max(0, todos.length - 60))) fs.rmSync(path.join(BACKUP_DIR, velho));
}
let ultimoBackup = "";
function backupDiario() {
  if (ultimoBackup === hojeBrasilia()) return;
  try { fazerBackup("diario"); ultimoBackup = hojeBrasilia(); } catch (e) { console.error("Falha no backup:", e.message); }
}
backupDiario();
setInterval(backupDiario, 3 * 3600 * 1000).unref();

const extras = {
  async listarBackups() {
    return {
      pasta: BACKUP_DIR,
      lista: fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort().reverse()
        .map((f) => ({ arquivo: f, tamanho: fs.statSync(path.join(BACKUP_DIR, f)).size })),
    };
  },
  async baixarBackup(nome) {
    const arq = path.join(BACKUP_DIR, path.basename(nome));
    if (!arq.endsWith(".db") || !fs.existsSync(arq)) return null;
    return new Response(fs.readFileSync(arq), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${path.basename(arq)}"` } });
  },
};

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      const partes = [];
      for await (const p of req) partes.push(p);
      const corpo = Buffer.concat(partes);
      const pedido = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : corpo });
      const r = await tratarApi(pedido, { db, ambiente: "local", ip: req.socket.remoteAddress, extras });
      const cab = Object.fromEntries(r.headers);
      const cookies = r.headers.getSetCookie();
      if (cookies.length) cab["set-cookie"] = cookies;
      res.writeHead(r.status, cab);
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    let arq = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!arq.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(arq) || fs.statSync(arq).isDirectory()) arq = path.join(PUBLIC, "index.html");
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(arq)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(arq).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, () => {
  console.log(`\n  Gestão da barbearia rodando em http://localhost:${PORT}`);
  console.log(`  Banco de dados: ${DB_FILE}`);
  console.log(`  Backups automáticos: ${BACKUP_DIR}\n`);
});
