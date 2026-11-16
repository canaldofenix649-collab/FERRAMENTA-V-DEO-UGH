// Importa a exportação do app antigo (o .zip com os CSVs) para o banco novo.
// Pode ser rodado de novo com uma exportação mais nova: os registros têm o mesmo
// id do app antigo, então nada é duplicado, só atualizado. O que foi lançado no
// app novo não é tocado. Antes de importar, um backup do banco é feito.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { db, transacao, fazerBackup } from "./db.js";

// ---------- leitura do .zip (sem dependências) ----------
export function lerZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("O arquivo enviado não é um .zip válido.");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const arquivos = {};
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Zip corrompido.");
    const metodo = buf.readUInt16LE(p + 10);
    const tamComp = buf.readUInt32LE(p + 20);
    const lenNome = buf.readUInt16LE(p + 28);
    const lenExtra = buf.readUInt16LE(p + 30);
    const lenCom = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nome = buf.subarray(p + 46, p + 46 + lenNome).toString("utf8");
    p += 46 + lenNome + lenExtra + lenCom;
    if (nome.endsWith("/")) continue;
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const dados = buf.subarray(ini, ini + tamComp);
    if (metodo === 0) arquivos[path.basename(nome)] = dados.toString("utf8");
    else if (metodo === 8) arquivos[path.basename(nome)] = zlib.inflateRawSync(dados).toString("utf8");
  }
  return arquivos;
}

// ---------- CSV ----------
export function lerCsv(texto) {
  texto = texto.replace(/^﻿/, "");
  const linhas = [];
  let campo = "", linha = [], aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
      } else campo += c;
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

// ---------- conversões ----------
const txt = (v) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const num = (v) => (txt(v) == null ? null : Number(String(v).replace(",", ".")));
const bool = (v) => (["t", "true", "1", "sim"].includes(String(v).trim().toLowerCase()) ? 1 : 0);
const chave = (nome) => (nome || "").trim().toLowerCase().replace(/\s+/g, " ");
const lista = (v) => JSON.stringify(String(v || "").replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean));

export function categoriaSaida(descricao) {
  const d = (descricao || "").toLowerCase();
  if (d.startsWith("taxa ")) return "taxa";
  if (d.startsWith("pagamento de comissão") || d.startsWith("pagamento de comissao") || d.startsWith("vale")) return "comissao_paga";
  return "outra";
}

/** Recebe { "arquivo.csv": "conteúdo" } e grava tudo. Devolve um relatório. */
export function importarArquivos(arquivos) {
  const tem = (n) => typeof arquivos[n] === "string";
  if (!tem("transacoes.csv") && !tem("clientes.csv")) {
    throw new Error("Não encontrei transacoes.csv nem clientes.csv. Envie o .zip exportado do app antigo.");
  }
  const csv = (n) => (tem(n) ? lerCsv(arquivos[n]) : []);
  const backup = fazerBackup("antes-importar");
  const rel = {};
  const conta = (t) => (rel[t] = (rel[t] || 0) + 1);

  transacao(() => {
    // Colaboradores
    for (const r of csv("colaboradores.csv")) {
      db.prepare(`INSERT INTO colaboradores (id,nome,telefone,email,pct_comissao,ativo,criado_em) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, telefone=excluded.telefone, email=excluded.email,
        pct_comissao=excluded.pct_comissao, ativo=excluded.ativo`)
        .run(r.id, r.nome.trim(), txt(r.telefone), txt(r.email), num(r.pct_comissao) ?? 50, bool(r.ativo), txt(r.criado_em));
      conta("colaboradores");
    }
    // Clientes
    for (const r of csv("clientes.csv")) {
      db.prepare(`INSERT INTO clientes (id,nome,telefone,email,observacoes,criado_em) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, telefone=excluded.telefone, email=excluded.email, observacoes=excluded.observacoes`)
        .run(r.id, r.nome.trim(), txt(r.telefone), txt(r.email), txt(r.observacoes), txt(r.criado_em));
      conta("clientes");
    }
    for (const r of csv("servicos.csv")) {
      db.prepare(`INSERT OR REPLACE INTO servicos (id,nome,descricao,preco,duracao_min,pct_comissao,ativo) VALUES (?,?,?,?,?,?,?)`)
        .run(r.id, r.nome.trim(), txt(r.descricao), num(r.preco) ?? 0, num(r.duracao_min) ?? 30, num(r.pct_comissao) ?? 50, bool(r.ativo));
      conta("servicos");
    }
    for (const r of csv("produtos.csv")) {
      db.prepare(`INSERT OR REPLACE INTO produtos (id,nome,descricao,preco,custo,estoque,estoque_minimo,categoria,ativo) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(r.id, r.nome.trim(), txt(r.descricao), num(r.preco) ?? 0, num(r.custo) ?? 0, num(r.estoque) ?? 0, num(r.estoque_minimo) ?? 0, txt(r.categoria), bool(r.ativo));
      conta("produtos");
    }

    // Os CSVs do app antigo citam cliente/colaborador/produto pelo nome: transformo em id.
    const mapa = (tabela) => new Map(db.prepare(`SELECT id, nome FROM ${tabela}`).all().map((x) => [chave(x.nome), x.id]));
    const clientes = mapa("clientes"), colabs = mapa("colaboradores"), produtos = mapa("produtos");
    const idCliente = (nome) => {
      if (!txt(nome)) return null;
      let id = clientes.get(chave(nome));
      if (!id) {
        id = crypto.randomUUID();
        db.prepare("INSERT INTO clientes (id,nome,criado_em) VALUES (?,?,date('now'))").run(id, nome.trim());
        clientes.set(chave(nome), id);
        conta("clientes criados a partir dos lançamentos");
      }
      return id;
    };
    const idColab = (nome) => {
      if (!txt(nome)) return null;
      let id = colabs.get(chave(nome));
      if (!id) {
        id = crypto.randomUUID();
        db.prepare("INSERT INTO colaboradores (id,nome,ativo) VALUES (?,?,0)").run(id, nome.trim());
        colabs.set(chave(nome), id);
        conta("colaboradores criados a partir dos lançamentos");
      }
      return id;
    };

    const insTr = db.prepare(`INSERT OR REPLACE INTO transacoes
      (id,data_hora,tipo,categoria,descricao,valor,comissao,forma_pagamento,taxa_pct,taxa_valor,cliente_id,colaborador_id,produto_id,origem)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'importado')`);
    for (const r of csv("transacoes.csv")) {
      insTr.run(r.id, r.data_hora, r.tipo, r.tipo === "expense" ? categoriaSaida(r.descricao) : null, txt(r.descricao),
        num(r.valor) ?? 0, num(r.comissao) ?? 0, txt(r.forma_pagamento), num(r.taxa_pct), num(r.taxa_valor) ?? 0,
        idCliente(r.cliente), idColab(r.colaborador), txt(r.produto) ? produtos.get(chave(r.produto)) ?? null : null);
      conta("lançamentos");
    }
    for (const r of csv("caixa.csv")) {
      db.prepare(`INSERT INTO caixa (id,dia,abertura,fechamento,aberto_em,fechado_em,observacoes) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(dia) DO UPDATE SET abertura=excluded.abertura, fechamento=excluded.fechamento,
        aberto_em=excluded.aberto_em, fechado_em=excluded.fechado_em, observacoes=excluded.observacoes`)
        .run(r.id, r.dia, num(r.abertura) ?? 0, num(r.fechamento), txt(r.aberto_em), txt(r.fechado_em), txt(r.observacoes));
      conta("dias de caixa");
    }
    for (const r of csv("fiados.csv")) {
      db.prepare(`INSERT OR REPLACE INTO fiados (id,data,cliente_id,colaborador_id,valor,status,descricao,forma_pagamento,pago_em) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(r.id, r.data, idCliente(r.cliente), idColab(r.colaborador), num(r.valor) ?? 0, r.status || "pending", txt(r.descricao), txt(r.forma_pagamento), txt(r.pago_em));
      conta("fiados");
    }
    for (const r of csv("contas-a-pagar.csv")) {
      db.prepare(`INSERT OR REPLACE INTO contas (id,descricao,valor,vencimento,pago_em,status,categoria,observacoes,recorrente) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(r.id, r.descricao.trim(), num(r.valor) ?? 0, txt(r.vencimento), txt(r.pago_em), r.status || "pending", txt(r.categoria), txt(r.observacoes), bool(r.recorrente));
      conta("contas a pagar");
    }
    for (const r of csv("planos-clientes.csv")) {
      db.prepare(`INSERT OR REPLACE INTO planos (id,cliente_id,plano,preco,servicos_inclusos,cortes_maximos,inicio,termino,status,observacoes) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(r.id, idCliente(r.cliente), txt(r.plano), num(r.preco), lista(r.servicos_inclusos), num(r.cortes_maximos), txt(r.inicio), txt(r.termino), r.status || "active", txt(r.observacoes));
      conta("planos de clientes");
    }
    for (const r of csv("metas.csv")) {
      db.prepare(`INSERT OR REPLACE INTO metas (id,titulo,tipo,meta,descricao,inicio,termino,status,alcancada_em,colaborador_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(r.id, txt(r.titulo), txt(r.tipo), num(r.meta), txt(r.descricao), txt(r.inicio), txt(r.termino), txt(r.status), txt(r.alcancada_em), idColab(r.colaborador));
      conta("metas");
    }
    for (const r of csv("agendamentos.csv")) {
      db.prepare(`INSERT OR REPLACE INTO agendamentos (id,agendado_para,cliente_id,colaborador_id,status,observacoes) VALUES (?,?,?,?,?,?)`)
        .run(r.id, txt(r.agendado_para), idCliente(r.cliente), idColab(r.colaborador), txt(r.status), txt(r.observacoes));
      conta("agendamentos");
    }
  });

  return { importado: rel, backup: path.basename(backup) };
}

export function importarZip(buf) {
  return importarArquivos(lerZip(buf));
}

// Uso pelo terminal: npm run importar -- caminho/do/arquivo.zip   (ou uma pasta com os CSVs)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const alvo = process.argv[2];
  if (!alvo) {
    console.log("Uso: npm run importar -- caminho/do/arquivo.zip");
    process.exit(1);
  }
  let arquivos;
  if (fs.statSync(alvo).isDirectory()) {
    arquivos = {};
    for (const f of fs.readdirSync(alvo)) if (f.endsWith(".csv")) arquivos[f] = fs.readFileSync(path.join(alvo, f), "utf8");
  } else arquivos = lerZip(fs.readFileSync(alvo));
  const r = importarArquivos(arquivos);
  console.log("Importação concluída. Backup anterior salvo em dados/backups/" + r.backup);
  for (const [k, v] of Object.entries(r.importado)) console.log(`  ${k}: ${v}`);
}
