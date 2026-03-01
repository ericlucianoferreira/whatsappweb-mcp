# Plano de Melhorias — Estabilidade do whatsapp-mcp
**Data:** 2026-02-28
**Autor:** Eric Luciano / Claude Code
**Status:** Aguardando validação técnica

---

## Contexto

O whatsapp-mcp tem dois problemas de experiência identificados em uso real:

1. **Múltiplas sessões não funcionam** — abrir duas janelas do Claude Code causa conflito na porta 3847
2. **Mover/minimizar a janela do Edge quebra a conexão** — o service worker da extensão é suspenso pelo browser

Este documento apresenta a análise técnica completa (com referências), avaliação de risco de ban no WhatsApp e um plano de implementação para resolver ambos os problemas.

---

## Conclusões da Pesquisa

### 1. Risco de ban no WhatsApp

**Conclusão: baixo para o caso de uso atual.**

O WhatsApp não detecta a presença de extensões Chrome diretamente. O que ele detecta são **comportamentos anômalos**: volume alto de mensagens, intervalos regulares demais, ausência de variação humana, múltiplas contas no mesmo IP.

Para uso pessoal (número com histórico, volume controlado, máquina local), o risco é equivalente a usar qualquer extensão no browser — o que centenas de milhões de pessoas fazem diariamente.

As mudanças propostas neste plano **não aumentam o risco de ban** porque:
- O ponto de injeção do WA-JS (injected.js no contexto MAIN da página) **não muda**
- O WebSocket interno (MCP ↔ extensão) é invisível para o WhatsApp
- Os guardrails existentes (rate limit 10 msgs/min, anti-loop 60s, 50 destinatários/dia) permanecem

**Referências:**
- [131 Malicious Chrome Extensions Abused WhatsApp Web — The Hacker News](https://thehackernews.com/2025/10/131-chrome-extensions-caught-hijacking.html) — bans foram por spam massivo, não por extensão em si
- [Getting Banned — whatsapp-web.js Issues #2701](https://github.com/pedroslopez/whatsapp-web.js/issues/2701)
- [Building Personal Solutions on top of WhatsApp — Devesh Kumar](https://blog.devesh.tech/post/building-personal-solutions-on-top-of-whatsapp) — "O risco é infinitamente menor para um número com histórico e uso orgânico diário"

---

### 2. WebSocket no Content Script — descartado

**Conclusão: não resolve o problema, piora em alguns aspectos.**

Foi pesquisada a possibilidade de mover o WebSocket do service worker para o content script da extensão. A pesquisa revelou:

- O Chrome aplica **throttling agressivo em timers de JavaScript** em abas em background desde o Chrome 88 — `setInterval` no content script pode ser atrasado para 1x/segundo ou agrupado em wake intervals de 1 minuto
- Um reload da aba do WhatsApp Web **fecha imediatamente** o WebSocket do content script
- O content script não compartilha estado com outros contextos da extensão
- A documentação oficial do Chrome recomenda **manter o WebSocket no service worker**

**Referências:**
- [Use WebSockets in service workers — Chrome for Developers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Heavy throttling of chained JS timers beginning in Chrome 88](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)

---

### 3. Soluções recomendadas pela pesquisa

#### Problema 1 — Múltiplas sessões: **Daemon WebSocket separado**

Separar o WebSocket server em um processo Node.js independente (daemon), gerenciado pelo PM2. Cada instância do MCP stdio se conecta ao daemon via HTTP local em vez de subir seu próprio WebSocket server.

**Referências:**
- [PM2 Quick Start](https://pm2.keymetrics.io/docs/usage/quick-start/)
- [Usage with PM2 — Socket.IO](https://socket.io/docs/v4/pm2/)

#### Problema 2 — Service worker suspenso: **Offscreen Document keepalive**

Usar a Offscreen Document API (Chrome 109+) para enviar mensagens periódicas ao service worker, mantendo-o acordado mesmo quando a janela do Edge está minimizada.

**Referências:**
- [chrome.offscreen API — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Offscreen Documents in Manifest V3 — Chrome Developers Blog](https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3)

---

## Plano de Implementação

### Problema 2 — Janela minimizada (PRIORIDADE 1)
*Mais impactante no dia a dia. Menor complexidade.*

#### O que mudar

**A. Adicionar `offscreen.html` e `offscreen.js` à extensão**

`extension/offscreen.html`:
```html
<!DOCTYPE html>
<html><head><title>Keepalive</title></head>
<body><script src="offscreen.js"></script></body>
</html>
```

`extension/offscreen.js`:
```js
// Envia mensagem ao service worker a cada 25s para mantê-lo ativo
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'keepalive' }).catch(() => {});
}, 25000);
```

**B. Atualizar `manifest.json`**

Adicionar permissão e declarar o offscreen document:
```json
{
  "permissions": ["storage", "scripting", "offscreen"],
  ...
}
```

**C. Atualizar `service-worker.js`**

Criar o offscreen document na inicialização e tratar a mensagem keepalive:
```js
// Criar offscreen document para keepalive
async function createOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Manter service worker ativo para conexão WebSocket com MCP'
  });
}

// Chamar na inicialização
createOffscreenDocument();

// Tratar mensagem keepalive
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'keepalive') {
    // Mensagem recebida — isso reseta o idle timer do SW
  }
});
```

**D. Adicionar offscreen.html às web_accessible_resources (não necessário — é recurso interno)**

**Arquivos afetados:**
- `extension/manifest.json` — adicionar permissão `offscreen`
- `extension/service-worker.js` — criar offscreen document + tratar keepalive
- `extension/offscreen.html` — novo arquivo
- `extension/offscreen.js` — novo arquivo

**Impacto nos guardrails/lógica de negócio:** Nenhum. Mudança puramente na camada de infraestrutura da extensão.

---

### Problema 1 — Múltiplas sessões (PRIORIDADE 2)
*Maior complexidade. Necessário apenas se o uso de múltiplas sessões for frequente.*

#### Arquitetura proposta

```
[Extensão Chrome] <──WebSocket ws://localhost:3847──> [WS Daemon — ws-daemon.js]
                                                              │
                                                    HTTP REST localhost:3848
                                                              │
                                        ┌─────────────────────┴──────────────────────┐
                                        │                                              │
                               [MCP Session 1 — stdio]                    [MCP Session 2 — stdio]
                               [Claude Code janela A]                     [Claude Code janela B]
```

#### O que mudar

**A. Criar `ws-daemon.js` (novo arquivo em `src/`)**

Processo independente que:
- Mantém o WebSocket server na porta 3847 (sem mudança para a extensão)
- Expõe uma API HTTP REST na porta 3848 para os clientes MCP
- Gerencia a fila de comandos e correlação de respostas (substituindo o que hoje é feito em `ws-bridge.js`)

**B. Refatorar `src/ws-bridge.js`**

De servidor WebSocket para cliente HTTP que faz requests para o daemon:
```js
// Antes: abre ws.Server na porta 3847
// Depois: faz fetch('http://localhost:3848/command', { method: 'POST', body: ... })
```

**C. Script de startup para o daemon**

`start-daemon.bat` (Windows):
```bat
@echo off
pm2 start src/ws-daemon.js --name whatsapp-ws-daemon
pm2 save
```

Ou via npm scripts em `package.json`:
```json
{
  "scripts": {
    "start": "node index.js",
    "start-daemon": "pm2 start src/ws-daemon.js --name whatsapp-ws-daemon",
    "stop-daemon": "pm2 stop whatsapp-ws-daemon"
  }
}
```

**D. Atualizar o lock file**

O lock file PID atual pode ser removido (o daemon gerencia isso). Ou mantido apenas para o daemon.

**Arquivos afetados:**
- `src/ws-bridge.js` — refatorar de server para client HTTP
- `src/ws-daemon.js` — novo arquivo (o server WebSocket real)
- `package.json` — adicionar `pm2` como dependência + scripts
- `README.md` — documentar que o daemon deve ser iniciado separadamente

**Pré-requisito:** PM2 instalado globalmente (`npm install -g pm2`)

**Impacto nos guardrails/lógica de negócio:** Nenhum. A interface de `sendCommand()` exportada pelo `ws-bridge.js` permanece idêntica — os arquivos de tools (`messages.js`, `chats.js`, etc.) não precisam de alteração.

---

## Ordem de Implementação Recomendada

| # | Mudança | Complexidade | Impacto | Prioridade |
|---|---------|:---:|:---:|:---:|
| 1 | Offscreen Document keepalive | Baixa | Alto (resolve janela minimizada) | **P1** |
| 2 | Daemon WebSocket separado | Média | Médio (resolve múltiplas sessões) | P2 |

Recomendo implementar e testar o item 1 primeiro, por ser cirúrgico e de baixo risco. O item 2 envolve refatoração mais profunda e só vale se múltiplas sessões simultâneas forem necessárias com frequência.

---

## Arquivos que NÃO precisam ser alterados

- `src/tools/messages.js`
- `src/tools/chats.js`
- `src/tools/contacts.js`
- `src/tools/status.js`
- `src/guardrails.js`
- `src/config.js`
- `index.js`
- `extension/injected.js`
- `extension/content-script.js`
- `extension/popup.html` / `popup.js`
- `extension/wppconnect-wa.js`

---

## Perguntas em Aberto para o Desenvolvedor

1. O `chrome.offscreen` com reason `WORKERS` é semanticamente correto para keepalive de service worker? Existe um reason mais adequado ou isso pode causar rejeição se a extensão for publicada na Chrome Web Store?
2. Para o daemon: HTTP REST local (porta 3848) é a melhor interface entre o MCP e o daemon, ou seria melhor usar um named pipe / Unix socket no Windows?
3. PM2 ou alternativa mais leve para Windows (ex: NSSM — Non-Sucking Service Manager)?

---

*Documento gerado em 28/02/2026 — whatsapp-mcp v1.0*
