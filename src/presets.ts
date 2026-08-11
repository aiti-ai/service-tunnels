/**
 * Provider/tunnel 参数变体（Presets —— 「另存为常用」）。
 *
 * 用户在暴露表单填好隧道/认证参数后，可把整组参数保存为一个命名变体
 * （如「我的ngrok」），后续下拉直接选用带入参数；可编辑/删除。
 *
 * 存储：configDir/service-tunnels.json 的 `tunnelPresets` / `authPresets`
 * （writeConfigFile 持久化，与 allowToolDownload 同路径）。
 *
 * 加密：敏感字段（key 匹配 token/secret/password/key）用 AES-256-GCM 加密，
 * 密文格式 `enc:v1:<iv>:<tag>:<data>`（均 base64）。密钥首次生成存
 * cacheDir/presets.key（0600）。解密失败视为损坏跳过（不阻塞其他 preset）。
 *
 * 回显策略：`list()` 返回掩码敏感字段（供 UI 展示）；`get()` 返回明文（供
 * 暴露时合并进 tunnelParams/providerParams）；`save()` 的敏感字段入参即密文
 * 存储。UI 表单敏感字段留空 = 用已存值（合并时处理）。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { join } from "path";

export type PresetKind = "tunnel" | "auth";

export interface Preset {
  name: string;
  kind: PresetKind;
  /** tunnel 类型（ngrok/cloudflared/…）或 auth provider（portal/oauth2-github/…）。 */
  type: string;
  params: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** 敏感字段判定（password 类型或 key 匹配 token/secret/password/key）。 */
export function isSensitiveKey(key: string): boolean {
  return /token|secret|password|key/i.test(key);
}

const ALGO = "aes-256-gcm";
const ENC_PREFIX = "enc:v1:";

// ── AES-256-GCM 加解密 ───────────────────────────────────────────────────

function encrypt(secret: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, secret, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

function decrypt(secret: Buffer, blob: string): string {
  if (!blob.startsWith(ENC_PREFIX)) throw new Error("not an encrypted blob");
  const parts = blob.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("malformed encrypted blob");
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, secret, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** 读取/生成 presets 密钥（cacheDir/presets.key, 0600）。 */
export function loadPresetsKey(cacheDir: string): Buffer {
  const p = join(cacheDir, "presets.key");
  if (existsSync(p)) {
    const k = readFileSync(p);
    if (k.length === 32) return k;
  }
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(p, key, { mode: 0o600 });
  return key;
}

// ── 配置档读写（tunnelPresets / authPresets）──────────────────────────────

export interface PresetFileRow {
  name: string;
  type: string;
  /** 敏感字段已是密文 enc:v1:…；非敏感字段明文。 */
  params: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export function readPresetRows(
  file: { tunnelPresets?: PresetFileRow[]; authPresets?: PresetFileRow[] },
  kind: PresetKind,
): PresetFileRow[] {
  const rows = kind === "tunnel" ? (file.tunnelPresets ?? []) : (file.authPresets ?? []);
  return Array.isArray(rows) ? rows : [];
}

/** 列表：敏感字段掩码（UI 展示用），损坏密文跳过。 */
export function listPresets(
  file: { tunnelPresets?: PresetFileRow[]; authPresets?: PresetFileRow[] },
  kind: PresetKind,
  type: string | undefined,
  secret: Buffer,
): Preset[] {
  const out: Preset[] = [];
  for (const row of readPresetRows(file, kind)) {
    if (type && row.type !== type) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (const [k, v] of Object.entries(row.params ?? {})) {
      if (!isSensitiveKey(k)) { params[k] = v; continue; }
      try { params[k] = decrypt(secret, v); } catch { ok = false; break; }
    }
    if (!ok) continue; // 损坏条目跳过
    // 掩码敏感字段（明文也先解密再掩码 —— UI 只拿掩码版）
    for (const k of Object.keys(params)) {
      if (isSensitiveKey(k)) params[k] = maskSecret(params[k] ?? "");
    }
    out.push({ name: row.name, kind, type: row.type, params, createdAt: row.createdAt, updatedAt: row.updatedAt });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 取单个（明文，供暴露合并）。不存在/损坏 → undefined。 */
export function getPreset(
  file: { tunnelPresets?: PresetFileRow[]; authPresets?: PresetFileRow[] },
  kind: PresetKind,
  type: string,
  name: string,
  secret: Buffer,
): Preset | undefined {
  const row = readPresetRows(file, kind).find((r) => r.type === type && r.name === name);
  if (!row) return undefined;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.params ?? {})) {
    if (!isSensitiveKey(k)) { params[k] = v; continue; }
    try { params[k] = decrypt(secret, v); } catch { return undefined; }
  }
  return { name: row.name, kind, type: row.type, params, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** 保存（敏感字段加密落盘）。同 (type,name) 覆盖。 */
export function savePreset(
  file: { tunnelPresets?: PresetFileRow[]; authPresets?: PresetFileRow[] },
  kind: PresetKind,
  type: string,
  name: string,
  params: Record<string, string | number | boolean | undefined>,
  secret: Buffer,
): PresetFileRow {
  const now = Date.now();
  const encrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue; // 空值不存
    const s = String(v);
    encrypted[k] = isSensitiveKey(k) ? encrypt(secret, s) : s;
  }
  const rows = readPresetRows(file, kind);
  const idx = rows.findIndex((r) => r.type === type && r.name === name);
  const row: PresetFileRow = { name, type, params: encrypted, createdAt: idx >= 0 ? rows[idx]!.createdAt : now, updatedAt: now };
  if (idx >= 0) rows[idx] = row;
  else rows.push(row);
  if (kind === "tunnel") file.tunnelPresets = rows;
  else file.authPresets = rows;
  return row;
}

/** 删除。返回是否删除成功。 */
export function removePreset(
  file: { tunnelPresets?: PresetFileRow[]; authPresets?: PresetFileRow[] },
  kind: PresetKind,
  type: string,
  name: string,
): boolean {
  const rows = readPresetRows(file, kind);
  const next = rows.filter((r) => !(r.type === type && r.name === name));
  if (next.length === rows.length) return false;
  if (kind === "tunnel") file.tunnelPresets = next;
  else file.authPresets = next;
  return true;
}

/** 掩码：只留末 4 位。 */
export function maskSecret(v: string): string {
  if (v.length <= 4) return "••••";
  return `••••${v.slice(-4)}`;
}

/** 参数摘要（UI 下拉旁显示）：非敏感字段 + 敏感字段计数。 */
export function presetSummary(params: Record<string, string>): string {
  const plain = Object.entries(params).filter(([k]) => !isSensitiveKey(k)).map(([k, v]) => `${k}=${v}`).join(", ");
  const secrets = Object.keys(params).filter((k) => isSensitiveKey(k)).length;
  return plain + (secrets ? `${plain ? " · " : ""}${secrets} 个敏感字段` : "");
}
