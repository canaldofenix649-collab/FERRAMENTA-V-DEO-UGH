import fs from "node:fs/promises";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

/**
 * Provedores de voz (narração e clonagem). Escolha no .env com VOICE_PROVIDER:
 *  - "elevenlabs": API oficial da ElevenLabs (ELEVENLABS_API_KEY)
 *  - "ai33": API da ai33.pro / OpenSpeaker (AI33_API_KEY)
 * Sem VOICE_PROVIDER, usa o primeiro que tiver chave configurada (ai33 > elevenlabs).
 *
 * As vozes clonadas ficam salvas como "<provedor>:<id>", para saber de qual serviço elas são.
 */
export interface VoiceProvider {
  name: "elevenlabs" | "ai33";
  defaultVoices: { viral: string; ugc: string };
  /** Gera a fala em MP3 e salva em `file`. */
  narrate(text: string, voiceId: string, file: string): Promise<void>;
  /** Clona a voz a partir de amostras em MP3 e devolve o ID da voz pronta para usar em `narrate`. */
  clone(name: string, mp3Samples: Buffer[]): Promise<string>;
  deleteVoice(voiceId: string): Promise<void>;
}

// ---------- ElevenLabs ----------
function elevenLabsProvider(): VoiceProvider | null {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  const client = new ElevenLabsClient(process.env.ELEVENLABS_BASE_URL ? { baseUrl: process.env.ELEVENLABS_BASE_URL } : {});
  const model = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
  return {
    name: "elevenlabs",
    defaultVoices: {
      viral: process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb",
      ugc: process.env.ELEVENLABS_VOICE_ID_UGC || "21m00Tcm4TlvDq8ikWAM",
    },
    async narrate(text, voiceId, file) {
      const stream = await client.textToSpeech.convert(voiceId, { text, modelId: model, outputFormat: "mp3_44100_128" });
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      await fs.writeFile(file, Buffer.concat(chunks));
    },
    async clone(name, samples) {
      const created = await client.voices.ivc.create({
        name,
        description: "Voz clonada com consentimento do próprio usuário (Estúdio Viral IA).",
        files: samples.map((data, i) => ({ data, filename: `amostra-${i + 1}.mp3`, contentType: "audio/mpeg" })),
        removeBackgroundNoise: true,
      });
      return created.voiceId;
    },
    async deleteVoice(voiceId) {
      await client.voices.delete(voiceId);
    },
  };
}

// ---------- ai33.pro (OpenSpeaker) ----------
function ai33Provider(): VoiceProvider | null {
  const apiKey = process.env.AI33_API_KEY;
  if (!apiKey) return null;
  const base = (process.env.AI33_BASE_URL || "https://api.ai33.pro").replace(/\/$/, "");
  const speed = process.env.AI33_SPEED || "1";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Faz a requisição tratando limite de uso (429) e servidor ocupado (503). */
  async function call(path: string, init: RequestInit = {}): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(base + path, { ...init, headers: { "xi-api-key": apiKey!, ...(init.headers ?? {}) } });
      if ((res.status === 429 || res.status === 503) && attempt < 5) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
        await sleep(retryAfter * 1000 + Math.random() * 500);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        throw new Error(`ai33 ${path}: HTTP ${res.status} ${body?.message ?? body?.error ?? ""}`.trim());
      }
      return body;
    }
  }

  /** As gerações são assíncronas: cria a tarefa e consulta até terminar. */
  async function waitTask(taskId: string, timeoutMs = 5 * 60 * 1000): Promise<any> {
    const started = Date.now();
    let delay = 1500;
    while (Date.now() - started < timeoutMs) {
      await sleep(delay);
      const task = await call(`/v1/task/${encodeURIComponent(taskId)}`);
      if (task.status === "done") return task;
      if (task.status === "error" || task.status === "failed" || task.error_message) {
        throw new Error(`ai33: tarefa falhou (${task.error_message ?? task.status})`);
      }
      delay = Math.min(delay * 1.4, 6000);
    }
    throw new Error("ai33: a tarefa demorou demais.");
  }

  const rawCloneId = (voiceId: string) => voiceId.replace(/^clone_/, "");

  return {
    name: "ai33",
    defaultVoices: {
      viral: process.env.AI33_VOICE_ID || "elevenlabs_JBFqnCBsd6RMkjVDRZzb",
      ugc: process.env.AI33_VOICE_ID_UGC || "elevenlabs_21m00Tcm4TlvDq8ikWAM",
    },
    async narrate(text, voiceId, file) {
      const form = new FormData();
      form.append("text", text);
      form.append("voice_id", voiceId);
      form.append("speed", speed);
      form.append("with_transcript", "false");
      const { task_id } = await call("/v3/text-to-speech", { method: "POST", body: form });
      const task = await waitTask(task_id);
      const url = task.metadata?.audio_url;
      if (!url) throw new Error("ai33: a tarefa terminou sem áudio.");
      const audio = await fetch(url);
      if (!audio.ok) throw new Error(`ai33: falha ao baixar o áudio (HTTP ${audio.status}).`);
      await fs.writeFile(file, Buffer.from(await audio.arrayBuffer()));
    },
    async clone(name, samples) {
      // a ai33 aceita um único arquivo (até 10 MB): juntamos as amostras MP3
      const audio = Buffer.concat(samples);
      if (audio.length > 10 * 1024 * 1024) throw new Error("ai33: gravação maior que 10 MB.");
      const form = new FormData();
      form.append("voice_name", name);
      form.append("audio_file", new Blob([audio], { type: "audio/mpeg" }), "amostra.mp3");
      const body = await call("/v3/text-to-speech/voice-clone", { method: "POST", body: form });
      const id = body?.data?.voice_id;
      if (!id) throw new Error("ai33: a clonagem não retornou voice_id.");
      return `clone_${rawCloneId(String(id))}`;
    },
    async deleteVoice(voiceId) {
      await call(`/v3/text-to-speech/voice-clone/${encodeURIComponent(rawCloneId(voiceId))}`, { method: "DELETE" });
    },
  };
}

// ---------- Seleção ----------
const providers = { elevenlabs: elevenLabsProvider(), ai33: ai33Provider() };
const chosen = (process.env.VOICE_PROVIDER || "").trim().toLowerCase();
if (chosen && chosen !== "elevenlabs" && chosen !== "ai33") {
  console.warn(`Aviso: VOICE_PROVIDER="${chosen}" desconhecido. Use "ai33" ou "elevenlabs".`);
}
if (chosen === "ai33" || chosen === "elevenlabs") {
  if (!providers[chosen]) console.warn(`Aviso: VOICE_PROVIDER=${chosen}, mas a chave desse serviço não está no .env.`);
}

export const voiceProvider: VoiceProvider | null =
  chosen === "ai33" || chosen === "elevenlabs" ? providers[chosen] : (providers.ai33 ?? providers.elevenlabs);

/** Monta o ID salvo no banco ("ai33:clone_abc"). */
export const storedVoiceId = (provider: VoiceProvider, voiceId: string) => `${provider.name}:${voiceId}`;

/** Separa o provedor do ID salvo. IDs antigos sem prefixo são da ElevenLabs. */
export function parseStoredVoice(stored: string): { provider: VoiceProvider | null; voiceId: string; providerName: string } {
  const match = /^(elevenlabs|ai33):(.+)$/.exec(stored);
  const providerName = match ? match[1]! : "elevenlabs";
  const voiceId = match ? match[2]! : stored;
  return { provider: providers[providerName as keyof typeof providers], voiceId, providerName };
}

/** A voz salva pode ser usada com o provedor ativo agora? */
export const isUsableWithCurrentProvider = (stored: string) =>
  Boolean(voiceProvider) && parseStoredVoice(stored).providerName === voiceProvider!.name;
