import 'dotenv/config';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import multer from 'multer';

const ROOT = process.cwd();
const PORT = 3000;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads', 'logos');
const STORAGE_DIR = path.join(ROOT, 'storage');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });

// ---------------- CONFIG & ENV ----------------

const APP_SECRET = process.env.APP_SECRET || 'dev_secret_change_me_in_production';
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'qrlw_session';
const SESSION_LIFETIME_HOURS = Math.max(1, Number(process.env.SESSION_LIFETIME_HOURS || 12));
const IMAGE_BANK_QUOTA_MB = Math.max(10, Number(process.env.IMAGE_BANK_QUOTA_MB || 200));
const SIGNALING_MODE = process.env.SIGNALING_MODE || 'poll';
const PROFANITY_LIST = (process.env.PROFANITY_LIST || '')
  .split(',')
  .map((w) => w.trim())
  .filter(Boolean);

const CONFIG = {
  maxUploadBytes: 2 * 1024 * 1024,
  maxImageDim: 4096,
  pollIdleMs: 2000,
  pollFastMs: 700,
  adminPollMs: 1500,
  thumbIntervalMs: 3000,
  wallOfflineThresholdSec: 10,
  participantStaleSec: 120,
  signalTtlSec: 60,
  statsTtlSec: 120,
};
const ASSET_VER = String(Date.now());

function isValidIceUrl(url: string): boolean {
  return /^(stuns?|turns?):[a-z0-9.\[\]-]+(:\d+)?(\?[^\s]*)?$/i.test(url.trim());
}

function readDotEnvFallback(): Record<string, string> {
  try {
    const envFile = path.join(ROOT, '.env');
    if (fs.existsSync(envFile)) {
      return dotenv.parse(fs.readFileSync(envFile, 'utf8'));
    }
  } catch {}
  return {};
}

type IceServerEntry = { urls: string | string[]; username?: string; credential?: string };

function isNonPlaceholderSecret(val: string | undefined): string {
  const s = String(val || '').trim();
  if (!s || /not yet|placeholder|replace_with|your_|change_me|^x{3,}$|^y{3,}$/i.test(s)) return '';
  return s;
}

type TurnOverride = {
  mode: 'cloudflare' | 'static';
  cf_key_id?: string;
  cf_api_token?: string;
  cf_ttl?: number;
  turn_url?: string;
  turn_user?: string;
  turn_pass?: string;
};

function readTurnOverride(): TurnOverride | null {
  try {
    if (!db) return null;
    const row = db.prepare("SELECT setting_value FROM system_settings WHERE setting_key = 'turn_config'").get() as { setting_value?: string } | undefined;
    if (!row?.setting_value) return null;
    const parsed = JSON.parse(row.setting_value) as TurnOverride;
    if (parsed && (parsed.mode === 'cloudflare' || parsed.mode === 'static')) {
      return parsed;
    }
  } catch {}
  return null;
}

function getEffectiveTurnConfig(): { urls: string[]; user: string; pass: string; source: 'db' | 'env' | 'none' } {
  const override = readTurnOverride();
  if (override) {
    if (override.mode !== 'static') return { urls: [], user: '', pass: '', source: 'none' };
    const urls = String(override.turn_url || '').split(',').map((s) => s.trim()).filter(isValidIceUrl);
    const user = isNonPlaceholderSecret(override.turn_user);
    const pass = isNonPlaceholderSecret(override.turn_pass);
    if (urls.length > 0 && user && pass) {
      return { urls, user, pass, source: 'db' };
    }
    return { urls: [], user: '', pass: '', source: 'none' };
  }
  const envTurnUrls = (process.env.TURN_URL || '').split(',').map((s) => s.trim()).filter(isValidIceUrl);
  if (envTurnUrls.length > 0) {
    const user = isNonPlaceholderSecret(process.env.TURN_USER);
    const pass = isNonPlaceholderSecret(process.env.TURN_PASS);
    if (user && pass) {
      return { urls: envTurnUrls, user, pass, source: 'env' };
    }
  }
  const fileEnv = readDotEnvFallback();
  const fileTurnUrls = (fileEnv.TURN_URL || '').split(',').map((s) => s.trim()).filter(isValidIceUrl);
  if (fileTurnUrls.length > 0) {
    const user = isNonPlaceholderSecret(fileEnv.TURN_USER);
    const pass = isNonPlaceholderSecret(fileEnv.TURN_PASS);
    if (user && pass) {
      return { urls: fileTurnUrls, user, pass, source: 'env' };
    }
  }
  return { urls: [], user: '', pass: '', source: 'none' };
}

function getCloudflareTurnConfig(): { keyId: string; apiToken: string; ttl: number; source: 'db' | 'env' } | null {
  const override = readTurnOverride();
  if (override) {
    if (override.mode !== 'cloudflare') return null;
    const keyId = isNonPlaceholderSecret(override.cf_key_id);
    const apiToken = isNonPlaceholderSecret(override.cf_api_token);
    if (!keyId || !apiToken) return null;
    const rawTtl = Number(override.cf_ttl || 86400);
    const ttl = Number.isFinite(rawTtl) ? Math.max(60, Math.min(86400, Math.floor(rawTtl))) : 86400;
    return { keyId, apiToken, ttl, source: 'db' };
  }
  const envKeyId = isNonPlaceholderSecret(process.env.CLOUDFLARE_TURN_KEY_ID);
  const envToken = isNonPlaceholderSecret(process.env.CLOUDFLARE_TURN_API_TOKEN);
  const fileEnv = (!envKeyId || !envToken) ? readDotEnvFallback() : {};
  const keyId = envKeyId || isNonPlaceholderSecret(fileEnv.CLOUDFLARE_TURN_KEY_ID);
  const apiToken = envToken || isNonPlaceholderSecret(fileEnv.CLOUDFLARE_TURN_API_TOKEN);
  if (!keyId || !apiToken) return null;
  const rawTtl = Number(process.env.CLOUDFLARE_TURN_TTL || fileEnv.CLOUDFLARE_TURN_TTL || 86400);
  const ttl = Number.isFinite(rawTtl) ? Math.max(60, Math.min(86400, Math.floor(rawTtl))) : 86400;
  return { keyId, apiToken, ttl, source: 'env' };
}

let cfIceCache: {
  cacheKey: string;
  servers: IceServerEntry[];
  expiresAt: number;
  failUntil: number;
  lastError: string;
  loggedFailKey: string;
  inFlight: Promise<IceServerEntry[]> | null;
} = {
  cacheKey: '',
  servers: [],
  expiresAt: 0,
  failUntil: 0,
  lastError: '',
  loggedFailKey: '',
  inFlight: null,
};

function clearCfIceCache() {
  cfIceCache = {
    cacheKey: '',
    servers: [],
    expiresAt: 0,
    failUntil: 0,
    lastError: '',
    loggedFailKey: '',
    inFlight: null,
  };
}

function cfCacheKeyFor(cf: { keyId: string; apiToken: string; ttl: number }): string {
  return crypto.createHash('sha256').update(`${cf.keyId}:${cf.apiToken}:${cf.ttl}`).digest('hex');
}

function sanitizeIceEntry(item: unknown): IceServerEntry | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const rawUrls = Array.isArray(obj.urls) ? obj.urls : [obj.urls];
  const urls = rawUrls.map((u) => String(u ?? '').trim()).filter(isValidIceUrl);
  if (urls.length === 0) return null;
  const entry: IceServerEntry = {
    urls: Array.isArray(obj.urls) ? urls : urls[0],
  };
  if (obj.username) entry.username = String(obj.username);
  if (obj.credential) entry.credential = String(obj.credential);
  return entry;
}

async function requestCloudflareIceServers(
  keyId: string,
  apiToken: string,
  ttl: number
): Promise<{ ok: boolean; status: number; servers: IceServerEntry[]; error: string }> {
  try {
    const resp = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return {
        ok: false,
        status: resp.status,
        servers: [],
        error: `HTTP ${resp.status}: ${body.replace(/\s+/g, ' ').trim().slice(0, 140)}`,
      };
    }
    const data = (await resp.json()) as { iceServers?: unknown };
    const rawList = Array.isArray(data?.iceServers)
      ? data.iceServers
      : (data?.iceServers ? [data.iceServers] : []);
    const parsed = rawList.map(sanitizeIceEntry).filter((x): x is IceServerEntry => Boolean(x));
    if (parsed.length === 0) {
      return { ok: false, status: resp.status, servers: [], error: 'Cloudflare returned no valid ICE servers' };
    }
    return { ok: true, status: resp.status, servers: parsed, error: '' };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      servers: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchCloudflareIceServers(): Promise<IceServerEntry[]> {
  const cf = getCloudflareTurnConfig();
  if (!cf) return [];
  const cacheKey = cfCacheKeyFor(cf);
  const now = Date.now();
  if (cfIceCache.cacheKey === cacheKey && cfIceCache.servers.length > 0 && now < cfIceCache.expiresAt) {
    return cfIceCache.servers;
  }
  if (cfIceCache.cacheKey === cacheKey && now < cfIceCache.failUntil) {
    return cfIceCache.servers;
  }
  if (cfIceCache.inFlight && cfIceCache.cacheKey === cacheKey) {
    return cfIceCache.inFlight;
  }

  if (cfIceCache.cacheKey !== cacheKey) {
    cfIceCache.servers = [];
    cfIceCache.expiresAt = 0;
    cfIceCache.failUntil = 0;
    cfIceCache.lastError = '';
  }
  cfIceCache.cacheKey = cacheKey;
  cfIceCache.inFlight = (async () => {
    try {
      const res = await requestCloudflareIceServers(cf.keyId, cf.apiToken, cf.ttl);
      if (res.ok) {
        cfIceCache.servers = res.servers;
        cfIceCache.expiresAt = Date.now() + Math.min(43200, Math.max(30, Math.floor(cf.ttl * 0.5))) * 1000;
        cfIceCache.failUntil = 0;
        cfIceCache.lastError = '';
        cfIceCache.loggedFailKey = '';
      } else {
        const isClientErr = res.status >= 400 && res.status < 500;
        cfIceCache.lastError = res.error;
        cfIceCache.failUntil = Date.now() + (isClientErr ? 300_000 : 30_000);
        if (cfIceCache.loggedFailKey !== cacheKey) {
          cfIceCache.loggedFailKey = cacheKey;
          console.info(`[CF TURN] Fallback to STUN (${cfIceCache.lastError})`);
        }
      }
      return cfIceCache.servers;
    } finally {
      cfIceCache.inFlight = null;
    }
  })();

  return cfIceCache.inFlight;
}

function getStaticIceServers(): IceServerEntry[] {
  const servers: IceServerEntry[] = [];
  const defaultStun = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
  const stunRaw = process.env.STUN_URLS || defaultStun.join(',');
  const stunUrls = stunRaw.split(',').map((s) => s.trim()).filter(isValidIceUrl);
  servers.push({ urls: stunUrls.length > 0 ? stunUrls : defaultStun });
  const turnCfg = getEffectiveTurnConfig();
  if (turnCfg.urls.length > 0) {
    const entry: IceServerEntry = {
      urls: turnCfg.urls.length === 1 ? turnCfg.urls[0] : turnCfg.urls,
    };
    if (turnCfg.user) entry.username = turnCfg.user;
    if (turnCfg.pass) entry.credential = turnCfg.pass;
    servers.push(entry);
  }
  return servers;
}

function getIceServers(): IceServerEntry[] {
  const cf = getCloudflareTurnConfig();
  if (cf && cfIceCache.servers.length > 0 && cfIceCache.cacheKey === cfCacheKeyFor(cf)) {
    return cfIceCache.servers;
  }
  return getStaticIceServers();
}

async function getIceServersAsync(): Promise<IceServerEntry[]> {
  const cfServers = await fetchCloudflareIceServers();
  if (cfServers.length > 0) {
    return cfServers;
  }
  return getStaticIceServers();
}

function turnConfigured(): boolean {
  if (getEffectiveTurnConfig().urls.length > 0) return true;
  const cf = getCloudflareTurnConfig();
  if (!cf) return false;
  if (cfIceCache.cacheKey === cfCacheKeyFor(cf) && cfIceCache.lastError && cfIceCache.servers.length === 0) {
    return false;
  }
  return true;
}

function getTurnError(): string {
  const cf = getCloudflareTurnConfig();
  if (cf && cfIceCache.cacheKey === cfCacheKeyFor(cf) && cfIceCache.lastError && cfIceCache.servers.length === 0) {
    return cfIceCache.lastError;
  }
  return '';
}

// ---------------- SQLITE SETUP ----------------

const dbRelPath = process.env.DB_SQLITE_PATH || 'storage/local.sqlite';
const dbPath = path.isAbsolute(dbRelPath) ? dbRelPath : path.join(ROOT, dbRelPath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

const schemaSql = fs.readFileSync(path.join(ROOT, 'schema.sqlite.sql'), 'utf8');
db.exec(schemaSql);
const evCols = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
if (!evCols.some((c) => c.name === 'join_logo_image_id')) {
  db.exec('ALTER TABLE events ADD COLUMN join_logo_image_id INTEGER DEFAULT NULL REFERENCES media_images(id) ON DELETE SET NULL');
}
if (!evCols.some((c) => c.name === 'wall_fit_mode')) {
  db.exec("ALTER TABLE events ADD COLUMN wall_fit_mode TEXT NOT NULL DEFAULT 'fit'");
}
if (!evCols.some((c) => c.name === 'wall_tile_bg')) {
  db.exec("ALTER TABLE events ADD COLUMN wall_tile_bg TEXT NOT NULL DEFAULT 'blur'");
}
if (!evCols.some((c) => c.name === 'wall_tile_bg_color')) {
  db.exec("ALTER TABLE events ADD COLUMN wall_tile_bg_color TEXT NOT NULL DEFAULT '#090d16'");
}
if (!evCols.some((c) => c.name === 'mirror_front_wall')) {
  db.exec('ALTER TABLE events ADD COLUMN mirror_front_wall INTEGER NOT NULL DEFAULT 0');
}
const partCols = db.prepare('PRAGMA table_info(participants)').all() as Array<{ name: string }>;
if (!partCols.some((c) => c.name === 'facing_mode')) {
  db.exec("ALTER TABLE participants ADD COLUMN facing_mode TEXT NOT NULL DEFAULT 'unknown'");
}
if (!partCols.some((c) => c.name === 'capture_settings')) {
  db.exec('ALTER TABLE participants ADD COLUMN capture_settings TEXT DEFAULT NULL');
}
const slotCols = db.prepare('PRAGMA table_info(wall_slots)').all() as Array<{ name: string }>;
if (!slotCols.some((c) => c.name === 'fit_mode')) {
  db.exec('ALTER TABLE wall_slots ADD COLUMN fit_mode TEXT DEFAULT NULL');
}

function utcNow(offsetSec = 0): string {
  const d = new Date(Date.now() + offsetSec * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function dbGet<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

function dbAll<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

function dbRun(sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]));
}

// Seed Super Admin & starter demo event on first run
(function bootstrapData() {
  const username = process.env.SEED_ADMIN_USER || 'superadmin';
  const displayName = process.env.SEED_ADMIN_NAME || 'Event Director';
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
  const pass = process.env.SEED_ADMIN_PASS || 'ChangeMeNow!2026';

  const adminCount = dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM admins')?.c || 0;
  if (adminCount === 0) {
    const hash = bcrypt.hashSync(pass, 10);
    dbRun(
      `INSERT INTO admins (username, display_name, email, password_hash, role, status, event_scope, must_change_password, created_at)
       VALUES (?, ?, ?, ?, 'super_admin', 'active', 'all', 0, ?)`,
      username,
      displayName,
      email,
      hash,
      utcNow()
    );
  } else if (adminCount === 1) {
    const first = dbGet<{ id: number; last_login: string | null }>(
      "SELECT id, last_login FROM admins WHERE role = 'super_admin' ORDER BY id ASC LIMIT 1"
    );
    if (first && first.last_login === null) {
      dbRun(
        'UPDATE admins SET username = ?, display_name = ?, email = ?, password_hash = ? WHERE id = ?',
        username,
        displayName,
        email,
        bcrypt.hashSync(pass, 10),
        first.id
      );
    }
  }

  const evCount = dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM events')?.c || 0;
  if (evCount === 0) {
    const admin = dbGet<{ id: number }>('SELECT id FROM admins ORDER BY id ASC LIMIT 1');
    const wallKey = crypto.randomBytes(16).toString('hex');
    dbRun(
      `INSERT INTO events (slug, title, wall_key, status, join_locked, max_participants, max_wall_feeds, layout, show_labels, audio_enabled, blackout, created_by, created_at)
       VALUES ('demo', 'Live Stage Demo', ?, 'active', 0, 100, 4, 'single', 1, 0, 0, ?, ?)`,
      wallKey,
      admin?.id || null,
      utcNow()
    );
  }
})();

// ---------------- HELPERS & VALIDATION ----------------

function esc(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeJsonScript(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function isHttps(req: Request): boolean {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (proto.split(',')[0].trim() === 'https') return true;
  const origin = String(req.headers.origin || '').toLowerCase();
  const referer = String(req.headers.referer || '').toLowerCase();
  if (origin.startsWith('https://') || referer.startsWith('https://')) return true;
  const host = String(req.get('host') || '').toLowerCase();
  if (host.endsWith('.run.app') || (process.env.APP_URL || '').startsWith('https://')) return true;
  return false;
}

function sessionCookieOptions(req: Request, maxAgeMs?: number) {
  const https = isHttps(req);
  const opts: {
    maxAge?: number;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'none' | 'lax';
    partitioned?: boolean;
  } = {
    path: '/',
    httpOnly: true,
    secure: https,
    sameSite: https ? 'none' : 'lax',
  };
  if (https) opts.partitioned = true;
  if (maxAgeMs !== undefined) opts.maxAge = maxAgeMs;
  return opts;
}

function isLocalHostname(hostOrUrl: string): boolean {
  const clean = hostOrUrl.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  return !clean || clean === 'localhost' || clean === '127.0.0.1' || clean === '0.0.0.0' || clean === '::1' || clean === '[::1]';
}

function originFromHeaderUrl(val: unknown): string | null {
  const raw = String(val || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if ((u.protocol === 'https:' || u.protocol === 'http:') && !isLocalHostname(u.hostname)) {
      return u.origin;
    }
  } catch {}
  return null;
}

function baseUrl(req: Request): string {
  const fwdHostRaw = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  if (fwdHostRaw && !isLocalHostname(fwdHostRaw)) {
    return `${isHttps(req) ? 'https' : 'http'}://${fwdHostRaw}`;
  }
  const host = String(req.get('host') || '').trim();
  if (host && !isLocalHostname(host)) {
    return `${isHttps(req) ? 'https' : 'http'}://${host}`;
  }
  const headerOrigin = originFromHeaderUrl(req.headers.origin) || originFromHeaderUrl(req.headers.referer);
  if (headerOrigin) return headerOrigin;

  const configured = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured && !configured.includes('example.com') && !isLocalHostname(configured)) {
    return configured;
  }
  if (host) {
    return `${isHttps(req) ? 'https' : 'http'}://${host}`;
  }
  return `http://localhost:${PORT}`;
}

function clientIp(req: Request): string {
  const fwd = String(req.headers['x-forwarded-for'] || '');
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || req.socket.remoteAddress || '0.0.0.0';
}

function ipHash(req: Request): string {
  return crypto.createHmac('sha256', APP_SECRET).update(clientIp(req)).digest('hex');
}

function cleanSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function cleanText(input: unknown, maxLen: number): string {
  return String(input ?? '')
    .trim()
    .replace(/[\x00-\x1F\x7F]/g, '')
    .slice(0, maxLen);
}

function hexColor(input: unknown, fallback = '#000000', allowTransparent = false): string {
  const v = String(input ?? '').trim().toLowerCase();
  if (allowTransparent && v === 'transparent') return 'transparent';
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  return fallback;
}

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function filterProfanity(name: string): string {
  let out = name;
  for (const word of PROFANITY_LIST) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '*'.repeat(Math.max(3, word.length)));
  }
  return out;
}

function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters long.';
  if (!/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return 'Password must include uppercase, lowercase, and at least one number.';
  }
  return null;
}

function checkRateLimit(bucket: string, maxHits: number, windowSec: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const row = dbGet<{ hits: number; window_start: number }>('SELECT hits, window_start FROM rate_limits WHERE bucket_key = ?', bucket);
  if (!row || now - row.window_start >= windowSec) {
    dbRun(
      `INSERT INTO rate_limits (bucket_key, hits, window_start) VALUES (?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET hits = 1, window_start = excluded.window_start`,
      bucket,
      now
    );
    return true;
  }
  const nextHits = row.hits + 1;
  dbRun('UPDATE rate_limits SET hits = ? WHERE bucket_key = ?', nextHits, bucket);
  return nextHits <= maxHits;
}

function logAudit(req: Request, eventId: number | null, adminId: number | null, adminName: string, action: string, details = '') {
  dbRun(
    'INSERT INTO audit_log (event_id, admin_id, admin_name, action, details, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    eventId,
    adminId,
    adminName,
    cleanText(action, 64),
    cleanText(details, 500),
    ipHash(req),
    utcNow()
  );
}

function addTimeline(eventId: number, kind: string, message: string) {
  dbRun(
    'INSERT INTO event_timeline (event_id, kind, message, created_at) VALUES (?, ?, ?, ?)',
    eventId,
    cleanText(kind, 32),
    cleanText(message, 255),
    utcNow()
  );
}

function maybeCleanup() {
  if (Math.random() > 0.08) return;
  const now = utcNow();
  const sigCutoff = utcNow(-CONFIG.signalTtlSec);
  const statCutoff = utcNow(-CONFIG.statsTtlSec);
  const partCutoff = utcNow(-CONFIG.participantStaleSec);
  const rateCutoff = Math.floor(Date.now() / 1000) - 3600;

  dbRun('DELETE FROM signals WHERE consumed = 1 OR created_at < ?', sigCutoff);
  dbRun('DELETE FROM stream_stats WHERE reported_at < ?', statCutoff);
  dbRun('DELETE FROM wall_heartbeats WHERE last_seen < ?', utcNow(-300));
  dbRun('DELETE FROM admin_sessions WHERE expires_at < ? OR (revoked = 1 AND last_seen < ?)', now, utcNow(-86400));
  dbRun('DELETE FROM rate_limits WHERE window_start < ?', rateCutoff);

  const stale = dbAll<{ id: number; event_id: number; display_name: string }>(
    "SELECT id, event_id, display_name FROM participants WHERE status IN ('waiting', 'onair') AND last_seen < ?",
    partCutoff
  );
  for (const p of stale) {
    dbRun('DELETE FROM wall_slots WHERE participant_id = ?', p.id);
    dbRun("UPDATE participants SET status = 'left', thumbnail_data = NULL, preview_admin_id = NULL WHERE id = ?", p.id);
    addTimeline(p.event_id, 'leave', `${p.display_name} timed out`);
  }
}

// ---------------- AUTH & RBAC ----------------

interface AdminSession {
  session_id: number;
  csrf_token: string;
  expires_at: string;
  current_event_id: number | null;
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: 'super_admin' | 'host' | 'moderator';
  status: string;
  event_scope: 'all' | 'assigned';
  must_change_password: number;
  last_login: string | null;
}

function getCurrentAdmin(req: Request): AdminSession | null {
  const rawToken = String(req.cookies?.[SESSION_COOKIE_NAME] || '');
  if (rawToken.length < 32) return null;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const row = dbGet<AdminSession>(
    `SELECT s.id AS session_id, s.csrf_token, s.expires_at, s.current_event_id,
            a.id, a.username, a.display_name, a.email, a.role, a.status,
            a.event_scope, a.must_change_password, a.last_login
     FROM admin_sessions s
     JOIN admins a ON a.id = s.admin_id
     WHERE s.session_token_hash = ? AND s.revoked = 0 AND s.expires_at > ?`,
    tokenHash,
    utcNow()
  );
  if (!row || row.status !== 'active') return null;
  return row;
}

function createAdminSession(req: Request, res: Response, adminId: number): string {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const csrf = crypto.randomBytes(32).toString('hex');
  const now = utcNow();
  const expires = utcNow(SESSION_LIFETIME_HOURS * 3600);
  const ua = String(req.headers['user-agent'] || '').slice(0, 250);

  dbRun(
    `INSERT INTO admin_sessions (admin_id, session_token_hash, csrf_token, last_seen, ip_hash, user_agent, revoked, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    adminId,
    tokenHash,
    csrf,
    now,
    ipHash(req),
    ua,
    now,
    expires
  );
  dbRun('UPDATE admins SET last_login = ? WHERE id = ?', now, adminId);

  res.cookie(SESSION_COOKIE_NAME, rawToken, sessionCookieOptions(req, SESSION_LIFETIME_HOURS * 3600 * 1000));
  return csrf;
}

function touchAdminPresence(sessionId: number, eventId?: number) {
  if (eventId !== undefined) {
    dbRun('UPDATE admin_sessions SET last_seen = ?, current_event_id = ? WHERE id = ?', utcNow(), eventId, sessionId);
  } else {
    dbRun('UPDATE admin_sessions SET last_seen = ? WHERE id = ?', utcNow(), sessionId);
  }
}

function canAccessEvent(user: AdminSession, eventId: number): boolean {
  if (user.role === 'super_admin' || user.event_scope === 'all') return true;
  const row = dbGet('SELECT 1 FROM admin_event_access WHERE admin_id = ? AND event_id = ?', user.id, eventId);
  return Boolean(row);
}

function requirePageAuth(req: Request, res: Response, allowForceChangePage = false): AdminSession | null {
  const user = getCurrentAdmin(req);
  if (!user) {
    res.redirect('/admin/login');
    return null;
  }
  if (user.must_change_password === 1 && !allowForceChangePage) {
    res.redirect('/admin/change-password');
    return null;
  }
  return user;
}

function requireApiAuth(
  req: Request,
  res: Response,
  allowedRoles: Array<'super_admin' | 'host' | 'moderator'> = ['super_admin', 'host', 'moderator'],
  verifyCsrf = false
): AdminSession | null {
  const user = getCurrentAdmin(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required.' });
    return null;
  }
  if (user.must_change_password === 1) {
    res.status(403).json({ error: 'Password change required before continuing.' });
    return null;
  }
  if (!allowedRoles.includes(user.role)) {
    res.status(403).json({ error: 'Insufficient permissions for this action.' });
    return null;
  }
  if (verifyCsrf) {
    const provided = String(req.headers['x-csrf-token'] || req.body?.csrf_token || '');
    const a = Buffer.from(user.csrf_token);
    const b = Buffer.from(provided);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(403).json({ error: 'Invalid CSRF token. Please refresh the page.' });
      return null;
    }
  }
  return user;
}

// ---------------- IMAGE BANK HELPERS ----------------

function quotaBytes(): number {
  return IMAGE_BANK_QUOTA_MB * 1024 * 1024;
}

function usedBytes(): number {
  const row = dbGet<{ total: number }>('SELECT COALESCE(SUM(size), 0) AS total FROM media_images');
  return row?.total || 0;
}

function syncUseCounts() {
  dbRun('UPDATE media_images SET use_count = (SELECT COUNT(*) FROM events WHERE events.logo_image_id = media_images.id OR events.join_logo_image_id = media_images.id)');
}

function detectImageTypeAndDims(buf: Buffer): { mime: string; ext: string; width: number; height: number; isSvg: boolean } | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width/height at bytes 16..23
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { mime: 'image/png', ext: 'png', width, height, isSvg: false };
  }
  // JPEG: FF D8 FF
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 8 < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return { mime: 'image/jpeg', ext: 'jpg', width, height, isSvg: false };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return { mime: 'image/jpeg', ext: 'jpg', width: 512, height: 512, isSvg: false };
  }
  // WebP: RIFF....WEBP
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp', width: 512, height: 512, isSvg: false };
  }
  // SVG
  const text = buf.toString('utf8');
  if (/<svg[\s>]/i.test(text)) {
    return { mime: 'image/svg+xml', ext: 'svg', width: 512, height: 512, isSvg: true };
  }
  return null;
}

function sanitizeSvg(raw: string): string | null {
  let clean = raw
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!ENTITY[^>]*>/gi, '');
  if (!/<svg[\s>]/i.test(clean)) return null;
  clean = clean
    .replace(/<\s*(script|foreignObject|iframe|object|embed|applet|meta|link|base|audio|video)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|foreignObject|iframe|object|embed|applet|meta|link|base|audio|video)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href|src)\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*')/gi, '')
    .replace(/javascript\s*:/gi, '');
  return clean;
}

// ---------------- EXPRESS APP ----------------

const app = express();
app.set('trust proxy', true);
app.use(cookieParser());
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "frame-src 'self'",
      "frame-ancestors 'self' https://aistudio.google.com https://*.google.com",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ')
  );
  next();
});

app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(
  '/assets',
  express.static(path.join(PUBLIC_DIR, 'assets'), {
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    },
  })
);
app.use('/uploads', express.static(path.join(PUBLIC_DIR, 'uploads')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.maxUploadBytes, files: 20 },
});

// ---------------- HTML PAGES ----------------

app.get('/', (req, res) => {
  const demo = dbGet<{ slug: string; wall_key: string; title: string }>(
    "SELECT slug, wall_key, title FROM events WHERE status = 'active' ORDER BY id ASC LIMIT 1"
  );
  const demoSlug = demo?.slug || 'demo';
  const demoWall = demo ? `/wall/${encodeURIComponent(demo.slug)}?key=${encodeURIComponent(demo.wall_key)}` : '/admin';
  const seedUser = process.env.SEED_ADMIN_USER || 'superadmin';

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QR Live Wall — Live Preview</title>
  <link rel="stylesheet" href="/assets/css/common.css">
  <link rel="stylesheet" href="/assets/css/admin.css">
</head>
<body class="adm-auth-body">
  <main class="panel" style="max-width:760px;width:100%;padding:28px;display:flex;flex-direction:column;gap:18px;">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
      <div>
        <div class="adm-auth-brand">QR LIVE WALL</div>
        <h1 style="margin:4px 0 0;font-size:28px;">Live Studio &amp; Preview Launchpad</h1>
      </div>
      <a href="/admin" class="btn btn-primary">Open Admin Console</a>
    </div>
    <p style="margin:0;color:var(--text-secondary);">
      Running live in AI Studio with Express + SQLite. All Audience, OBS Wall, Admin Control, Monitor, Image Bank, and WebRTC signaling endpoints are active.
    </p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;">
      <a href="/admin" class="event-card" style="text-decoration:none;color:inherit;">
        <h2 class="event-card-title">1. Admin &amp; Monitor</h2>
        <p class="page-meta" style="margin:0;">Manage events, QR branding, Image Bank, accounts, and live monitor.</p>
        <span class="btn btn-primary btn-sm" style="margin-top:auto;">Go to /admin</span>
      </a>
      <a href="/join/${esc(demoSlug)}" target="_blank" class="event-card" style="text-decoration:none;color:inherit;">
        <h2 class="event-card-title">2. Audience Join</h2>
        <p class="page-meta" style="margin:0;">Open on a phone (or new tab) to test camera join, lobby thumbnails, and WebRTC.</p>
        <span class="btn btn-secondary btn-sm" style="margin-top:auto;">Open /join/${esc(demoSlug)}</span>
      </a>
      <a href="${esc(demoWall)}" target="_blank" class="event-card" style="text-decoration:none;color:inherit;">
        <h2 class="event-card-title">3. OBS Wall Output</h2>
        <p class="page-meta" style="margin:0;">1920x1080 Browser Source showing branded QR and live WebRTC feeds.</p>
        <span class="btn btn-secondary btn-sm" style="margin-top:auto;">Open Wall View</span>
      </a>
    </div>
    <div class="adm-alert" style="font-size:13px;">
      Seeded Super Admin username: <code class="tabular">${esc(seedUser)}</code> (sign in with your configured <code class="tabular">SEED_ADMIN_PASS</code>).
    </div>
  </main>
</body>
</html>`);
});

app.get('/join/:slug', async (req, res) => {
  const slug = cleanSlug(req.params.slug);
  const event = dbGet<{
    id: number;
    slug: string;
    title: string;
    status: string;
    join_locked: number;
    logo_filename: string | null;
    join_logo_filename: string | null;
  }>(
    `SELECT e.id, e.slug, e.title, e.status, e.join_locked, m.filename AS logo_filename, jm.filename AS join_logo_filename
     FROM events e
     LEFT JOIN media_images m ON m.id = e.logo_image_id
     LEFT JOIN media_images jm ON jm.id = e.join_logo_image_id
     WHERE e.slug = ?`,
    slug
  );
  if (!event) {
    res.status(404).type('html').send('<h1>Event not found</h1>');
    return;
  }
  const brandFile = event.join_logo_filename || event.logo_filename;
  const brandLogoUrl = brandFile ? `/uploads/logos/${encodeURIComponent(String(brandFile))}` : null;
  const config = {
    eventSlug: event.slug,
    eventTitle: event.title,
    eventStatus: event.status,
    joinLocked: event.join_locked === 1,
    brandLogoUrl,
    signalingMode: SIGNALING_MODE,
    iceServers: await getIceServersAsync(),
    pollIdleMs: CONFIG.pollIdleMs,
    pollFastMs: CONFIG.pollFastMs,
    thumbIntervalMs: CONFIG.thumbIntervalMs,
  };
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <title>${esc(config.eventTitle)} — Join Live Wall</title>
  <link rel="stylesheet" href="/assets/css/common.css?v=${ASSET_VER}">
  <link rel="stylesheet" href="/assets/css/audience.css?v=${ASSET_VER}">
</head>
<body class="aud-body">
  <script id="app-config" type="application/json">${safeJsonScript(config)}</script>
  <main class="aud-shell">
    <header class="aud-header">
      <div class="aud-event-title" id="aud-event-title">${esc(config.eventTitle)}</div>
      <div class="aud-status-bar status-waiting" id="aud-status-banner" hidden>
        <span class="status-dot" id="aud-status-dot"></span>
        <span id="aud-status-text">Waiting in lobby</span>
      </div>
    </header>
    <section class="aud-inapp-warning" id="aud-inapp-warning" hidden>
      <p><strong>In-app browser detected.</strong> Camera access often fails inside social apps. Open this page in <strong>Safari</strong> or <strong>Chrome</strong>.</p>
      <button type="button" class="btn btn-secondary" id="aud-copy-link">Copy Page Link</button>
    </section>
    <section class="aud-card" id="aud-step-join">
      <div class="aud-brand-wrap" id="aud-brand-wrap"${brandLogoUrl ? '' : ' hidden'}>
        <img id="aud-brand-img" src="${brandLogoUrl ? esc(brandLogoUrl) : ''}" alt="${esc(config.eventTitle)} branding">
      </div>
      <h1 class="aud-heading">Join the Live Screen</h1>
      <p class="aud-sub">Share your camera reaction with the venue screen. Your video only streams live if the host puts you on air.</p>
      <div class="aud-alert" id="aud-join-error" hidden></div>
      <form id="aud-join-form" class="aud-form">
        <label class="consent-row"><input type="checkbox" id="aud-consent" required><span>My camera and microphone may be shown on the venue screen.</span></label>
        <button type="submit" class="btn btn-primary btn-lg" id="aud-start-btn">Start Camera &amp; Join</button>
      </form>
    </section>
    <section class="aud-stage" id="aud-step-stage" hidden>
      <div class="aud-orient-hint" id="aud-orient-hint" hidden>
        Landscape gives the best result on the big screen
      </div>
      <div class="aud-video-wrap" id="aud-video-wrap">
        <video id="aud-preview" autoplay playsinline muted></video>
        <div class="aud-onair-frame" id="aud-onair-frame" hidden><span class="onair-tag">ON AIR</span></div>
        <div class="aud-preview-note" id="aud-preview-note">Previewing locally · Full uncropped frame</div>
      </div>
      <div class="aud-alert" id="aud-stage-error" hidden></div>
      <div class="aud-controls">
        <button type="button" class="btn btn-control" id="aud-mic-btn" aria-pressed="false"><span class="ctrl-label" id="aud-mic-label">Mic On</span></button>
        <button type="button" class="btn btn-control" id="aud-flip-btn"><span class="ctrl-label">Flip Camera</span></button>
        <button type="button" class="btn btn-danger" id="aud-leave-btn"><span class="ctrl-label">Leave</span></button>
      </div>
    </section>
    <section class="aud-card aud-ended" id="aud-step-ended" hidden>
      <h2 id="aud-ended-title">Session Ended</h2>
      <p id="aud-ended-desc">You have left the live wall.</p>
      <button type="button" class="btn btn-primary btn-lg" id="aud-rejoin-btn">Return to Join Screen</button>
    </section>
  </main>
  <script type="module" src="/assets/js/audience.js?v=${ASSET_VER}"></script>
</body>
</html>`);
});

app.get('/wall/:slug', async (req, res) => {
  const slug = cleanSlug(req.params.slug);
  const key = String(req.query.key || '');
  const event = dbGet<Record<string, unknown>>('SELECT * FROM events WHERE slug = ?', slug);
  if (!event || String(event.wall_key) !== key) {
    res.status(403).type('html').send('<h1>Invalid or missing Wall Key</h1>');
    return;
  }
  const bgParam = String(req.query.bg || 'transparent').toLowerCase();
  const bg = ['transparent', 'black', 'green'].includes(bgParam) ? bgParam : 'transparent';
  const audioParam = String(req.query.audio || '').toLowerCase();
  const audioOverride = ['on', 'off'].includes(audioParam) ? audioParam : null;
  const qrParam = String(req.query.qr || 'auto').toLowerCase();
  const qrMode = ['on', 'off', 'corner', 'auto'].includes(qrParam) ? qrParam : 'auto';
  const isMonitor = String(req.query.monitor || '0') === '1';
  const viewerId = isMonitor
    ? String(req.query.mid || `mon_${crypto.randomBytes(4).toString('hex')}`).replace(/[^a-zA-Z0-9_-]/g, '')
    : 'obs';

  const config = {
    eventSlug: event.slug,
    eventTitle: event.title,
    wallKey: key,
    joinUrl: `${baseUrl(req)}/join/${encodeURIComponent(String(event.slug))}`,
    bg,
    audioOverride,
    qrMode,
    isMonitor,
    viewerId,
    signalingMode: SIGNALING_MODE,
    iceServers: await getIceServersAsync(),
    version: process.env.APP_VERSION || '1.0.0',
    pollIdleMs: CONFIG.pollIdleMs,
    pollFastMs: CONFIG.pollFastMs,
  };
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(config.eventTitle)} — Wall</title>
  <link rel="stylesheet" href="/assets/css/wall.css?v=${ASSET_VER}">
</head>
<body class="wall-body wall-bg-${esc(bg)}">
  <script id="app-config" type="application/json">${safeJsonScript(config)}</script>
  <main class="wall-stage" id="wall-stage">
    <section class="wall-qr-idle" id="wall-qr-idle">
      <div class="wall-qr-card" id="wall-qr-card">
        <div class="wall-qr-eyebrow" id="wall-event-title">${esc(config.eventTitle)}</div>
        <div class="wall-qr-canvas-wrap"><canvas id="wall-qr-canvas" width="1360" height="1360"></canvas></div>
        <div class="wall-qr-cta">Scan to join the live wall</div>
      </div>
    </section>
    <section class="wall-grid layout-single" id="wall-grid" hidden></section>
    <aside class="wall-qr-corner" id="wall-qr-corner" hidden>
      <canvas id="wall-qr-corner-canvas" width="440" height="440"></canvas>
      <div class="wall-qr-corner-label">Scan to join</div>
    </aside>
    <div class="wall-blackout" id="wall-blackout" hidden></div>
  </main>
  <script type="module" src="/assets/js/wall.js?v=${ASSET_VER}"></script>
</body>
</html>`);
});

function renderLoginHtml(error: string | null = null): string {
  const seedUser = process.env.SEED_ADMIN_USER || 'superadmin';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QR Live Wall — Host Sign In</title>
  <link rel="stylesheet" href="/assets/css/common.css"><link rel="stylesheet" href="/assets/css/admin.css">
</head>
<body class="adm-auth-body">
  <main class="adm-auth-card">
    <div class="adm-auth-brand">QR Live Wall</div>
    <h1 class="adm-auth-title">Host &amp; Studio Sign In</h1>
    <p class="adm-auth-sub">Manage live event walls, audience feeds, and branded QR codes.</p>
    ${error ? `<div class="adm-alert adm-alert-error">${esc(error)}</div>` : ''}
    <form method="post" action="/admin/login" class="adm-auth-form">
      <label class="field"><span>Username or Email</span><input type="text" name="username" required autofocus autocomplete="username" placeholder="${esc(seedUser)}"></label>
      <label class="field"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>
      <button type="submit" class="btn btn-primary btn-lg">Sign In</button>
    </form>
    <p class="page-meta" style="margin:14px 0 0;font-size:12px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
      <span>Default username: <code class="tabular">${esc(seedUser)}</code></span>
      <a href="/admin/login" target="_blank" rel="noopener">Open in new tab</a>
    </p>
  </main>
</body>
</html>`;
}

app.get('/admin', (req, res) => {
  res.redirect(getCurrentAdmin(req) ? '/admin/events' : '/admin/login');
});

app.get('/admin/login', (req, res) => {
  if (getCurrentAdmin(req)) {
    res.redirect('/admin/events');
    return;
  }
  res.type('html').send(renderLoginHtml());
});

app.post('/admin/login', (req, res) => {
  const bucket = `login:${ipHash(req)}`;
  if (!checkRateLimit(bucket, 15, 300)) {
    res.status(429).type('html').send(renderLoginHtml('Too many login attempts. Please wait 5 minutes.'));
    return;
  }
  const identifier = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const admin = dbGet<{ id: number; display_name: string; password_hash: string; status: string; must_change_password: number }>(
    "SELECT id, display_name, password_hash, status, must_change_password FROM admins WHERE LOWER(username) = LOWER(?) OR (email != '' AND LOWER(email) = LOWER(?)) LIMIT 1",
    identifier,
    identifier
  );
  // Support PHP $2y$ bcrypt hashes cleanly in bcryptjs
  const normalizedHash = admin ? admin.password_hash.replace(/^\$2y\$/, '$2b$') : '';
  if (!admin || !bcrypt.compareSync(password, normalizedHash)) {
    res.status(401).type('html').send(renderLoginHtml('Invalid username or password.'));
    return;
  }
  if (admin.status !== 'active') {
    res.status(403).type('html').send(renderLoginHtml('This account is disabled. Contact the Super Admin.'));
    return;
  }
  dbRun('DELETE FROM rate_limits WHERE bucket_key = ?', bucket);
  createAdminSession(req, res, admin.id);
  logAudit(req, null, admin.id, admin.display_name, 'admin_login', 'Signed in');
  res.redirect(admin.must_change_password === 1 ? '/admin/change-password' : '/admin/events');
});

app.post('/admin/logout', (req, res) => {
  const user = getCurrentAdmin(req);
  if (user && String(req.body?.csrf_token || '') === user.csrf_token) {
    logAudit(req, null, user.id, user.display_name, 'admin_logout', 'Signed out');
    dbRun('UPDATE admin_sessions SET revoked = 1 WHERE id = ?', user.session_id);
  }
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions(req));
  res.redirect('/admin/login');
});

function renderChangePasswordHtml(user: AdminSession, error: string | null = null): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Change Password — QR Live Wall</title>
  <link rel="stylesheet" href="/assets/css/common.css"><link rel="stylesheet" href="/assets/css/admin.css">
</head>
<body class="adm-auth-body">
  <main class="adm-auth-card">
    <div class="adm-auth-brand">QR Live Wall</div>
    <h1 class="adm-auth-title">Set a New Password</h1>
    <p class="adm-auth-sub">Hello ${esc(user.display_name)}. You must update your password before entering the studio console.</p>
    ${error ? `<div class="adm-alert adm-alert-error">${esc(error)}</div>` : ''}
    <form method="post" action="/admin/change-password" class="adm-auth-form">
      <input type="hidden" name="csrf_token" value="${esc(user.csrf_token)}">
      <label class="field"><span>Current Password</span><input type="password" name="current_password" required autocomplete="current-password"></label>
      <label class="field"><span>New Password (10+ chars, upper, lower, number)</span><input type="password" name="new_password" required minlength="10" autocomplete="new-password"></label>
      <label class="field"><span>Confirm New Password</span><input type="password" name="confirm_password" required minlength="10" autocomplete="new-password"></label>
      <button type="submit" class="btn btn-primary btn-lg">Update Password</button>
    </form>
  </main>
</body>
</html>`;
}

app.get('/admin/change-password', (req, res) => {
  const user = requirePageAuth(req, res, true);
  if (!user) return;
  res.type('html').send(renderChangePasswordHtml(user));
});

app.post('/admin/change-password', (req, res) => {
  const user = requirePageAuth(req, res, true);
  if (!user) return;
  if (String(req.body?.csrf_token || '') !== user.csrf_token) {
    res.status(403).type('html').send(renderChangePasswordHtml(user, 'Invalid CSRF token.'));
    return;
  }
  const cur = String(req.body?.current_password || '');
  const nextPw = String(req.body?.new_password || '');
  const conf = String(req.body?.confirm_password || '');
  const row = dbGet<{ password_hash: string }>('SELECT password_hash FROM admins WHERE id = ?', user.id);
  if (!row || !bcrypt.compareSync(cur, row.password_hash.replace(/^\$2y\$/, '$2b$'))) {
    res.status(400).type('html').send(renderChangePasswordHtml(user, 'Current password is incorrect.'));
    return;
  }
  if (nextPw !== conf) {
    res.status(400).type('html').send(renderChangePasswordHtml(user, 'New passwords do not match.'));
    return;
  }
  const pwErr = validatePasswordStrength(nextPw);
  if (pwErr) {
    res.status(400).type('html').send(renderChangePasswordHtml(user, pwErr));
    return;
  }
  dbRun('UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?', bcrypt.hashSync(nextPw, 10), user.id);
  logAudit(req, null, user.id, user.display_name, 'password_changed', 'User updated password');
  res.redirect('/admin/events');
});

app.get('/admin/events/:id/print-qr', (req, res) => {
  const user = requirePageAuth(req, res, false);
  if (!user) return;
  const eventId = Number(req.params.id);
  if (!canAccessEvent(user, eventId)) {
    res.status(403).send('Forbidden');
    return;
  }
  const ev = dbGet<Record<string, unknown>>(
    'SELECT e.*, m.filename AS logo_filename FROM events e LEFT JOIN media_images m ON m.id = e.logo_image_id WHERE e.id = ?',
    eventId
  );
  if (!ev) {
    res.status(404).send('Event not found');
    return;
  }
  const printConfig = {
    title: ev.title,
    joinUrl: `${baseUrl(req)}/join/${encodeURIComponent(String(ev.slug))}`,
    logoUrl: ev.logo_filename ? `/uploads/logos/${encodeURIComponent(String(ev.logo_filename))}` : null,
    qrLogoShape: ev.qr_logo_shape,
    qrLogoFit: ev.qr_logo_fit,
    qrLogoScale: Number(ev.qr_logo_scale),
    qrLogoPadding: Number(ev.qr_logo_padding),
    qrLogoBg: ev.qr_logo_bg,
    qrFg: ev.qr_fg,
    qrBg: ev.qr_bg,
  };
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Print QR — ${esc(ev.title)}</title>
  <link rel="stylesheet" href="/assets/css/common.css">
  <style>
    body { background: #f8fafc; color: #0f172a; margin: 0; font-family: var(--font-sans); }
    .print-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 24px; background: #0f172a; color: #f8fafc; }
    .print-toolbar-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .poster { max-width: 820px; margin: 32px auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 20px; padding: 48px; text-align: center; }
    .poster h1 { font-size: 40px; margin: 0 0 12px; line-height: 1.15; }
    .poster p.sub { font-size: 20px; color: #475569; margin: 0 0 32px; }
    .poster canvas { width: 100%; max-width: 520px; height: auto; border-radius: 12px; }
    .poster .url { margin-top: 24px; font-family: var(--font-mono); font-size: 16px; color: #334155; word-break: break-all; }
    @media print { .print-toolbar { display: none; } body { background: #fff; } .poster { border: none; margin: 0 auto; padding: 20px; } }
  </style>
</head>
<body>
  <script id="app-config" type="application/json">${safeJsonScript(printConfig)}</script>
  <div class="print-toolbar">
    <strong>Printable QR Poster</strong>
    <div class="print-toolbar-actions">
      <button type="button" class="btn btn-secondary btn-sm" id="dl-png-btn">Download PNG (1024px)</button>
      <button type="button" class="btn btn-secondary btn-sm" id="dl-svg-btn">Download SVG</button>
      <button type="button" class="btn btn-primary btn-sm" id="print-btn">Print Poster</button>
    </div>
  </div>
  <main class="poster">
    <h1>${esc(ev.title)}</h1>
    <p class="sub">Scan with your phone camera to join the live screen</p>
    <canvas id="print-qr-canvas" width="1024" height="1024"></canvas>
    <div class="url" id="print-join-url">${esc(printConfig.joinUrl)}</div>
  </main>
  <script type="module" src="/assets/js/print-qr.js"></script>
</body>
</html>`);
});

async function renderAdminShell(req: Request, res: Response) {
  const user = requirePageAuth(req, res, false);
  if (!user) return;
  touchAdminPresence(user.session_id);
  const appConfig = {
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      email: user.email,
      role: user.role,
      event_scope: user.event_scope,
    },
    csrfToken: user.csrf_token,
    baseUrl: baseUrl(req),
    initialRoute: req.path,
    turnConfigured: turnConfigured(),
    quotaBytes: quotaBytes(),
    iceServers: await getIceServersAsync(),
    adminPollMs: CONFIG.adminPollMs,
  };
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QR Live Wall — Admin Console</title>
  <link rel="stylesheet" href="/assets/css/common.css?v=${ASSET_VER}"><link rel="stylesheet" href="/assets/css/admin.css?v=${ASSET_VER}">
</head>
<body class="adm-body">
  <script id="app-config" type="application/json">${safeJsonScript(appConfig)}</script>
  <div class="adm-shell">
    <header class="adm-topbar">
      <a href="/admin/events" class="adm-brand" data-nav="/admin/events">QR Live Wall</a>
      <nav class="adm-nav" aria-label="Main Navigation">
        <a href="/admin/events" class="adm-nav-link" data-nav="/admin/events">Events</a>
        <a href="/admin/frame-check" class="adm-nav-link" data-nav="/admin/frame-check">Frame Check</a>
        <a href="/admin/images" class="adm-nav-link" data-nav="/admin/images">Image Bank</a>
        ${user.role === 'super_admin' ? `
          <a href="/admin/accounts" class="adm-nav-link" data-nav="/admin/accounts">Accounts</a>
          <a href="/admin/audit" class="adm-nav-link" data-nav="/admin/audit">Audit Log</a>
        ` : ''}
      </nav>
      <div class="adm-top-actions">
        <span class="adm-user-meta">${esc(user.display_name)} · ${esc(user.role.replace('_', ' '))}</span>
        <button type="button" class="btn btn-secondary btn-sm" id="adm-logout-all-btn" title="Revoke all sessions">Log out everywhere</button>
        <form method="post" action="/admin/logout" class="inline-form">
          <input type="hidden" name="csrf_token" value="${esc(user.csrf_token)}">
          <button type="submit" class="btn btn-ghost btn-sm">Sign Out</button>
        </form>
      </div>
    </header>
    <main class="adm-main" id="adm-main"><div class="adm-loading">Loading studio console...</div></main>
  </div>
  <div class="adm-modal-backdrop" id="adm-modal-backdrop" hidden><div class="adm-modal" id="adm-modal" role="dialog" aria-modal="true"></div></div>
  <div class="adm-toast-stack" id="adm-toast-stack" aria-live="polite"></div>
  <script type="module" src="/assets/js/admin-boot.js?v=${ASSET_VER}"></script>
</body>
</html>`);
}

app.get(['/admin/events', '/admin/events/:id', '/admin/events/:id/monitor', '/admin/frame-check', '/admin/images', '/admin/accounts', '/admin/audit'], renderAdminShell);

// ---------------- AUDIENCE API ----------------

function loadAudienceParticipant(slug: string, token: string) {
  if (!slug || !token) return null;
  return dbGet<Record<string, unknown>>(
    `SELECT p.*, e.status AS event_status, e.join_locked, e.audio_enabled, e.blackout
     FROM participants p JOIN events e ON e.id = p.event_id
     WHERE e.slug = ? AND p.session_token = ?`,
    slug,
    token
  );
}

function buildAudienceState(p: Record<string, unknown>) {
  const pid = Number(p.id);
  const eid = Number(p.event_id);
  if (p.status === 'waiting' || p.status === 'onair') {
    dbRun('UPDATE participants SET last_seen = ? WHERE id = ?', utcNow(), pid);
  }
  const slot = dbGet<{ slot_no: number }>('SELECT slot_no FROM wall_slots WHERE event_id = ? AND participant_id = ?', eid, pid);
  const effectiveStatus = p.event_status !== 'active' ? 'event_closed' : String(p.status);

  const targets: string[] = [];
  if (effectiveStatus === 'onair' && slot) {
    const viewers = dbAll<{ viewer_id: string }>(
      'SELECT viewer_id FROM wall_heartbeats WHERE event_id = ? AND last_seen >= ? ORDER BY is_primary DESC, last_seen DESC LIMIT 8',
      eid,
      utcNow(-15)
    );
    for (const v of viewers) targets.push(v.viewer_id);
    if (!targets.includes('obs')) targets.push('obs');
  }
  if ((effectiveStatus === 'waiting' || effectiveStatus === 'onair') && p.preview_admin_id) {
    targets.push(`preview_${p.preview_admin_id}`);
  }

  const signals = dbAll<{ id: number; target_id: string; type: string; payload: string }>(
    "SELECT id, target_id, type, payload FROM signals WHERE event_id = ? AND participant_id = ? AND direction = 'to_audience' AND consumed = 0 ORDER BY id ASC",
    eid,
    pid
  );
  if (signals.length > 0) {
    const ph = signals.map(() => '?').join(',');
    dbRun(`DELETE FROM signals WHERE id IN (${ph})`, ...signals.map((s) => s.id));
  }

  return {
    status: effectiveStatus,
    slot_no: slot ? slot.slot_no : null,
    display_name: p.name_hidden === 1 ? 'Guest' : p.display_name,
    muted_by_admin: p.muted_by_admin === 1,
    wall_audio_enabled: p.audio_enabled === 1,
    blackout: p.blackout === 1,
    preview_active: Boolean(p.preview_admin_id),
    active_targets: Array.from(new Set(targets)),
    signals: signals.map((s) => ({
      id: s.id,
      target_id: s.target_id,
      type: s.type,
      payload: JSON.parse(s.payload),
    })),
  };
}

function encodeCaptureSettings(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const clean = {
    width: Math.max(0, Math.round(Number(r.width || 0))),
    height: Math.max(0, Math.round(Number(r.height || 0))),
    videoWidth: Math.max(0, Math.round(Number(r.videoWidth || 0))),
    videoHeight: Math.max(0, Math.round(Number(r.videoHeight || 0))),
    frameRate: Math.max(0, Number(r.frameRate || 0)),
    aspectRatio: Math.max(0, Number(r.aspectRatio || 0)),
    facingMode: r.facingMode === 'user' || r.facingMode === 'environment' ? r.facingMode : 'unknown',
    zoom: typeof r.zoom === 'number' && Number.isFinite(r.zoom) ? Math.round(r.zoom * 100) / 100 : null,
    label: cleanText(r.label, 80),
  };
  const encoded = JSON.stringify(clean);
  return encoded.length <= 1024 ? encoded : null;
}

app.post('/api/audience/join', async (req, res) => {
  maybeCleanup();
  const hIp = ipHash(req);
  if (!checkRateLimit(`join:${hIp}`, 25, 60)) {
    res.status(429).json({ error: 'Too many requests.' });
    return;
  }

  const slug = cleanSlug(String(req.body?.slug || ''));
  const rawName = cleanText(req.body?.display_name, 40);
  const message = cleanText(req.body?.message, 120);
  const consent = Boolean(req.body?.consent);
  const existingToken = cleanText(req.body?.session_token || req.cookies?.[`qrlw_aud_${slug}`], 96);
  const facingMode = req.body?.facing_mode === 'user' || req.body?.facing_mode === 'environment' ? req.body.facing_mode : 'unknown';
  const capJson = encodeCaptureSettings(req.body?.capture_settings);

  if (!slug || !consent) {
    res.status(422).json({ error: 'Camera and microphone consent is required.' });
    return;
  }

  const event = dbGet<Record<string, unknown>>('SELECT * FROM events WHERE slug = ?', slug);
  if (!event) {
    res.status(404).json({ error: 'Event not found.' });
    return;
  }
  if (event.status !== 'active') {
    res.status(403).json({ error: 'This event has ended.', code: 'event_closed' });
    return;
  }
  const eventId = Number(event.id);

  const ban = dbGet(
    "SELECT id FROM bans WHERE event_id = ? AND (ip_hash = ? OR (session_token != '' AND session_token = ?)) LIMIT 1",
    eventId,
    hIp,
    existingToken
  );
  if (ban) {
    res.status(403).json({ error: 'You have been removed from this event.', code: 'banned' });
    return;
  }

  let name = rawName ? filterProfanity(rawName) : '';
  const now = utcNow();
  const ua = String(req.headers['user-agent'] || '').slice(0, 250);

  if (existingToken) {
    const existing = dbGet<Record<string, unknown>>('SELECT * FROM participants WHERE event_id = ? AND session_token = ?', eventId, existingToken);
    if (existing) {
      if (existing.status === 'banned') {
        res.status(403).json({ error: 'You have been banned from this event.', code: 'banned' });
        return;
      }
      if (event.join_locked === 1 && existing.status !== 'waiting' && existing.status !== 'onair') {
        res.status(403).json({ error: 'Joining is currently locked by the host.', code: 'join_locked' });
        return;
      }
      const nextStatus = existing.status === 'waiting' || existing.status === 'onair' ? existing.status : 'waiting';
      const resolvedName = name || String(existing.display_name || '') || `Guest #${Number(event.total_joined || 0) + 1}`;
      dbRun(
        'UPDATE participants SET display_name = ?, message = ?, status = ?, facing_mode = ?, capture_settings = ?, last_seen = ?, ip_hash = ?, user_agent = ? WHERE id = ?',
        resolvedName,
        message,
        nextStatus,
        facingMode,
        capJson,
        now,
        hIp,
        ua,
        existing.id
      );
      res.json({
        participant_id: existing.id,
        session_token: existingToken,
        status: nextStatus,
        display_name: resolvedName,
        ice_servers: await getIceServersAsync(),
      });
      return;
    }
  }

  if (event.join_locked === 1) {
    res.status(403).json({ error: 'Joining is currently locked by the host.', code: 'join_locked' });
    return;
  }

  const activeCount = dbGet<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM participants WHERE event_id = ? AND status IN ('waiting', 'onair')", eventId)?.cnt || 0;
  if (activeCount >= Number(event.max_participants)) {
    res.status(403).json({ error: 'Lobby is currently full. Please try again shortly.', code: 'full' });
    return;
  }

  if (!name) {
    name = `Guest #${Number(event.total_joined || 0) + 1}`;
  }

  const token = crypto.randomBytes(24).toString('hex');
  const info = dbRun(
    'INSERT INTO participants (event_id, session_token, display_name, message, status, facing_mode, capture_settings, last_seen, joined_at, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    eventId,
    token,
    name,
    message,
    'waiting',
    facingMode,
    capJson,
    now,
    now,
    hIp,
    ua
  );
  const newConc = activeCount + 1;
  dbRun(
    'UPDATE events SET total_joined = total_joined + 1, peak_concurrent = CASE WHEN peak_concurrent < ? THEN ? ELSE peak_concurrent END WHERE id = ?',
    newConc,
    newConc,
    eventId
  );
  addTimeline(eventId, 'join', `${name} joined the lobby`);

  res.json({
    participant_id: Number(info.lastInsertRowid),
    session_token: token,
    status: 'waiting',
    display_name: name,
    ice_servers: await getIceServersAsync(),
  });
});

app.post('/api/audience/thumbnail', (req, res) => {
  const slug = cleanSlug(String(req.body?.slug || ''));
  const token = cleanText(req.body?.session_token, 96);
  const img = String(req.body?.image || '');
  if (!slug || !token || !img.startsWith('data:image/jpeg;base64,') || img.length > 70000) {
    res.status(422).json({ error: 'Invalid thumbnail payload.' });
    return;
  }
  if (!checkRateLimit(`thumb:${token.slice(0, 16)}`, 30, 60)) {
    res.status(429).json({ error: 'Too many requests.' });
    return;
  }
  const p = loadAudienceParticipant(slug, token);
  if (!p) {
    res.status(404).json({ error: 'Participant not found.' });
    return;
  }
  if (p.status !== 'waiting' && p.status !== 'onair') {
    res.json({ ok: false, status: p.status });
    return;
  }
  dbRun('UPDATE participants SET thumbnail_data = ?, thumb_version = thumb_version + 1, last_seen = ? WHERE id = ?', img, utcNow(), p.id);
  res.json({ ok: true });
});

app.get('/api/audience/poll', (req, res) => {
  maybeCleanup();
  const slug = cleanSlug(String(req.query.slug || ''));
  const token = cleanText(req.query.token, 96);
  const p = loadAudienceParticipant(slug, token);
  if (!p) {
    res.status(404).json({ error: 'Participant session not found.' });
    return;
  }
  res.json(buildAudienceState(p));
});

app.get('/api/audience/stream', (req, res) => {
  const slug = cleanSlug(String(req.query.slug || ''));
  const token = cleanText(req.query.token, 96);
  if (!loadAudienceParticipant(slug, token)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.flushHeaders();
  let last = '';
  const iv = setInterval(() => {
    const fresh = loadAudienceParticipant(slug, token);
    if (!fresh) return;
    const state = buildAudienceState(fresh);
    const json = JSON.stringify(state);
    if (json !== last || state.signals.length > 0) {
      res.write(`event: state\ndata: ${json}\n\n`);
      last = json;
    } else {
      res.write(': ping\n\n');
    }
  }, 600);
  req.on('close', () => clearInterval(iv));
});

app.post('/api/audience/signal', (req, res) => {
  const slug = cleanSlug(String(req.body?.slug || ''));
  const token = cleanText(req.body?.session_token, 96);
  const targetId = cleanText(req.body?.target_id || 'obs', 64);
  const type = cleanText(req.body?.type, 32);
  const payload = JSON.stringify(req.body?.payload ?? null);
  const p = loadAudienceParticipant(slug, token);
  if (!p) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }
  if (!type || payload.length > 65000) {
    res.status(422).json({ error: 'Invalid signal.' });
    return;
  }
  dbRun(
    "INSERT INTO signals (event_id, participant_id, target_id, direction, type, payload, created_at, consumed) VALUES (?, ?, ?, 'to_viewer', ?, ?, ?, 0)",
    p.event_id,
    p.id,
    targetId,
    type,
    payload,
    utcNow()
  );
  res.json({ ok: true });
});

app.post('/api/audience/stats', (req, res) => {
  const slug = cleanSlug(String(req.body?.slug || ''));
  const token = cleanText(req.body?.session_token, 96);
  const p = loadAudienceParticipant(slug, token);
  if (!p) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }
  if (req.body?.facing_mode !== undefined || req.body?.capture_settings !== undefined) {
    const fm = req.body?.facing_mode === 'user' || req.body?.facing_mode === 'environment' ? req.body.facing_mode : String(p.facing_mode || 'unknown');
    const capJson = req.body?.capture_settings !== undefined ? encodeCaptureSettings(req.body.capture_settings) : (p.capture_settings as string | null);
    dbRun('UPDATE participants SET facing_mode = ?, capture_settings = ? WHERE id = ?', fm, capJson, p.id);
  }
  dbRun(
    `INSERT INTO stream_stats (event_id, participant_id, reporter, state, width, height, fps, bitrate, packet_loss, rtt, relay_type, reported_at)
     VALUES (?, ?, 'audience', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, participant_id, reporter) DO UPDATE SET
     state=excluded.state, width=excluded.width, height=excluded.height, fps=excluded.fps, bitrate=excluded.bitrate,
     packet_loss=excluded.packet_loss, rtt=excluded.rtt, relay_type=excluded.relay_type, reported_at=excluded.reported_at`,
    p.event_id,
    p.id,
    cleanText(req.body?.state || 'unknown', 32),
    Math.max(0, Number(req.body?.width || 0)),
    Math.max(0, Number(req.body?.height || 0)),
    Math.max(0, Number(req.body?.fps || 0)),
    Math.max(0, Number(req.body?.bitrate || 0)),
    Math.max(0, Number(req.body?.packet_loss || 0)),
    Math.max(0, Number(req.body?.rtt || 0)),
    cleanText(req.body?.relay_type || 'unknown', 32),
    utcNow()
  );
  res.json({ ok: true });
});

app.post('/api/audience/leave', (req, res) => {
  const slug = cleanSlug(String(req.body?.slug || ''));
  const token = cleanText(req.body?.session_token, 96);
  if (slug && token) {
    const p = dbGet<{ id: number; event_id: number; display_name: string }>(
      'SELECT p.id, p.event_id, p.display_name FROM participants p JOIN events e ON e.id = p.event_id WHERE e.slug = ? AND p.session_token = ?',
      slug,
      token
    );
    if (p) {
      dbRun('DELETE FROM wall_slots WHERE participant_id = ?', p.id);
      dbRun('DELETE FROM signals WHERE participant_id = ?', p.id);
      dbRun("UPDATE participants SET status = 'left', thumbnail_data = NULL, preview_admin_id = NULL WHERE id = ?", p.id);
      dbRun(
        'UPDATE events SET state_version = state_version + 1, last_action_by = ?, last_action_summary = ?, last_action_at = ? WHERE id = ?',
        p.display_name,
        `${p.display_name} left the stream`,
        utcNow(),
        p.event_id
      );
      addTimeline(p.event_id, 'leave', `${p.display_name} left`);
    }
  }
  res.json({ ok: true });
});

// ---------------- WALL API ----------------

function verifyWall(slug: string, key: string) {
  const ev = dbGet<Record<string, unknown>>(
    'SELECT e.*, m.filename AS logo_filename FROM events e LEFT JOIN media_images m ON m.id = e.logo_image_id WHERE e.slug = ?',
    slug
  );
  if (!ev || String(ev.wall_key) !== key) return null;
  return ev;
}

function buildWallState(req: Request, event: Record<string, unknown>, viewerId: string) {
  const eid = Number(event.id);
  const slots = dbAll<Record<string, unknown>>(
    `SELECT ws.slot_no, ws.fit_mode, p.id AS participant_id, p.display_name, p.message, p.name_hidden, p.muted_by_admin, p.facing_mode, p.capture_settings
     FROM wall_slots ws JOIN participants p ON p.id = ws.participant_id
     WHERE ws.event_id = ? AND p.status = 'onair' ORDER BY ws.slot_no ASC`,
    eid
  );

  const signals = dbAll<{ id: number; participant_id: number; type: string; payload: string }>(
    "SELECT id, participant_id, type, payload FROM signals WHERE event_id = ? AND target_id = ? AND direction = 'to_viewer' AND consumed = 0 ORDER BY id ASC",
    eid,
    viewerId
  );
  if (signals.length > 0) {
    const ph = signals.map(() => '?').join(',');
    dbRun(`DELETE FROM signals WHERE id IN (${ph})`, ...signals.map((s) => s.id));
  }

  return {
    event_status: event.status,
    title: event.title,
    blackout: event.blackout === 1,
    layout: event.layout,
    max_wall_feeds: event.max_wall_feeds,
    show_labels: event.show_labels === 1,
    audio_enabled: event.audio_enabled === 1,
    wall_fit_mode: event.wall_fit_mode || 'fit',
    wall_tile_bg: event.wall_tile_bg || 'blur',
    wall_tile_bg_color: event.wall_tile_bg_color || '#090d16',
    mirror_front_wall: Number(event.mirror_front_wall || 0) === 1,
    qr: {
      joinUrl: `${baseUrl(req)}/join/${encodeURIComponent(String(event.slug))}`,
      logoUrl: event.logo_filename ? `/uploads/logos/${encodeURIComponent(String(event.logo_filename))}` : null,
      shape: event.qr_logo_shape,
      fit: event.qr_logo_fit,
      scale: Number(event.qr_logo_scale),
      padding: Number(event.qr_logo_padding),
      logoBg: event.qr_logo_bg,
      fg: event.qr_fg,
      bg: event.qr_bg,
    },
    slots: slots.map((s) => {
      let capParsed: unknown = null;
      if (typeof s.capture_settings === 'string' && s.capture_settings) {
        try { capParsed = JSON.parse(s.capture_settings); } catch {}
      }
      return {
        slot_no: Number(s.slot_no),
        participant_id: Number(s.participant_id),
        display_name: s.name_hidden === 1 ? 'Guest' : s.display_name,
        message: s.name_hidden === 1 ? '' : s.message,
        muted: s.muted_by_admin === 1,
        fit_mode: s.fit_mode || null,
        facing_mode: s.facing_mode || 'unknown',
        capture_settings: capParsed,
      };
    }),
    signals: signals.map((s) => ({
      id: s.id,
      participant_id: s.participant_id,
      type: s.type,
      payload: JSON.parse(s.payload),
    })),
  };
}

app.get('/api/wall/poll', (req, res) => {
  maybeCleanup();
  const slug = cleanSlug(String(req.query.slug || ''));
  const key = String(req.query.key || '');
  const viewerId = String(req.query.viewer_id || 'obs').replace(/[^a-zA-Z0-9_-]/g, '') || 'obs';
  const isPrimary = String(req.query.is_primary || '0') === '1' ? 1 : 0;
  const resolution = cleanText(req.query.resolution, 32);
  const version = cleanText(req.query.version, 32);

  const event = verifyWall(slug, key);
  if (!event) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  dbRun(
    `INSERT INTO wall_heartbeats (event_id, viewer_id, is_primary, last_seen, resolution, version)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, viewer_id) DO UPDATE SET
     is_primary=excluded.is_primary, last_seen=excluded.last_seen, resolution=excluded.resolution, version=excluded.version`,
    event.id,
    viewerId,
    isPrimary,
    utcNow(),
    resolution,
    version
  );
  res.json(buildWallState(req, event, viewerId));
});

app.get('/api/wall/stream', (req, res) => {
  const slug = cleanSlug(String(req.query.slug || ''));
  const key = String(req.query.key || '');
  const viewerId = String(req.query.viewer_id || 'obs').replace(/[^a-zA-Z0-9_-]/g, '') || 'obs';
  const isPrimary = String(req.query.is_primary || '0') === '1' ? 1 : 0;
  const resolution = cleanText(req.query.resolution, 32);
  const version = cleanText(req.query.version, 32);

  if (!verifyWall(slug, key)) {
    res.status(403).end();
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.flushHeaders();
  let last = '';
  const iv = setInterval(() => {
    const fresh = verifyWall(slug, key);
    if (!fresh) return;
    dbRun(
      `INSERT INTO wall_heartbeats (event_id, viewer_id, is_primary, last_seen, resolution, version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, viewer_id) DO UPDATE SET
       is_primary=excluded.is_primary, last_seen=excluded.last_seen, resolution=excluded.resolution, version=excluded.version`,
      fresh.id,
      viewerId,
      isPrimary,
      utcNow(),
      resolution,
      version
    );
    const state = buildWallState(req, fresh, viewerId);
    const json = JSON.stringify(state);
    if (json !== last || state.signals.length > 0) {
      res.write(`event: state\ndata: ${json}\n\n`);
      last = json;
    } else {
      res.write(': ping\n\n');
    }
  }, 500);
  req.on('close', () => clearInterval(iv));
});

app.post('/api/wall/signal', (req, res) => {
  const slug = cleanSlug(String(req.body?.slug || ''));
  const key = String(req.body?.key || '');
  const viewerId = String(req.body?.viewer_id || 'obs').replace(/[^a-zA-Z0-9_-]/g, '') || 'obs';
  const pid = Number(req.body?.participant_id || 0);
  const type = cleanText(req.body?.type, 32);
  const payload = JSON.stringify(req.body?.payload ?? null);

  const event = verifyWall(slug, key);
  if (!event) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (pid <= 0 || !type || payload.length > 65000) {
    res.status(422).json({ error: 'Invalid signal.' });
    return;
  }
  dbRun(
    "INSERT INTO signals (event_id, participant_id, target_id, direction, type, payload, created_at, consumed) VALUES (?, ?, ?, 'to_audience', ?, ?, ?, 0)",
    event.id,
    pid,
    viewerId,
    type,
    payload,
    utcNow()
  );
  res.json({ ok: true });
});

app.post('/api/wall/stats', (req, res) => {
  const slug = cleanSlug(String(req.body?.slug || ''));
  const key = String(req.body?.key || '');
  const event = verifyWall(slug, key);
  if (!event) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const items = Array.isArray(req.body?.stats) ? req.body.stats : [];
  const now = utcNow();
  for (const item of items) {
    const pid = Number(item?.participant_id || 0);
    if (pid <= 0) continue;
    dbRun(
      `INSERT INTO stream_stats (event_id, participant_id, reporter, state, width, height, fps, bitrate, packet_loss, rtt, relay_type, reported_at)
       VALUES (?, ?, 'wall', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, participant_id, reporter) DO UPDATE SET
       state=excluded.state, width=excluded.width, height=excluded.height, fps=excluded.fps, bitrate=excluded.bitrate,
       packet_loss=excluded.packet_loss, rtt=excluded.rtt, relay_type=excluded.relay_type, reported_at=excluded.reported_at`,
      event.id,
      pid,
      cleanText(item.state || 'unknown', 32),
      Math.max(0, Number(item.width || 0)),
      Math.max(0, Number(item.height || 0)),
      Math.max(0, Number(item.fps || 0)),
      Math.max(0, Number(item.bitrate || 0)),
      Math.max(0, Number(item.packet_loss || 0)),
      Math.max(0, Number(item.rtt || 0)),
      cleanText(item.relay_type || 'unknown', 32),
      now
    );
  }
  res.json({ ok: true });
});

// ---------------- ADMIN API ----------------

app.get('/api/admin/me', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host', 'moderator'], false);
  if (!user) return;
  touchAdminPresence(user.session_id);
  res.json({ user });
});

app.post('/api/admin/logout-everywhere', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host', 'moderator'], true);
  if (!user) return;
  logAudit(req, null, user.id, user.display_name, 'logout_everywhere', 'Revoked all own sessions');
  dbRun('UPDATE admin_sessions SET revoked = 1 WHERE admin_id = ?', user.id);
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions(req));
  res.json({ ok: true });
});

app.get('/api/admin/events', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host', 'moderator'], false);
  if (!user) return;
  touchAdminPresence(user.session_id);
  const sql =
    user.role === 'super_admin' || user.event_scope === 'all'
      ? `SELECT e.*, m.filename AS logo_filename, jm.filename AS join_logo_filename,
                (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'waiting') AS waiting_count,
                (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'onair') AS onair_count
         FROM events e
         LEFT JOIN media_images m ON m.id = e.logo_image_id
         LEFT JOIN media_images jm ON jm.id = e.join_logo_image_id
         ORDER BY e.created_at DESC`
      : `SELECT e.*, m.filename AS logo_filename, jm.filename AS join_logo_filename,
                (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'waiting') AS waiting_count,
                (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'onair') AS onair_count
         FROM events e JOIN admin_event_access aea ON aea.event_id = e.id AND aea.admin_id = ?
         LEFT JOIN media_images m ON m.id = e.logo_image_id
         LEFT JOIN media_images jm ON jm.id = e.join_logo_image_id
         ORDER BY e.created_at DESC`;
  const events = user.role === 'super_admin' || user.event_scope === 'all' ? dbAll(sql) : dbAll(sql, user.id);
  res.json({ events });
});

app.post('/api/admin/events', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host'], true);
  if (!user) return;
  const title = cleanText(req.body?.title, 120);
  if (!title) {
    res.status(422).json({ error: 'Event title is required.' });
    return;
  }
  let slug = cleanSlug(String(req.body?.slug || '') || title) || `event-${crypto.randomBytes(3).toString('hex')}`;
  if (dbGet('SELECT id FROM events WHERE slug = ?', slug)) {
    slug += `-${crypto.randomBytes(2).toString('hex')}`;
  }
  const defLogo = dbGet<{ id: number }>(
    "SELECT id FROM media_images WHERE is_default = 1 AND (visibility = 'shared' OR uploaded_by = ?) LIMIT 1",
    user.id
  );
  const wallKey = crypto.randomBytes(16).toString('hex');
  const layout = ['single', 'split2', 'grid4', 'pip'].includes(req.body?.layout) ? req.body.layout : 'single';
  const maxPart = Math.max(2, Math.min(500, Number(req.body?.max_participants || 100)));
  const maxFeeds = Math.max(1, Math.min(4, Number(req.body?.max_wall_feeds || 4)));

  const info = dbRun(
    `INSERT INTO events (slug, title, wall_key, status, join_locked, max_participants, max_wall_feeds, layout, show_labels, audio_enabled, blackout, logo_image_id, created_by, created_at)
     VALUES (?, ?, ?, 'active', 0, ?, ?, ?, 1, 0, 0, ?, ?, ?)`,
    slug,
    title,
    wallKey,
    maxPart,
    maxFeeds,
    layout,
    defLogo?.id || null,
    user.id,
    utcNow()
  );
  const eventId = Number(info.lastInsertRowid);
  syncUseCounts();
  if (user.event_scope === 'assigned') {
    dbRun('INSERT INTO admin_event_access (admin_id, event_id) VALUES (?, ?)', user.id, eventId);
  }
  logAudit(req, eventId, user.id, user.display_name, 'event_created', `Created event ${title} (${slug})`);
  res.status(201).json({ event: dbGet('SELECT * FROM events WHERE id = ?', eventId) });
});

app.post('/api/admin/events/:id/settings', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host'], true);
  if (!user) return;
  const eventId = Number(req.params.id);
  const event = dbGet<Record<string, unknown>>('SELECT * FROM events WHERE id = ?', eventId);
  if (!event || !canAccessEvent(user, eventId)) {
    res.status(event ? 403 : 404).json({ error: event ? 'Forbidden' : 'Event not found.' });
    return;
  }

  const b = req.body || {};
  const title = b.title !== undefined ? cleanText(b.title, 120) : String(event.title);
  if (!title) {
    res.status(422).json({ error: 'Title cannot be empty.' });
    return;
  }
  const status = ['active', 'closed'].includes(b.status) ? b.status : String(event.status);
  const joinLocked = b.join_locked !== undefined ? (b.join_locked ? 1 : 0) : Number(event.join_locked);
  const maxPart = b.max_participants !== undefined ? Math.max(2, Math.min(500, Number(b.max_participants))) : Number(event.max_participants);
  const maxFeeds = b.max_wall_feeds !== undefined ? Math.max(1, Math.min(4, Number(b.max_wall_feeds))) : Number(event.max_wall_feeds);
  const layout = ['single', 'split2', 'grid4', 'pip'].includes(b.layout) ? b.layout : String(event.layout);
  const showLabels = b.show_labels !== undefined ? (b.show_labels ? 1 : 0) : Number(event.show_labels);
  const audioEnabled = b.audio_enabled !== undefined ? (b.audio_enabled ? 1 : 0) : Number(event.audio_enabled);
  const blackout = b.blackout !== undefined ? (b.blackout ? 1 : 0) : Number(event.blackout);

  const logoImageId =
    b.logo_image_id !== undefined ? (b.logo_image_id === null || b.logo_image_id === '' ? null : Number(b.logo_image_id)) : (event.logo_image_id as number | null);
  if (logoImageId !== null) {
    const img = dbGet("SELECT id FROM media_images WHERE id = ? AND (visibility = 'shared' OR uploaded_by = ?)", logoImageId, user.id);
    if (!img) {
      res.status(404).json({ error: 'Selected logo image is unavailable.' });
      return;
    }
  }

  const joinLogoImageId =
    b.join_logo_image_id !== undefined
      ? (b.join_logo_image_id === null || b.join_logo_image_id === '' ? null : Number(b.join_logo_image_id))
      : ((event.join_logo_image_id as number | null) ?? null);
  if (joinLogoImageId !== null) {
    const jImg = dbGet("SELECT id FROM media_images WHERE id = ? AND (visibility = 'shared' OR uploaded_by = ?)", joinLogoImageId, user.id);
    if (!jImg) {
      res.status(404).json({ error: 'Selected join branding image is unavailable.' });
      return;
    }
  }

  const qrShape = ['square', 'circle'].includes(b.qr_logo_shape) ? b.qr_logo_shape : String(event.qr_logo_shape);
  const qrFit = ['contain', 'cover'].includes(b.qr_logo_fit) ? b.qr_logo_fit : String(event.qr_logo_fit);
  const qrScale = b.qr_logo_scale !== undefined ? Math.max(10, Math.min(22, Number(b.qr_logo_scale))) : Number(event.qr_logo_scale);
  const qrPadding = b.qr_logo_padding !== undefined ? Math.max(0, Math.min(24, Number(b.qr_logo_padding))) : Number(event.qr_logo_padding);
  const qrLogoBg = b.qr_logo_bg !== undefined ? hexColor(b.qr_logo_bg, '#ffffff', true) : String(event.qr_logo_bg);
  const qrFg = b.qr_fg !== undefined ? hexColor(b.qr_fg, '#000000', false) : String(event.qr_fg);
  const qrBg = b.qr_bg !== undefined ? hexColor(b.qr_bg, '#ffffff', false) : String(event.qr_bg);

  if (relativeLuminance(qrFg) >= relativeLuminance(qrBg)) {
    res.status(422).json({ error: 'QR foreground must be darker than QR background.' });
    return;
  }
  if (contrastRatio(qrFg, qrBg) < 4.5) {
    res.status(422).json({ error: 'QR contrast ratio is too low (< 4.5:1).' });
    return;
  }

  const wallKey = b.regen_wall_key ? crypto.randomBytes(16).toString('hex') : String(event.wall_key);
  if (status === 'closed' && event.status !== 'closed') {
    dbRun('DELETE FROM wall_slots WHERE event_id = ?', eventId);
    dbRun('UPDATE participants SET thumbnail_data = NULL, preview_admin_id = NULL WHERE event_id = ?', eventId);
  }
  dbRun('DELETE FROM wall_slots WHERE event_id = ? AND slot_no > ?', eventId, maxFeeds);
  dbRun("UPDATE participants SET status = 'waiting' WHERE event_id = ? AND status = 'onair' AND id NOT IN (SELECT participant_id FROM wall_slots WHERE event_id = ?)", eventId, eventId);

  const wallFitMode = ['fit', 'fill', 'stretch'].includes(b.wall_fit_mode) ? b.wall_fit_mode : String(event.wall_fit_mode || 'fit');
  const wallTileBg = ['blur', 'solid', 'transparent'].includes(b.wall_tile_bg) ? b.wall_tile_bg : String(event.wall_tile_bg || 'blur');
  const wallTileBgColor = b.wall_tile_bg_color !== undefined ? hexColor(b.wall_tile_bg_color, '#090d16', false) : String(event.wall_tile_bg_color || '#090d16');
  const mirrorFrontWall = b.mirror_front_wall !== undefined ? (b.mirror_front_wall ? 1 : 0) : Number(event.mirror_front_wall || 0);

  dbRun(
    `UPDATE events SET title = ?, wall_key = ?, status = ?, join_locked = ?, max_participants = ?, max_wall_feeds = ?,
     layout = ?, show_labels = ?, audio_enabled = ?, blackout = ?, logo_image_id = ?, join_logo_image_id = ?,
     wall_fit_mode = ?, wall_tile_bg = ?, wall_tile_bg_color = ?, mirror_front_wall = ?,
     qr_logo_shape = ?, qr_logo_fit = ?, qr_logo_scale = ?, qr_logo_padding = ?, qr_logo_bg = ?, qr_fg = ?, qr_bg = ?,
     state_version = state_version + 1, last_action_by = ?, last_action_summary = ?, last_action_at = ?
     WHERE id = ?`,
    title,
    wallKey,
    status,
    joinLocked,
    maxPart,
    maxFeeds,
    layout,
    showLabels,
    audioEnabled,
    blackout,
    logoImageId,
    joinLogoImageId,
    wallFitMode,
    wallTileBg,
    wallTileBgColor,
    mirrorFrontWall,
    qrShape,
    qrFit,
    qrScale,
    qrPadding,
    qrLogoBg,
    qrFg,
    qrBg,
    user.display_name,
    'Updated event settings',
    utcNow(),
    eventId
  );
  syncUseCounts();
  logAudit(req, eventId, user.id, user.display_name, 'event_settings', `Updated settings for ${title}`);
  const updated = dbGet(
    'SELECT e.*, m.filename AS logo_filename, jm.filename AS join_logo_filename FROM events e LEFT JOIN media_images m ON m.id = e.logo_image_id LEFT JOIN media_images jm ON jm.id = e.join_logo_image_id WHERE e.id = ?',
    eventId
  );
  res.json({ event: updated });
});

app.delete('/api/admin/events/:id', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin'], true);
  if (!user) return;
  const eventId = Number(req.params.id);
  const event = dbGet<{ title: string; slug: string }>('SELECT title, slug FROM events WHERE id = ?', eventId);
  if (!event) {
    res.status(404).json({ error: 'Event not found.' });
    return;
  }
  dbRun('DELETE FROM events WHERE id = ?', eventId);
  syncUseCounts();
  logAudit(req, null, user.id, user.display_name, 'event_deleted', `Deleted event ${event.title} (${event.slug})`);
  res.json({ ok: true });
});

app.get('/api/admin/events/:id/state', (req, res) => {
  maybeCleanup();
  const user = requireApiAuth(req, res, ['super_admin', 'host', 'moderator'], false);
  if (!user) return;
  const eventId = Number(req.params.id);
  touchAdminPresence(user.session_id, eventId);
  const eventRow = dbGet<Record<string, unknown>>(
    'SELECT e.*, m.filename AS logo_filename, jm.filename AS join_logo_filename FROM events e LEFT JOIN media_images m ON m.id = e.logo_image_id LEFT JOIN media_images jm ON jm.id = e.join_logo_image_id WHERE e.id = ?',
    eventId
  );
  if (!eventRow || !canAccessEvent(user, eventId)) {
    res.status(eventRow ? 403 : 404).json({ error: eventRow ? 'Forbidden' : 'Event not found.' });
    return;
  }

  const participants = dbAll<Record<string, unknown>>(
    `SELECT p.id, p.display_name, p.message, p.name_hidden, p.muted_by_admin, p.status,
            p.facing_mode, p.capture_settings, p.preview_admin_id, p.last_seen, p.joined_at, p.thumb_version,
            (p.thumbnail_data IS NOT NULL) AS has_thumb, ws.slot_no, ws.fit_mode AS slot_fit_mode
     FROM participants p
     LEFT JOIN wall_slots ws ON ws.event_id = p.event_id AND ws.participant_id = p.id
     WHERE p.event_id = ? AND p.status IN ('waiting', 'onair')
     ORDER BY (ws.slot_no IS NULL) ASC, ws.slot_no ASC, p.joined_at ASC`,
    eventId
  );

  const statsRows = dbAll<Record<string, unknown>>('SELECT * FROM stream_stats WHERE event_id = ?', eventId);
  const statsMap = new Map<number, Record<string, Record<string, unknown>>>();
  for (const sr of statsRows) {
    const pid = Number(sr.participant_id);
    if (!statsMap.has(pid)) statsMap.set(pid, {});
    statsMap.get(pid)![String(sr.reporter)] = sr;
  }

  const obsHb = dbGet<Record<string, unknown>>(
    'SELECT * FROM wall_heartbeats WHERE event_id = ? AND is_primary = 1 ORDER BY last_seen DESC LIMIT 1',
    eventId
  );
  let wallOnline = false;
  let wallAgeSec: number | null = null;
  if (obsHb) {
    wallAgeSec = Math.max(0, Math.floor((Date.now() - Date.parse(`${obsHb.last_seen}Z`)) / 1000));
    wallOnline = wallAgeSec <= CONFIG.wallOfflineThresholdSec;
  }

  const onlineAdmins = dbAll(
    `SELECT DISTINCT a.id, a.display_name, a.role, s.last_seen
     FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.revoked = 0 AND s.current_event_id = ? AND s.last_seen >= ?`,
    eventId,
    utcNow(-10)
  );
  const timeline = dbAll('SELECT kind, message, created_at FROM event_timeline WHERE event_id = ? ORDER BY id DESC LIMIT 20', eventId);

  const alerts: Array<{ level: string; code: string; message: string }> = [];
  const cfTurnErr = getTurnError();
  if (cfTurnErr && getEffectiveTurnConfig().urls.length === 0) {
    const hint = /cannot find specified key/i.test(cfTurnErr)
      ? 'Confirm Key ID is the TURN Token ID under Cloudflare Dashboard → Realtime → TURN (not Account ID or SFU App ID).'
      : 'Verify CLOUDFLARE_TURN_KEY_ID & CLOUDFLARE_TURN_API_TOKEN under Cloudflare Realtime → TURN.';
    alerts.push({
      level: 'amber',
      code: 'turn_error',
      message: `Cloudflare TURN key failed (${cfTurnErr}). ${hint}`,
    });
  } else if (!turnConfigured()) {
    alerts.push({ level: 'amber', code: 'no_turn', message: 'TURN server not configured — cellular/strict-NAT phones may fail to connect.' });
  }
  if (!wallOnline) {
    alerts.push({
      level: 'red',
      code: 'wall_offline',
      message: !obsHb ? 'OBS Wall Browser Source has not connected yet.' : `OBS Wall Browser Source offline (${wallAgeSec}s since last heartbeat).`,
    });
  }
  const qBytes = quotaBytes();
  const uBytes = usedBytes();
  if (qBytes > 0 && uBytes / qBytes >= 0.85) {
    alerts.push({ level: 'amber', code: 'storage_high', message: `Image Bank storage is ${Math.round((uBytes / qBytes) * 100)}% full.` });
  }

  let waitingCount = 0;
  let onairCount = 0;
  const formattedParts = participants.map((p) => {
    const pid = Number(p.id);
    if (p.status === 'onair') onairCount++;
    else waitingCount++;
    const st = statsMap.get(pid) || null;
    if (p.status === 'onair' && st?.wall) {
      const ws = st.wall;
      if (ws.state === 'failed' || ws.state === 'disconnected') {
        alerts.push({ level: 'red', code: 'feed_failed', message: `${p.display_name} connection ${ws.state}.` });
      } else if (Number(ws.packet_loss) > 5 || Number(ws.rtt) > 350) {
        alerts.push({ level: 'amber', code: 'poor_quality', message: `${p.display_name} poor network (loss ${ws.packet_loss}%, RTT ${ws.rtt}ms).` });
      }
    }
    let capParsed: unknown = null;
    if (typeof p.capture_settings === 'string' && p.capture_settings) {
      try { capParsed = JSON.parse(p.capture_settings); } catch {}
    }
    return {
      ...p,
      id: pid,
      slot_no: p.slot_no !== null && p.slot_no !== undefined ? Number(p.slot_no) : null,
      slot_fit_mode: p.slot_fit_mode || null,
      facing_mode: p.facing_mode || 'unknown',
      capture_settings: capParsed,
      name_hidden: p.name_hidden === 1,
      muted_by_admin: p.muted_by_admin === 1,
      has_thumb: Boolean(p.has_thumb),
      preview_admin_id: p.preview_admin_id ? Number(p.preview_admin_id) : null,
      stats: st,
    };
  });

  const bans = dbAll('SELECT id, display_name, reason, created_at FROM bans WHERE event_id = ? ORDER BY id DESC LIMIT 30', eventId);
  const createdMs = Date.parse(`${eventRow.created_at}Z`);

  res.json({
    event: eventRow,
    joinUrl: `${baseUrl(req)}/join/${encodeURIComponent(String(eventRow.slug))}`,
    wallUrl: `${baseUrl(req)}/wall/${encodeURIComponent(String(eventRow.slug))}?key=${encodeURIComponent(String(eventRow.wall_key))}`,
    participants: formattedParts,
    bans,
    wall_heartbeat: {
      online: wallOnline,
      age_sec: wallAgeSec,
      last_seen: obsHb?.last_seen || null,
      resolution: obsHb?.resolution || '',
      version: obsHb?.version || '',
    },
    counters: {
      total_joined: Number(eventRow.total_joined),
      waiting: waitingCount,
      onair: onairCount,
      kicked_banned: Number(eventRow.total_kicked_banned),
      peak_concurrent: Number(eventRow.peak_concurrent),
      duration_sec: Math.max(0, Math.floor((Date.now() - createdMs) / 1000)),
    },
    online_admins: onlineAdmins,
    alerts,
    timeline,
    server_time: utcNow(),
  });
});

app.get('/api/admin/events/:id/participants/:pid/thumb', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host', 'moderator'], false);
  if (!user) return;
  const eventId = Number(req.params.id);
  if (!canAccessEvent(user, eventId)) {
    res.status(403).end();
    return;
  }
  const p = dbGet<{ thumbnail_data: string | null }>(
    'SELECT thumbnail_data FROM participants WHERE id = ? AND event_id = ?',
    Number(req.params.pid),
    eventId
  );
  if (!p?.thumbnail_data?.startsWith('data:image/jpeg;base64,')) {
    res.status(404).end();
    return;
  }
  const bytes = Buffer.from(p.thumbnail_data.slice('data:image/jpeg;base64,'.length), 'base64');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(bytes);
});

app.post('/api/admin/events/:id/wall-action', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host', 'moderator'], true);
  if (!user) return;
  const eventId = Number(req.params.id);
  const event = dbGet<Record<string, unknown>>('SELECT * FROM events WHERE id = ?', eventId);
  if (!event || !canAccessEvent(user, eventId)) {
    res.status(event ? 403 : 404).json({ error: event ? 'Forbidden' : 'Event not found.' });
    return;
  }

  const action = String(req.body?.action || '');
  const pid = Number(req.body?.participant_id || 0);
  let slotNo = req.body?.slot_no !== undefined && req.body?.slot_no !== null ? Number(req.body.slot_no) : null;
  const now = utcNow();
  let summary = '';

  if (action === 'put_on_wall' || action === 'preview_take') {
    const p = dbGet<{ id: number; display_name: string }>(
      "SELECT id, display_name FROM participants WHERE id = ? AND event_id = ? AND status IN ('waiting', 'onair')",
      pid,
      eventId
    );
    if (!p) {
      res.status(404).json({ error: 'Participant is no longer connected.' });
      return;
    }
    const maxFeeds = Number(event.max_wall_feeds);
    const existingSlot = dbGet<{ slot_no: number }>('SELECT slot_no FROM wall_slots WHERE event_id = ? AND participant_id = ?', eventId, pid);
    if (slotNo === null) {
      if (existingSlot) slotNo = existingSlot.slot_no;
      else {
        const taken = new Set(dbAll<{ slot_no: number }>('SELECT slot_no FROM wall_slots WHERE event_id = ?', eventId).map((r) => r.slot_no));
        for (let i = 1; i <= maxFeeds; i++) {
          if (!taken.has(i)) {
            slotNo = i;
            break;
          }
        }
        if (slotNo === null) slotNo = 1;
      }
    }
    if (slotNo < 1 || slotNo > maxFeeds) {
      res.status(422).json({ error: `Slot must be between 1 and ${maxFeeds}.` });
      return;
    }
    const occ = dbGet<{ participant_id: number }>('SELECT participant_id FROM wall_slots WHERE event_id = ? AND slot_no = ?', eventId, slotNo);
    if (occ && occ.participant_id !== pid) {
      dbRun("UPDATE participants SET status = 'waiting' WHERE id = ?", occ.participant_id);
    }
    dbRun('DELETE FROM wall_slots WHERE event_id = ? AND participant_id = ?', eventId, pid);
    dbRun(
      `INSERT INTO wall_slots (event_id, slot_no, participant_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id, slot_no) DO UPDATE SET participant_id = excluded.participant_id, updated_at = excluded.updated_at`,
      eventId,
      slotNo,
      pid,
      now
    );
    dbRun("UPDATE participants SET status = 'onair', preview_admin_id = NULL WHERE id = ?", pid);
    summary = `Put ${p.display_name} on Slot ${slotNo}`;
    addTimeline(eventId, 'wall', `${p.display_name} went ON AIR (Slot ${slotNo})`);
  } else if (action === 'remove_from_wall') {
    const p = dbGet<{ display_name: string }>('SELECT display_name FROM participants WHERE id = ? AND event_id = ?', pid, eventId);
    dbRun('DELETE FROM wall_slots WHERE event_id = ? AND participant_id = ?', eventId, pid);
    dbRun("UPDATE participants SET status = 'waiting' WHERE id = ? AND status = 'onair'", pid);
    const name = p?.display_name || `#${pid}`;
    summary = `Removed ${name} from wall`;
    addTimeline(eventId, 'wall', `${name} moved back to lobby`);
  } else if (action === 'swap_slots') {
    const fromSlot = Number(req.body?.from_slot || 0);
    const toSlot = Number(req.body?.to_slot || 0);
    const maxFeeds = Number(event.max_wall_feeds);
    if (fromSlot < 1 || toSlot < 1 || fromSlot > maxFeeds || toSlot > maxFeeds || fromSlot === toSlot) {
      res.status(422).json({ error: 'Invalid slot numbers.' });
      return;
    }
    const a = dbGet<{ participant_id: number }>('SELECT participant_id FROM wall_slots WHERE event_id = ? AND slot_no = ?', eventId, fromSlot);
    const b = dbGet<{ participant_id: number }>('SELECT participant_id FROM wall_slots WHERE event_id = ? AND slot_no = ?', eventId, toSlot);
    dbRun('DELETE FROM wall_slots WHERE event_id = ? AND slot_no IN (?, ?)', eventId, fromSlot, toSlot);
    if (a) dbRun('INSERT INTO wall_slots (event_id, slot_no, participant_id, updated_at) VALUES (?, ?, ?, ?)', eventId, toSlot, a.participant_id, now);
    if (b) dbRun('INSERT INTO wall_slots (event_id, slot_no, participant_id, updated_at) VALUES (?, ?, ?, ?)', eventId, fromSlot, b.participant_id, now);
    summary = `Swapped Slot ${fromSlot} and Slot ${toSlot}`;
  } else if (action === 'clear_wall') {
    dbRun('DELETE FROM wall_slots WHERE event_id = ?', eventId);
    dbRun("UPDATE participants SET status = 'waiting' WHERE event_id = ? AND status = 'onair'", eventId);
    summary = 'Cleared wall back to QR';
    addTimeline(eventId, 'wall', summary);
  } else if (action === 'blackout') {
    const val = req.body?.blackout ? 1 : 0;
    dbRun('UPDATE events SET blackout = ? WHERE id = ?', val, eventId);
    summary = val ? 'Activated BLACKOUT' : 'Ended BLACKOUT';
    addTimeline(eventId, 'wall', summary);
  } else if (action === 'toggle_audio') {
    if (!['super_admin', 'host'].includes(user.role)) {
      res.status(403).json({ error: 'Only Hosts or Super Admins can toggle wall audio.' });
      return;
    }
    const val = req.body?.audio_enabled ? 1 : 0;
    dbRun('UPDATE events SET audio_enabled = ? WHERE id = ?', val, eventId);
    summary = val ? 'Enabled wall audio' : 'Muted wall audio';
  } else if (action === 'toggle_labels') {
    if (!['super_admin', 'host'].includes(user.role)) {
      res.status(403).json({ error: 'Only Hosts or Super Admins can toggle labels.' });
      return;
    }
    const val = req.body?.show_labels ? 1 : 0;
    dbRun('UPDATE events SET show_labels = ? WHERE id = ?', val, eventId);
    summary = val ? 'Enabled name labels' : 'Hid name labels';
  } else if (action === 'set_layout') {
    if (!['super_admin', 'host'].includes(user.role)) {
      res.status(403).json({ error: 'Only Hosts or Super Admins can change layout.' });
      return;
    }
    const layout = String(req.body?.layout || 'single');
    if (!['single', 'split2', 'grid4', 'pip'].includes(layout)) {
      res.status(422).json({ error: 'Invalid layout.' });
      return;
    }
    dbRun('UPDATE events SET layout = ? WHERE id = ?', layout, eventId);
    summary = `Changed layout to ${layout}`;
  } else if (action === 'set_slot_fit') {
    if (!['super_admin', 'host'].includes(user.role)) {
      res.status(403).json({ error: 'Only Hosts or Super Admins can change tile fit mode.' });
      return;
    }
    const maxFeeds = Number(event.max_wall_feeds);
    if (slotNo === null || slotNo < 1 || slotNo > maxFeeds) {
      res.status(422).json({ error: `Slot must be between 1 and ${maxFeeds}.` });
      return;
    }
    const rawFit = req.body?.fit_mode;
    const fitVal = rawFit === null || rawFit === undefined || rawFit === '' || rawFit === 'inherit' ? null : String(rawFit);
    if (fitVal !== null && !['fit', 'fill', 'stretch'].includes(fitVal)) {
      res.status(422).json({ error: 'Invalid tile fit mode.' });
      return;
    }
    dbRun('UPDATE wall_slots SET fit_mode = ? WHERE event_id = ? AND slot_no = ?', fitVal, eventId, slotNo);
    summary = `Slot ${slotNo} fit set to ${fitVal ?? 'event default'}`;
  } else if (action === 'preview_start') {
    dbRun('UPDATE participants SET preview_admin_id = NULL WHERE event_id = ? AND preview_admin_id = ?', eventId, user.id);
    dbRun(
      "UPDATE participants SET preview_admin_id = ?, preview_requested_at = ? WHERE id = ? AND event_id = ? AND status IN ('waiting', 'onair')",
      user.id,
      now,
      pid,
      eventId
    );
    summary = `Started private preview for #${pid}`;
  } else if (action === 'preview_stop') {
    dbRun('UPDATE participants SET preview_admin_id = NULL WHERE event_id = ? AND preview_admin_id = ?', eventId, user.id);
    summary = 'Stopped private preview';
  } else {
    res.status(422).json({ error: 'Unknown wall action.' });
    return;
  }

  dbRun(
    'UPDATE events SET state_version = state_version + 1, last_action_by = ?, last_action_summary = ?, last_action_at = ? WHERE id = ?',
    user.display_name,
    summary,
    now,
    eventId
  );
  logAudit(req, eventId, user.id, user.display_name, `wall_${action}`, summary);
  res.json({ ok: true, summary });
});

app.post('/api/admin/events/:id/participant-action', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host', 'moderator'], true);
  if (!user) return;
  const eventId = Number(req.params.id);
  if (!canAccessEvent(user, eventId)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const action = String(req.body?.action || '');
  const pid = Number(req.body?.participant_id || 0);
  const now = utcNow();

  if (action === 'unban') {
    const banId = Number(req.body?.ban_id || 0);
    dbRun('DELETE FROM bans WHERE id = ? AND event_id = ?', banId, eventId);
    logAudit(req, eventId, user.id, user.display_name, 'unban', `Removed ban #${banId}`);
    res.json({ ok: true });
    return;
  }

  const p = dbGet<Record<string, unknown>>('SELECT * FROM participants WHERE id = ? AND event_id = ?', pid, eventId);
  if (!p) {
    res.status(404).json({ error: 'Participant not found.' });
    return;
  }

  let summary = '';
  if (action === 'mute_toggle') {
    const nextMute = p.muted_by_admin === 1 ? 0 : 1;
    dbRun('UPDATE participants SET muted_by_admin = ? WHERE id = ?', nextMute, pid);
    summary = `${nextMute ? 'Muted' : 'Unmuted'} ${p.display_name}`;
  } else if (action === 'edit_name') {
    const newName = cleanText(req.body?.display_name ?? p.display_name, 40) || String(p.display_name);
    const hidden = req.body?.name_hidden ? 1 : 0;
    dbRun('UPDATE participants SET display_name = ?, name_hidden = ? WHERE id = ?', newName, hidden, pid);
    summary = `Updated name/visibility for ${newName}`;
  } else if (action === 'kick') {
    dbRun('DELETE FROM wall_slots WHERE participant_id = ?', pid);
    dbRun("UPDATE participants SET status = 'removed', thumbnail_data = NULL, preview_admin_id = NULL WHERE id = ?", pid);
    dbRun('UPDATE events SET total_kicked_banned = total_kicked_banned + 1 WHERE id = ?', eventId);
    summary = `Kicked ${p.display_name}`;
    addTimeline(eventId, 'kick', summary);
  } else if (action === 'ban') {
    dbRun('DELETE FROM wall_slots WHERE participant_id = ?', pid);
    dbRun("UPDATE participants SET status = 'banned', thumbnail_data = NULL, preview_admin_id = NULL WHERE id = ?", pid);
    dbRun('UPDATE events SET total_kicked_banned = total_kicked_banned + 1 WHERE id = ?', eventId);
    dbRun(
      'INSERT INTO bans (event_id, ip_hash, session_token, display_name, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      eventId,
      p.ip_hash,
      p.session_token,
      p.display_name,
      cleanText(req.body?.reason || 'Banned by moderator', 180),
      user.id,
      now
    );
    summary = `Banned ${p.display_name}`;
    addTimeline(eventId, 'ban', summary);
  } else {
    res.status(422).json({ error: 'Unknown participant action.' });
    return;
  }

  dbRun(
    'UPDATE events SET state_version = state_version + 1, last_action_by = ?, last_action_summary = ?, last_action_at = ? WHERE id = ?',
    user.display_name,
    summary,
    now,
    eventId
  );
  logAudit(req, eventId, user.id, user.display_name, `participant_${action}`, summary);
  res.json({ ok: true, summary });
});

app.get('/api/admin/events/:id/preview-poll', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host', 'moderator'], false);
  if (!user) return;
  const eventId = Number(req.params.id);
  if (!canAccessEvent(user, eventId)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const targetId = `preview_${user.id}`;
  const signals = dbAll<{ id: number; participant_id: number; type: string; payload: string }>(
    "SELECT id, participant_id, type, payload FROM signals WHERE event_id = ? AND target_id = ? AND direction = 'to_viewer' AND consumed = 0 ORDER BY id ASC",
    eventId,
    targetId
  );
  if (signals.length > 0) {
    const ph = signals.map(() => '?').join(',');
    dbRun(`DELETE FROM signals WHERE id IN (${ph})`, ...signals.map((s) => s.id));
  }
  res.json({
    target_id: targetId,
    signals: signals.map((s) => ({
      id: s.id,
      participant_id: s.participant_id,
      type: s.type,
      payload: JSON.parse(s.payload),
    })),
  });
});

app.post('/api/admin/events/:id/preview-signal', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host', 'moderator'], true);
  if (!user) return;
  const eventId = Number(req.params.id);
  if (!canAccessEvent(user, eventId)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const pid = Number(req.body?.participant_id || 0);
  const type = cleanText(req.body?.type, 32);
  const payload = JSON.stringify(req.body?.payload ?? null);
  if (pid <= 0 || !type) {
    res.status(422).json({ error: 'Invalid preview signal.' });
    return;
  }
  dbRun(
    "INSERT INTO signals (event_id, participant_id, target_id, direction, type, payload, created_at, consumed) VALUES (?, ?, ?, 'to_audience', ?, ?, ?, 0)",
    eventId,
    pid,
    `preview_${user.id}`,
    type,
    payload,
    utcNow()
  );
  res.json({ ok: true });
});

// ---------------- IMAGE BANK API ----------------

app.get('/api/admin/images', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host', 'moderator'], false);
  if (!user) return;
  syncUseCounts();
  const q = String(req.query.q || '').trim();
  const sort = String(req.query.sort || 'newest');
  const orderSql = sort === 'name' ? 'm.label ASC, m.id DESC' : sort === 'used' ? 'm.use_count DESC, m.id DESC' : 'm.created_at DESC, m.id DESC';

  const where = ["(m.visibility = 'shared' OR m.uploaded_by = ?)"];
  const params: unknown[] = [user.id];
  if (q) {
    where.push('(LOWER(m.label) LIKE LOWER(?) OR LOWER(m.tags) LIKE LOWER(?) OR LOWER(m.original_name) LIKE LOWER(?))');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const images = dbAll(
    `SELECT m.*, COALESCE(a.display_name, 'System') AS uploader_name
     FROM media_images m LEFT JOIN admins a ON a.id = m.uploaded_by
     WHERE ${where.join(' AND ')} ORDER BY ${orderSql}`,
    ...params
  );
  res.json({ images, used_bytes: usedBytes(), quota_bytes: quotaBytes() });
});

app.post('/api/admin/images/upload', (req, res, next) => {
  upload.array('files[]', 20)(req, res, (err) => {
    if (err) {
      res.status(422).json({ error: err.message || 'Upload failed (max 2 MB).' });
      return;
    }
    next();
  });
}, (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host'], true);
  if (!user) return;
  const files = (req.files as Express.Multer.File[]) || [];
  if (files.length === 0) {
    res.status(422).json({ error: 'No files uploaded.' });
    return;
  }
  const visibility = req.body?.visibility === 'private' ? 'private' : 'shared';
  const tags = cleanText(req.body?.tags, 200);
  const uploaded: Array<{ ok: boolean; duplicate: boolean; image: Record<string, unknown> }> = [];
  const errors: string[] = [];

  for (const file of files) {
    const info = detectImageTypeAndDims(file.buffer);
    if (!info) {
      errors.push(`${file.originalname}: Unsupported or non-image file.`);
      continue;
    }
    if (info.width <= 0 || info.height <= 0 || info.width > CONFIG.maxImageDim || info.height > CONFIG.maxImageDim) {
      errors.push(`${file.originalname}: Dimensions out of bounds.`);
      continue;
    }
    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const existing = dbGet<Record<string, unknown>>(
      "SELECT * FROM media_images WHERE file_hash = ? AND (visibility = 'shared' OR uploaded_by = ?) LIMIT 1",
      hash,
      user.id
    );
    if (existing) {
      uploaded.push({ ok: true, duplicate: true, image: existing });
      continue;
    }
    if (usedBytes() + file.size > quotaBytes()) {
      errors.push(`${file.originalname}: Image Bank quota exceeded.`);
      continue;
    }

    let finalBuf = file.buffer;
    if (info.isSvg) {
      const sanitized = sanitizeSvg(file.buffer.toString('utf8'));
      if (!sanitized) {
        errors.push(`${file.originalname}: SVG failed security validation.`);
        continue;
      }
      finalBuf = Buffer.from(sanitized, 'utf8');
    }

    const filename = `${crypto.randomBytes(16).toString('hex')}.${info.ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), finalBuf);
    const label = cleanText(path.parse(file.originalname).name || 'Logo', 100);

    const ins = dbRun(
      `INSERT INTO media_images (filename, original_name, label, tags, file_hash, mime_type, width, height, size, thumb_path, visibility, is_default, uploaded_by, use_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
      filename,
      cleanText(file.originalname, 200),
      label,
      tags,
      hash,
      info.mime,
      info.width,
      info.height,
      finalBuf.length,
      filename,
      visibility,
      user.id,
      utcNow()
    );
    const row = dbGet<Record<string, unknown>>('SELECT * FROM media_images WHERE id = ?', ins.lastInsertRowid)!;
    uploaded.push({ ok: true, duplicate: false, image: row });
    logAudit(req, null, user.id, user.display_name, 'image_uploaded', `Uploaded ${label}`);
  }

  if (uploaded.length === 0 && errors.length > 0) {
    res.status(422).json({ error: errors.join(' | ') });
    return;
  }
  res.json({ uploaded, errors, used_bytes: usedBytes(), quota_bytes: quotaBytes() });
});

app.post('/api/admin/images/:id', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host'], true);
  if (!user) return;
  const imageId = Number(req.params.id);
  const img = dbGet<Record<string, unknown>>('SELECT * FROM media_images WHERE id = ?', imageId);
  if (!img) {
    res.status(404).json({ error: 'Image not found.' });
    return;
  }
  if (img.visibility === 'private' && img.uploaded_by !== user.id && user.role !== 'super_admin') {
    res.status(403).json({ error: 'Forbidden.' });
    return;
  }
  const label = req.body?.label !== undefined ? cleanText(req.body.label, 100) || String(img.label) : String(img.label);
  const tags = req.body?.tags !== undefined ? cleanText(req.body.tags, 200) : String(img.tags);
  let visibility = ['shared', 'private'].includes(req.body?.visibility) ? req.body.visibility : String(img.visibility);
  let isDefault = req.body?.is_default !== undefined ? (req.body.is_default ? 1 : 0) : Number(img.is_default);
  if (req.body?.is_default) {
    dbRun('UPDATE media_images SET is_default = 0');
    isDefault = 1;
    visibility = 'shared';
  }
  dbRun('UPDATE media_images SET label = ?, tags = ?, visibility = ?, is_default = ? WHERE id = ?', label, tags, visibility, isDefault, imageId);
  logAudit(req, null, user.id, user.display_name, 'image_updated', `Updated image #${imageId} (${label})`);
  res.json({ ok: true });
});

app.post('/api/admin/images/:id/replace-everywhere', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host'], true);
  if (!user) return;
  const imageId = Number(req.params.id);
  const repId = req.body?.replacement_image_id ? Number(req.body.replacement_image_id) : null;
  if (repId !== null && !dbGet('SELECT id FROM media_images WHERE id = ?', repId)) {
    res.status(404).json({ error: 'Replacement image not found.' });
    return;
  }
  dbRun('UPDATE events SET logo_image_id = ?, state_version = state_version + 1 WHERE logo_image_id = ?', repId, imageId);
  dbRun('UPDATE events SET join_logo_image_id = ?, state_version = state_version + 1 WHERE join_logo_image_id = ?', repId, imageId);
  syncUseCounts();
  logAudit(req, null, user.id, user.display_name, 'image_replaced', `Replaced logo #${imageId} everywhere`);
  res.json({ ok: true });
});

app.delete('/api/admin/images/:id', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin', 'host'], true);
  if (!user) return;
  const imageId = Number(req.params.id);
  const img = dbGet<Record<string, unknown>>('SELECT * FROM media_images WHERE id = ?', imageId);
  if (!img) {
    res.status(404).json({ error: 'Image not found.' });
    return;
  }
  if (img.visibility === 'private' && img.uploaded_by !== user.id && user.role !== 'super_admin') {
    res.status(403).json({ error: 'Forbidden.' });
    return;
  }
  const usedBy = dbAll('SELECT id, title FROM events WHERE logo_image_id = ? OR join_logo_image_id = ?', imageId, imageId);
  if (usedBy.length > 0 && req.query.force !== '1') {
    res.status(409).json({ error: `Image is currently used by ${usedBy.length} event(s).`, in_use: true, events: usedBy });
    return;
  }
  if (usedBy.length > 0) {
    dbRun('UPDATE events SET logo_image_id = NULL, state_version = state_version + 1 WHERE logo_image_id = ?', imageId);
    dbRun('UPDATE events SET join_logo_image_id = NULL, state_version = state_version + 1 WHERE join_logo_image_id = ?', imageId);
  }
  dbRun('DELETE FROM media_images WHERE id = ?', imageId);
  const f1 = path.join(UPLOAD_DIR, path.basename(String(img.filename)));
  if (fs.existsSync(f1)) fs.unlinkSync(f1);
  syncUseCounts();
  logAudit(req, null, user.id, user.display_name, 'image_deleted', `Deleted image ${img.label} (#${imageId})`);
  res.json({ ok: true });
});

// ---------------- ACCOUNTS & AUDIT (SUPER ADMIN) ----------------

app.get('/api/admin/accounts', (req, res) => {
  const user = requireApiAuth(req, res, ['super_admin'], false);
  if (!user) return;
  const admins = dbAll<Record<string, unknown>>(
    'SELECT id, username, display_name, email, role, status, event_scope, must_change_password, last_login, created_at FROM admins ORDER BY id ASC'
  );
  const assigns = dbAll<{ admin_id: number; event_id: number }>('SELECT admin_id, event_id FROM admin_event_access');
  const map = new Map<number, number[]>();
  for (const a of assigns) {
    if (!map.has(a.admin_id)) map.set(a.admin_id, []);
    map.get(a.admin_id)!.push(a.event_id);
  }
  res.json({
    accounts: admins.map((a) => ({
      ...a,
      id: Number(a.id),
      must_change_password: a.must_change_password === 1,
      event_ids: map.get(Number(a.id)) || [],
    })),
  });
});

app.post('/api/admin/accounts', (req, res) => {
  const actor = requireApiAuth(req, res, ['super_admin'], true);
  if (!actor) return;
  const username = cleanSlug(String(req.body?.username || ''));
  const displayName = cleanText(req.body?.display_name, 100);
  const email = cleanText(req.body?.email, 190);
  const role = ['super_admin', 'host', 'moderator'].includes(req.body?.role) ? req.body.role : 'host';
  const password = String(req.body?.password || '');
  const eventScope = req.body?.event_scope === 'assigned' ? 'assigned' : 'all';
  const eventIds = Array.isArray(req.body?.event_ids) ? req.body.event_ids : [];

  if (!username || !displayName) {
    res.status(422).json({ error: 'Username and display name are required.' });
    return;
  }
  const pwErr = validatePasswordStrength(password);
  if (pwErr) {
    res.status(422).json({ error: pwErr });
    return;
  }
  if (dbGet('SELECT id FROM admins WHERE username = ?', username)) {
    res.status(409).json({ error: 'Username already exists.' });
    return;
  }
  const info = dbRun(
    'INSERT INTO admins (username, display_name, email, password_hash, role, status, event_scope, must_change_password, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
    username,
    displayName,
    email,
    bcrypt.hashSync(password, 10),
    role,
    'active',
    eventScope,
    actor.id,
    utcNow()
  );
  const newId = Number(info.lastInsertRowid);
  if (eventScope === 'assigned') {
    for (const eid of eventIds) {
      if (Number(eid) > 0) dbRun('INSERT INTO admin_event_access (admin_id, event_id) VALUES (?, ?)', newId, Number(eid));
    }
  }
  logAudit(req, null, actor.id, actor.display_name, 'account_created', `Created ${role} account ${username}`);
  res.status(201).json({ ok: true, id: newId });
});

app.post('/api/admin/accounts/:id', (req, res) => {
  const actor = requireApiAuth(req, res, ['super_admin'], true);
  if (!actor) return;
  const accountId = Number(req.params.id);
  const target = dbGet<Record<string, unknown>>('SELECT * FROM admins WHERE id = ?', accountId);
  if (!target) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  const displayName = req.body?.display_name !== undefined ? cleanText(req.body.display_name, 100) : String(target.display_name);
  const email = req.body?.email !== undefined ? cleanText(req.body.email, 190) : String(target.email);
  const role = ['super_admin', 'host', 'moderator'].includes(req.body?.role) ? req.body.role : String(target.role);
  const status = ['active', 'disabled'].includes(req.body?.status) ? req.body.status : String(target.status);
  const eventScope = ['all', 'assigned'].includes(req.body?.event_scope) ? req.body.event_scope : String(target.event_scope);

  if (actor.id === accountId && (status !== 'active' || role !== 'super_admin')) {
    res.status(422).json({ error: 'You cannot disable yourself or demote your own Super Admin role.' });
    return;
  }
  dbRun(
    'UPDATE admins SET display_name = ?, email = ?, role = ?, status = ?, event_scope = ? WHERE id = ?',
    displayName,
    email,
    role,
    status,
    eventScope,
    accountId
  );
  if (status !== 'active') dbRun('UPDATE admin_sessions SET revoked = 1 WHERE admin_id = ?', accountId);
  if (Array.isArray(req.body?.event_ids)) {
    dbRun('DELETE FROM admin_event_access WHERE admin_id = ?', accountId);
    if (eventScope === 'assigned') {
      for (const eid of req.body.event_ids) {
        if (Number(eid) > 0) dbRun('INSERT INTO admin_event_access (admin_id, event_id) VALUES (?, ?)', accountId, Number(eid));
      }
    }
  }
  logAudit(req, null, actor.id, actor.display_name, 'account_updated', `Updated account ${target.username} (${role}, ${status})`);
  res.json({ ok: true });
});

app.post('/api/admin/accounts/:id/reset-password', (req, res) => {
  const actor = requireApiAuth(req, res, ['super_admin'], true);
  if (!actor) return;
  const accountId = Number(req.params.id);
  const target = dbGet<{ username: string }>('SELECT username FROM admins WHERE id = ?', accountId);
  if (!target) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  const pw = String(req.body?.password || '');
  const err = validatePasswordStrength(pw);
  if (err) {
    res.status(422).json({ error: err });
    return;
  }
  dbRun('UPDATE admins SET password_hash = ?, must_change_password = 1 WHERE id = ?', bcrypt.hashSync(pw, 10), accountId);
  dbRun('UPDATE admin_sessions SET revoked = 1 WHERE admin_id = ?', accountId);
  logAudit(req, null, actor.id, actor.display_name, 'account_password_reset', `Reset password for ${target.username}`);
  res.json({ ok: true });
});

app.post('/api/admin/accounts/:id/revoke-sessions', (req, res) => {
  const actor = requireApiAuth(req, res, ['super_admin'], true);
  if (!actor) return;
  const accountId = Number(req.params.id);
  const target = dbGet<{ username: string }>('SELECT username FROM admins WHERE id = ?', accountId);
  if (!target) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  dbRun('UPDATE admin_sessions SET revoked = 1 WHERE admin_id = ?', accountId);
  logAudit(req, null, actor.id, actor.display_name, 'account_sessions_revoked', `Revoked sessions for ${target.username}`);
  res.json({ ok: true });
});

app.delete('/api/admin/accounts/:id', (req, res) => {
  const actor = requireApiAuth(req, res, ['super_admin'], true);
  if (!actor) return;
  const accountId = Number(req.params.id);
  if (actor.id === accountId) {
    res.status(422).json({ error: 'You cannot delete your own account.' });
    return;
  }
  const target = dbGet<{ username: string }>('SELECT username FROM admins WHERE id = ?', accountId);
  if (!target) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  dbRun('DELETE FROM admins WHERE id = ?', accountId);
  logAudit(req, null, actor.id, actor.display_name, 'account_deleted', `Deleted account ${target.username}`);
  res.json({ ok: true });
});

app.get('/api/admin/audit', (req, res) => {
  const actor = requireApiAuth(req, res, ['super_admin'], false);
  if (!actor) return;
  const eventId = req.query.event_id ? Number(req.query.event_id) : null;
  const q = String(req.query.q || '').trim();
  const where = ['1=1'];
  const params: unknown[] = [];
  if (eventId) {
    where.push('al.event_id = ?');
    params.push(eventId);
  }
  if (q) {
    where.push('(LOWER(al.admin_name) LIKE LOWER(?) OR LOWER(al.details) LIKE LOWER(?) OR LOWER(al.action) LIKE LOWER(?))');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const logs = dbAll(
    `SELECT al.*, e.title AS event_title
     FROM audit_log al LEFT JOIN events e ON e.id = al.event_id
     WHERE ${where.join(' AND ')} ORDER BY al.id DESC LIMIT 200`,
    ...params
  );
  res.json({ logs });
});

function maskKeyId(val: string): string {
  if (val.length <= 8) return '*'.repeat(val.length);
  return `${val.slice(0, 4)}...${val.slice(-4)}`;
}

function buildTurnStatusPayload() {
  const override = readTurnOverride();
  const cf = getCloudflareTurnConfig();
  const st = getEffectiveTurnConfig();
  let mode: 'cloudflare' | 'static' | 'none' = 'none';
  let source: 'db' | 'env' | 'none' = 'none';
  if (cf) {
    mode = 'cloudflare';
    source = cf.source;
  } else if (st.urls.length > 0) {
    mode = 'static';
    source = st.source;
  } else if (override) {
    source = 'db';
  }
  return {
    mode,
    source,
    configured: turnConfigured(),
    error: getTurnError(),
    cf_key_preview: cf ? maskKeyId(cf.keyId) : '',
    cf_ttl: cf ? cf.ttl : 86400,
    has_cf_token: Boolean(cf),
    turn_url: st.urls.join(', '),
    turn_user: st.user,
    has_turn_pass: Boolean(st.pass),
  };
}

app.get('/api/admin/turn-config', (req, res) => {
  const actor = requireApiAuth(req, res, ['super_admin'], false);
  if (!actor) return;
  res.json(buildTurnStatusPayload());
});

app.post('/api/admin/turn-config', async (req, res) => {
  const actor = requireApiAuth(req, res, ['super_admin'], true);
  if (!actor) return;
  const action = String(req.body?.action || 'save').trim();
  if (action === 'clear') {
    dbRun("DELETE FROM system_settings WHERE setting_key = 'turn_config'");
    clearCfIceCache();
    logAudit(req, null, actor.id, actor.display_name, 'turn_config_cleared', 'Cleared saved TURN override');
    res.json({
      ok: true,
      message: 'Saved TURN override cleared. Falling back to .env configuration.',
      status: buildTurnStatusPayload(),
    });
    return;
  }

  const mode = String(req.body?.mode || 'cloudflare').trim();
  const existing = readTurnOverride();

  if (mode === 'cloudflare') {
    const keyId = String(req.body?.cf_key_id || '').trim();
    let token = String(req.body?.cf_api_token || '').trim();
    const rawTtl = Number(req.body?.cf_ttl || 86400);
    const ttl = Number.isFinite(rawTtl) ? Math.max(60, Math.min(86400, Math.floor(rawTtl))) : 86400;

    if (!token && existing?.mode === 'cloudflare' && existing.cf_key_id === keyId) {
      token = String(existing.cf_api_token || '').trim();
    }
    if (!isNonPlaceholderSecret(keyId) || !isNonPlaceholderSecret(token)) {
      res.status(422).json({ error: 'Both Cloudflare TURN Token ID and API Token are required.' });
      return;
    }

    const test = await requestCloudflareIceServers(keyId, token, ttl);
    if (!test.ok) {
      const extra = /cannot find specified key/i.test(test.error)
        ? ' Make sure you copied the TURN Token ID under Cloudflare Dashboard → Realtime → TURN (do not use your Account ID or Realtime SFU App ID, and ensure the Token belongs to that same TURN key).'
        : '';
      res.status(400).json({ error: `Cloudflare rejected credentials (${test.error}).${extra}` });
      return;
    }

    const payload = { mode: 'cloudflare', cf_key_id: keyId, cf_api_token: token, cf_ttl: ttl };
    dbRun(
      `INSERT INTO system_settings (setting_key, setting_value, updated_at) VALUES ('turn_config', ?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
      JSON.stringify(payload),
      utcNow()
    );
    cfIceCache = {
      cacheKey: cfCacheKeyFor({ keyId, apiToken: token, ttl }),
      servers: test.servers,
      expiresAt: Date.now() + Math.min(43200, Math.max(30, Math.floor(ttl * 0.5))) * 1000,
      failUntil: 0,
      lastError: '',
      loggedFailKey: '',
      inFlight: null,
    };
    logAudit(req, null, actor.id, actor.display_name, 'turn_config_updated', `Verified and saved Cloudflare Realtime TURN key (${maskKeyId(keyId)})`);
    res.json({
      ok: true,
      ice_count: test.servers.length,
      message: `Cloudflare TURN verified and saved (${test.servers.length} ICE entries generated).`,
      status: buildTurnStatusPayload(),
    });
    return;
  }

  if (mode === 'static') {
    const rawUrl = String(req.body?.turn_url || '').trim();
    const urls = rawUrl.split(',').map((s) => s.trim()).filter(isValidIceUrl);
    const user = String(req.body?.turn_user || '').trim();
    let pass = String(req.body?.turn_pass || '').trim();
    if (!pass && existing?.mode === 'static') {
      pass = String(existing.turn_pass || '').trim();
    }
    if (urls.length === 0) {
      res.status(422).json({ error: 'Enter at least one valid turn: or turns: URL (e.g. turns:turn.example.com:5349?transport=tcp).' });
      return;
    }
    if (!isNonPlaceholderSecret(user) || !isNonPlaceholderSecret(pass)) {
      res.status(422).json({ error: 'Static TURN Username and Credential are required.' });
      return;
    }
    const payload = { mode: 'static', turn_url: urls.join(','), turn_user: user, turn_pass: pass };
    dbRun(
      `INSERT INTO system_settings (setting_key, setting_value, updated_at) VALUES ('turn_config', ?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
      JSON.stringify(payload),
      utcNow()
    );
    clearCfIceCache();
    logAudit(req, null, actor.id, actor.display_name, 'turn_config_updated', 'Saved static TURN configuration');
    res.json({
      ok: true,
      message: 'Static TURN configuration saved.',
      status: buildTurnStatusPayload(),
    });
    return;
  }

  res.status(422).json({ error: 'Unsupported TURN mode.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QR Live Wall server running at http://0.0.0.0:${PORT}`);
});
