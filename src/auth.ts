import crypto from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { createSession, deleteSession, findSessionUser, type User } from "./db.js";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const COOKIE = "sid";
const SESSION_DAYS = 30;
const isProduction = process.env.NODE_ENV === "production";

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

// ---------- Senhas ----------
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- Sessões (cookie httpOnly; só o hash do token fica no banco) ----------
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function startSession(res: Response, userId: number): void {
  const token = crypto.randomBytes(32).toString("base64url");
  const maxAgeMs = SESSION_DAYS * 24 * 60 * 60 * 1000;
  createSession(sha256(token), userId, Date.now() + maxAgeMs);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: maxAgeMs, path: "/" });
}

export function endSession(req: Request, res: Response): void {
  const token = readCookie(req, COOKIE);
  if (token) deleteSession(sha256(token));
  res.clearCookie(COOKIE, { path: "/" });
}

/** Carrega o usuário logado (se houver) em req.user. */
export function loadUser(req: Request, _res: Response, next: NextFunction): void {
  const token = readCookie(req, COOKIE);
  if (token) req.user = findSessionUser(sha256(token));
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Faça login para continuar." });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.is_admin) {
    res.status(403).json({ error: "Acesso restrito ao administrador." });
    return;
  }
  next();
}

// ---------- Limite de tentativas (em memória) ----------
/** Permite no máximo `max` eventos por chave dentro da janela `windowMs`. */
export function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const recent = times.filter((t) => t > cutoff);
      if (recent.length) hits.set(key, recent);
      else hits.delete(key);
    }
  }, windowMs).unref();

  return (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= max) return false;
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}
