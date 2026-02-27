// ─── TOOLS: CHATS ────────────────────────────────────────────────────────────

import { z } from "zod";
import { sendCommand } from "../ws-bridge.js";

export function registerChatTools(server) {
  // ─── list_chats ────────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_list_chats",
    "Lista os chats recentes do WhatsApp, ordenados por última mensagem. Retorna nome, ID, última mensagem e contagem de não lidas.",
    {
      limit: z.number().optional().default(20).describe("Quantidade de chats (padrão 20, máx 50)"),
    },
    async ({ limit }) => {
      try {
        const result = await sendCommand("GET_CHATS", {
          limit: Math.min(limit, 50),
        });

        if (!result.chats || result.chats.length === 0) {
          return { content: [{ type: "text", text: "Nenhum chat encontrado." }] };
        }

        const formatted = result.chats.map((c) => ({
          id: c.id,
          name: c.name || c.contact?.name || c.id,
          isGroup: c.isGroup || false,
          unreadCount: c.unreadCount || 0,
          lastMessage: c.lastMessage
            ? {
                body: (c.lastMessage.body || "").substring(0, 100),
                timestamp: c.lastMessage.timestamp,
                fromMe: c.lastMessage.fromMe,
              }
            : null,
        }));

        return {
          content: [{
            type: "text",
            text: `${formatted.length} chat(s):\n\n${JSON.stringify(formatted, null, 2)}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── get_chat ──────────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_get_chat",
    "Retorna detalhes de um chat específico do WhatsApp (nome, participantes, tipo).",
    {
      chat_id: z.string().describe("ID do chat (ex: 5511999999999@c.us para contato, ou ID de grupo)"),
    },
    async ({ chat_id }) => {
      try {
        const result = await sendCommand("GET_CHAT", { chatId: chat_id });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── search_chats ──────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_search_chats",
    "Busca chats do WhatsApp por nome do contato ou grupo.",
    {
      query: z.string().describe("Termo de busca (nome do contato ou grupo)"),
    },
    async ({ query }) => {
      try {
        const result = await sendCommand("SEARCH_CHATS", { query });

        if (!result.chats || result.chats.length === 0) {
          return { content: [{ type: "text", text: `Nenhum chat encontrado para "${query}".` }] };
        }

        const formatted = result.chats.map((c) => ({
          id: c.id,
          name: c.name || c.id,
          isGroup: c.isGroup || false,
        }));

        return {
          content: [{
            type: "text",
            text: `${formatted.length} chat(s) para "${query}":\n\n${JSON.stringify(formatted, null, 2)}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );
}
