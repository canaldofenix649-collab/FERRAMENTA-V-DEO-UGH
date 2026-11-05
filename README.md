# Estúdio Viral IA

Ferramenta com IA para criar conteúdo para redes sociais:

1. **Shorts viral**: você digita só o título ou a ideia, e a IA entrega ganchos, o roteiro dividido em cenas (fala, texto na tela, visual e prompt de imagem), a legenda, as hashtags, a ideia de thumbnail e a trilha.
2. **Vídeo UGC de produto**: você sobe a foto do produto e a IA **lê a imagem**, identifica o produto, os benefícios, o público e as dores que ele resolve, cria uma **influenciadora fictícia** e escreve o roteiro dela divulgando o produto, com cenas, o prompt do avatar e ângulos de anúncio para testes A/B.

Os dois modos têm uma **prévia em formato 9:16** que toca as cenas com o texto na tela e a narração usando a voz do navegador.

Também tem **contas de usuário com créditos**, **histórico dos vídeos gerados** e um **painel de administração**, ou seja, já está pronta para receber clientes.

## Como rodar

Você precisa do **Node.js 22.13 ou mais recente** e de uma chave da API da Anthropic (https://console.anthropic.com).

```bash
npm install
cp .env.example .env      # coloque sua ANTHROPIC_API_KEY e seu ADMIN_EMAIL
npm run dev               # abre em http://localhost:3000
```

Depois, crie uma conta no site **com o mesmo e-mail do `ADMIN_EMAIL`**. Essa conta vira administradora e ganha o link **Admin** no topo da página.

## Como funciona a parte comercial

| Recurso | Como funciona |
|---|---|
| Cadastro e login | E-mail e senha (senhas criptografadas com scrypt, sessão em cookie seguro de 30 dias) |
| Créditos | Cada conta nova ganha `FREE_CREDITS` (padrão 3). Shorts viral custa `COST_VIRAL` (1) e UGC custa `COST_UGC` (2) |
| Estorno automático | Se a IA falhar, os créditos voltam para o usuário na hora |
| Histórico | Cada vídeo gerado fica salvo em "Meus vídeos" para abrir de novo ou excluir |
| Painel admin (`/admin.html`) | Lista de usuários, busca, quantos vídeos cada um gerou e botão para **adicionar ou remover créditos** (use número negativo para remover) |
| Proteções | Limite de tentativas de login, até 10 gerações por minuto por usuário, uma geração por vez e imagem de no máximo 5 MB |

Enquanto o pagamento automático não estiver integrado, a venda pode ser manual: o cliente paga (Pix, Hotmart, Kiwify...) e você adiciona os créditos pelo painel admin.

Todas essas regras são configuradas no `.env` (veja `.env.example`). Para reduzir o custo por geração, troque `CLAUDE_MODEL` para `claude-sonnet-5-5`.

## Colocar no ar

O banco de dados é um arquivo SQLite dentro de `DATA_DIR`. Em produção, essa pasta precisa ficar num **disco persistente**, senão os usuários são apagados a cada deploy.

**Com Docker** (Railway, Render, Fly.io, VPS):

```bash
docker build -t estudio-viral .
docker run -p 3000:3000 -v estudio-data:/data --env-file .env estudio-viral
```

**Sem Docker** (Render ou Railway): comando de build `npm install`, comando de start `npm start`, e as variáveis do `.env.example` cadastradas no painel do serviço, incluindo `NODE_ENV=production` e `TRUST_PROXY=1`. Monte um disco persistente e aponte `DATA_DIR` para ele.

## Estrutura

| Arquivo | O que faz |
|---|---|
| `src/server.ts` | Rotas da API: autenticação, geração com créditos, histórico e admin |
| `src/ai.ts` | Prompts e chamadas ao Claude (visão para ler o produto e saída JSON estruturada) |
| `src/schemas.ts` | Formato dos resultados (cenas, ganchos, produto, influenciadora...) |
| `src/db.ts` | Banco SQLite: usuários, sessões, créditos e histórico |
| `src/auth.ts` | Senhas, sessões e limites de tentativas |
| `public/` | Interface web (login, ferramenta, histórico, player de prévia e painel admin) |

## Próximos passos: gerar o vídeo final (MP4)

Hoje a ferramenta gera **todo o planejamento** do vídeo e uma prévia. Para exportar o MP4 pronto, cada parte do resultado já vem preparada para uma API de mídia:

| Etapa | Campo usado | Serviços possíveis |
|---|---|---|
| Voz da narração | `scenes[].narration` | ElevenLabs, OpenAI TTS, Google TTS |
| Influenciadora falando (UGC) | `influencer.avatar_prompt` + `full_script` | HeyGen, D-ID, Synthesia, Captions/Mirage, Arcads |
| Imagens e clipes das cenas | `scenes[].image_prompt` | Runway, Kling, Luma, Pika, Flux/SDXL, banco Pexels |
| Legendas animadas e montagem | `scenes[].on_screen_text` + tempos | FFmpeg (local), Creatomate, Shotstack, Remotion |

Ordem sugerida para evoluir:

1. **Narração com TTS** e montagem com **FFmpeg** (imagens das cenas, áudio e legendas queimadas) para gerar o MP4 de Shorts.
2. **Avatar UGC** com uma API de avatar falante recebendo o roteiro e a foto do produto.
3. **Pagamento automático** (Stripe, Mercado Pago, Hotmart ou Kiwify via webhook) creditando o usuário após a compra.
4. **Publicação direta** no TikTok, Instagram e YouTube e um calendário de postagens.

> Use sempre influenciadoras **fictícias** geradas por IA, ou pessoas reais que tenham autorizado o uso da imagem. Em anúncios, sinalize quando o conteúdo for gerado por IA, conforme as regras de cada plataforma.
