// ─── TOOLS: MENSAGENS ────────────────────────────────────────────────────────

import { z } from "zod";
import { sendCommand } from "../ws-bridge.js";
import { MAX_SEND_PER_MINUTE } from "../config.js";

// Rate limiting simples para envio
let sendTimestamps = [];

function checkRateLimit() {
  const now = Date.now();
  sendTimestamps = sendTimestamps.filter((t) => now - t < 60_000);
  if (sendTimestamps.length >= MAX_SEND_PER_MINUTE) {
    throw new Error(
      `Rate limit: máximo ${MAX_SEND_PER_MINUTE} mensagens por minuto. ` +
      `Aguarde alguns segundos antes de enviar novamente.`
    );
  }
  sendTimestamps.push(now);
}

export function registerMessageTools(server) {
  // ─── list_messages ─────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_list_messages",
    "Lista mensagens recentes de um chat do WhatsApp. CUIDADO: abrir mensagens de um chat pode marcá-las como lidas (blue ticks). Para ver não lidas sem risco, use whatsapp_get_unread_chats primeiro.",
    {
      chat_id: z.string().describe("ID do chat"),
      limit: z.number().optional().default(30).describe("Quantidade de mensagens (padrão 30, máx 50)"),
    },
    async ({ chat_id, limit }) => {
      try {
        const result = await sendCommand("GET_MESSAGES", {
          chatId: chat_id,
          limit: Math.min(limit, 50),
        });

        if (!result.messages || result.messages.length === 0) {
          return { content: [{ type: "text", text: "Nenhuma mensagem encontrada." }] };
        }

        const formatted = result.messages.map((m) => ({
          id: m.id,
          from: m.from || (m.fromMe ? "Eu" : m.sender || "Desconhecido"),
          body: m.body || "",
          timestamp: m.timestamp,
          fromMe: m.fromMe || false,
          type: m.type || "chat",
          hasMedia: m.hasMedia || false,
        }));

        return {
          content: [{
            type: "text",
            text: `${formatted.length} mensagem(ns):\n\n${JSON.stringify(formatted, null, 2)}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── send_message ──────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_send_message",
    "Envia uma mensagem de texto no WhatsApp para um chat existente. Usa delay humanizado automaticamente.",
    {
      chat_id: z.string().describe("ID do chat destino (ex: 5511999999999@c.us)"),
      message: z.string().describe("Texto da mensagem a enviar"),
    },
    async ({ chat_id, message }) => {
      try {
        checkRateLimit();
        const result = await sendCommand("SEND_MESSAGE", {
          chatId: chat_id,
          text: message,
        });
        return {
          content: [{
            type: "text",
            text: `Mensagem enviada para ${chat_id}.${result.id ? ` ID: ${result.id}` : ""}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro ao enviar: ${err.message}` }] };
      }
    }
  );

  // ─── send_message_by_phone ─────────────────────────────────────────────────
  server.tool(
    "whatsapp_send_message_by_phone",
    "Envia mensagem de texto por número de telefone (sem precisar do chat_id). Formato: código do país + número, sem + ou espaços.",
    {
      phone_number: z.string().describe("Número de telefone (ex: 5511999999999)"),
      message: z.string().describe("Texto da mensagem a enviar"),
    },
    async ({ phone_number, message }) => {
      try {
        checkRateLimit();
        // Limpar formatação do número
        const cleanNumber = phone_number.replace(/[\s\-\+\(\)]/g, "");
        const chatId = cleanNumber.includes("@") ? cleanNumber : `${cleanNumber}@c.us`;

        const result = await sendCommand("SEND_MESSAGE", {
          chatId,
          text: message,
        });
        return {
          content: [{
            type: "text",
            text: `Mensagem enviada para ${phone_number}.${result.id ? ` ID: ${result.id}` : ""}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro ao enviar: ${err.message}` }] };
      }
    }
  );

  // ─── get_unread_chats ──────────────────────────────────────────────────────
  server.tool(
    "whatsapp_get_unread_chats",
    "Lista chats com mensagens não lidas no WhatsApp. Retorna APENAS metadados (nome, contagem, última mensagem). NÃO abre os chats, então NÃO marca como lido nem envia blue ticks. Seguro para verificar periodicamente.",
    {},
    async () => {
      try {
        const result = await sendCommand("GET_UNREAD");

        if (!result.chats || result.chats.length === 0) {
          return { content: [{ type: "text", text: "Nenhum chat com mensagens não lidas." }] };
        }

        const formatted = result.chats.map((c) => ({
          chatId: c.id,
          chatName: c.name || c.id,
          isGroup: c.isGroup || false,
          unreadCount: c.unreadCount || 0,
          lastMessage: c.lastMessage
            ? {
                body: (c.lastMessage.body || "").substring(0, 150),
                timestamp: c.lastMessage.timestamp,
                fromMe: c.lastMessage.fromMe,
              }
            : null,
        }));

        const totalUnread = formatted.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
        return {
          content: [{
            type: "text",
            text: `${totalUnread} mensagem(ns) não lida(s) em ${formatted.length} chat(s):\n\n${JSON.stringify(formatted, null, 2)}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── read_unread_messages ──────────────────────────────────────────────────
  server.tool(
    "whatsapp_read_unread_messages",
    "Lê as mensagens não lidas de um chat ESPECÍFICO. ATENÇÃO: isso PODE marcar as mensagens como lidas (blue ticks) no WhatsApp. Use whatsapp_get_unread_chats primeiro para ver quais chats têm não lidas, depois use esta tool só quando realmente quiser ler.",
    {
      chat_id: z.string().describe("ID do chat para ler as mensagens não lidas"),
      limit: z.number().optional().default(20).describe("Quantidade máxima de mensagens (padrão 20)"),
    },
    async ({ chat_id, limit }) => {
      try {
        const result = await sendCommand("GET_UNREAD_DETAIL", {
          chatId: chat_id,
          limit: Math.min(limit, 50),
        });

        if (!result.messages || result.messages.length === 0) {
          return { content: [{ type: "text", text: "Nenhuma mensagem não lida neste chat." }] };
        }

        const formatted = result.messages.map((m) => ({
          id: m.id,
          from: m.from || (m.fromMe ? "Eu" : m.sender || "Desconhecido"),
          body: m.body || "",
          timestamp: m.timestamp,
          fromMe: m.fromMe || false,
          type: m.type || "chat",
        }));

        return {
          content: [{
            type: "text",
            text: `${formatted.length} mensagem(ns) não lida(s):\n\n${JSON.stringify(formatted, null, 2)}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── mark_as_read ──────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_mark_as_read",
    "Marca um chat como lido no WhatsApp (envia blue ticks). Use após ler e processar as mensagens.",
    {
      chat_id: z.string().describe("ID do chat para marcar como lido"),
    },
    async ({ chat_id }) => {
      try {
        const result = await sendCommand("MARK_AS_READ", { chatId: chat_id });
        return {
          content: [{
            type: "text",
            text: `Chat ${chat_id} marcado como lido.`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── mark_as_unread ────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_mark_as_unread",
    "Marca um chat como não lido no WhatsApp. Útil para lembrar de responder depois.",
    {
      chat_id: z.string().describe("ID do chat para marcar como não lido"),
    },
    async ({ chat_id }) => {
      try {
        await sendCommand("MARK_AS_UNREAD", { chatId: chat_id });
        return {
          content: [{
            type: "text",
            text: `Chat ${chat_id} marcado como não lido.`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );
}
