// ─── INJECTED SCRIPT (MUNDO MAIN) ────────────────────────────────────────────
// Roda no contexto da página web.whatsapp.com com acesso ao WPP (WA-JS).

(async function () {
  "use strict";

  // ─── AGUARDAR WA-JS FICAR PRONTO ────────────────────────────────────────────

  async function waitForWPP(maxWait = 60000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (typeof WPP !== "undefined" && WPP.webpack && WPP.webpack.isReady) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("WPP (WA-JS) não ficou pronto a tempo");
  }

  try {
    await waitForWPP();
    console.log("[INJ] WPP pronto, registrando handlers");
  } catch (err) {
    console.error("[INJ]", err.message);
    return;
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────────

  /**
   * Extrai o ID serializado de um objeto Wid de forma segura.
   * Wid objects do WA-JS têm ._serialized como string.
   * NUNCA usar .toString() em Wid — retorna "[object Object]".
   */
  function safeWid(id) {
    if (!id) return "";
    if (typeof id === "string") return id;
    if (id._serialized && typeof id._serialized === "string") return id._serialized;
    // Fallback: reconstruir manualmente
    if (id.user && id.server) return `${id.user}@${id.server}`;
    return "";
  }

  function randomDelay(min = 800, max = 2500) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function sendResponse(id, result, error) {
    window.postMessage({
      source: "whatsapp-mcp-injected",
      payload: error ? { id, error: String(error) } : { id, result },
    }, "*");
  }

  function formatChat(chat) {
    return {
      id: safeWid(chat.id),
      name: chat.name || chat.contact?.name || chat.contact?.pushname || "",
      isGroup: chat.isGroup || false,
      unreadCount: chat.unreadCount || 0,
      lastMessage: chat.lastMessage
        ? {
            body: chat.lastMessage.body || "",
            timestamp: chat.lastMessage.t || chat.lastMessage.timestamp,
            fromMe: chat.lastMessage.id?.fromMe || false,
          }
        : null,
    };
  }

  function formatMessage(msg) {
    return {
      id: safeWid(msg.id),
      from: safeWid(msg.from),
      sender: msg.sender?.pushname || msg.sender?.name || "",
      body: msg.body || "",
      timestamp: msg.t || msg.timestamp,
      fromMe: msg.id?.fromMe || false,
      type: msg.type || "chat",
      hasMedia: msg.isMedia || msg.isMMS || false,
    };
  }

  function formatContact(contact) {
    const id = safeWid(contact.id);
    return {
      id,
      name: contact.name || contact.pushname || contact.verifiedName || "",
      pushname: contact.pushname || "",
      number: id.replace("@c.us", ""),
      isMyContact: contact.isMyContact || false,
      isBusiness: contact.isBusiness || false,
    };
  }

  /**
   * Normaliza um chatId string para formato WPP válido.
   * Remove +, garante @c.us para números.
   */
  function normalizeChatId(chatId) {
    let id = String(chatId).trim();
    // Remover + do início (WPP não aceita)
    id = id.replace(/^\+/, "");
    // Adicionar @c.us se parece número sem @
    if (!id.includes("@") && /^\d+$/.test(id)) {
      id = id + "@c.us";
    }
    return id;
  }

  // ─── COMMAND HANDLERS ────────────────────────────────────────────────────────

  const handlers = {
    IS_AUTHENTICATED: async () => {
      try {
        const authenticated = WPP.conn.isAuthenticated();
        return { authenticated };
      } catch {
        return { authenticated: false };
      }
    },

    GET_MY_INFO: async () => {
      const wid = WPP.conn.getMyUserId();
      const widStr = safeWid(wid);
      let name = "";
      try {
        const me = await WPP.contact.get(widStr);
        name = me?.pushname || me?.name || "";
      } catch {}
      return {
        wid: widStr,
        phone: widStr.replace("@c.us", ""),
        name,
        platform: WPP.conn.getPlatform?.() || "unknown",
      };
    },

    GET_CHATS: async (payload) => {
      const limit = payload.limit || 20;
      const allChats = await WPP.chat.list({ count: limit });
      allChats.sort((a, b) => {
        const tA = a.lastMessage?.t || a.t || 0;
        const tB = b.lastMessage?.t || b.t || 0;
        return tB - tA;
      });
      const chats = allChats.slice(0, limit).map(formatChat);
      return { chats };
    },

    GET_CHAT: async (payload) => {
      const chat = WPP.chat.get(payload.chatId);
      if (!chat) throw new Error(`Chat não encontrado: ${payload.chatId}`);
      return formatChat(chat);
    },

    SEARCH_CHATS: async (payload) => {
      const query = (payload.query || "").toLowerCase();
      const allChats = await WPP.chat.list();
      const filtered = allChats.filter((c) => {
        const name = (c.name || c.contact?.name || c.contact?.pushname || "").toLowerCase();
        const id = safeWid(c.id).toLowerCase();
        return name.includes(query) || id.includes(query);
      });
      return { chats: filtered.slice(0, 20).map(formatChat) };
    },

    GET_MESSAGES: async (payload) => {
      const limit = payload.limit || 30;
      const msgs = await WPP.chat.getMessages(payload.chatId, {
        count: limit,
      });
      return { messages: msgs.map(formatMessage) };
    },

    SEND_MESSAGE: async (payload) => {
      const chatId = normalizeChatId(payload.chatId);
      const text = String(payload.text);

      if (!chatId || chatId === "[object Object]") {
        throw new Error(`chatId inválido: ${payload.chatId}. Deve ser no formato "5511999999999@c.us".`);
      }

      await new Promise((r) => setTimeout(r, randomDelay()));

      // wa-js 3.22.0 corrige os dois bugs (Invalid WID + openChatBottom)
      await WPP.chat.openChatBottom(chatId);
      await new Promise((r) => setTimeout(r, 400));
      const result = await WPP.chat.sendTextMessage(chatId, text);
      return { sent: true, id: safeWid(result?.id) || "" };
    },

    SEARCH_CONTACTS: async (payload) => {
      const query = (payload.query || "").toLowerCase();
      const allContacts = await WPP.contact.list();
      const filtered = allContacts.filter((c) => {
        const name = (c.name || c.pushname || c.verifiedName || "").toLowerCase();
        const id = safeWid(c.id).toLowerCase();
        return name.includes(query) || id.includes(query);
      });
      return { contacts: filtered.slice(0, 20).map(formatContact) };
    },

    CHECK_EXISTS: async (payload) => {
      const phone = payload.phone;
      const result = await WPP.contact.queryExists(`${phone}@c.us`);
      return {
        exists: !!result,
        jid: safeWid(result?.wid) || null,
        isBusiness: result?.biz || false,
      };
    },

    GET_CONTACT: async (payload) => {
      const contact = await WPP.contact.get(payload.contactId);
      if (!contact) throw new Error(`Contato não encontrado: ${payload.contactId}`);
      return {
        ...formatContact(contact),
        status: contact.status || "",
        isBlocked: contact.isContactBlocked || false,
        isEnterprise: contact.isEnterprise || false,
      };
    },

    GET_UNREAD: async () => {
      const unreadChats = await WPP.chat.list({ onlyWithUnreadMessage: true });
      const result = unreadChats.slice(0, 20).map(formatChat);
      return { chats: result };
    },

    GET_UNREAD_DETAIL: async (payload) => {
      const chatId = payload.chatId;
      const msgs = await WPP.chat.getMessages(chatId, {
        count: payload.limit || 20,
        onlyUnread: true,
      });
      return { messages: msgs.map(formatMessage) };
    },

    MARK_AS_READ: async (payload) => {
      await WPP.chat.markIsRead(payload.chatId);
      // markIsRead não reverte unreadCount=-1 (marcado manualmente).
      // Forçar via modelo interno para garantir.
      try {
        const chat = WPP.chat.get(payload.chatId);
        if (chat && chat.unreadCount !== 0) {
          chat.unreadCount = 0;
          chat.trigger && chat.trigger("change:unreadCount");
        }
      } catch {}
      return { success: true };
    },

    MARK_AS_UNREAD: async (payload) => {
      await WPP.chat.markIsUnread(payload.chatId);
      return { success: true };
    },

    DOWNLOAD_MEDIA: async (payload) => {
      const { msgId, chatId } = payload;

      // Buscar a mensagem pelo ID dentro do chat
      const msgs = await WPP.chat.getMessages(chatId, { count: 50 });
      const msg = msgs.find((m) => safeWid(m.id) === msgId || m.id?.id === msgId);

      if (!msg) throw new Error(`Mensagem não encontrada: ${msgId}`);
      if (!msg.isMedia && !msg.isMMS && msg.type === "chat") {
        throw new Error(`Mensagem não contém mídia (type: ${msg.type})`);
      }

      const media = await WPP.chat.downloadMedia(msg);
      if (!media) throw new Error("Falha ao baixar mídia — arquivo pode ter expirado.");

      return {
        data: media.data,           // base64
        mimetype: media.mimetype || msg.mimetype || "application/octet-stream",
        filename: media.filename || msg.filename || `media_${Date.now()}`,
        type: msg.type,             // image, video, audio, ptt, document, sticker
        caption: msg.caption || msg.body || "",
      };
    },
  };

  // ─── ESCUTAR COMANDOS DO CONTENT SCRIPT ──────────────────────────────────────

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "whatsapp-mcp-content") return;

    const { id, type, payload } = event.data.payload;
    if (!id || !type) return;

    const handler = handlers[type];
    if (!handler) {
      sendResponse(id, null, `Comando desconhecido: ${type}`);
      return;
    }

    try {
      const result = await handler(payload || {});
      sendResponse(id, result);
    } catch (err) {
      console.error(`[INJ] Erro no comando ${type}:`, err);
      sendResponse(id, null, err.message || String(err));
    }
  });

  console.log("[INJ] WhatsApp MCP Bridge ativo");
})();
