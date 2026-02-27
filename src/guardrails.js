// ─── GUARDRAILS DE ENVIO ─────────────────────────────────────────────────────
// Regras invioláveis para envio de mensagens via WhatsApp MCP.

import fs from "fs";
import os from "os";
import path from "path";

// ─── CONSTANTES FIXAS (não configuráveis) ────────────────────────────────────

const RATE_LIMIT_PER_MINUTE = 10;       // máximo de envios por minuto — FIXO
const MAX_RECIPIENTS_PER_DAY = 50;      // máximo de destinatários únicos por dia

// ─── ESTADO EM MEMÓRIA ───────────────────────────────────────────────────────

let sendTimestamps = [];                // timestamps dos últimos envios (rate limit)

// ─── ESTADO PERSISTIDO ───────────────────────────────────────────────────────

const STATE_FILE = path.join(os.tmpdir(), "whatsapp-mcp-state.json");
const AUDIT_FILE = path.join(os.homedir(), ".whatsapp-mcp-audit.jsonl");

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const state = JSON.parse(raw);
    // Reset se for de outro dia
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

// ─── LIMITE DIÁRIO DE DESTINATÁRIOS ─────────────────────────────────────────

export function checkDailyRecipientLimit(chatId) {
  const state = readState();
  if (!state.recipients.includes(chatId)) {
    if (state.recipients.length >= MAX_RECIPIENTS_PER_DAY) {
      throw new Error(
        `Limite diário atingido: máximo ${MAX_RECIPIENTS_PER_DAY} destinatários únicos por dia. ` +
        `Já enviado para ${state.recipients.length} pessoas hoje.`
      );
    }
  }
  // Registrar destinatário (se novo)
  if (!state.recipients.includes(chatId)) {
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
      `Adicione o parâmetro confirmed: true para confirmar o envio para este grupo.`
    );
  }
}

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
