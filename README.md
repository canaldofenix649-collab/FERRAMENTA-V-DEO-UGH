# Estúdio Viral IA

Ferramenta com IA para criar conteúdo para redes sociais:

1. **Shorts viral**: você digita só o título ou a ideia, e a IA entrega ganchos, o roteiro dividido em cenas (fala, texto na tela, visual e prompt de imagem), a legenda, as hashtags, a ideia de thumbnail e a trilha.
2. **Vídeo UGC de produto**: você sobe a foto do produto e a IA **lê a imagem**, identifica o produto, os benefícios, o público e as dores que ele resolve, cria uma **influenciadora fictícia** e escreve o roteiro dela divulgando o produto, com cenas, o prompt do avatar e ângulos de anúncio para testes A/B.

Os dois modos têm uma **prévia em formato 9:16** que toca as cenas com o texto na tela e a narração usando a voz do navegador.

## Como rodar

Você precisa do Node.js 20 ou mais recente e de uma chave da API da Anthropic (https://console.anthropic.com).

```bash
npm install
cp .env.example .env      # coloque sua ANTHROPIC_API_KEY
npm run dev               # abre em http://localhost:3000
```

## Estrutura

| Arquivo | O que faz |
|---|---|
| `src/server.ts` | Servidor Express com as rotas `POST /api/viral` (JSON) e `POST /api/ugc` (upload da imagem) |
| `src/ai.ts` | Prompts e chamadas ao Claude (visão para ler o produto e saída JSON estruturada) |
| `src/schemas.ts` | Formato dos resultados (cenas, ganchos, produto, influenciadora...) |
| `public/` | Interface web (abas, formulários, player de prévia) |

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
3. **Contas de usuário e créditos** (por exemplo Supabase com Stripe ou Mercado Pago) para transformar a ferramenta em um SaaS.
4. **Publicação direta** no TikTok, Instagram e YouTube e um calendário de postagens.

> Use sempre influenciadoras **fictícias** geradas por IA, ou pessoas reais que tenham autorizado o uso da imagem. Em anúncios, sinalize quando o conteúdo for gerado por IA, conforme as regras de cada plataforma.
