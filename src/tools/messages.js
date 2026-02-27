// ─── TOOLS: MENSAGENS ────────────────────────────────────────────────────────

import { z } from "zod";
import { sendCommand } from "../ws-bridge.js";
import {
  checkRateLimit,
  checkDailyRecipientLimit,
  checkGroupConfirmation,
  logAudit,
  getAuditLog,
  getDailyStats,
} from "../guardrails.js";

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
            text: `⚠️ Atenção: abrir este chat pode marcar mensagens como lidas.\n\n${formatted.length} mensagem(ns):\n\n${JSON.stringify(formatted, null, 2)}`
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
    "Envia uma mensagem de texto no WhatsApp. Regras: máx 10 msgs/min (fixo), máx 50 destinatários únicos/dia, grupos exigem confirmed=true. Uma conversa com várias mensagens para a mesma pessoa conta como 1 destinatário.",
    {
      chat_id: z.string().describe("ID do chat destino (ex: 5511999999999@c.us)"),
      message: z.string().describe("Texto da mensagem. Pode conter quebras de linha — conta como 1 envio."),
      confirmed: z.boolean().optional().default(false).describe("Obrigatório true para grupos (@g.us)"),
    },
    async ({ chat_id, message, confirmed }) => {
      try {
        // Guardrails
        checkRateLimit();
        checkGroupConfirmation(chat_id, confirmed);
        checkDailyRecipientLimit(chat_id);

        const result = await sendCommand("SEND_MESSAGE", {
          chatId: chat_id,
          text: message,
        });

        // Log de auditoria
        logAudit({
          action: "send_message",
          chat_id,
          length: message.length,
          message_id: result.id || "",
        });

        const stats = getDailyStats();
        return {
          content: [{
            type: "text",
            text: `Mensagem enviada.${result.id ? ` ID: ${result.id}` : ""}\n` +
              `Destinatários hoje: ${stats.uniqueRecipients}/${stats.maxRecipients}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── send_message_by_phone ─────────────────────────────────────────────────
  server.tool(
    "whatsapp_send_message_by_phone",
    "Envia mensagem por número de telefone. Mesmas regras do send_message: máx 10/min, 50 destinatários/dia, grupos exigem confirmed=true.",
    {
      phone_number: z.string().describe("Número de telefone (ex: 5511999999999)"),
      message: z.string().describe("Texto da mensagem"),
      confirmed: z.boolean().optional().default(false).describe("Obrigatório true para grupos"),
    },
    async ({ phone_number, message, confirmed }) => {
      try {
        const cleanNumber = phone_number.replace(/[\s\-\+\(\)]/g, "");
        const chatId = cleanNumber.includes("@") ? cleanNumber : `${cleanNumber}@c.us`;

        checkRateLimit();
        checkGroupConfirmation(chatId, confirmed);
        checkDailyRecipientLimit(chatId);

        const result = await sendCommand("SEND_MESSAGE", {
          chatId,
          text: message,
        });

        logAudit({
          action: "send_message_by_phone",
          chat_id: chatId,
          phone: phone_number,
          length: message.length,
          message_id: result.id || "",
        });

        const stats = getDailyStats();
        return {
          content: [{
            type: "text",
            text: `Mensagem enviada para ${phone_number}.\n` +
              `Destinatários hoje: ${stats.uniqueRecipients}/${stats.maxRecipients}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── get_unread_chats ──────────────────────────────────────────────────────
  server.tool(
    "whatsapp_get_unread_chats",
    "Lista chats com mensagens não lidas. Retorna APENAS metadados — NÃO abre os chats, NÃO marca como lido, NÃO envia blue ticks. Seguro para verificar periodicamente.",
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
    "Lê mensagens não lidas de um chat. REGRA IMPORTANTE: após ler, o chat é automaticamente marcado de volta como NÃO LIDO para não perder. Você DEVE usar whatsapp_resolve_chat depois para decidir o que fazer: responder, ignorar (marcar como lido) ou manter não lido.",
    {
      chat_id: z.string().describe("ID do chat"),
      limit: z.number().optional().default(20).describe("Quantidade máxima (padrão 20)"),
    },
    async ({ chat_id, limit }) => {
      try {
        const result = await sendCommand("GET_UNREAD_DETAIL", {
          chatId: chat_id,
          limit: Math.min(limit, 50),
        });

        // Sempre marcar de volta como não lido — regra inviolável
        try {
          await sendCommand("MARK_AS_UNREAD", { chatId: chat_id });
        } catch {}

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

        // Log de auditoria — lido sem resolução
        logAudit({ action: "read_unread", chat_id, count: formatted.length, resolved: false });

        return {
          content: [{
            type: "text",
            text: `${formatted.length} mensagem(ns) lida(s).\n` +
              `⚠️ Chat mantido como NÃO LIDO. Use whatsapp_resolve_chat para decidir:\n` +
              `- "reply" + message: responder e marcar como lido\n` +
              `- "ignore": marcar como lido sem responder\n` +
              `- "keep_unread": manter não lido\n\n` +
              JSON.stringify(formatted, null, 2)
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── resolve_chat ──────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_resolve_chat",
    "Resolve um chat após leitura. Ações: 'reply' (responde e marca como lido), 'ignore' (marca como lido sem responder), 'keep_unread' (mantém não lido). Obrigatório usar após whatsapp_read_unread_messages.",
    {
      chat_id: z.string().describe("ID do chat"),
      action: z.enum(["reply", "ignore", "keep_unread"]).describe("Ação a tomar"),
      message: z.string().optional().describe("Mensagem de resposta (obrigatório se action='reply')"),
      confirmed: z.boolean().optional().default(false).describe("Obrigatório true para grupos"),
    },
    async ({ chat_id, action, message, confirmed }) => {
      try {
        if (action === "reply") {
          if (!message) throw new Error("Mensagem obrigatória para action='reply'.");
          checkRateLimit();
          checkGroupConfirmation(chat_id, confirmed);
          checkDailyRecipientLimit(chat_id);
          await sendCommand("SEND_MESSAGE", { chatId: chat_id, text: message });
          await sendCommand("MARK_AS_READ", { chatId: chat_id });
          logAudit({ action: "resolve_reply", chat_id, length: message.length });
          const stats = getDailyStats();
          return {
            content: [{
              type: "text",
              text: `Respondido e marcado como lido.\nDestinatários hoje: ${stats.uniqueRecipients}/${stats.maxRecipients}`
            }],
          };
        }

        if (action === "ignore") {
          await sendCommand("MARK_AS_READ", { chatId: chat_id });
          logAudit({ action: "resolve_ignore", chat_id });
          return { content: [{ type: "text", text: `Chat marcado como lido (ignorado).` }] };
        }

        if (action === "keep_unread") {
          // Já está não lido — só registrar
          logAudit({ action: "resolve_keep_unread", chat_id });
          return { content: [{ type: "text", text: `Chat mantido como não lido.` }] };
        }

      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── mark_as_read ──────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_mark_as_read",
    "Marca um chat como lido (envia blue ticks). Use após ler e processar as mensagens.",
    {
      chat_id: z.string().describe("ID do chat"),
    },
    async ({ chat_id }) => {
      try {
        await sendCommand("MARK_AS_READ", { chatId: chat_id });
        logAudit({ action: "mark_as_read", chat_id });
        return { content: [{ type: "text", text: `Chat marcado como lido.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── mark_as_unread ────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_mark_as_unread",
    "Marca um chat como não lido. Útil para lembrar de responder depois.",
    {
      chat_id: z.string().describe("ID do chat"),
    },
    async ({ chat_id }) => {
      try {
        await sendCommand("MARK_AS_UNREAD", { chatId: chat_id });
        logAudit({ action: "mark_as_unread", chat_id });
        return { content: [{ type: "text", text: `Chat marcado como não lido.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── get_audit_log ─────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_get_audit_log",
    "Retorna o log de auditoria das últimas ações realizadas (envios, leituras). Útil para rastrear o que foi feito.",
    {
      limit: z.number().optional().default(20).describe("Quantidade de entradas (padrão 20)"),
    },
    async ({ limit }) => {
      try {
        const entries = getAuditLog(limit);
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "Nenhuma entrada no log de auditoria." }] };
        }
        const stats = getDailyStats();
        return {
          content: [{
            type: "text",
            text: `📊 Stats hoje: ${stats.uniqueRecipients}/${stats.maxRecipients} destinatários únicos\n\n` +
              `Últimas ${entries.length} ações:\n\n${JSON.stringify(entries, null, 2)}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );
}
