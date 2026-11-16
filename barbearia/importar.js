// Importa pelo terminal (banco local): npm run importar -- caminho/do/arquivo.zip
import fs from "node:fs";
import path from "node:path";
import { lerZip, lerCsv } from "./public/zipcsv.js";
import { importarLote, ARQUIVOS_IMPORTACAO } from "./src/api.js";
import { bancoLocal } from "./src/db-node.js";
import { garantirSchema } from "./src/schema.js";

const alvo = process.argv[2];
if (!alvo) {
  console.log("Uso: npm run importar -- caminho/do/arquivo.zip");
  process.exit(1);
}
const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, "dados");
const db = bancoLocal(path.join(DATA_DIR, "barbearia.db"));
await garantirSchema(db);
const backup = path.join(DATA_DIR, "backups", `antes-importar-${Date.now()}.db`);
fs.mkdirSync(path.dirname(backup), { recursive: true });
db.sqlite.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);

let arquivos = {};
if (fs.statSync(alvo).isDirectory()) {
  for (const f of fs.readdirSync(alvo)) if (f.endsWith(".csv")) arquivos[f] = fs.readFileSync(path.join(alvo, f), "utf8");
} else arquivos = await lerZip(fs.readFileSync(alvo));

for (const nome of ARQUIVOS_IMPORTACAO) {
  if (!arquivos[nome]) continue;
  const linhas = lerCsv(arquivos[nome]);
  let total = 0;
  for (let i = 0; i < linhas.length; i += 400) total += (await importarLote(db, nome, linhas.slice(i, i + 400))).total;
  console.log(`  ${nome}: ${total}`);
}
console.log("Importação concluída. Backup de antes: " + backup);
