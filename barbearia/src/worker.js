// Entrada do app no Cloudflare. As telas (pasta public/) são servidas direto pelo Cloudflare;
// este código só responde /api/*.
// Backup automático: o banco D1 guarda sozinho o histórico de alterações dos últimos 7 dias
// (Time Travel). Além disso, o app lembra o dono de baixar uma cópia toda semana.
import { tratarApi, personalizarManifest } from "./api.js";
import { bancoD1 } from "./db-d1.js";

export default {
  async fetch(req, env, execucao) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      return tratarApi(req, {
        db: bancoD1(env.DB), ambiente: "cloudflare", ip: req.headers.get("cf-connecting-ip"),
        esperar: (p) => execucao.waitUntil(p), // notificações saem depois da resposta
      });
    }
    if (url.pathname === "/manifest.webmanifest") {
      const base = await env.ASSETS.fetch(req);
      return personalizarManifest(bancoD1(env.DB), await base.text());
    }
    return env.ASSETS.fetch(req);
  },
};
