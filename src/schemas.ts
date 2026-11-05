import { z } from "zod";

/** Uma cena do vídeo: o que é dito, o que aparece e o texto na tela. */
export const SceneSchema = z.object({
  start_seconds: z.number().describe("Segundo em que a cena começa"),
  end_seconds: z.number().describe("Segundo em que a cena termina"),
  narration: z.string().describe("Fala/locução exata desta cena"),
  on_screen_text: z.string().describe("Legenda curta e chamativa exibida na tela"),
  visual: z.string().describe("Descrição do que aparece na tela (enquadramento, ação, cenário)"),
  image_prompt: z
    .string()
    .describe("Prompt em inglês para gerar a imagem/clipe desta cena numa IA de imagem/vídeo"),
});

/** Resultado do modo "Shorts viral a partir do título". */
export const ViralVideoSchema = z.object({
  title: z.string(),
  hooks: z.array(z.string()).describe("3 a 5 ganchos alternativos para os 3 primeiros segundos"),
  chosen_hook: z.string(),
  scenes: z.array(SceneSchema),
  full_script: z.string().describe("Roteiro completo, pronto para gravar ou para locução em IA"),
  call_to_action: z.string(),
  caption: z.string().describe("Legenda do post"),
  hashtags: z.array(z.string()),
  thumbnail_idea: z.string(),
  music_mood: z.string().describe("Estilo de música/trilha recomendado"),
  why_it_can_go_viral: z.string().describe("Explicação curta dos gatilhos de retenção usados"),
});

/** Resultado do modo UGC: análise do produto + roteiro com influenciadora. */
export const UgcVideoSchema = z.object({
  product: z.object({
    name: z.string(),
    category: z.string(),
    key_features: z.array(z.string()),
    benefits: z.array(z.string()).describe("Benefícios na linguagem do cliente"),
    target_audience: z.string(),
    pain_points: z.array(z.string()).describe("Dores que o produto resolve"),
  }),
  influencer: z.object({
    persona: z.string().describe("Quem é a influenciadora (idade, estilo, nicho)"),
    look: z.string().describe("Aparência, roupa e cenário"),
    voice: z.string().describe("Tom de voz e jeito de falar"),
    avatar_prompt: z
      .string()
      .describe("Prompt em inglês para gerar a influenciadora numa IA de avatar/imagem"),
  }),
  hooks: z.array(z.string()),
  chosen_hook: z.string(),
  scenes: z.array(SceneSchema),
  full_script: z.string(),
  call_to_action: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
  ad_angles: z.array(z.string()).describe("Outros ângulos de anúncio para testar (A/B)"),
});

export type ViralVideo = z.infer<typeof ViralVideoSchema>;
export type UgcVideo = z.infer<typeof UgcVideoSchema>;
