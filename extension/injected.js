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
      id: chat.id?._serialized || chat.id?.toString() || chat.id,
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
      id: msg.id?._serialized || msg.id?.toString() || msg.id,
      from: msg.from?._serialized || msg.from || "",
      sender: msg.sender?.pushname || msg.sender?.name || "",
      body: msg.body || "",
      timestamp: msg.t || msg.timestamp,
      fromMe: msg.id?.fromMe || false,
      type: msg.type || "chat",
      hasMedia: msg.isMedia || msg.isMMS || false,
    };
  }

  function formatContact(contact) {
    return {
      id: contact.id?._serialized || contact.id?.toString() || contact.id,
      name: contact.name || contact.pushname || contact.verifiedName || "",
      pushname: contact.pushname || "",
      number: contact.id?._serialized?.replace("@c.us", "") || "",
      isMyContact: contact.isMyContact || false,
      isBusiness: contact.isBusiness || false,
    };
  }

  // ─── COMMAND HANDLERS ────────────────────────────────────────────────────────

  const handlers = {
    IS_AUTHENTICATED: async () => {
      try {
        // isAuthenticated() é SINCRONO — retorna boolean direto
        const authenticated = WPP.conn.isAuthenticated();
        return { authenticated };
      } catch {
        return { authenticated: false };
      }
    },

    GET_MY_INFO: async () => {
      // getMyUserId() é SINCRONO — retorna Wid | undefined
      const wid = WPP.conn.getMyUserId();
      const widStr = wid?._serialized || wid?.toString?.() || "";
      let name = "";
      try {
        // contact.get() é ASYNC
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
      // Ordenar por última mensagem (mais recente primeiro)
      allChats.sort((a, b) => {
        const tA = a.lastMessage?.t || a.t || 0;
        const tB = b.lastMessage?.t || b.t || 0;
        return tB - tA;
      });
      const chats = allChats.slice(0, limit).map(formatChat);
      return { chats };
    },

    GET_CHAT: async (payload) => {
      // chat.get() é SINCRONO — retorna ChatModel | undefined
      const chat = WPP.chat.get(payload.chatId);
      if (!chat) throw new Error(`Chat não encontrado: ${payload.chatId}`);
      return formatChat(chat);
    },

    SEARCH_CHATS: async (payload) => {
      const query = (payload.query || "").toLowerCase();
      const allChats = await WPP.chat.list();
      const filtered = allChats.filter((c) => {
        const name = (c.name || c.contact?.name || c.contact?.pushname || "").toLowerCase();
        const id = (c.id?._serialized || "").toLowerCase();
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
      const delay = randomDelay();
      // sendTextMessage já tem delay nativo + markIsRead: true por default
      // O delay nativo simula digitação internamente — mais seguro que markIsComposing manual
      const result = await WPP.chat.sendTextMessage(payload.chatId, payload.text, {
        delay,
        createChat: true,
      });
      return {
        id: result?.id || "",
        sent: true,
      };
    },

    SEARCH_CONTACTS: async (payload) => {
      const query = (payload.query || "").toLowerCase();
      const allContacts = await WPP.contact.list();
      const filtered = allContacts.filter((c) => {
        const name = (c.name || c.pushname || c.verifiedName || "").toLowerCase();
        const id = (c.id?._serialized || "").toLowerCase();
        return name.includes(query) || id.includes(query);
      });
      return { contacts: filtered.slice(0, 20).map(formatContact) };
    },

    CHECK_EXISTS: async (payload) => {
      const phone = payload.phone;
      const result = await WPP.contact.queryExists(`${phone}@c.us`);
      return {
        exists: !!result,
        jid: result?.wid?._serialized || null,
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

    // GET_UNREAD: retorna APENAS metadados (nome, unreadCount, última msg)
    // NÃO abre cada chat para evitar marcar como lido / blue ticks
    GET_UNREAD: async () => {
      const unreadChats = await WPP.chat.list({ onlyWithUnreadMessage: true });
      const result = unreadChats.slice(0, 20).map((chat) => {
        const formatted = formatChat(chat);
        // Incluir a última mensagem como preview (já está no objeto chat)
        // Não chamar getMessages para não disparar "visto"
        return formatted;
      });
      return { chats: result };
    },

    // GET_UNREAD_DETAIL: para quando QUISER ler as mensagens (aceita o risco de marcar como lido)
    GET_UNREAD_DETAIL: async (payload) => {
      const chatId = payload.chatId;
      const msgs = await WPP.chat.getMessages(chatId, {
        count: payload.limit || 20,
        onlyUnread: true,
      });
      return { messages: msgs.map(formatMessage) };
    },

    // MARK_AS_READ: marcar chat como lido explicitamente
    MARK_AS_READ: async (payload) => {
      const result = await WPP.chat.markIsRead(payload.chatId);
      return { success: true, unreadCount: result?.unreadCount ?? 0 };
    },

    // MARK_AS_UNREAD: marcar chat como não lido
    MARK_AS_UNREAD: async (payload) => {
      await WPP.chat.markIsUnread(payload.chatId);
      return { success: true };
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
