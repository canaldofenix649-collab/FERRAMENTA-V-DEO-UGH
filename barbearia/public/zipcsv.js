// Leitura do .zip exportado do app antigo e dos CSVs. Funciona no navegador e no Node.

/** Lê um .zip (ArrayBuffer/Uint8Array) e devolve { "nome.csv": "texto" }. */
export async function lerZip(dados) {
  const buf = dados instanceof Uint8Array ? dados : new Uint8Array(dados);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("O arquivo não é um .zip válido.");
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder("utf-8");
  const arquivos = {};
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Zip corrompido.");
    const metodo = dv.getUint16(p + 10, true);
    const tamComp = dv.getUint32(p + 20, true);
    const lenNome = dv.getUint16(p + 28, true), lenExtra = dv.getUint16(p + 30, true), lenCom = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const nome = dec.decode(buf.subarray(p + 46, p + 46 + lenNome));
    p += 46 + lenNome + lenExtra + lenCom;
    if (nome.endsWith("/")) continue;
    const ini = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const bruto = buf.subarray(ini, ini + tamComp);
    const base = nome.split("/").pop();
    if (metodo === 0) arquivos[base] = dec.decode(bruto);
    else if (metodo === 8) arquivos[base] = dec.decode(await descomprimir(bruto));
  }
  return arquivos;
}
async function descomprimir(bruto) {
  const fluxo = new Blob([bruto]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(fluxo).arrayBuffer());
}

/** CSV (com aspas) -> lista de objetos usando a primeira linha como cabeçalho. */
export function lerCsv(texto) {
  texto = texto.replace(/^﻿/, "");
  const linhas = [];
  let campo = "", linha = [], aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false; }
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ",") { linha.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      linha.push(campo); campo = "";
      if (linha.length > 1 || linha[0] !== "") linhas.push(linha);
      linha = [];
    } else campo += c;
  }
  if (campo !== "" || linha.length) { linha.push(campo); linhas.push(linha); }
  const [cab, ...resto] = linhas;
  if (!cab) return [];
  return resto.map((l) => Object.fromEntries(cab.map((k, i) => [k.trim(), l[i] ?? ""])));
}
