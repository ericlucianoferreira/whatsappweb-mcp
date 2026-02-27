// ─── CONFIGURAÇÃO DO WHATSAPP MCP ───────────────────────────────────────────

export const WS_PORT = 3847;
export const WS_PATH = "/whatsapp-bridge";

// Rate limiting: máximo de mensagens enviadas por minuto
export const MAX_SEND_PER_MINUTE = 10;

// Delay humanizado para envio (ms)
export const SEND_DELAY_MIN = 800;
export const SEND_DELAY_MAX = 2500;

// WebSocket keep-alive interval (ms)
export const PING_INTERVAL = 20_000;

// Timeout para aguardar resposta da extensão (ms)
export const COMMAND_TIMEOUT = 15_000;
