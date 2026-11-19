// Notificações push (Web Push, RFC 8291 + VAPID RFC 8292) só com WebCrypto:
// funciona igual no Cloudflare e no Node, sem biblioteca e sem conta extra.
// O par de chaves VAPID é criado no primeiro uso e guardado no banco.

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const juntar = (...partes) => {
  const total = partes.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of partes) { out.set(p, i); i += p.length; }
  return out;
};

// Só serviços de push conhecidos (evita o servidor ser usado para chamar endereços quaisquer).
const SERVICOS_PUSH = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];
export function endpointValido(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && SERVICOS_PUSH.some((r) => r.test(u.hostname));
  } catch { return false; }
}

let vapidCache = null;
/** Chaves VAPID da barbearia (cria e guarda na primeira vez). */
export async function chavesVapid(db) {
  if (vapidCache) return vapidCache;
  let salvo = (await db.get("SELECT valor FROM config WHERE chave = 'vapid'"))?.valor;
  if (!salvo) {
    const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", par.privateKey);
    const pub = b64url(await crypto.subtle.exportKey("raw", par.publicKey));
    salvo = JSON.stringify({ jwk, pub });
    // se dois acessos criarem ao mesmo tempo, fica valendo o primeiro
    await db.run("INSERT INTO config (chave, valor) VALUES ('vapid', ?) ON CONFLICT(chave) DO NOTHING", [salvo]);
    salvo = (await db.get("SELECT valor FROM config WHERE chave = 'vapid'")).valor;
  }
  const { jwk, pub } = JSON.parse(salvo);
  const privada = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  vapidCache = { privada, pub };
  return vapidCache;
}

async function jwtVapid(vapid, endpoint, contato) {
  const cab = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const corpo = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contato })));
  const assinatura = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.privada, enc.encode(`${cab}.${corpo}`));
  return `${cab}.${corpo}.${b64url(assinatura)}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const chave = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, chave, bytes * 8));
}

/** Criptografa a mensagem para um aparelho (aes128gcm, RFC 8291). */
export async function criptografar(p256dh, auth, texto) {
  const uaPublica = deB64url(p256dh);
  const segredoAuth = deB64url(auth);
  const efemera = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublica = new Uint8Array(await crypto.subtle.exportKey("raw", efemera.publicKey));
  const chaveUa = await crypto.subtle.importKey("raw", uaPublica, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const segredoEcdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: chaveUa }, efemera.privateKey, 256));
  const ikm = await hkdf(segredoAuth, segredoEcdh, juntar(enc.encode("WebPush: info\0"), uaPublica, asPublica), 32);
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(sal, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(sal, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const chaveAes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, chaveAes, juntar(enc.encode(texto), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // tamanho do registro: 4096
  return juntar(sal, rs, new Uint8Array([asPublica.length]), asPublica, cifrado);
}

/** Envia uma notificação para cada aparelho inscrito. Remove aparelhos que não existem mais. */
export async function enviarPush(db, inscricoes, mensagem, contato) {
  if (!inscricoes.length) return;
  const vapid = await chavesVapid(db);
  const texto = JSON.stringify(mensagem);
  await Promise.all(inscricoes.map(async (s) => {
    try {
      const corpo = await criptografar(s.p256dh, s.auth, texto);
      const r = await fetch(s.endpoint, {
        method: "POST",
        headers: {
          Authorization: `vapid t=${await jwtVapid(vapid, s.endpoint, contato)}, k=${vapid.pub}`,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "86400",
          Urgency: "normal",
        },
        body: corpo,
      });
      if (r.status === 404 || r.status === 410) await db.run("DELETE FROM push_inscricoes WHERE endpoint = ?", [s.endpoint]);
      else if (!r.ok) console.error("push recusado", r.status, await r.text().catch(() => ""));
    } catch (e) {
      console.error("falha ao enviar push", e?.message || e);
    }
  }));
}
