// Adaptador do banco D1 (Cloudflare). Mesma interface do adaptador local.
export function bancoD1(d1) {
  const prep = (sql, params = []) => (params.length ? d1.prepare(sql).bind(...params) : d1.prepare(sql));
  return {
    async all(sql, params) { return (await prep(sql, params).all()).results; },
    async get(sql, params) { return (await prep(sql, params).first()) ?? null; },
    async run(sql, params) { const r = await prep(sql, params).run(); return { changes: r.meta?.changes ?? 0 }; },
    /** Executa vários comandos de uma vez, tudo ou nada. */
    async batch(lista) { if (lista.length) await d1.batch(lista.map(([sql, params]) => prep(sql, params))); },
  };
}
