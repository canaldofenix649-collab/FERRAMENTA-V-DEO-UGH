import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { UgcVideoSchema, ViralVideoSchema, type UgcVideo, type ViralVideo } from "./schemas.js";

const MODEL = "claude-opus-5-5";
const client = new Anthropic();

export class AiError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

/** Gera uma resposta JSON validada pelo schema Zod informado. */
async function generateJson<T>(
  schema: z.ZodType<T>,
  system: string,
  content: Anthropic.Beta.BetaContentBlockParam[],
): Promise<T> {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Se o modelo recusar por política, a API tenta automaticamente um modelo de fallback.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: jsonSchema },
    },
    system,
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new AiError("A IA recusou este pedido. Tente reformular o título ou o produto.", 422);
  }
  if (response.stop_reason === "max_tokens") {
    throw new AiError("A resposta ficou longa demais. Tente um vídeo mais curto.");
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AiError("A IA retornou um formato inválido. Tente novamente.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AiError("A IA retornou dados incompletos. Tente novamente.");
  }
  return parsed.data;
}

const VIRAL_SYSTEM = `Você é um estrategista de conteúdo e roteirista especialista em vídeos curtos virais
(YouTube Shorts, TikTok, Instagram Reels). Você domina retenção: gancho forte nos 3 primeiros segundos,
loops abertos, ritmo rápido com uma ideia por cena, quebra de padrão, payoff no final e CTA natural.
Escreva no idioma pedido pelo usuário, com linguagem falada, frases curtas e nada de enrolação.
As cenas devem cobrir o vídeo inteiro, sem buracos de tempo, respeitando a duração pedida.`;

export interface ViralInput {
  title: string;
  platform: string;
  durationSeconds: number;
  tone: string;
  niche?: string;
  language: string;
}

export function generateViralVideo(input: ViralInput): Promise<ViralVideo> {
  const prompt = `Crie um vídeo curto viral completo a partir deste título.

Título/ideia: ${input.title}
Plataforma: ${input.platform}
Duração alvo: ${input.durationSeconds} segundos
Tom: ${input.tone}
Nicho: ${input.niche || "deduza a partir do título"}
Idioma: ${input.language}

Entregue ganchos alternativos, o roteiro dividido em cenas com tempo, legenda na tela,
descrição visual e um prompt de imagem em inglês para cada cena, além de legenda do post,
hashtags, ideia de thumbnail e trilha.`;

  return generateJson(ViralVideoSchema, VIRAL_SYSTEM, [{ type: "text", text: prompt }]);
}

const UGC_SYSTEM = `Você é diretor criativo de anúncios UGC (user generated content) de alta conversão
para TikTok Ads, Reels e Shorts. Primeiro você analisa a imagem do produto com atenção: identifique o
que é, para que serve, materiais, diferenciais visíveis e público. Não invente especificações técnicas
que não estejam visíveis ou informadas; quando algo for incerto, fale de forma genérica.
Depois crie uma influenciadora fictícia (nunca uma pessoa real) que combine com o público e escreva um
roteiro autêntico, em primeira pessoa, como se ela estivesse gravando com o celular:
gancho forte, problema, demonstração do produto, benefício, prova/reação e CTA.
Escreva no idioma pedido pelo usuário.`;

export interface UgcInput {
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  productNotes?: string;
  influencerStyle?: string;
  durationSeconds: number;
  language: string;
}

export function generateUgcVideo(input: UgcInput): Promise<UgcVideo> {
  const prompt = `Analise o produto da imagem e crie um vídeo UGC com uma influenciadora divulgando.

Informações extras do vendedor: ${input.productNotes || "nenhuma"}
Estilo de influenciadora desejado: ${input.influencerStyle || "escolha o que mais converte para esse público"}
Duração alvo: ${input.durationSeconds} segundos
Idioma: ${input.language}`;

  return generateJson(UgcVideoSchema, UGC_SYSTEM, [
    { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.imageBase64 } },
    { type: "text", text: prompt },
  ]);
}
