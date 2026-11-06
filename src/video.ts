import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import type { UgcVideo, ViralVideo } from "./schemas.js";
import { parseStoredVoice, storedVoiceId, voiceProvider } from "./voice.js";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string | null) || "ffmpeg";

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

const dataDir = process.env.DATA_DIR || path.resolve("data");
export const mediaDir = (generationId: number) => path.join(dataDir, "media", String(generationId));
const uploadsDir = path.join(dataDir, "uploads");

// ---------- Provedores (opcionais: sem chave, a ferramenta usa alternativas gratuitas) ----------
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const IMAGE_QUALITY = (process.env.OPENAI_IMAGE_QUALITY || "medium") as "low" | "medium" | "high";

export const videoFeatures = {
  aiImages: Boolean(openai),
  narration: Boolean(voiceProvider),
  voiceClone: Boolean(voiceProvider) && process.env.VOICE_CLONE_ENABLED !== "false",
  voiceProvider: voiceProvider?.name ?? null,
};

// ---------- Clonagem de voz (provedor definido em src/voice.ts) ----------
export const MIN_VOICE_SECONDS = 20;

/**
 * Converte as gravações para MP3 limpo (o navegador grava em webm/ogg/mp4),
 * confere a duração total e cria a voz clonada. Retorna o ID da voz.
 */
export async function cloneVoice(
  userId: number,
  samples: { buffer: Buffer; originalName: string }[],
  workDir: string,
): Promise<{ voiceId: string; seconds: number }> {
  if (!voiceProvider) throw new Error("Clonagem de voz indisponível.");
  await fs.mkdir(workDir, { recursive: true });
  try {
    const files: Buffer[] = [];
    let seconds = 0;
    for (const [i, sample] of samples.entries()) {
      const input = path.join(workDir, `in-${i}${path.extname(sample.originalName) || ".audio"}`);
      const output = path.join(workDir, `out-${i}.mp3`);
      await fs.writeFile(input, sample.buffer);
      try {
        await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "44100", "-b:a", "128k", output]);
      } catch {
        throw new VoiceSampleError("Não foi possível ler o arquivo de áudio. Grave novamente ou envie MP3, WAV ou M4A.");
      }
      seconds += await mediaDuration(output);
      files.push(await fs.readFile(output));
    }
    if (seconds < MIN_VOICE_SECONDS) {
      throw new VoiceSampleError(`A gravação tem ${Math.round(seconds)}s. Grave pelo menos ${MIN_VOICE_SECONDS} segundos (o ideal é 1 minuto).`);
    }
    const voiceId = await voiceProvider.clone(`estudio-user-${userId}`, files);
    return { voiceId: storedVoiceId(voiceProvider, voiceId), seconds: Math.round(seconds) };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** Apaga a voz no serviço onde ela foi criada (recebe o ID salvo no banco). */
export async function deleteClonedVoice(stored: string): Promise<void> {
  const { provider, voiceId } = parseStoredVoice(stored);
  if (provider) await provider.deleteVoice(voiceId);
}

export class VoiceSampleError extends Error {}

// ---------- Imagem do produto (UGC) ----------
export async function saveProductImage(generationId: number, buffer: Buffer): Promise<void> {
  await fs.mkdir(uploadsDir, { recursive: true });
  // normaliza para PNG (e limita o tamanho) para facilitar o uso posterior
  await sharp(buffer).rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).png().toFile(path.join(uploadsDir, `${generationId}.png`));
}

async function loadProductImage(generationId: number): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(uploadsDir, `${generationId}.png`));
  } catch {
    return null;
  }
}

export async function deleteMedia(generationId: number): Promise<void> {
  await fs.rm(mediaDir(generationId), { recursive: true, force: true });
  await fs.rm(path.join(uploadsDir, `${generationId}.png`), { force: true });
}

// ---------- Fundos das cenas ----------
const GRADIENTS = [
  ["#3a1030", "#12122a"],
  ["#0f3443", "#123d2e"],
  ["#41295a", "#2f0743"],
  ["#16222a", "#3a6073"],
  ["#5a1a1a", "#1a1a40"],
];

function gradientBackground(index: number): Promise<Buffer> {
  const [a, b] = GRADIENTS[index % GRADIENTS.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Produto centralizado sobre uma versão desfocada dele mesmo. */
async function productBackground(product: Buffer): Promise<Buffer> {
  const blurred = await sharp(product).resize(WIDTH, HEIGHT, { fit: "cover" }).blur(40).modulate({ brightness: 0.6 }).toBuffer();
  const { data: front, info } = await sharp(product)
    .resize(Math.round(WIDTH * 0.85), Math.round(HEIGHT * 0.45), { fit: "inside" })
    .toBuffer({ resolveWithObject: true });
  const left = Math.round((WIDTH - info.width) / 2);
  const top = Math.round(HEIGHT * 0.12);
  return sharp(blurred).composite([{ input: front, left, top }]).png().toBuffer();
}

async function aiImage(prompt: string, references: Buffer[]): Promise<Buffer> {
  const fullPrompt = `${prompt}\n\nVertical 9:16 photo, realistic, smartphone camera look. Do not write any text, letters or captions in the image.`;
  const response = references.length
    ? await openai!.images.edit({
        model: IMAGE_MODEL,
        image: await Promise.all(references.map((buf, i) => toFile(buf, `ref-${i}.png`, { type: "image/png" }))),
        prompt: fullPrompt,
        size: "1024x1536",
        quality: IMAGE_QUALITY,
      })
    : await openai!.images.generate({ model: IMAGE_MODEL, prompt: fullPrompt, size: "1024x1536", quality: IMAGE_QUALITY });
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error("A IA de imagem não retornou imagem.");
  return Buffer.from(b64, "base64");
}

// ---------- Legenda sobre a imagem ----------
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((line + " " + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

function captionSvg(text: string): Buffer {
  const fontSize = 84;
  const lineHeight = fontSize * 1.18;
  const lines = wrap(text.toUpperCase(), 17);
  const top = HEIGHT * 0.62 - (lines.length * lineHeight) / 2;
  const font = `font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-weight="900" font-size="${fontSize}" text-anchor="middle"`;
  const rows = lines
    .map((l, i) => {
      const y = top + (i + 1) * lineHeight;
      return `<text x="${WIDTH / 2}" y="${y}" ${font} fill="none" stroke="#000" stroke-width="14" stroke-linejoin="round">${xml(l)}</text>
              <text x="${WIDTH / 2}" y="${y}" ${font} fill="#fff">${xml(l)}</text>`;
    })
    .join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.4" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#shade)"/>${rows}</svg>`);
}

async function composeFrame(background: Buffer, caption: string): Promise<Buffer> {
  const base = await sharp(background).resize(WIDTH, HEIGHT, { fit: "cover" }).toBuffer();
  return sharp(base).composite([{ input: captionSvg(caption) }]).png().toBuffer();
}

// ---------- Áudio ----------

async function mediaDuration(file: string): Promise<number> {
  // o ffmpeg imprime "Duration: 00:00:04.52" no stderr; o código de saída é 1 porque não há saída
  const { stderr } = await run(FFMPEG, ["-hide_banner", "-i", file]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) throw new Error("Não foi possível ler a duração do áudio.");
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ---------- Montagem ----------
async function renderSegment(png: string, audio: string | null, seconds: number, out: string): Promise<void> {
  const frames = Math.ceil(seconds * FPS);
  const zoom = `zoompan=z='min(zoom+0.0007,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS}`;
  await run(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-loop", "1", "-framerate", String(FPS), "-i", png,
    ...(audio ? ["-i", audio] : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]),
    "-vf", `scale=${WIDTH * 1.25}:${HEIGHT * 1.25},${zoom},format=yuv420p`,
    "-af", "apad",
    "-frames:v", String(frames), "-t", seconds.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    out,
  ]);
}

async function concat(segments: string[], out: string): Promise<void> {
  const list = path.join(path.dirname(out), "segments.txt");
  await fs.writeFile(list, segments.map((s) => `file '${path.basename(s)}'`).join("\n"));
  await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
}

export interface RenderedVideo {
  files: string[]; // nomes dos arquivos dentro de mediaDir
  durationSeconds: number;
}

/** Gera as imagens (PNG) de cada cena, a narração e o vídeo final (MP4). */
export async function renderVideo(
  generationId: number,
  kind: "viral" | "ugc",
  result: ViralVideo | UgcVideo,
  onProgress: (message: string) => void,
  options: { voiceId?: string } = {},
): Promise<RenderedVideo> {
  const dir = mediaDir(generationId);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const product = kind === "ugc" ? await loadProductImage(generationId) : null;
  const influencerPrompt = "influencer" in result ? result.influencer.avatar_prompt : "";
  // voz clonada do usuário (usa o serviço onde ela foi criada) ou a voz padrão do provedor ativo
  const cloned = options.voiceId ? parseStoredVoice(options.voiceId) : null;
  if (cloned && !cloned.provider) throw new Error(`Provedor da voz clonada (${cloned.providerName}) sem chave configurada.`);
  const tts = cloned?.provider ?? voiceProvider;
  const voice = cloned?.voiceId ?? (tts ? tts.defaultVoices[kind === "ugc" ? "ugc" : "viral"] : "");
  const scenes = result.scenes;
  const files: string[] = [];
  const segments: string[] = [];
  let firstAiFrame: Buffer | null = null;
  let total = 0;

  for (const [i, scene] of scenes.entries()) {
    const n = i + 1;
    onProgress(`Criando a cena ${n} de ${scenes.length}...`);

    // 1. Imagem de fundo
    let background: Buffer;
    if (openai) {
      const prompt = [scene.image_prompt, influencerPrompt && `Person: ${influencerPrompt}`, product && "The product in the first reference image must appear exactly as it is (same shape, colors and label)."]
        .filter(Boolean)
        .join("\n");
      const refs = [product, firstAiFrame].filter((b): b is Buffer => Boolean(b));
      background = await aiImage(prompt, refs);
      // a primeira imagem vira referência para manter a mesma pessoa nas próximas cenas
      if (kind === "ugc" && !firstAiFrame) firstAiFrame = await sharp(background).png().toBuffer();
    } else if (product) {
      background = await productBackground(product);
    } else {
      background = await gradientBackground(i);
    }

    // 2. Quadro final com legenda (PNG)
    const pngName = `cena-${n}.png`;
    await fs.writeFile(path.join(dir, pngName), await composeFrame(background, scene.on_screen_text));
    files.push(pngName);

    // 3. Narração da cena
    let audio: string | null = null;
    let seconds = Math.max(2, scene.end_seconds - scene.start_seconds);
    if (tts && scene.narration.trim()) {
      audio = path.join(dir, `audio-${n}.mp3`);
      await tts.narrate(scene.narration, voice, audio);
      seconds = (await mediaDuration(audio)) + 0.3;
    }

    // 4. Trecho de vídeo
    const segment = path.join(dir, `trecho-${n}.mp4`);
    await renderSegment(path.join(dir, pngName), audio, seconds, segment);
    segments.push(segment);
    total += seconds;
  }

  onProgress("Montando o vídeo final...");
  await concat(segments, path.join(dir, "video.mp4"));

  // limpa arquivos intermediários
  await Promise.all(
    (await fs.readdir(dir))
      .filter((f) => f.startsWith("trecho-") || f.startsWith("audio-") || f === "segments.txt")
      .map((f) => fs.rm(path.join(dir, f), { force: true })),
  );

  return { files: ["video.mp4", ...files], durationSeconds: Math.round(total) };
}
