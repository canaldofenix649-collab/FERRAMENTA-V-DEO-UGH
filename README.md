# Estúdio Viral IA

Ferramenta com IA para criar conteúdo para redes sociais:

1. **Shorts viral**: você digita só o título ou a ideia, e a IA entrega ganchos, o roteiro dividido em cenas (fala, texto na tela, visual e prompt de imagem), a legenda, as hashtags, a ideia de thumbnail e a trilha.
2. **Vídeo UGC de produto**: você sobe a foto do produto e a IA **lê a imagem**, identifica o produto, os benefícios, o público e as dores que ele resolve, cria uma **influenciadora fictícia** e escreve o roteiro dela divulgando o produto, com cenas, o prompt do avatar e ângulos de anúncio para testes A/B.

Os dois modos têm uma **prévia em formato 9:16** e um botão **Gerar vídeo MP4**, que cria o vídeo final (1080x1920, pronto para postar) com imagens por IA, legendas e narração, além de um **PNG de cada cena**.

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
| Vídeo MP4 | Botão em cada vídeo gerado. Custa `COST_VIDEO` (3) créditos, roda em segundo plano e estorna se falhar |
| Minha voz | O usuário grava a própria voz pelo navegador (ou envia um áudio) e a ferramenta clona com a ElevenLabs. Depois ele escolhe "Minha voz clonada" ao gerar o MP4 |
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
| `src/voice.ts` | Serviços de voz (ai33 e ElevenLabs): narração, clonagem e exclusão de vozes |
| `src/video.ts` | Geração do MP4: imagens das cenas, legendas, narração e montagem com FFmpeg |
| `public/` | Interface web (login, ferramenta, histórico, player de prévia e painel admin) |

## Como o vídeo MP4 é feito

| Etapa | Serviço | Sem a chave |
|---|---|---|
| Imagem de cada cena | OpenAI (`OPENAI_API_KEY`). No UGC, a foto do produto é enviada como referência para a influenciadora aparecer segurando o produto real | Fundo colorido (Shorts) ou a foto do produto (UGC) |
| Narração | ai33.pro (`AI33_API_KEY`) ou ElevenLabs (`ELEVENLABS_API_KEY`), escolhido em `VOICE_PROVIDER`; uma voz para Shorts e outra para UGC | Vídeo sem narração |
| Legendas e montagem | FFmpeg e sharp, rodando no próprio servidor (grátis) | Sempre funciona |

Cada cena dura exatamente o tempo da narração, então as legendas ficam sincronizadas. A imagem recebe um zoom lento (efeito Ken Burns), como nos Shorts.

Custo aproximado por vídeo de 6 a 8 cenas: imagens de US$ 0,05 a 0,30 cada (depende de `OPENAI_IMAGE_QUALITY`) e narração de alguns centavos. Confira os preços atuais em cada serviço e ajuste `COST_VIDEO`.

## Clonagem de voz

1. Em **Minha voz**, o usuário lê um texto em voz alta por pelo menos 20 segundos (o ideal é 1 minuto). O texto começa com uma frase de autorização.
2. Ele marca a confirmação de que a voz é dele. O servidor converte o áudio, confere a duração e cria a voz na ElevenLabs.
3. Ao gerar o MP4, ele escolhe **Minha voz clonada** e o vídeo sai narrado com a voz dele.

Cuidados que já estão no código:

- cada conta tem **uma única voz**, que só ela pode usar; regravar apaga a anterior;
- o consentimento (texto, data, IP e duração) fica registrado no banco;
- o usuário pode **excluir a voz** a qualquer momento, e ela é apagada também na ElevenLabs;
- há limite de 5 tentativas de clonagem por hora.

A clonagem funciona com os dois serviços de voz (`VOICE_PROVIDER=ai33` ou `elevenlabs`). Cada voz fica salva junto com o nome do serviço onde foi criada. Se você trocar de serviço, as vozes antigas continuam funcionando enquanto a chave do serviço antigo estiver no `.env`; sem ela, o cliente só precisa gravar de novo.

Na ElevenLabs, a clonagem exige um plano pago, e cada plano tem um limite de vozes personalizadas. Confira o seu antes de liberar para muitos clientes. Para desativar, use `VOICE_CLONE_ENABLED=false`. Para cobrar, use `COST_VOICE_CLONE`.

Deixe claro nos seus termos de uso que é proibido clonar a voz de outra pessoa sem autorização.

## Chaves de API: onde ficam

As chaves **nunca vão para o código nem para o GitHub**. Elas ficam só:

- no arquivo `.env`, quando você roda no seu computador (ele está no `.gitignore`);
- nas **variáveis de ambiente** do serviço de hospedagem (Railway, Render etc.), quando o site está no ar.

Os clientes nunca veem as chaves: o navegador conversa com o seu servidor, e só o servidor conversa com as IAs. Configure um limite de gastos mensal no painel de cada serviço (Anthropic, OpenAI e ElevenLabs) para se proteger.

## Próximos passos

1. **Avatar falante no UGC** (HeyGen, D-ID ou Arcads), com a influenciadora mexendo a boca no ritmo da narração.
2. **Pagamento automático** (Stripe, Mercado Pago, Hotmart ou Kiwify via webhook) creditando o usuário após a compra.
3. **Música de fundo** e mais estilos de legenda.
4. **Publicação direta** no TikTok, Instagram e YouTube e um calendário de postagens.

> Use sempre influenciadoras **fictícias** geradas por IA, ou pessoas reais que tenham autorizado o uso da imagem. Em anúncios, sinalize quando o conteúdo for gerado por IA, conforme as regras de cada plataforma.
