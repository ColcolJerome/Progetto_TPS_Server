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
const publicDir = path.join(__dirname, 'public');

// 0.0.0.0 abilita il multiplayer locale/LAN: altri dispositivi possono aprire
// http://IP_DEL_PC:8080 e ogni browser/tab avrà una propria sessione TCP+UDP.
const UI_HOST = process.env.UI_HOST || '0.0.0.0';
const UI_PORT = Number(process.env.UI_PORT || CONFIG.UI_PORT);

function clonePublicSession(session) {
  return { ...session, token: undefined };
}

function safeWsSend(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

class GameBridgeSession {
  constructor(ws) {
    this.ws = ws;
    this.tcp = null;
    this.udp = null;
    this.tcpBuffer = '';
    this.helloTimer = null;
    this.inputTimer = null;
    this.deadCloseTimer = null;
    this.latestSnapshot = null;
    this.inputSeq = 0;
    this.lastTarget = null;

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

    this.inputTimer = setInterval(() => {
      if (this.lastTarget) this.sendTarget(this.lastTarget);
    }, 1000 / 30);
  }

  wsSend(payload) {
    safeWsSend(this.ws, payload);
  }

  publishState(extra = {}) {
    this.wsSend({ type: 'bridgeState', session: clonePublicSession(this.session), ...extra });
  }

  tcpSend(payload) {
    if (!this.tcp || this.tcp.destroyed) return false;
    this.tcp.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

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

  destroy() {
    if (this.inputTimer) clearInterval(this.inputTimer);
    this.inputTimer = null;
    this.close('browserClosed', false);
  }

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
        // Chat, leaderboard, system messages are forwarded to the browser via tcpMessage.
        break;
    }
  }

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

  sendTarget(target) {
    if (!this.session.connected || !this.session.udpReady || !this.session.alive) return;
    const tx = Number(target.tx);
    const ty = Number(target.ty);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
    this.lastTarget = { tx, ty };
    this.udpSend({ type: 'input', seq: ++this.inputSeq, tx, ty });
  }

  sendSplit(target = this.lastTarget) {
    if (!this.session.connected || !this.session.udpReady || !this.session.alive) return;
    const tx = Number(target?.tx);
    const ty = Number(target?.ty);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
    this.lastTarget = { tx, ty };
    this.udpSend({ type: 'split', seq: ++this.inputSeq, tx, ty });
  }

  sendEject(target = this.lastTarget) {
    if (!this.session.connected || !this.session.udpReady || !this.session.alive) return;
    const tx = Number(target?.tx);
    const ty = Number(target?.ty);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
    this.lastTarget = { tx, ty };
    this.udpSend({ type: 'eject', seq: ++this.inputSeq, tx, ty });
  }

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

const httpServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);
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

const wss = new WebSocketServer({ server: httpServer, path: '/bridge' });

wss.on('connection', ws => {
  const game = new GameBridgeSession(ws);
  game.wsSend({ type: 'bridgeState', session: clonePublicSession(game.session) });

  ws.on('message', raw => game.handleWsMessage(raw));
  ws.on('close', () => game.destroy());
  ws.on('error', () => game.destroy());
});

function localNetworkUrls() {
  const urls = [`http://127.0.0.1:${UI_PORT}`];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries || []) {
      if (info.family === 'IPv4' && !info.internal) urls.push(`http://${info.address}:${UI_PORT}`);
    }
  }
  return [...new Set(urls)];
}

httpServer.listen(UI_PORT, UI_HOST, () => {
  console.log(`Client bridge pronto su ${UI_HOST}:${UI_PORT}`);
  console.log('Multiplayer locale attivo: ogni tab/browser/dispositivo LAN ottiene una sessione TCP+UDP indipendente.');
  console.log('Apri uno di questi URL:');
  for (const url of localNetworkUrls()) console.log(`  - ${url}`);
  console.log('Se usi un solo PC con server e bridge, lascia host gioco 127.0.0.1 nel menu.');
});

process.on('SIGINT', () => {
  console.log('\nChiusura client bridge...');
  for (const client of wss.clients) {
    try { client.close(); } catch {}
  }
  httpServer.close();
  process.exit(0);
});
