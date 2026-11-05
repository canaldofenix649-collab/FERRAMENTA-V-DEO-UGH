import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { AiError, generateUgcVideo, generateViralVideo, type UgcInput } from "./ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "..", "public")));

const ViralBody = z.object({
  title: z.string().trim().min(3).max(300),
  platform: z.string().default("TikTok / Reels / Shorts"),
  durationSeconds: z.coerce.number().int().min(10).max(180).default(30),
  tone: z.string().default("energético e curioso"),
  niche: z.string().optional(),
  language: z.string().default("Português do Brasil"),
});

app.post("/api/viral", async (req, res, next) => {
  try {
    const body = ViralBody.parse(req.body);
    res.json(await generateViralVideo(body));
  } catch (err) {
    next(err);
  }
});

const UgcBody = z.object({
  productNotes: z.string().max(2000).optional(),
  influencerStyle: z.string().max(500).optional(),
  durationSeconds: z.coerce.number().int().min(10).max(120).default(30),
  language: z.string().default("Português do Brasil"),
});

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

app.post("/api/ugc", upload.single("image"), async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "Envie a foto do produto." });
      return;
    }
    const mediaType = IMAGE_TYPES.find((t) => t === file.mimetype);
    if (!mediaType) {
      res.status(400).json({ error: "Formato de imagem não suportado (use JPG, PNG, WEBP ou GIF)." });
      return;
    }
    const body = UgcBody.parse(req.body);
    const input: UgcInput = { ...body, imageBase64: file.buffer.toString("base64"), mediaType };
    res.json(await generateUgcVideo(input));
  } catch (err) {
    next(err);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "Dados inválidos.", details: err.issues });
  } else if (err instanceof multer.MulterError) {
    res.status(400).json({ error: `Erro no upload: ${err.message}` });
  } else if (err instanceof AiError) {
    res.status(err.status).json({ error: err.message });
  } else if (err instanceof Anthropic.AuthenticationError) {
    res.status(500).json({ error: "Chave da API inválida. Confira ANTHROPIC_API_KEY no .env." });
  } else if (err instanceof Anthropic.RateLimitError) {
    res.status(429).json({ error: "Muitas requisições. Aguarde alguns segundos e tente de novo." });
  } else if (err instanceof Anthropic.APIError) {
    console.error(err);
    res.status(502).json({ error: `Erro da IA (${err.status ?? "rede"}). Tente novamente.` });
  } else {
    console.error(err);
    res.status(500).json({ error: "Erro inesperado." });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Ferramenta rodando em http://localhost:${port}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("Aviso: ANTHROPIC_API_KEY não definida. Copie .env.example para .env e coloque sua chave.");
  }
});
