// ─── GUARDRAILS DE ENVIO ─────────────────────────────────────────────────────
// Regras de segurança para envio de mensagens via WhatsApp MCP.

import fs from "fs";
import os from "os";
import path from "path";

// ─── CONSTANTES FIXAS (não configuráveis) ────────────────────────────────────

const RATE_LIMIT_PER_MINUTE = 10;       // máximo de envios por minuto — FIXO
const MAX_RECIPIENTS_PER_DAY = 50;      // máximo de destinatários únicos por dia
const MSG_LIMIT_SOFT = 1000;            // acima disso exige confirmed=true
const MSG_LIMIT_HARD = 2000;            // acima disso bloqueado mesmo com confirmed
const ANTI_LOOP_WINDOW_MS = 60_000;     // janela anti-loop (ms)
const SEND_DELAY_MS = 10_000;           // janela de cancelamento (ms)

// ─── ESTADO EM MEMÓRIA ───────────────────────────────────────────────────────

let sendTimestamps = [];                // para rate limit
let recentSends = [];                   // para anti-loop: { chatId, hash, ts }

// ─── ESTADO PERSISTIDO ───────────────────────────────────────────────────────

const STATE_FILE = path.join(os.tmpdir(), "whatsapp-mcp-state.json");
const AUDIT_FILE = path.join(os.homedir(), ".whatsapp-mcp-audit.jsonl");

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const state = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    if (state.date !== today) {
      return { date: today, recipients: [] };
    }
    return state;
  } catch {
    return { date: new Date().toISOString().slice(0, 10), recipients: [] };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

// ─── RATE LIMIT ──────────────────────────────────────────────────────────────

export function checkRateLimit() {
  const now = Date.now();
  sendTimestamps = sendTimestamps.filter((t) => now - t < 60_000);
  if (sendTimestamps.length >= RATE_LIMIT_PER_MINUTE) {
    throw new Error(
      `Rate limit atingido: máximo ${RATE_LIMIT_PER_MINUTE} mensagens por minuto. ` +
      `Aguarde alguns segundos.`
    );
  }
  sendTimestamps.push(now);
}

// ─── LIMITE DIÁRIO DE DESTINATÁRIOS ──────────────────────────────────────────

export function checkDailyRecipientLimit(chatId) {
  const state = readState();
  if (!state.recipients.includes(chatId)) {
    if (state.recipients.length >= MAX_RECIPIENTS_PER_DAY) {
      throw new Error(
        `Limite diário atingido: máximo ${MAX_RECIPIENTS_PER_DAY} destinatários únicos por dia. ` +
        `Já enviado para ${state.recipients.length} pessoas hoje.`
      );
    }
    state.recipients.push(chatId);
    saveState(state);
  }
}

export function getDailyStats() {
  const state = readState();
  return {
    date: state.date,
    uniqueRecipients: state.recipients.length,
    maxRecipients: MAX_RECIPIENTS_PER_DAY,
    remaining: MAX_RECIPIENTS_PER_DAY - state.recipients.length,
  };
}

// ─── CONFIRMAÇÃO PARA GRUPOS ─────────────────────────────────────────────────

export function checkGroupConfirmation(chatId, confirmed) {
  if (chatId.includes("@g.us") && !confirmed) {
    throw new Error(
      `Envio para grupos requer confirmação explícita. ` +
      `Use confirmed: true para confirmar o envio para este grupo.`
    );
  }
}

// ─── LIMITE DE TAMANHO ───────────────────────────────────────────────────────

export function checkMessageLength(text, confirmed) {
  if (text.length > MSG_LIMIT_HARD) {
    throw new Error(
      `Mensagem muito longa (${text.length} caracteres). Máximo permitido: ${MSG_LIMIT_HARD}. ` +
      `Divida em partes menores.`
    );
  }
  if (text.length > MSG_LIMIT_SOFT && !confirmed) {
    throw new Error(
      `Mensagem longa (${text.length} caracteres, limite padrão: ${MSG_LIMIT_SOFT}). ` +
      `Use confirmed: true para confirmar o envio de mensagem longa (máx ${MSG_LIMIT_HARD} chars).`
    );
  }
}

// ─── ANTI-LOOP ───────────────────────────────────────────────────────────────
// Bloqueia o mesmo texto para o mesmo destinatário em menos de 60s.

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}

export function checkAntiLoop(chatId, text) {
  const now = Date.now();
  recentSends = recentSends.filter((s) => now - s.ts < ANTI_LOOP_WINDOW_MS);
  const hash = simpleHash(text);
  const duplicate = recentSends.find((s) => s.chatId === chatId && s.hash === hash);
  if (duplicate) {
    const secsAgo = Math.round((now - duplicate.ts) / 1000);
    throw new Error(
      `Anti-loop: esta mensagem já foi enviada para este destinatário há ${secsAgo}s. ` +
      `Aguarde ${Math.round(ANTI_LOOP_WINDOW_MS / 1000)}s antes de reenviar o mesmo texto.`
    );
  }
  recentSends.push({ chatId, hash, ts: now });
}

// ─── BLOQUEIO DE CONTEÚDO SENSÍVEL ───────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  { pattern: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/, label: "número de cartão de crédito" },
  { pattern: /\b\d{3}\.?\d{3}\.?\d{3}[\-\.]?\d{2}\b/, label: "CPF" },
  { pattern: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}[\-\.]?\d{2}\b/, label: "CNPJ" },
  { pattern: /senha\s*[:=]\s*\S+/i, label: "senha" },
  { pattern: /password\s*[:=]\s*\S+/i, label: "password" },
  { pattern: /token\s*[:=]\s*[A-Za-z0-9\-_]{20,}/i, label: "token/chave de API" },
];

export function checkSensitiveContent(text, confirmed) {
  if (confirmed) return; // usuário confirmou explicitamente
  const found = [];
  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) found.push(label);
  }
  if (found.length > 0) {
    throw new Error(
      `⚠️ Conteúdo potencialmente sensível detectado: ${found.join(", ")}.\n` +
      `Tem certeza que quer enviar? Use confirmed: true para confirmar.`
    );
  }
}

// ─── JANELA DE CANCELAMENTO ──────────────────────────────────────────────────
// Aguarda SEND_DELAY_MS antes de enviar de fato.
// Retorna uma Promise que resolve após o delay.

export function sendDelay() {
  return new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
}

export const SEND_DELAY_SECONDS = SEND_DELAY_MS / 1000;

// ─── LOG DE AUDITORIA ─────────────────────────────────────────────────────────

export function logAudit(entry) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + "\n";
    fs.appendFileSync(AUDIT_FILE, line);
  } catch {}
}

export function getAuditLog(limit = 50) {
  try {
    const content = fs.readFileSync(AUDIT_FILE, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
