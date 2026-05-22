/**
 * @file client.js
 * @description Bridge HTTP/WebSocket tra il browser e i server di gioco TCP/UDP.
 * Serve i file statici della UI, fa da reverse proxy verso `api.js` per le
 * rotte `/api/...` e gestisce una sessione `GameBridgeSession` per ogni tab/browser.
 * @requires node:net
 * @requires node:dgram
 * @requires node:http
 * @requires node:fs
 * @requires node:path
 * @requires node:os
 * @requires node:url
 * @requires ws
 * @requires ../shared/config.js
 */

import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CONFIG, randomColor, safeJsonParse, sanitizeName } from '../shared/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @constant {string} publicDir - Percorso assoluto della cartella dei file statici. */
const publicDir = path.join(__dirname, 'public');

/**
 * @constant {string} UI_HOST
 * @description Indirizzo su cui ascolta il server HTTP.
 * `0.0.0.0` abilita il multiplayer locale/LAN: altri dispositivi possono aprire
 * `http://IP_DEL_PC:8080` e ogni browser/tab avrà una propria sessione TCP+UDP.
 */
const UI_HOST = process.env.UI_HOST || '0.0.0.0';

/** @constant {number} UI_PORT - Porta su cui ascolta il server HTTP. */
const UI_PORT = Number(CONFIG.UI_PORT);

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Crea una copia della sessione omettendo il campo `token` prima di inviarla al browser.
 *
 * @param {SessionState} session - Stato di sessione interno.
 * @returns {Omit<SessionState, 'token'>} Copia della sessione senza il token JWT.
 */
function clonePublicSession(session) {
  return { ...session, token: undefined };
}

/**
 * Invia un payload JSON via WebSocket solo se la connessione è aperta.
 *
 * @param {import('ws').WebSocket} ws - Socket WebSocket destinatario.
 * @param {Object} payload - Oggetto da serializzare e inviare.
 * @returns {void}
 */
function safeWsSend(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

// ─── GameBridgeSession ────────────────────────────────────────────────────────

/**
 * @typedef {Object} SessionState
 * @description Stato completo di una sessione di gioco, condiviso (in forma ridotta) col browser.
 * @property {boolean} connected - `true` se la connessione TCP è attiva e il server ha inviato `welcome`.
 * @property {boolean} connecting - `true` durante il tentativo di connessione.
 * @property {boolean} udpReady - `true` dopo il completamento dell'handshake UDP (`helloAck`).
 * @property {boolean} alive - `true` se la cella del giocatore è viva sul server.
 * @property {string} host - Hostname o IP del server di gioco.
 * @property {number} tcpPort - Porta TCP del server di gioco.
 * @property {number} udpPort - Porta UDP del server di gioco.
 * @property {string|null} id - ID univoco assegnato dal server al giocatore.
 * @property {string|null} token - Token di sessione UDP (non esposto al browser).
 * @property {string|null} name - Username del giocatore nella partita corrente.
 * @property {string} color - Colore esadecimale della cella del giocatore.
 * @property {Object|null} world - Metadati del mondo di gioco ricevuti con `welcome`.
 * @property {string|null} lastError - Ultimo messaggio di errore, o `null` se nessuno.
 */

/**
 * @typedef {Object} TargetPosition
 * @property {number} tx - Coordinata X del target nel sistema di riferimento del mondo.
 * @property {number} ty - Coordinata Y del target nel sistema di riferimento del mondo.
 */

/**
 * Gestisce il ciclo di vita completo di una sessione di gioco per un singolo client WebSocket.
 * Mantiene la connessione TCP per i messaggi di controllo (join, chat, rispawn, morte)
 * e la connessione UDP per gli snapshot e gli input ad alta frequenza (30 Hz).
 */
class GameBridgeSession {
  /**
   * @param {import('ws').WebSocket} ws - WebSocket del browser associato a questa sessione.
   */
  constructor(ws) {
    /** @type {import('ws').WebSocket} */
    this.ws = ws;

    /** @type {net.Socket|null} - Socket TCP verso il server di gioco. */
    this.tcp = null;

    /** @type {dgram.Socket|null} - Socket UDP verso il server di gioco. */
    this.udp = null;

    /** @type {string} - Buffer per il parsing dei messaggi TCP newline-delimited. */
    this.tcpBuffer = '';

    /** @type {ReturnType<typeof setInterval>|null} - Timer per i retry dell'handshake UDP. */
    this.helloTimer = null;

    /** @type {ReturnType<typeof setInterval>|null} - Timer che invia il target al server a 30 Hz. */
    this.inputTimer = null;

    /** @type {ReturnType<typeof setTimeout>|null} - Timer che chiude TCP/UDP dopo la morte del giocatore. */
    this.deadCloseTimer = null;

    /** @type {Object|null} - Ultimo snapshot UDP ricevuto dal server. */
    this.latestSnapshot = null;

    /** @type {number} - Numero di sequenza incrementale per i pacchetti UDP di input. */
    this.inputSeq = 0;

    /** @type {TargetPosition|null} - Ultima posizione target inviata o ricevuta dal browser. */
    this.lastTarget = null;

    /** @type {SessionState} */
    this.session = {
      connected: false,
      connecting: false,
      udpReady: false,
      alive: false,
      host: '127.0.0.1',
      tcpPort: CONFIG.TCP_PORT,
      udpPort: CONFIG.UDP_PORT,
      id: null,
      token: null,
      name: null,
      color: randomColor(),
      world: null,
      lastError: null
    };

    // Avvia il loop di invio input a 30 Hz.
    this.inputTimer = setInterval(() => {
      if (this.lastTarget) this.sendTarget(this.lastTarget);
    }, 1000 / 30);
  }

  /**
   * Invia un payload JSON al browser tramite WebSocket.
   *
   * @param {Object} payload - Oggetto da inviare.
   * @returns {void}
   */
  wsSend(payload) {
    safeWsSend(this.ws, payload);
  }

  /**
   * Pubblica lo stato corrente della sessione (senza token) al browser,
   * opzionalmente arricchito con campi extra come l'evento scatenante.
   *
   * @param {Object} [extra={}] - Campi aggiuntivi da includere nel messaggio `bridgeState`.
   * @returns {void}
   */
  publishState(extra = {}) {
    this.wsSend({ type: 'bridgeState', session: clonePublicSession(this.session), ...extra });
  }

  /**
   * Invia un messaggio JSON al server di gioco tramite TCP (newline-delimited).
   *
   * @param {Object} payload - Oggetto da serializzare e inviare.
   * @returns {boolean} `true` se il messaggio è stato scritto, `false` se il socket non è disponibile.
   */
  tcpSend(payload) {
    if (!this.tcp || this.tcp.destroyed) return false;
    this.tcp.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  /**
   * Invia un pacchetto JSON al server di gioco tramite UDP,
   * aggiungendo automaticamente `id` e `token` di sessione.
   *
   * @param {Object} payload - Dati da inviare (esclusi `id` e `token`, aggiunti internamente).
   * @returns {boolean} `true` se l'invio è stato avviato, `false` se la sessione non è pronta.
   */
  udpSend(payload) {
    if (!this.udp || !this.session.id || !this.session.token) return false;
    const msg = Buffer.from(JSON.stringify({ id: this.session.id, token: this.session.token, ...payload }));
    this.udp.send(msg, this.session.udpPort, this.session.host, err => {
      if (err) {
        this.session.lastError = err.message;
        this.publishState({ event: 'udpSendError' });
      }
    });
    return true;
  }

  /**
   * Chiude le connessioni TCP e UDP, azzera lo stato della sessione
   * e notifica il browser con l'evento `closed`.
   *
   * @param {string} [reason='manual'] - Motivo della chiusura (es. `'manual'`, `'dead'`, `'Timeout TCP'`).
   * @param {boolean} [publish=true] - Se `true`, notifica il browser dell'avvenuta chiusura.
   * @returns {void}
   */
  close(reason = 'manual', publish = true) {
    if (this.helloTimer) clearInterval(this.helloTimer);
    if (this.deadCloseTimer) clearTimeout(this.deadCloseTimer);
    this.helloTimer = null;
    this.deadCloseTimer = null;

    if (this.tcp) {
      this.tcp.removeAllListeners();
      this.tcp.destroy();
      this.tcp = null;
    }
    if (this.udp) {
      this.udp.removeAllListeners();
      try { this.udp.close(); } catch {}
      this.udp = null;
    }

    this.tcpBuffer = '';
    this.latestSnapshot = null;
    this.lastTarget = null;
    this.inputSeq = 0;

    Object.assign(this.session, {
      connected: false,
      connecting: false,
      udpReady: false,
      alive: false,
      id: null,
      token: null,
      world: null,
      lastError: (reason === 'manual' || reason === 'reconnect' || reason === 'dead' || reason === 'browserClosed') ? null : reason
    });

    if (publish) this.publishState({ event: 'closed', reason });
  }

  /**
   * Distrugge completamente la sessione quando il browser chiude il WebSocket.
   * Ferma il timer di input e chiude TCP/UDP senza notificare il browser.
   *
   * @returns {void}
   */
  destroy() {
    if (this.inputTimer) clearInterval(this.inputTimer);
    this.inputTimer = null;
    this.close('browserClosed', false);
  }

  /**
   * Inizializza il socket UDP e avvia l'handshake con il server di gioco
   * inviando messaggi `hello` ogni 500 ms fino alla ricezione di `helloAck`.
   *
   * @returns {void}
   */
  beginUdpHandshake() {
    if (this.udp) {
      try { this.udp.close(); } catch {}
    }
    this.udp = dgram.createSocket('udp4');

    this.udp.on('message', message => {
      const msg = safeJsonParse(message.toString('utf8'));
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'helloAck') {
        this.session.udpReady = true;
        this.publishState({ event: 'udpReady' });
        return;
      }

      if (msg.type === 'snapshot') {
        this.latestSnapshot = msg;
        this.session.alive = true;
        this.wsSend({ type: 'snapshot', snapshot: msg });
        return;
      }

      if (msg.type === 'error') {
        this.session.lastError = msg.message;
        this.wsSend({ type: 'udpError', message: msg.message });
      }
    });

    this.udp.on('error', err => {
      this.session.lastError = `UDP: ${err.message}`;
      this.publishState({ event: 'udpError' });
    });

    this.udp.bind(0, () => {
      const sendHello = () => this.udpSend({ type: 'hello' });
      sendHello();
      if (this.helloTimer) clearInterval(this.helloTimer);
      this.helloTimer = setInterval(() => {
        if (!this.session.udpReady) sendHello();
      }, 500);
    });
  }

  /**
   * Gestisce un messaggio TCP ricevuto dal server di gioco.
   * Aggiorna lo stato della sessione in base al tipo di messaggio e lo
   * inoltra al browser (senza il token).
   *
   * @param {{ type: string, [key: string]: any }} msg - Messaggio deserializzato dal server.
   * @returns {void}
   */
  handleTcpMessage(msg) {
    this.wsSend({ type: 'tcpMessage', message: { ...msg, token: undefined } });

    switch (msg.type) {
      case 'welcome': {
        Object.assign(this.session, {
          connected: true,
          connecting: false,
          udpReady: false,
          alive: true,
          id: msg.id,
          token: msg.token,
          name: msg.name,
          color: msg.color,
          udpPort: Number(msg.udpPort || this.session.udpPort),
          world: msg.world || null,
          lastError: null
        });
        this.publishState({ event: 'welcome' });
        this.beginUdpHandshake();
        break;
      }
      case 'dead': {
        this.session.alive = false;
        this.publishState({ event: 'dead', killer: msg.killer, deathMessage: msg.message, score: msg.score });
        // Il browser mostra il popup dopo 2s; poco dopo liberiamo anche TCP/UDP.
        this.deadCloseTimer = setTimeout(() => this.close('dead'), 2050);
        break;
      }
      case 'respawned': {
        this.session.alive = true;
        this.publishState({ event: 'respawned' });
        break;
      }
      case 'error': {
        this.session.lastError = msg.message;
        this.publishState({ event: 'tcpError' });
        break;
      }
      default:
        // Chat, leaderboard e system messages vengono inoltrati al browser via tcpMessage.
        break;
    }
  }

  /**
   * Avvia una nuova connessione al server di gioco.
   * Chiude eventuali connessioni preesistenti, aggiorna la sessione,
   * apre il socket TCP e invia subito il messaggio `join`.
   *
   * @param {Object} options - Parametri di connessione.
   * @param {string} [options.host='127.0.0.1'] - Hostname o IP del server di gioco.
   * @param {number} [options.tcpPort] - Porta TCP (default da `CONFIG.TCP_PORT`).
   * @param {number} [options.udpPort] - Porta UDP (default da `CONFIG.UDP_PORT`).
   * @param {string} [options.name='Blob'] - Nome del giocatore.
   * @param {string} [options.color] - Colore esadecimale della cella (es. `'#ff0000'`).
   * @returns {void}
   */
  connectToGame({ host, tcpPort, udpPort, name, color }) {
    this.close('reconnect', false);

    Object.assign(this.session, {
      connecting: true,
      connected: false,
      udpReady: false,
      alive: false,
      host: String(host || '127.0.0.1').trim(),
      tcpPort: Number(tcpPort || CONFIG.TCP_PORT),
      udpPort: Number(udpPort || CONFIG.UDP_PORT),
      name: sanitizeName(name, 'Blob'),
      color: typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : randomColor(),
      lastError: null
    });
    this.publishState({ event: 'connecting' });

    this.tcp = new net.Socket();
    this.tcp.setNoDelay(true);
    this.tcp.setKeepAlive(true);
    this.tcp.setTimeout(15000);

    this.tcp.connect(this.session.tcpPort, this.session.host, () => {
      this.tcpSend({ type: 'join', name: this.session.name, color: this.session.color });
    });

    this.tcp.on('data', chunk => {
      this.tcpBuffer += chunk.toString('utf8');
      let newlineIndex;
      while ((newlineIndex = this.tcpBuffer.indexOf('\n')) >= 0) {
        const line = this.tcpBuffer.slice(0, newlineIndex).trim();
        this.tcpBuffer = this.tcpBuffer.slice(newlineIndex + 1);
        if (!line) continue;
        const msg = safeJsonParse(line);
        if (msg) this.handleTcpMessage(msg);
      }
    });

    this.tcp.on('close', () => {
      this.close('Connessione TCP chiusa dal server');
    });

    this.tcp.on('timeout', () => {
      this.close('Timeout TCP');
    });

    this.tcp.on('error', err => {
      this.session.lastError = `TCP: ${err.message}`;
      this.publishState({ event: 'tcpError' });
    });
  }

  /**
   * Invia la posizione target corrente al server tramite UDP.
   * Viene chiamato sia dal loop a 30 Hz sia direttamente al ricevimento di un
   * evento `target` dal browser.
   *
   * @param {TargetPosition} target - Coordinata target nel sistema di riferimento del mondo.
   * @returns {void}
   */
  sendTarget(target) {
    if (!this.session.connected || !this.session.udpReady || !this.session.alive) return;
    const tx = Number(target.tx);
    const ty = Number(target.ty);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
    this.lastTarget = { tx, ty };
    this.udpSend({ type: 'input', seq: ++this.inputSeq, tx, ty });
  }

  /**
   * Invia un comando di divisione (split) della cella al server tramite UDP.
   *
   * @param {TargetPosition} [target=this.lastTarget] - Direzione del split.
   * @returns {void}
   */
  sendSplit(target = this.lastTarget) {
    if (!this.session.connected || !this.session.udpReady || !this.session.alive) return;
    const tx = Number(target?.tx);
    const ty = Number(target?.ty);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
    this.lastTarget = { tx, ty };
    this.udpSend({ type: 'split', seq: ++this.inputSeq, tx, ty });
  }

  /**
   * Invia un comando di eiezione di massa (eject) al server tramite UDP.
   *
   * @param {TargetPosition} [target=this.lastTarget] - Direzione dell'eiezione.
   * @returns {void}
   */
  sendEject(target = this.lastTarget) {
    if (!this.session.connected || !this.session.udpReady || !this.session.alive) return;
    const tx = Number(target?.tx);
    const ty = Number(target?.ty);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
    this.lastTarget = { tx, ty };
    this.udpSend({ type: 'eject', seq: ++this.inputSeq, tx, ty });
  }

  /**
   * Gestisce un messaggio WebSocket grezzo ricevuto dal browser.
   * Deserializza il payload e lo smista al metodo appropriato in base al campo `type`.
   *
   * | `type`       | Azione                                                     |
   * |--------------|------------------------------------------------------------|
   * | `connect`    | Avvia una nuova connessione al server di gioco             |
   * | `target`     | Aggiorna la posizione target                               |
   * | `split`      | Invia comando di split via UDP                             |
   * | `eject`      | Invia comando di eject via UDP                             |
   * | `chat`       | Invia un messaggio in chat via TCP (max 180 caratteri)     |
   * | `respawn`    | Richiede il rispawn via TCP                                |
   * | `disconnect` | Chiude manualmente la sessione                             |
   * | `ping`       | Risponde con `pong` e il timestamp corrente                |
   *
   * @param {Buffer|string} raw - Payload grezzo ricevuto dal WebSocket.
   * @returns {void}
   */
  handleWsMessage(raw) {
    const msg = safeJsonParse(raw.toString('utf8'));
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'connect':
        this.connectToGame(msg);
        break;
      case 'target':
        this.sendTarget(msg);
        break;
      case 'split':
        this.sendSplit(msg);
        break;
      case 'eject':
        this.sendEject(msg);
        break;
      case 'chat':
        this.tcpSend({ type: 'chat', text: String(msg.text || '').slice(0, 180) });
        break;
      case 'respawn':
        this.tcpSend({ type: 'respawn' });
        break;
      case 'disconnect':
        this.close('manual');
        break;
      case 'ping':
        this.wsSend({ type: 'pong', at: Date.now() });
        break;
      default:
        break;
    }
  }
}

// ─── Reverse proxy verso api.js ───────────────────────────────────────────────

/**
 * @constant {number} API_PORT
 * @description Porta del server API Express. Deve corrispondere a quella definita in `api.js`.
 */
const API_PORT = Number(process.env.API_PORT || 3000);

/**
 * Fa da reverse proxy per le richieste `/api/...`, inoltrandole al server Express
 * in ascolto su `127.0.0.1:API_PORT`.
 * Restituisce HTTP 502 se il server API non è raggiungibile.
 *
 * @param {http.IncomingMessage} req - Richiesta HTTP in ingresso.
 * @param {http.ServerResponse} res - Risposta HTTP da inviare al client.
 * @returns {void}
 */
function proxyToApi(req, res) {
  const options = {
    hostname: '127.0.0.1',
    port: API_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };
  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'API server non raggiungibile' }));
  });
  req.pipe(proxyReq);
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

/**
 * Server HTTP che smista le richieste in arrivo:
 * - `/api/...` → {@link proxyToApi} (reverse proxy verso `api.js`)
 * - tutto il resto → file statici dalla cartella {@link publicDir}
 *
 * La directory traversal è prevenuta con `path.normalize` e un controllo
 * che il percorso assoluto rimanga dentro `publicDir`.
 *
 * @type {http.Server}
 */
const httpServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);

  if (requestUrl.pathname.startsWith('/api/')) {
    proxyToApi(req, res);
    return;
  }

  let filePath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  filePath = path.normalize(filePath).replace(/^\.\.(\/|\\|$)/, '');
  const absolutePath = path.join(publicDir, filePath);
  if (!absolutePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(absolutePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(absolutePath).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

/**
 * Server WebSocket montato su `/bridge`.
 * Ogni connessione crea una {@link GameBridgeSession} indipendente,
 * così ogni tab/browser/dispositivo LAN ha il proprio canale TCP+UDP.
 *
 * @type {WebSocketServer}
 */
const wss = new WebSocketServer({ server: httpServer, path: '/bridge' });

wss.on('connection', ws => {
  const game = new GameBridgeSession(ws);
  game.wsSend({ type: 'bridgeState', session: clonePublicSession(game.session) });

  ws.on('message', raw => game.handleWsMessage(raw));
  ws.on('close', () => game.destroy());
  ws.on('error', () => game.destroy());
});

// ─── Helper: URL LAN ──────────────────────────────────────────────────────────

/**
 * Raccoglie tutti gli indirizzi IPv4 non-loopback delle interfacce di rete
 * e li restituisce come URL accessibili dal browser, insieme a `127.0.0.1`.
 *
 * @returns {string[]} Lista di URL univoci del tipo `http://<ip>:<port>`.
 */
function localNetworkUrls() {
  const urls = [`http://127.0.0.1:${UI_PORT}`];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries || []) {
      if (info.family === 'IPv4' && !info.internal) urls.push(`http://${info.address}:${UI_PORT}`);
    }
  }
  return [...new Set(urls)];
}

// ─── Avvio e shutdown ─────────────────────────────────────────────────────────

/**
 * Avvia il server HTTP (e il WebSocket montato su di esso) sull'indirizzo {@link UI_HOST}
 * e la porta {@link UI_PORT}, poi stampa in console gli URL raggiungibili.
 */
httpServer.listen(UI_PORT, UI_HOST, () => {
  console.log(`Client bridge pronto su ${UI_HOST}:${UI_PORT}`);
  console.log('Multiplayer locale attivo: ogni tab/browser/dispositivo LAN ottiene una sessione TCP+UDP indipendente.');
  console.log('Apri uno di questi URL:');
  for (const url of localNetworkUrls()) console.log(`  - ${url}`);
  console.log('Se usi un solo PC con server e bridge, lascia host gioco 127.0.0.1 nel menu.');
});

/**
 * Gestisce la chiusura pulita del processo su `SIGINT` (Ctrl+C).
 * Chiude tutti i WebSocket attivi e l'HTTP server prima di uscire.
 */
process.on('SIGINT', () => {
  console.log('\nChiusura client bridge...');
  for (const client of wss.clients) {
    try { client.close(); } catch {}
  }
  httpServer.close();
  process.exit(0);
});