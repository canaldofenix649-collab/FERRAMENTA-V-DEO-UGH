import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { AiError, generateUgcVideo, generateViralVideo, type UgcInput } from "./ai.js";
import {
  endSession,
  hashPassword,
  loadUser,
  rateLimiter,
  requireAdmin,
  requireUser,
  startSession,
  verifyPassword,
} from "./auth.js";
import * as db from "./db.js";
import os from "node:os";
import {
  cloneVoice,
  deleteClonedVoice,
  deleteMedia,
  mediaDir,
  MIN_VOICE_SECONDS,
  renderVideo,
  saveProductImage,
  videoFeatures,
  VoiceSampleError,
} from "./video.js";

// ---------- Configuração (pode ser alterada no .env) ----------
const config = {
  freeCredits: Number(process.env.FREE_CREDITS ?? 3),
  costViral: Number(process.env.COST_VIRAL ?? 1),
  costUgc: Number(process.env.COST_UGC ?? 2),
  costVideo: Number(process.env.COST_VIDEO ?? 3),
  costVoice: Number(process.env.COST_VOICE_CLONE ?? 0),
  maxParallelRenders: Number(process.env.MAX_PARALLEL_RENDERS ?? 2),
  adminEmail: (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase(),
};

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

if (process.env.TRUST_PROXY) app.set("trust proxy", 1); // necessário atrás de Render, Railway, Nginx etc.
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(loadUser);
app.use(express.static(path.join(here, "..", "public")));

const publicUser = (u: db.User) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  credits: u.credits,
  isAdmin: Boolean(u.is_admin),
});

// ---------- Autenticação ----------
const authLimiter = rateLimiter(10, 15 * 60 * 1000); // 10 tentativas por IP a cada 15 min

const RegisterBody = z.object({
  name: z.string().trim().min(2, "Informe seu nome.").max(80),
  email: z.string().trim().toLowerCase().email("E-mail inválido."),
  password: z.string().min(8, "A senha precisa ter pelo menos 8 caracteres.").max(200),
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    if (!authLimiter(`ip:${req.ip}`)) {
      res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
      return;
    }
    const body = RegisterBody.parse(req.body);
    if (db.findUserWithPasswordByEmail(body.email)) {
      res.status(409).json({ error: "Já existe uma conta com este e-mail." });
      return;
    }
    const isAdmin = config.adminEmail !== "" && body.email === config.adminEmail;
    const user = db.createUser(body.name, body.email, await hashPassword(body.password), config.freeCredits, isAdmin);
    startSession(res, user.id);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

const LoginBody = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string(),
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    if (!authLimiter(`ip:${req.ip}`)) {
      res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
      return;
    }
    const body = LoginBody.parse(req.body);
    const found = db.findUserWithPasswordByEmail(body.email);
    if (!found || !(await verifyPassword(body.password, found.password_hash))) {
      res.status(401).json({ error: "E-mail ou senha incorretos." });
      return;
    }
    if (config.adminEmail && found.email === config.adminEmail && !found.is_admin) db.setAdmin(found.id, true);
    startSession(res, found.id);
    res.json({ user: publicUser(db.findUserById(found.id)!) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/auth/logout", (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json({
    user: req.user ? publicUser(req.user) : null,
    costs: { viral: config.costViral, ugc: config.costUgc, video: config.costVideo },
    features: videoFeatures,
  });
});

// ---------- Geração (consome créditos) ----------
const generationLimiter = rateLimiter(10, 60 * 1000); // até 10 gerações por minuto por usuário
const inProgress = new Set<number>(); // uma geração por vez por usuário

async function runGeneration<T>(
  req: Request,
  res: Response,
  kind: "viral" | "ugc",
  generate: () => Promise<T>,
  titleOf: (result: T) => string,
  afterSave?: (id: number) => Promise<void>,
): Promise<void> {
  const user = req.user!;
  const cost = kind === "viral" ? config.costViral : config.costUgc;

  if (inProgress.has(user.id)) {
    res.status(429).json({ error: "Aguarde a geração atual terminar." });
    return;
  }
  if (!generationLimiter(`user:${user.id}`)) {
    res.status(429).json({ error: "Muitas gerações em pouco tempo. Aguarde um minuto." });
    return;
  }
  const reason = kind === "viral" ? "Shorts viral" : "Vídeo UGC";
  if (!db.spendCredits(user.id, cost, reason)) {
    res.status(402).json({ error: `Créditos insuficientes. Esta geração custa ${cost} crédito(s).` });
    return;
  }

  inProgress.add(user.id);
  try {
    const result = await generate();
    const id = db.saveGeneration(user.id, kind, titleOf(result), result);
    await afterSave?.(id).catch((e) => console.error("Falha ao salvar arquivos da geração", e));
    res.json({ id, kind, result, credits: db.findUserById(user.id)!.credits });
  } catch (err) {
    db.addCredits(user.id, cost, `Estorno: falha na geração (${reason})`);
    throw err;
  } finally {
    inProgress.delete(user.id);
  }
}

const ViralBody = z.object({
  title: z.string().trim().min(3, "Escreva um título com pelo menos 3 caracteres.").max(300),
  platform: z.string().max(60).default("TikTok / Reels / Shorts"),
  durationSeconds: z.coerce.number().int().min(10).max(180).default(30),
  tone: z.string().max(80).default("energético e curioso"),
  niche: z.string().max(120).optional(),
  language: z.string().max(40).default("Português do Brasil"),
});

app.post("/api/viral", requireUser, async (req, res, next) => {
  try {
    const body = ViralBody.parse(req.body);
    await runGeneration(req, res, "viral", () => generateViralVideo(body), (r) => r.title || body.title);
  } catch (err) {
    next(err);
  }
});

const UgcBody = z.object({
  productNotes: z.string().max(2000).optional(),
  influencerStyle: z.string().max(500).optional(),
  durationSeconds: z.coerce.number().int().min(10).max(120).default(30),
  language: z.string().max(40).default("Português do Brasil"),
});

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

app.post("/api/ugc", requireUser, upload.single("image"), async (req, res, next) => {
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
    await runGeneration(req, res, "ugc", () => generateUgcVideo(input), (r) => r.product.name, (id) =>
      saveProductImage(id, file.buffer),
    );
  } catch (err) {
    next(err);
  }
});

// ---------- Histórico ----------
app.get("/api/generations", requireUser, (req, res) => {
  res.json({ items: db.listGenerations(req.user!.id) });
});

app.get("/api/generations/:id", requireUser, (req, res) => {
  const id = Number(req.params.id);
  const result = db.getGeneration(req.user!.id, id);
  if (!result) {
    res.status(404).json({ error: "Não encontrado." });
    return;
  }
  res.json({ id, result, video: videoView(id) });
});

app.delete("/api/generations/:id", requireUser, (req, res) => {
  const id = Number(req.params.id);
  if (renderQueue.active.has(id)) {
    res.status(409).json({ error: "Aguarde o vídeo terminar de ser gerado." });
    return;
  }
  const ok = db.deleteGeneration(req.user!.id, id);
  if (ok) void deleteMedia(id);
  res.status(ok ? 200 : 404).json({ ok });
});

// ---------- Vídeo final (MP4 + PNGs) ----------
const renderQueue = {
  waiting: [] as { generationId: number; userId: number }[],
  active: new Set<number>(),
};

function pumpRenderQueue(): void {
  while (renderQueue.active.size < config.maxParallelRenders && renderQueue.waiting.length) {
    const job = renderQueue.waiting.shift()!;
    renderQueue.active.add(job.generationId);
    void processRender(job.generationId, job.userId).finally(() => {
      renderQueue.active.delete(job.generationId);
      pumpRenderQueue();
    });
  }
}

async function processRender(generationId: number, userId: number): Promise<void> {
  const row = db.getGenerationRow(userId, generationId);
  const cost = db.getVideo(generationId)?.cost ?? 0;
  if (!row) return;
  try {
    db.upsertVideo(generationId, { status: "processing", progress: "Começando..." });
    let voiceId: string | undefined;
    if (db.getVideoVoice(generationId) === "mine") {
      voiceId = db.getUserVoice(userId)?.voiceId;
      if (!voiceId) throw new Error("O usuário não tem mais voz clonada.");
    }
    const rendered = await renderVideo(
      generationId,
      row.kind,
      JSON.parse(row.result),
      (progress) => db.upsertVideo(generationId, { progress }),
      { voiceId },
    );
    db.upsertVideo(generationId, { status: "done", progress: "", files: rendered.files });
  } catch (err) {
    console.error(`Falha ao renderizar o vídeo ${generationId}`, err);
    db.upsertVideo(generationId, {
      status: "error",
      progress: "",
      error: "Não foi possível gerar o vídeo. Seus créditos foram devolvidos.",
    });
    if (cost > 0) db.addCredits(userId, cost, "Estorno: falha ao gerar vídeo MP4");
  }
}

const videoView = (generationId: number) => {
  const v = db.getVideo(generationId);
  if (!v) return null;
  return {
    status: v.status,
    progress: v.status === "queued" ? "Na fila..." : v.progress,
    error: v.error,
    files: v.files.map((name) => ({ name, url: `/api/generations/${generationId}/media/${name}` })),
  };
};

app.post("/api/generations/:id/video", requireUser, (req, res) => {
  const user = req.user!;
  const generationId = Number(req.params.id);
  if (!db.getGenerationRow(user.id, generationId)) {
    res.status(404).json({ error: "Não encontrado." });
    return;
  }
  const existing = db.getVideo(generationId);
  if (existing && (existing.status === "queued" || existing.status === "processing")) {
    res.json({ video: videoView(generationId), credits: user.credits });
    return;
  }
  if (!db.spendCredits(user.id, config.costVideo, "Vídeo MP4")) {
    res.status(402).json({ error: `Créditos insuficientes. O vídeo custa ${config.costVideo} crédito(s).` });
    return;
  }
  const voice = req.body?.voice === "mine" ? "mine" : "ai";
  if (voice === "mine" && !db.getUserVoice(user.id)) {
    db.addCredits(user.id, config.costVideo, "Estorno: voz clonada não encontrada");
    res.status(400).json({ error: "Você ainda não clonou sua voz." });
    return;
  }
  db.upsertVideo(generationId, { status: "queued", progress: "", error: null, files: [], cost: config.costVideo });
  db.setVideoVoice(generationId, voice);
  renderQueue.waiting.push({ generationId, userId: user.id });
  pumpRenderQueue();
  res.status(202).json({ video: videoView(generationId), credits: db.findUserById(user.id)!.credits });
});

app.get("/api/generations/:id/video", requireUser, (req, res) => {
  const generationId = Number(req.params.id);
  if (!db.getGenerationRow(req.user!.id, generationId)) {
    res.status(404).json({ error: "Não encontrado." });
    return;
  }
  res.json({ video: videoView(generationId) });
});

app.get("/api/generations/:id/media/:file", requireUser, (req, res) => {
  const generationId = Number(req.params.id);
  const file = String(req.params.file);
  const video = db.getGenerationRow(req.user!.id, generationId) && db.getVideo(generationId);
  if (!video || !video.files.includes(file)) {
    res.status(404).json({ error: "Arquivo não encontrado." });
    return;
  }
  if (req.query.download) res.attachment(`video-${generationId}-${file}`);
  res.sendFile(path.join(mediaDir(generationId), file));
});

// ---------- Minha voz (clonagem com consentimento) ----------
const CONSENT_TEXT =
  "Eu confirmo que esta é a minha própria voz e autorizo o Estúdio Viral IA a criar uma cópia digital dela " +
  "para narrar os vídeos que eu gerar nesta conta.";
const voiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 3 } });
const voiceLimiter = rateLimiter(5, 60 * 60 * 1000); // até 5 tentativas de clonagem por hora

app.get("/api/voice", requireUser, (req, res) => {
  const voice = db.getUserVoice(req.user!.id);
  res.json({
    available: videoFeatures.voiceClone,
    voice: voice ? { createdAt: voice.createdAt } : null,
    consentText: CONSENT_TEXT,
    minSeconds: MIN_VOICE_SECONDS,
    cost: config.costVoice,
  });
});

app.post("/api/voice", requireUser, voiceUpload.array("audio", 3), async (req, res) => {
  const user = req.user!;
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  try {
    if (!videoFeatures.voiceClone) {
      res.status(503).json({ error: "A clonagem de voz não está disponível no momento." });
      return;
    }
    if (req.body?.consent !== "true") {
      res.status(400).json({ error: "Você precisa confirmar que a voz é sua e autorizar a clonagem." });
      return;
    }
    if (!files.length || files.some((f) => !/^(audio\/|video\/|application\/octet-stream)/.test(f.mimetype))) {
      res.status(400).json({ error: "Envie uma gravação de áudio." });
      return;
    }
    if (!voiceLimiter(`user:${user.id}`)) {
      res.status(429).json({ error: "Muitas tentativas. Tente de novo mais tarde." });
      return;
    }
    if (config.costVoice > 0 && !db.spendCredits(user.id, config.costVoice, "Clonagem de voz")) {
      res.status(402).json({ error: `Créditos insuficientes. A clonagem custa ${config.costVoice} crédito(s).` });
      return;
    }

    try {
      const old = db.getUserVoice(user.id);
      const workDir = path.join(os.tmpdir(), `voz-${user.id}-${Date.now()}`);
      const { voiceId, seconds } = await cloneVoice(
        user.id,
        files.map((f) => ({ buffer: f.buffer, originalName: f.originalname })),
        workDir,
      );
      const consent = JSON.stringify({ text: CONSENT_TEXT, at: new Date().toISOString(), ip: req.ip, seconds });
      db.setUserVoice(user.id, voiceId, consent);
      if (old) deleteClonedVoice(old.voiceId).catch((e) => console.error("Falha ao apagar voz antiga", e));
      res.json({ voice: { createdAt: db.getUserVoice(user.id)!.createdAt }, credits: db.findUserById(user.id)!.credits });
    } catch (err) {
      if (config.costVoice > 0) db.addCredits(user.id, config.costVoice, "Estorno: falha na clonagem de voz");
      throw err;
    }
  } catch (err) {
    if (err instanceof VoiceSampleError) {
      res.status(400).json({ error: `${err.message}${config.costVoice > 0 ? " Seus créditos foram devolvidos." : ""}` });
      return;
    }
    console.error("Falha na clonagem de voz", err);
    res.status(502).json({
      error: `Não foi possível clonar a voz. Tente gravar em um lugar silencioso.${config.costVoice > 0 ? " Seus créditos foram devolvidos." : ""}`,
    });
  }
});

app.delete("/api/voice", requireUser, async (req, res) => {
  const voice = db.getUserVoice(req.user!.id);
  if (voice) {
    db.setUserVoice(req.user!.id, null, null);
    await deleteClonedVoice(voice.voiceId).catch((e) => console.error("Falha ao apagar voz", e));
  }
  res.json({ ok: true });
});

// ---------- Administração ----------
app.get("/api/admin/stats", requireUser, requireAdmin, (_req, res) => {
  res.json(db.stats());
});

app.get("/api/admin/users", requireUser, requireAdmin, (req, res) => {
  const search = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
  res.json({ users: db.listUsers(search) });
});

const CreditsBody = z.object({
  amount: z.coerce.number().int().min(-100000).max(100000).refine((n) => n !== 0, "Informe um valor diferente de zero."),
  reason: z.string().trim().max(200).optional(),
});

app.post("/api/admin/users/:id/credits", requireUser, requireAdmin, (req, res, next) => {
  try {
    const target = db.findUserById(Number(req.params.id));
    if (!target) {
      res.status(404).json({ error: "Usuário não encontrado." });
      return;
    }
    const body = CreditsBody.parse(req.body);
    db.addCredits(target.id, body.amount, body.reason || `Ajuste manual por ${req.user!.email}`);
    res.json({ user: db.findUserById(target.id) });
  } catch (err) {
    next(err);
  }
});

// ---------- Erros ----------
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: err.issues[0]?.message ?? "Dados inválidos." });
  } else if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Imagem maior que 5 MB." : `Erro no upload: ${err.message}` });
  } else if (err instanceof AiError) {
    res.status(err.status).json({ error: `${err.message} Seus créditos foram devolvidos.` });
  } else if (err instanceof Anthropic.AuthenticationError) {
    console.error("Chave da API da Anthropic inválida.");
    res.status(503).json({ error: "Serviço de IA indisponível no momento. Seus créditos foram devolvidos." });
  } else if (err instanceof Anthropic.RateLimitError) {
    res.status(503).json({ error: "A IA está sobrecarregada. Tente de novo em instantes. Seus créditos foram devolvidos." });
  } else if (err instanceof Anthropic.APIError) {
    console.error(err);
    res.status(502).json({ error: "Erro na IA. Tente novamente. Seus créditos foram devolvidos." });
  } else {
    console.error(err);
    res.status(500).json({ error: "Erro inesperado." });
  }
});

setInterval(db.deleteExpiredSessions, 60 * 60 * 1000).unref();

// Vídeos interrompidos por uma reinicialização do servidor voltam para a fila.
for (const job of db.unfinishedVideos()) {
  db.upsertVideo(job.generation_id, { status: "queued" });
  renderQueue.waiting.push({ generationId: job.generation_id, userId: job.user_id });
}
pumpRenderQueue();

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Ferramenta rodando em http://localhost:${port}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("Aviso: ANTHROPIC_API_KEY não definida. Copie .env.example para .env e coloque sua chave.");
  }
  if (!config.adminEmail) {
    console.warn("Aviso: ADMIN_EMAIL não definido. Defina no .env para acessar o painel de administração.");
  }
});
