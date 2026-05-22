/**
 * @fileoverview Game server per il clone di Agar.io.
 * Gestisce il loop di gioco, le connessioni TCP di controllo e il canale UDP
 * per gli snapshot real-time. Supporta bot con intelligenza artificiale semplice
 * (fuga, caccia, farming, alleanze temporanee e tradimenti).
 *
 * Architettura della comunicazione:
 * - **TCP** – messaggi di controllo (join, chat, ping, respawn) con framing `\n`.
 * - **UDP** – snapshot ad alta frequenza (posizioni, cibo, pellet) e input del giocatore.
 *
 * @module server/server
 */

import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { CONFIG, clamp, rand, randomColor, safeJsonParse, sanitizeName } from '../shared/config.js';

/** Porta TCP effettiva (può essere sovrascritta via variabile d'ambiente). */
const TCP_PORT = Number(process.env.TCP_PORT || CONFIG.TCP_PORT);

/** Porta UDP effettiva (può essere sovrascritta via variabile d'ambiente). */
const UDP_PORT = Number(process.env.UDP_PORT || CONFIG.UDP_PORT);

/** Indirizzo di ascolto del server (default: tutte le interfacce). */
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Mappa di tutti i giocatori attivi, indicizzati per ID univoco.
 * @type {Map<string, Player>}
 */
const players = new Map();

/**
 * Array di tutti i pallini cibo presenti nel mondo.
 * @type {Food[]}
 */
const food = [];

/**
 * Array di tutti i pellet di massa espulsa ancora in gioco.
 * @type {Pellet[]}
 */
const ejectedMass = [];

/** Contatore globale per ID univoci del cibo. */
let foodSeq = 0;
/** Contatore globale per ID univoci dei pellet espulsi. */
let pelletSeq = 0;
/** Contatore globale per ID sequenziali dei bot. */
let botSeq = 0;
/** Contatore globale per ID univoci delle celle. */
let cellSeq = 0;
/** Timestamp dell'ultima scansione di formazione alleanze tra bot (ms). */
let lastAllianceScanAt = 0;

// ─── JSDoc typedef ──────────────────────────────────────────────────────────

/**
 * Singola cella di gioco appartenente a un giocatore.
 * Ogni giocatore può avere più celle dopo uno split.
 *
 * @typedef {Object} Cell
 * @property {string}  id       - Identificatore univoco della cella.
 * @property {string}  ownerId  - ID del giocatore proprietario.
 * @property {number}  x        - Posizione orizzontale corrente.
 * @property {number}  y        - Posizione verticale corrente.
 * @property {number}  mass     - Massa corrente della cella.
 * @property {number}  r        - Raggio corrente (derivato da `mass`).
 * @property {number}  vx       - Velocità orizzontale extra (impulso da split/eject).
 * @property {number}  vy       - Velocità verticale extra.
 * @property {number}  bornAt   - Timestamp di creazione (ms epoch).
 * @property {number}  mergeAt  - Timestamp dal quale la cella può fondersi (ms epoch).
 */

/**
 * Stato completo di un giocatore (umano o bot).
 *
 * @typedef {Object} Player
 * @property {string}                     id               - Identificatore univoco.
 * @property {string}                     token            - Segreto condiviso per autenticare i pacchetti UDP.
 * @property {string}                     name             - Nickname sanitizzato.
 * @property {string}                     color            - Colore esadecimale `#rrggbb`.
 * @property {Cell[]}                     cells            - Celle attive del giocatore.
 * @property {number}                     x                - Centroide orizzontale (media pesata per massa).
 * @property {number}                     y                - Centroide verticale.
 * @property {number}                     targetX          - Coordinata X verso cui si muovono le celle.
 * @property {number}                     targetY          - Coordinata Y verso cui si muovono le celle.
 * @property {number}                     mass             - Massa totale di tutte le celle.
 * @property {number}                     r                - Raggio equivalente alla massa totale.
 * @property {number}                     score            - Punteggio corrente (uguale a `mass`).
 * @property {number}                     kills            - Numero di avversari eliminati in questa sessione.
 * @property {boolean}                    alive            - Se `false`, il giocatore è morto.
 * @property {boolean}                    isBot            - `true` se controllato dall'AI del server.
 * @property {net.Socket=}                tcp              - Socket TCP del giocatore umano (assente per i bot).
 * @property {{address:string, port:number}=} udp         - Endpoint UDP registrato.
 * @property {number}                     lastInputAt      - Timestamp dell'ultimo input ricevuto (ms).
 * @property {number}                     joinedAt         - Timestamp di entrata in partita (ms).
 * @property {number}                     lastBotDecision  - Timestamp dell'ultima decisione AI del bot (ms).
 * @property {number}                     lastSplitAt      - Timestamp dell'ultimo split eseguito (ms).
 * @property {number}                     lastEjectAt      - Timestamp dell'ultimo eject eseguito (ms).
 * @property {number}                     lastCellLostAt   - Timestamp dell'ultima cella persa (ms).
 * @property {string|null}                allyId           - ID dell'alleato corrente del bot, o `null`.
 * @property {number}                     allyUntil        - Scadenza dell'alleanza (ms epoch).
 * @property {number}                     betrayAfter      - Timestamp dal quale il bot può tradire (ms epoch).
 * @property {number}                     lastAllyActionAt - Timestamp dell'ultima azione di supporto (ms).
 * @property {number}                     supportUntil     - Scadenza del ruolo di supporto attivo (ms).
 * @property {string|null}                supportTargetId  - ID del bersaglio da supportare, o `null`.
 * @property {number}                     botWanderX       - Destinazione X del wander corrente del bot.
 * @property {number}                     botWanderY       - Destinazione Y del wander corrente del bot.
 */

/**
 * Pallino cibo statico nel mondo.
 *
 * @typedef {Object} Food
 * @property {string} id    - Identificatore univoco.
 * @property {number} x     - Posizione orizzontale.
 * @property {number} y     - Posizione verticale.
 * @property {number} r     - Raggio.
 * @property {number} mass  - Massa (derivata da `r²`).
 * @property {string} color - Colore esadecimale.
 */

/**
 * Pellet di massa espulsa con il tasto W: si muove, poi diventa mangiabile.
 *
 * @typedef {Object} Pellet
 * @property {string} id        - Identificatore univoco.
 * @property {string} ownerId   - ID del giocatore che ha espulso il pellet.
 * @property {number} x         - Posizione orizzontale.
 * @property {number} y         - Posizione verticale.
 * @property {number} r         - Raggio.
 * @property {number} mass      - Massa.
 * @property {number} vx        - Velocità orizzontale.
 * @property {number} vy        - Velocità verticale.
 * @property {string} color     - Colore ereditato dal proprietario.
 * @property {number} bornAt    - Timestamp di creazione (ms).
 * @property {number} canEatAt  - Timestamp dal quale è riassorbibile dal proprietario (ms).
 */

// ─── Funzioni di conversione ─────────────────────────────────────────────────

/**
 * Converte il raggio di una cella nella sua massa equivalente.
 * Formula: `mass = r²`.
 *
 * @param {number} r - Raggio della cella.
 * @returns {number} Massa corrispondente.
 */
function radiusToMass(r) {
  return r * r;
}

/**
 * Converte la massa di una cella nel raggio equivalente.
 * Formula: `r = √mass` (minimo 1 per evitare celle di raggio zero).
 *
 * @param {number} mass - Massa della cella.
 * @returns {number} Raggio corrispondente.
 */
function massToRadius(mass) {
  return Math.sqrt(Math.max(1, mass));
}

/**
 * Genera un identificatore univoco con prefisso opzionale, basato su byte casuali.
 *
 * @param {string} [prefix=''] - Prefisso da anteporre all'ID.
 * @returns {string} Stringa nella forma `<prefix><16 caratteri hex>`.
 */
function makeId(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

/**
 * Genera una posizione casuale all'interno dei confini del mondo,
 * mantenendo un margine minimo dai bordi.
 *
 * @param {number} [margin=50] - Distanza minima da ogni bordo.
 * @returns {{x: number, y: number}} Coordinata casuale.
 */
function randomPoint(margin = 50) {
  return {
    x: rand(margin, CONFIG.WORLD_WIDTH - margin),
    y: rand(margin, CONFIG.WORLD_HEIGHT - margin)
  };
}

// ─── Creazione oggetti di gioco ──────────────────────────────────────────────

/**
 * Crea un nuovo pallino cibo in una posizione casuale del mondo.
 *
 * @returns {Food} L'oggetto cibo appena creato.
 */
function makeFood() {
  const r = rand(CONFIG.FOOD_RADIUS_MIN, CONFIG.FOOD_RADIUS_MAX);
  const p = randomPoint(20);
  return {
    id: `f${++foodSeq}`,
    x: p.x,
    y: p.y,
    r,
    mass: radiusToMass(r),
    color: randomColor()
  };
}

/**
 * Aggiunge pallini cibo finché non si raggiunge {@link CONFIG.FOOD_COUNT}.
 *
 * @returns {void}
 */
function replenishFood() {
  while (food.length < CONFIG.FOOD_COUNT) food.push(makeFood());
}

/**
 * Crea una nuova cella associata al giocatore specificato.
 *
 * @param {Player}  player         - Il giocatore proprietario.
 * @param {number}  x              - Posizione iniziale orizzontale.
 * @param {number}  y              - Posizione iniziale verticale.
 * @param {number}  mass           - Massa iniziale della cella.
 * @param {number}  [vx=0]         - Velocità orizzontale iniziale (es. impulso da split).
 * @param {number}  [vy=0]         - Velocità verticale iniziale.
 * @param {number}  [mergeDelayMs=0] - Ritardo aggiuntivo prima della fusione (ms).
 * @returns {Cell} La cella creata.
 */
function makeCell(player, x, y, mass, vx = 0, vy = 0, mergeDelayMs = 0) {
  const now = Date.now();
  return {
    id: `c-${++cellSeq}`,
    ownerId: player.id,
    x, y, mass,
    r: massToRadius(mass),
    vx, vy,
    bornAt: now,
    mergeAt: now + mergeDelayMs
  };
}

/**
 * Ricalcola i campi derivati del giocatore (massa totale, raggio, punteggio,
 * centroide) a partire dall'elenco corrente di celle.
 * Deve essere chiamata dopo ogni modifica alle celle.
 *
 * @param {Player} player - Il giocatore da aggiornare.
 * @returns {void}
 */
function updatePlayerDerived(player) {
  if (!player.cells.length) {
    player.mass = 0;
    player.r = 0;
    player.score = 0;
    return;
  }

  let total = 0, wx = 0, wy = 0;
  for (const c of player.cells) {
    c.r = massToRadius(c.mass);
    total += c.mass;
    wx += c.x * c.mass;
    wy += c.y * c.mass;
  }
  player.mass = total;
  player.r = massToRadius(total);
  player.score = total;
  player.x = wx / total;
  player.y = wy / total;
}

/**
 * Crea e registra un nuovo giocatore (umano o bot) nel mondo di gioco.
 * Aggiunge automaticamente la prima cella e calcola i dati derivati.
 *
 * @param {Object}       options          - Opzioni di creazione.
 * @param {string}       options.name     - Nome del giocatore (verrà sanitizzato).
 * @param {string=}      options.color    - Colore esadecimale `#rrggbb`; se omesso viene scelto casualmente.
 * @param {net.Socket=}  options.tcp      - Socket TCP del client; omesso per i bot.
 * @param {boolean}      [options.isBot=false] - Se `true`, crea un bot controllato dall'AI.
 * @returns {Player} Il giocatore creato e aggiunto alla mappa {@link players}.
 */
function makePlayer({ name, color, tcp, isBot = false }) {
  const p = randomPoint(120);
  const initialMass = radiusToMass(CONFIG.START_RADIUS);
  /** @type {Player} */
  const player = {
    id: isBot ? `bot-${++botSeq}` : makeId('p-'),
    token: isBot ? '' : makeId('t-'),
    name: sanitizeName(name, isBot ? `Bot ${botSeq + 1}` : 'Blob'),
    color: color || randomColor(),
    cells: [],
    x: p.x, y: p.y,
    targetX: p.x, targetY: p.y,
    mass: initialMass,
    r: CONFIG.START_RADIUS,
    score: Math.floor(initialMass),
    kills: 0,
    alive: true,
    isBot, tcp,
    udp: undefined,
    lastInputAt: Date.now(),
    joinedAt: Date.now(),
    lastBotDecision: 0,
    lastSplitAt: 0,
    lastEjectAt: 0,
    lastCellLostAt: 0,
    allyId: null, allyUntil: 0,
    betrayAfter: 0, lastAllyActionAt: 0,
    supportUntil: 0, supportTargetId: null,
    botWanderX: p.x, botWanderY: p.y
  };
  player.cells.push(makeCell(player, p.x, p.y, initialMass));
  updatePlayerDerived(player);
  players.set(player.id, player);
  return player;
}

/**
 * Resetta lo stato di un giocatore umano già esistente permettendogli
 * di rientrare in partita dopo la morte, senza ricreare la connessione TCP.
 *
 * @param {Player} player - Il giocatore da far rinascere.
 * @returns {void}
 */
function respawnPlayer(player) {
  const p = randomPoint(120);
  const initialMass = radiusToMass(CONFIG.START_RADIUS);
  player.cells = [makeCell(player, p.x, p.y, initialMass)];
  player.x = p.x; player.y = p.y;
  player.targetX = p.x; player.targetY = p.y;
  player.alive = true;
  player.lastInputAt = Date.now();
  player.lastSplitAt = 0; player.lastEjectAt = 0; player.lastCellLostAt = 0;
  player.allyId = null; player.allyUntil = 0;
  player.betrayAfter = 0; player.lastAllyActionAt = 0;
  player.supportUntil = 0; player.supportTargetId = null;
  player.botWanderX = p.x; player.botWanderY = p.y;
  updatePlayerDerived(player);
  tcpSend(player, { type: 'respawned', self: publicPlayer(player) });
}

/**
 * Aggiunge bot fino a raggiungere il numero configurato in {@link CONFIG.BOT_COUNT}.
 * Viene chiamato a ogni tick per rimpiazzare bot eliminati.
 *
 * @returns {void}
 */
function addBots() {
  const botNames = ['Byte', 'Nodo', 'Udpino', 'Tcpella', 'Blob.js', 'Packet', 'Ping', 'Pong', 'Kernel', 'Arena', 'Socket', 'Daemon', 'John sql'];
  while ([...players.values()].filter(p => p.isBot).length < CONFIG.BOT_COUNT) {
    makePlayer({ name: botNames[botSeq % botNames.length], color: randomColor(), isBot: true });
  }
}

// ─── Serializzazione pubblica ────────────────────────────────────────────────

/**
 * Crea la rappresentazione pubblica di una cella da includere negli snapshot UDP.
 * Omette i campi interni (vx, vy, mergeAt, bornAt) e arrotonda le coordinate
 * per ridurre le dimensioni del payload.
 *
 * @param {Player} player - Il giocatore proprietario della cella.
 * @param {Cell}   cell   - La cella da serializzare.
 * @returns {{ id: string, ownerId: string, name: string, color: string, x: number, y: number, r: number, isBot: boolean }}
 */
function publicCell(player, cell) {
  return {
    id: cell.id,
    ownerId: player.id,
    name: player.name,
    color: player.color,
    x: Math.round(cell.x),
    y: Math.round(cell.y),
    r: Math.round(cell.r * 10) / 10,
    isBot: player.isBot
  };
}

/**
 * Crea la rappresentazione pubblica di un giocatore da inviare al client.
 * Include tutte le sue celle serializzate tramite {@link publicCell}.
 *
 * @param {Player} p - Il giocatore da serializzare.
 * @returns {{ id: string, name: string, color: string, x: number, y: number, r: number, score: number, kills: number, isBot: boolean, cells: Array }}
 */
function publicPlayer(p) {
  return {
    id: p.id, name: p.name, color: p.color,
    x: Math.round(p.x), y: Math.round(p.y),
    r: Math.round(p.r * 10) / 10,
    score: Math.floor(p.score),
    kills: p.kills,
    isBot: p.isBot,
    cells: p.cells.map(c => publicCell(p, c))
  };
}

// ─── Comunicazione TCP ───────────────────────────────────────────────────────

/**
 * Invia un messaggio JSON al giocatore tramite il suo socket TCP.
 * Il messaggio viene serializzato e terminato con `\n` (framing a linee).
 * In caso di errore o socket distrutto, la chiamata viene ignorata silenziosamente.
 *
 * @param {Player} player  - Il destinatario.
 * @param {Object} message - L'oggetto da serializzare e inviare.
 * @returns {void}
 */
function tcpSend(player, message) {
  if (!player?.tcp || player.tcp.destroyed) return;
  try {
    player.tcp.write(`${JSON.stringify(message)}\n`);
  } catch {
    // Socket rotto: il gestore 'close' provvederà alla pulizia.
  }
}

/**
 * Invia un messaggio TCP a tutti i giocatori umani connessi.
 *
 * @param {Object} message - L'oggetto da trasmettere in broadcast.
 * @returns {void}
 */
function broadcastTcp(message) {
  for (const p of players.values()) {
    if (!p.isBot) tcpSend(p, message);
  }
}

// ─── Classifica ─────────────────────────────────────────────────────────────

/**
 * Calcola la classifica in tempo reale dei primi 10 giocatori per punteggio.
 *
 * @returns {Array<{ rank: number, id: string, name: string, score: number, r: number, isBot: boolean, cells: number }>}
 */
function leaderboard() {
  return [...players.values()]
    .filter(p => p.alive && p.cells.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((p, index) => ({
      rank: index + 1,
      id: p.id, name: p.name,
      score: Math.floor(p.score),
      r: Math.round(p.r),
      isBot: p.isBot,
      cells: p.cells.length
    }));
}

// ─── Utilità server ──────────────────────────────────────────────────────────

/**
 * Invia un messaggio di errore tramite TCP.
 * Accetta sia un socket grezzo (prima del join) sia un oggetto Player.
 *
 * @param {net.Socket|Player} socketOrPlayer - Il destinatario.
 * @param {string}            message        - Il testo dell'errore.
 * @returns {void}
 */
function sendError(socketOrPlayer, message) {
  const payload = `${JSON.stringify({ type: 'error', message })}\n`;
  if (socketOrPlayer?.write) socketOrPlayer.write(payload);
  else tcpSend(socketOrPlayer, { type: 'error', message });
}

/**
 * Verifica che l'accoppiata (id, token) corrisponda a un giocatore umano valido.
 * Usato per autenticare i pacchetti UDP, dove non esiste una sessione persistente.
 *
 * @param {string} id    - ID del giocatore.
 * @param {string} token - Token segreto del giocatore.
 * @returns {Player|null} Il giocatore se valido, `null` altrimenti.
 */
function validateToken(id, token) {
  const player = players.get(id);
  if (!player || player.isBot || player.token !== token) return null;
  return player;
}

// ─── Gestione messaggi TCP ───────────────────────────────────────────────────

/**
 * Processa un singolo messaggio TCP ricevuto da un client.
 * Il primo messaggio deve essere `{ type: "join" }`; i successivi richiedono
 * che `socketState.playerId` sia già impostato.
 *
 * Tipi gestiti: `join`, `chat`, `ping`, `respawn`.
 *
 * @param {net.Socket}               socket      - Il socket del mittente.
 * @param {string}                   raw         - La riga JSON grezza (senza `\n`).
 * @param {{ buffer: string, playerId: string|null }} socketState - Stato locale del socket.
 * @returns {void}
 */
function handleTcpMessage(socket, raw, socketState) {
  const msg = safeJsonParse(raw);
  if (!msg || typeof msg !== 'object') {
    sendError(socket, 'JSON non valido');
    return;
  }

  if (msg.type === 'join') {
    if (socketState.playerId) { sendError(socket, 'Sei gia connesso'); return; }
    const name = sanitizeName(msg.name, 'Blob');
    const color = typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color) ? msg.color : randomColor();
    const player = makePlayer({ name, color, tcp: socket, isBot: false });
    socketState.playerId = player.id;

    socket.write(`${JSON.stringify({
      type: 'welcome',
      id: player.id, token: player.token,
      name: player.name, color: player.color,
      tcpPort: TCP_PORT, udpPort: UDP_PORT,
      world: { width: CONFIG.WORLD_WIDTH, height: CONFIG.WORLD_HEIGHT },
      tickRate: CONFIG.TICK_RATE, snapshotRate: CONFIG.SNAPSHOT_RATE,
      maxCells: CONFIG.MAX_CELLS_PER_PLAYER,
      message: 'TCP ok: invia hello UDP per attivare gli snapshot real-time.'
    })}\n`);

    broadcastTcp({ type: 'system', message: `${player.name} è entrato in arena.` });
    console.log(`[TCP] join ${player.name} (${player.id}) from ${socket.remoteAddress}:${socket.remotePort}`);
    return;
  }

  const player = players.get(socketState.playerId);
  if (!player) { sendError(socket, 'Devi prima inviare {type:"join"}'); return; }

  switch (msg.type) {
    case 'chat': {
      const text = String(msg.text || '').replace(/[\r\n]/g, ' ').trim().slice(0, 180);
      if (!text) return;
      broadcastTcp({ type: 'chat', from: { id: player.id, name: player.name, color: player.color }, text, at: Date.now() });
      break;
    }
    case 'ping':
      tcpSend(player, { type: 'pong', at: Date.now(), echo: msg.at || null });
      break;
    case 'respawn':
      if (!player.alive || !player.cells.length) respawnPlayer(player);
      break;
    default:
      sendError(player, `Tipo TCP non gestito: ${msg.type}`);
  }
}

// ─── Server TCP ──────────────────────────────────────────────────────────────

/**
 * Server TCP che gestisce le connessioni dei client.
 * Per ogni connessione mantiene un buffer di framing a linee e uno stato locale
 * con l'ID del giocatore associato.
 *
 * @type {net.Server}
 */
const tcpServer = net.createServer(socket => {
  socket.setKeepAlive(true);
  socket.setNoDelay(true);
  const state = { buffer: '', playerId: null };

  socket.on('data', chunk => {
    state.buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, newlineIndex).trim();
      state.buffer = state.buffer.slice(newlineIndex + 1);
      if (line) handleTcpMessage(socket, line, state);
    }
    // Protezione contro buffer overflow da messaggi malformati o attacchi DoS.
    if (state.buffer.length > 8192) {
      sendError(socket, 'Messaggio TCP troppo grande');
      socket.destroy();
    }
  });

  socket.on('close', () => {
    if (state.playerId) {
      const p = players.get(state.playerId);
      if (p) {
        players.delete(state.playerId);
        broadcastTcp({ type: 'system', message: `${p.name} è uscito dall'arena.` });
        console.log(`[TCP] leave ${p.name} (${p.id})`);
      }
    }
  });

  socket.on('error', err => { console.warn(`[TCP] socket error: ${err.message}`); });
});

// ─── Server UDP ──────────────────────────────────────────────────────────────

/**
 * Socket UDP del server, condiviso per tutti i client.
 * @type {dgram.Socket}
 */
const udpServer = dgram.createSocket('udp4');

/**
 * Invia un payload JSON tramite UDP a un endpoint specificato.
 * I pacchetti che superano {@link CONFIG.UDP_PACKET_LIMIT_BYTES} vengono scartati
 * per evitare frammentazione a livello IP.
 *
 * @param {Player|{address: string, port: number}} rinfoOrPlayer - Destinatario: un Player (usa `player.udp`) o un `rinfo` diretto.
 * @param {Object}                                 payload       - L'oggetto da serializzare e inviare.
 * @returns {void}
 */
function udpSend(rinfoOrPlayer, payload) {
  const endpoint = rinfoOrPlayer.udp || rinfoOrPlayer;
  if (!endpoint?.address || !endpoint?.port) return;
  const buf = Buffer.from(JSON.stringify(payload));
  if (buf.byteLength > CONFIG.UDP_PACKET_LIMIT_BYTES) {
    console.warn(`[UDP] drop large packet (${buf.byteLength} bytes)`);
    return;
  }
  udpServer.send(buf, endpoint.port, endpoint.address, err => {
    if (err) console.warn(`[UDP] send error: ${err.message}`);
  });
}

// ─── Meccaniche di gioco ─────────────────────────────────────────────────────

/**
 * Esegue la divisione (split) di tutte le celle idonee di un giocatore verso
 * una direzione target. Rispetta il cooldown e il limite di celle per giocatore.
 *
 * @param {Player} player             - Il giocatore che esegue lo split.
 * @param {number} [tx=player.targetX] - Coordinata X del punto target.
 * @param {number} [ty=player.targetY] - Coordinata Y del punto target.
 * @returns {boolean} `true` se almeno una cella è stata divisa.
 */
function splitPlayer(player, tx = player.targetX, ty = player.targetY) {
  if (!player.alive || !player.cells.length) return false;
  const now = Date.now();
  if (now - player.lastSplitAt < CONFIG.SPLIT_COOLDOWN_MS) return false;
  if (player.cells.length >= CONFIG.MAX_CELLS_PER_PLAYER) return false;

  player.lastSplitAt = now;
  const candidates = [...player.cells]
    .filter(c => c.r >= CONFIG.SPLIT_MIN_RADIUS)
    .sort((a, b) => b.mass - a.mass);

  let created = 0;
  for (const cell of candidates) {
    if (player.cells.length >= CONFIG.MAX_CELLS_PER_PLAYER) break;
    if (cell.r < CONFIG.SPLIT_MIN_RADIUS) continue;

    const newMass = cell.mass / 2;
    cell.mass = newMass;
    cell.r = massToRadius(cell.mass);
    cell.mergeAt = now + CONFIG.MERGE_DELAY_MS;

    let dx = Number(tx) - cell.x, dy = Number(ty) - cell.y;
    let len = Math.hypot(dx, dy);
    if (!Number.isFinite(len) || len < 1) {
      dx = player.targetX - player.x; dy = player.targetY - player.y;
      len = Math.hypot(dx, dy);
    }
    if (len < 1) {
      const a = Math.random() * Math.PI * 2;
      dx = Math.cos(a); dy = Math.sin(a); len = 1;
    }
    const nx = dx / len, ny = dy / len;
    const childR = massToRadius(newMass);
    const child = makeCell(
      player,
      clamp(cell.x + nx * (cell.r + childR + 4), childR, CONFIG.WORLD_WIDTH - childR),
      clamp(cell.y + ny * (cell.r + childR + 4), childR, CONFIG.WORLD_HEIGHT - childR),
      newMass, nx * CONFIG.SPLIT_IMPULSE, ny * CONFIG.SPLIT_IMPULSE, CONFIG.MERGE_DELAY_MS
    );
    player.cells.push(child);
    created += 1;
  }

  if (created) {
    updatePlayerDerived(player);
    tcpSend(player, { type: 'split', cells: player.cells.length, maxCells: CONFIG.MAX_CELLS_PER_PLAYER });
  }
  return Boolean(created);
}

/**
 * Calcola il versore normalizzato dalla posizione di una cella verso un punto target.
 * Fallback progressivi per gestire vettori degeneri (lunghezza zero o NaN).
 *
 * @param {Cell}   cell   - La cella di partenza.
 * @param {Player} player - Il giocatore proprietario (usato come fallback).
 * @param {number} tx     - Coordinata X del target.
 * @param {number} ty     - Coordinata Y del target.
 * @returns {{ nx: number, ny: number }} Versore normalizzato.
 */
function directionFromCellToTarget(cell, player, tx, ty) {
  let dx = Number(tx) - cell.x, dy = Number(ty) - cell.y;
  let len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1) {
    dx = player.targetX - cell.x; dy = player.targetY - cell.y;
    len = Math.hypot(dx, dy);
  }
  if (!Number.isFinite(len) || len < 1) {
    const a = Math.random() * Math.PI * 2;
    dx = Math.cos(a); dy = Math.sin(a); len = 1;
  }
  return { nx: dx / len, ny: dy / len };
}

/**
 * Espelle massa (tasto W) da tutte le celle idonee del giocatore verso il target.
 * Ogni cella espulsa crea un {@link Pellet} con velocità iniziale.
 * Rispetta cooldown e dimensione minima della cella.
 *
 * @param {Player} player              - Il giocatore che espelle massa.
 * @param {number} [tx=player.targetX] - Coordinata X verso cui espellere.
 * @param {number} [ty=player.targetY] - Coordinata Y verso cui espellere.
 * @returns {boolean} `true` se è stato espulso almeno un pellet.
 */
function ejectMass(player, tx = player.targetX, ty = player.targetY) {
  if (!player.alive || !player.cells.length) return false;
  const now = Date.now();
  if (now - player.lastEjectAt < CONFIG.EJECT_COOLDOWN_MS) return false;

  const minRemainingMass = radiusToMass(CONFIG.EJECT_MIN_RADIUS * 0.82);
  const candidates = [...player.cells]
    .filter(c => c.r >= CONFIG.EJECT_MIN_RADIUS && c.mass > CONFIG.EJECT_MASS + minRemainingMass)
    .sort((a, b) => b.mass - a.mass);

  if (!candidates.length) return false;
  player.lastEjectAt = now;

  let count = 0;
  for (const cell of candidates) {
    const { nx, ny } = directionFromCellToTarget(cell, player, tx, ty);
    cell.mass -= CONFIG.EJECT_MASS;
    cell.r = massToRadius(cell.mass);

    const pellet = {
      id: `e-${++pelletSeq}`,
      ownerId: player.id,
      x: clamp(cell.x + nx * (cell.r + CONFIG.EJECT_RADIUS + 6), CONFIG.EJECT_RADIUS, CONFIG.WORLD_WIDTH - CONFIG.EJECT_RADIUS),
      y: clamp(cell.y + ny * (cell.r + CONFIG.EJECT_RADIUS + 6), CONFIG.EJECT_RADIUS, CONFIG.WORLD_HEIGHT - CONFIG.EJECT_RADIUS),
      r: CONFIG.EJECT_RADIUS,
      mass: CONFIG.EJECT_MASS,
      vx: nx * CONFIG.EJECT_IMPULSE,
      vy: ny * CONFIG.EJECT_IMPULSE,
      color: player.color,
      bornAt: now,
      canEatAt: now + CONFIG.EJECT_REABSORB_DELAY_MS
    };
    ejectedMass.push(pellet);
    count += 1;
  }

  // Mantiene il conteggio di pellet entro il limite per evitare lag.
  while (ejectedMass.length > CONFIG.EJECT_MAX_COUNT) ejectedMass.shift();
  updatePlayerDerived(player);
  tcpSend(player, { type: 'eject', pellets: count, mass: Math.floor(player.score) });
  return true;
}

// ─── Gestore messaggi UDP ────────────────────────────────────────────────────

/**
 * Gestisce i datagrammi UDP in arrivo.
 *
 * Tipi riconosciuti:
 * - `hello`  – Handshake iniziale: associa l'endpoint UDP al giocatore autenticato.
 * - `input`  – Aggiorna la coordinata target del giocatore (mouse/touch).
 * - `split`  – Richiesta di split verso il target corrente.
 * - `eject`  – Richiesta di eiezione massa verso il target corrente.
 */
udpServer.on('message', (message, rinfo) => {
  const msg = safeJsonParse(message.toString('utf8'));
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'hello') {
    const player = validateToken(msg.id, msg.token);
    if (!player) {
      udpSend(rinfo, { type: 'error', message: 'hello UDP rifiutato: id/token non validi' });
      return;
    }
    player.udp = { address: rinfo.address, port: rinfo.port };
    player.lastInputAt = Date.now();
    udpSend(rinfo, { type: 'helloAck', id: player.id, serverTime: Date.now() });
    tcpSend(player, { type: 'udpReady', endpoint: player.udp });
    console.log(`[UDP] bound ${player.name} (${player.id}) to ${rinfo.address}:${rinfo.port}`);
    return;
  }

  const player = validateToken(msg.id, msg.token);
  if (!player || !player.alive) return;
  // Aggiorna l'endpoint UDP se il client ha cambiato porta (NAT rebinding).
  if (!player.udp || player.udp.address !== rinfo.address || player.udp.port !== rinfo.port) {
    player.udp = { address: rinfo.address, port: rinfo.port };
  }

  const tx = Number(msg.tx), ty = Number(msg.ty);
  if (Number.isFinite(tx) && Number.isFinite(ty)) {
    player.targetX = clamp(tx, 0, CONFIG.WORLD_WIDTH);
    player.targetY = clamp(ty, 0, CONFIG.WORLD_HEIGHT);
    player.lastInputAt = Date.now();
  }

  if (msg.type === 'split') {
    splitPlayer(player, player.targetX, player.targetY);
  } else if (msg.type === 'eject') {
    ejectMass(player, player.targetX, player.targetY);
  }
});

udpServer.on('error', err => {
  console.error(`[UDP] server error: ${err.stack || err.message}`);
});

// ─── AI dei bot: utilità ─────────────────────────────────────────────────────

/**
 * Restituisce la cella con la massa più alta del giocatore.
 *
 * @param {Player} player - Il giocatore di cui cercare la cella più grande.
 * @returns {Cell|null} La cella più pesante, o `null` se il giocatore non ha celle.
 */
function largestCell(player) {
  return player.cells.reduce((best, cell) => (!best || cell.mass > best.mass ? cell : best), null);
}

/**
 * Verifica se due giocatori sono in un'alleanza attiva e reciproca al momento dato.
 * L'alleanza è valida solo se entrambi hanno lo stesso alleato registrato, le
 * scadenze non sono ancora passate e nessuno ha ancora deciso di tradire.
 *
 * @param {Player} a   - Primo giocatore.
 * @param {Player} b   - Secondo giocatore.
 * @param {number} [now=Date.now()] - Timestamp corrente (ms).
 * @returns {boolean} `true` se l'alleanza è attiva.
 */
function areAllied(a, b, now = Date.now()) {
  if (!a || !b) return false;
  return a.allyId === b.id && b.allyId === a.id
    && a.allyUntil > now && b.allyUntil > now
    && now < a.betrayAfter && now < b.betrayAfter;
}

/**
 * Scioglie l'alleanza tra due bot, azzerandone i campi correlati.
 * Può essere chiamata unilateralmente: se `b` è ancora alleato di `a`,
 * viene pulito anche `b`.
 *
 * @param {Player|null} a - Primo bot.
 * @param {Player|null} b - Secondo bot (può essere `null`).
 * @returns {void}
 */
function clearAlliance(a, b) {
  if (a) { a.allyId = null; a.allyUntil = 0; a.betrayAfter = 0; a.supportUntil = 0; a.supportTargetId = null; }
  if (b && b.allyId === a?.id) { b.allyId = null; b.allyUntil = 0; b.betrayAfter = 0; b.supportUntil = 0; b.supportTargetId = null; }
}

/**
 * Forma un'alleanza temporanea tra due bot. Solo bot possono allearsi.
 * La durata e il momento del tradimento vengono randomizzati per rendere il
 * comportamento meno prevedibile.
 *
 * @param {Player} a             - Primo bot.
 * @param {Player} b             - Secondo bot.
 * @param {number} [now=Date.now()] - Timestamp corrente (ms).
 * @returns {boolean} `true` se l'alleanza è stata creata, `false` altrimenti.
 */
function formAlliance(a, b, now = Date.now()) {
  if (!a || !b || a.id === b.id || !a.isBot || !b.isBot) return false;
  const until = now + CONFIG.BOT_ALLY_DURATION_MS + rand(-3500, 3500);
  const betrayAt = now + rand(CONFIG.BOT_ALLY_BETRAY_MIN_MS, CONFIG.BOT_ALLY_BETRAY_MAX_MS);
  a.allyId = b.id; b.allyId = a.id;
  a.allyUntil = b.allyUntil = until;
  a.betrayAfter = betrayAt + rand(-900, 900);
  b.betrayAfter = betrayAt + rand(-900, 900);
  a.lastAllyActionAt = b.lastAllyActionAt = now;
  return true;
}

/**
 * Restituisce tutte le celle nemiche visibili a un giocatore,
 * escludendo le proprie e quelle degli alleati correnti.
 *
 * @param {Player|string} owner          - Il giocatore osservante (o il suo ID).
 * @param {number}        [now=Date.now()] - Timestamp corrente (ms).
 * @returns {Array<{ player: Player, cell: Cell }>} Lista di riferimenti a celle nemiche.
 */
function allEnemyCells(owner, now = Date.now()) {
  const out = [];
  const ownerId = typeof owner === 'string' ? owner : owner.id;
  const ownerPlayer = typeof owner === 'string' ? players.get(owner) : owner;
  for (const p of players.values()) {
    if (!p.alive || !p.cells.length || p.id === ownerId) continue;
    if (ownerPlayer && areAllied(ownerPlayer, p, now)) continue;
    for (const c of p.cells) out.push({ player: p, cell: c });
  }
  return out;
}

/**
 * Cerca la migliore preda raggiungibile dalla cella più grande del bot.
 * La preda deve essere mangiabile (raggio sufficientemente inferiore) e
 * deve trovarsi entro una distanza di caccia proporzionale alla dimensione del bot.
 *
 * @param {Player} bot           - Il bot cacciatore.
 * @param {number} [now=Date.now()] - Timestamp corrente (ms).
 * @returns {{ player: Player, cell: Cell }|null} La preda con il punteggio migliore, o `null`.
 */
function findBestPreyFor(bot, now = Date.now()) {
  const biggest = largestCell(bot);
  if (!biggest) return null;
  let bestPrey = null, bestPreyScore = 0;
  for (const enemy of allEnemyCells(bot, now)) {
    const d = Math.hypot(enemy.cell.x - biggest.x, enemy.cell.y - biggest.y);
    if (biggest.r > enemy.cell.r * CONFIG.PLAYER_EAT_RATIO && d < 980 + biggest.r * 2.4) {
      const score = enemy.cell.mass / (d + 90) * (enemy.player.isBot ? 0.9 : 1.15);
      if (score > bestPreyScore) { bestPreyScore = score; bestPrey = enemy; }
    }
  }
  return bestPrey;
}

/**
 * Verifica se un bot può espellere massa (donare) senza rischiare la propria sopravvivenza.
 * Considera dimensione, massa totale e rapporto con il destinatario.
 *
 * @param {Player}      bot          - Il bot donatore.
 * @param {Player|null} [recipient=null] - Il destinatario; se fornito, controlla il rapporto di massa.
 * @returns {boolean} `true` se il bot può donare in sicurezza.
 */
function botCanDonate(bot, recipient = null) {
  if (!bot?.alive || !bot.cells?.length) return false;
  const big = largestCell(bot);
  if (!big || big.r < Math.max(28, CONFIG.EJECT_MIN_RADIUS)) return false;
  const safeFloor = radiusToMass(CONFIG.START_RADIUS) + CONFIG.EJECT_MASS * 5;
  if (bot.mass < safeFloor) return false;
  if (recipient && bot.mass < recipient.mass * 0.55) return false;
  if (bot.mass - CONFIG.EJECT_MASS < radiusToMass(24)) return false;
  return true;
}

// ─── AI dei bot: logica di alleanza e supporto ───────────────────────────────

/**
 * Gestisce il ciclo di vita delle alleanze tra bot:
 * - Scioglie le alleanze scadute o con alleato eliminato.
 * - Triggera tradimenti casuali quando il bot ha superato `betrayAfter`.
 * - Scansiona periodicamente per formare nuovi legami di supporto tattico.
 *
 * @param {number}   now  - Timestamp corrente (ms).
 * @param {Player[]} bots - Lista dei bot vivi al momento.
 * @returns {void}
 */
function coordinateBotAlliances(now, bots) {
  // 1) Gestione tradimenti e scadenze.
  for (const bot of bots) {
    const ally = bot.allyId ? players.get(bot.allyId) : null;
    if (!ally || !ally.alive || !ally.cells.length || bot.allyUntil <= now || ally.allyUntil <= now) {
      if (bot.allyId) clearAlliance(bot, ally);
      continue;
    }
    if (now >= bot.betrayAfter && Math.random() < 0.055) {
      const botBig = largestCell(bot), allyBig = largestCell(ally);
      clearAlliance(bot, ally);
      if (botBig && allyBig && botBig.r > allyBig.r * 1.08) {
        bot.targetX = ally.x; bot.targetY = ally.y;
      }
      broadcastTcp({ type: 'system', message: `${bot.name} ha tradito ${ally.name}!` });
    }
  }

  // 2) Supporto tattico: scansione meno frequente per non sovraccaricare la CPU.
  if (now - lastAllianceScanAt < 700) return;
  lastAllianceScanAt = now;

  for (const attacker of bots) {
    if (!attacker.alive || !attacker.cells.length) continue;
    const prey = findBestPreyFor(attacker, now);
    const attackerBig = largestCell(attacker);
    if (!prey || !attackerBig) continue;

    const distToPrey = Math.hypot(prey.cell.x - attackerBig.x, prey.cell.y - attackerBig.y);
    const splitRadius = massToRadius(attackerBig.mass / 2);
    const needsHelp = attackerBig.r < prey.cell.r * 1.75;
    const canBecomeKill = attackerBig.r > prey.cell.r * 1.10 || splitRadius > prey.cell.r * 1.02;
    const almostKill = distToPrey < 620 && needsHelp && canBecomeKill;
    if (!almostKill || Math.random() > 0.12) continue;

    // Cerca il bot helper più vicino all'attaccante.
    let helper = null, helperDist = Infinity;
    for (const candidate of bots) {
      if (candidate.id === attacker.id || !candidate.alive || !candidate.cells.length) continue;
      if (!botCanDonate(candidate, attacker)) continue;
      if (now - candidate.lastAllyActionAt < 1400) continue;
      const d = Math.hypot(candidate.x - attacker.x, candidate.y - attacker.y);
      if (d < Math.min(CONFIG.BOT_SUPPORT_RADIUS, 560) && d < helperDist) {
        if (candidate.allyId && candidate.allyId !== attacker.id && candidate.allyUntil > now) continue;
        helper = candidate; helperDist = d;
      }
    }

    if (!helper) continue;
    formAlliance(helper, attacker, now);
    helper.supportUntil = now + 1600; helper.supportTargetId = attacker.id;
    attacker.supportUntil = now + 1600; attacker.supportTargetId = prey.player.id;
    helper.targetX = attacker.x; helper.targetY = attacker.y;

    if (now - helper.lastAllyActionAt > 1400) {
      ejectMass(helper, attacker.x, attacker.y);
      helper.lastAllyActionAt = now;
      attacker.lastAllyActionAt = now;
    }
  }
}

// ─── AI dei bot: loop decisionale ───────────────────────────────────────────

/**
 * Aggiorna il comportamento di tutti i bot vivi per il tick corrente.
 * Ogni bot prende una nuova decisione ogni 160–340 ms (jitter randomizzato).
 *
 * Priorità decisionale (dalla più alta):
 * 1. **Supporto alleato** – Se è in fase di supporto, si dirige verso l'alleato.
 * 2. **Fuga** – Se c'è un pericolo con forza > 0.12, fuga pesata.
 * 3. **Caccia** – Se c'è una preda raggiungibile, insegue e valuta lo split offensivo.
 * 4. **Farming** – Cerca pellet espulsi o cibo nelle vicinanze.
 * 5. **Wander** – Si muove verso un punto casuale nell'arena.
 *
 * @param {number} now - Timestamp corrente (ms).
 * @returns {void}
 */
function updateBots(now) {
  const bots = [...players.values()].filter(p => p.isBot && p.alive && p.cells.length);
  coordinateBotAlliances(now, bots);
  const enemiesCache = new Map();

  for (const bot of bots) {
    if (now - bot.lastBotDecision < rand(160, 340)) continue;
    bot.lastBotDecision = now;
    updatePlayerDerived(bot);

    const biggest = largestCell(bot);
    if (!biggest) continue;

    // 1. Supporto alleato.
    if (bot.supportUntil > now && bot.supportTargetId) {
      const target = players.get(bot.supportTargetId);
      if (target?.alive && target.cells.length) {
        bot.targetX = target.x; bot.targetY = target.y;
        if (botCanDonate(bot, target) && bot.allyId === target.id && now - bot.lastAllyActionAt > 1400 && Math.random() < 0.08) {
          ejectMass(bot, target.x, target.y);
          bot.lastAllyActionAt = now;
        }
        continue;
      }
    }

    const enemies = enemiesCache.get(bot.id) || allEnemyCells(bot, now);
    enemiesCache.set(bot.id, enemies);

    let fleeX = 0, fleeY = 0, danger = 0;
    let nearestThreat = null, nearestThreatDist = Infinity;
    let bestPrey = null, bestPreyScore = 0;

    for (const enemy of enemies) {
      const dx = enemy.cell.x - bot.x, dy = enemy.cell.y - bot.y;
      const d = Math.hypot(dx, dy) || 1;
      const threatToBiggest = enemy.cell.r > biggest.r * CONFIG.PLAYER_EAT_RATIO;

      if (threatToBiggest) {
        const radius = 520 + enemy.cell.r * 3.2;
        if (d < radius) {
          const strength = ((radius - d) / radius) * Math.pow(enemy.cell.r / Math.max(1, biggest.r), 1.4);
          fleeX -= (dx / d) * strength; fleeY -= (dy / d) * strength;
          danger += strength;
          if (d < nearestThreatDist) { nearestThreat = enemy; nearestThreatDist = d; }
        }
      }

      if (biggest.r > enemy.cell.r * CONFIG.PLAYER_EAT_RATIO) {
        const chaseRadius = 980 + biggest.r * 2.4;
        if (d < chaseRadius) {
          const score = enemy.cell.mass / (d + 90) * (enemy.player.isBot ? 0.9 : 1.15);
          if (score > bestPreyScore) { bestPreyScore = score; bestPrey = enemy; }
        }
      }
    }

    // Repulsione dai bordi per evitare incastri.
    const edgeMargin = 260 + bot.r;
    if (bot.x < edgeMargin)                         fleeX += (edgeMargin - bot.x) / edgeMargin;
    if (bot.x > CONFIG.WORLD_WIDTH - edgeMargin)    fleeX -= (bot.x - (CONFIG.WORLD_WIDTH - edgeMargin)) / edgeMargin;
    if (bot.y < edgeMargin)                         fleeY += (edgeMargin - bot.y) / edgeMargin;
    if (bot.y > CONFIG.WORLD_HEIGHT - edgeMargin)   fleeY -= (bot.y - (CONFIG.WORLD_HEIGHT - edgeMargin)) / edgeMargin;

    // 2. Fuga.
    if (danger > 0.12) {
      const len = Math.hypot(fleeX, fleeY) || 1;
      bot.targetX = clamp(bot.x + (fleeX / len) * (850 + bot.r * 2), 0, CONFIG.WORLD_WIDTH);
      bot.targetY = clamp(bot.y + (fleeY / len) * (850 + bot.r * 2), 0, CONFIG.WORLD_HEIGHT);
      continue;
    }

    // 3. Caccia.
    if (bestPrey) {
      bot.targetX = bestPrey.cell.x; bot.targetY = bestPrey.cell.y;
      const splitRadius = massToRadius(biggest.mass / 2);
      const dist = Math.hypot(bestPrey.cell.x - biggest.x, bestPrey.cell.y - biggest.y);
      const canSplitKill = splitRadius > bestPrey.cell.r * CONFIG.PLAYER_EAT_RATIO && dist < 520 + biggest.r * 2.2;
      if (canSplitKill && bot.cells.length <= Math.floor(CONFIG.MAX_CELLS_PER_PLAYER / 2) && Math.random() < 0.28) {
        splitPlayer(bot, bestPrey.cell.x, bestPrey.cell.y);
      }
      continue;
    }

    // 4. Farming: pellet espulsi prima (più massa), poi food.
    let bestResource = null, bestResourceScore = 0;
    const search = 980 + bot.r * 3;
    for (const pellet of ejectedMass) {
      const d = Math.hypot(pellet.x - bot.x, pellet.y - bot.y);
      if (d > search) continue;
      const score = pellet.mass * 3.2 / (d + 80);
      if (score > bestResourceScore) { bestResourceScore = score; bestResource = pellet; }
    }
    for (const f of food) {
      const d = Math.hypot(f.x - bot.x, f.y - bot.y);
      if (d > search) continue;
      const score = f.mass / (d + 100);
      if (score > bestResourceScore) { bestResourceScore = score; bestResource = f; }
    }
    if (bestResource) { bot.targetX = bestResource.x; bot.targetY = bestResource.y; continue; }

    // 5. Wander coerente: aggiorna la meta solo quando raggiunta o per casualità.
    const wanderDist = Math.hypot(bot.botWanderX - bot.x, bot.botWanderY - bot.y);
    if (wanderDist < 160 || Math.random() < 0.035) {
      bot.botWanderX = clamp(bot.x + rand(-900, 900), 80, CONFIG.WORLD_WIDTH - 80);
      bot.botWanderY = clamp(bot.y + rand(-900, 900), 80, CONFIG.WORLD_HEIGHT - 80);
    }
    bot.targetX = bot.botWanderX; bot.targetY = bot.botWanderY;
  }
}

// ─── Fisica ───────────────────────────────────────────────────────────────────

/**
 * Aggiorna la posizione di tutte le celle di tutti i giocatori per un timestep `dt`.
 * Applica:
 * - Movimento verso `targetX/Y` con velocità scalata per raggio e numero di celle.
 * - Impulso da split/eject con attrito esponenziale.
 * - Clamping ai bordi del mondo.
 * - Decadimento di massa per celle sopra la dimensione iniziale.
 *
 * @param {number} dt - Timestep in secondi (clamped a 0.05 s per stabilità).
 * @returns {void}
 */
function moveCells(dt) {
  for (const p of players.values()) {
    if (!p.alive || !p.cells.length) continue;
    for (const c of p.cells) {
      c.r = massToRadius(c.mass);
      const dx = p.targetX - c.x, dy = p.targetY - c.y;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        const speed = clamp(CONFIG.BASE_SPEED / Math.pow(c.r / CONFIG.START_RADIUS, 0.48), CONFIG.MIN_SPEED, CONFIG.BASE_SPEED);
        const splitPenalty = Math.min(0.92, 1 / Math.pow(p.cells.length, 0.09));
        const step = Math.min(len, speed * splitPenalty * dt);
        c.x += (dx / len) * step; c.y += (dy / len) * step;
      }

      c.x += c.vx * dt; c.y += c.vy * dt;
      const friction = Math.exp(-3.8 * dt);
      c.vx *= friction; c.vy *= friction;
      if (Math.hypot(c.vx, c.vy) < 8) { c.vx = 0; c.vy = 0; }

      c.x = clamp(c.x, c.r, CONFIG.WORLD_WIDTH - c.r);
      c.y = clamp(c.y, c.r, CONFIG.WORLD_HEIGHT - c.r);

      if (p.mass > radiusToMass(CONFIG.START_RADIUS)) c.mass *= (1 - CONFIG.MASS_DECAY_PER_TICK);
      c.r = massToRadius(c.mass);
    }
    updatePlayerDerived(p);
  }
}

/**
 * Aggiorna la posizione di tutti i pellet di massa espulsa per un timestep `dt`.
 * Applica attrito esponenziale e rimbalzo elastico ai bordi del mondo.
 *
 * @param {number} dt - Timestep in secondi.
 * @returns {void}
 */
function moveEjectedPellets(dt) {
  for (let i = ejectedMass.length - 1; i >= 0; i--) {
    const pellet = ejectedMass[i];
    pellet.x += pellet.vx * dt; pellet.y += pellet.vy * dt;
    const friction = Math.exp(-2.6 * dt);
    pellet.vx *= friction; pellet.vy *= friction;
    if (Math.hypot(pellet.vx, pellet.vy) < 10) { pellet.vx = 0; pellet.vy = 0; }

    if (pellet.x < pellet.r)                       { pellet.x = pellet.r; pellet.vx = Math.abs(pellet.vx) * 0.25; }
    else if (pellet.x > CONFIG.WORLD_WIDTH - pellet.r)  { pellet.x = CONFIG.WORLD_WIDTH - pellet.r; pellet.vx = -Math.abs(pellet.vx) * 0.25; }
    if (pellet.y < pellet.r)                       { pellet.y = pellet.r; pellet.vy = Math.abs(pellet.vy) * 0.25; }
    else if (pellet.y > CONFIG.WORLD_HEIGHT - pellet.r) { pellet.y = CONFIG.WORLD_HEIGHT - pellet.r; pellet.vy = -Math.abs(pellet.vy) * 0.25; }
  }
}

/**
 * Gestisce la fusione e la separazione delle celle dello stesso giocatore.
 * Per ogni giocatore con più di una cella:
 * - Se due celle sono pronte a fondersi e sufficientemente vicine, vengono unite
 *   (media pesata di posizione, velocità e massa).
 * - Se non sono ancora pronte, vengono respinte delicatamente per evitare sovrapposizioni.
 *
 * Usa un loop `do...while` con ricerca dall'inizio dopo ogni fusione per
 * evitare indici non validi causati da `splice()`.
 *
 * @param {number} now - Timestamp corrente (ms).
 * @returns {void}
 */
function handleSameOwnerCells(now) {
  for (const p of players.values()) {
    if (!p.alive || p.cells.length < 2) continue;
    let merged;
    do {
      merged = false;
      outer:
      for (let i = 0; i < p.cells.length; i++) {
        for (let j = i + 1; j < p.cells.length; j++) {
          const a = p.cells[i], b = p.cells[j];
          if (!a || !b) continue;
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.hypot(dx, dy) || 0.0001;
          const nx = dx / d, ny = dy / d;
          const mergeReady = now >= a.mergeAt && now >= b.mergeAt;

          if (mergeReady && d < (a.r + b.r) * 0.65) {
            const bigIndex = a.mass >= b.mass ? i : j;
            const smallIndex = a.mass >= b.mass ? j : i;
            const big = p.cells[bigIndex], small = p.cells[smallIndex];
            if (!big || !small) continue;
            const totalMass = big.mass + small.mass;
            big.x = (big.x * big.mass + small.x * small.mass) / totalMass;
            big.y = (big.y * big.mass + small.y * small.mass) / totalMass;
            big.vx = (big.vx * big.mass + small.vx * small.mass) / totalMass;
            big.vy = (big.vy * big.mass + small.vy * small.mass) / totalMass;
            big.mass = totalMass; big.r = massToRadius(big.mass);
            big.mergeAt = Math.max(big.mergeAt, small.mergeAt);
            p.cells.splice(smallIndex, 1);
            merged = true;
            break outer;
          }

          const overlap = a.r + b.r - d;
          if (overlap > 0 && !mergeReady) {
            const push = overlap * 0.035;
            a.x = clamp(a.x + nx * push, a.r, CONFIG.WORLD_WIDTH - a.r);
            a.y = clamp(a.y + ny * push, a.r, CONFIG.WORLD_HEIGHT - a.r);
            b.x = clamp(b.x - nx * push, b.r, CONFIG.WORLD_WIDTH - b.r);
            b.y = clamp(b.y - ny * push, b.r, CONFIG.WORLD_HEIGHT - b.r);
          }
        }
      }
    } while (merged && p.cells.length > 1);
    updatePlayerDerived(p);
  }
}

/**
 * Controlla le collisioni tra le celle dei giocatori e il cibo.
 * Se una cella tocca abbastanza un pallino cibo, lo assorbe guadagnando il 90% della sua massa.
 * Il cibo consumato viene rimosso dall'array e ripristinato da {@link replenishFood}.
 *
 * @returns {void}
 */
function handleFoodCollisions() {
  for (const p of players.values()) {
    if (!p.alive || !p.cells.length) continue;
    for (const c of p.cells) {
      for (let i = food.length - 1; i >= 0; i--) {
        const f = food[i];
        const d = Math.hypot(c.x - f.x, c.y - f.y);
        if (d < c.r + f.r * 0.55) { c.mass += f.mass * 0.9; food.splice(i, 1); }
      }
    }
    updatePlayerDerived(p);
  }
  replenishFood();
}

/**
 * Controlla le collisioni tra le celle dei giocatori e i pellet di massa espulsa.
 * Un pellet viene assorbito se una cella ci si sovrappone, a patto che:
 * - Non appartenga al proprietario stesso entro il `canEatAt` delay.
 *
 * @param {number} now - Timestamp corrente (ms).
 * @returns {void}
 */
function handleEjectedCollisions(now) {
  if (!ejectedMass.length) return;
  for (const p of players.values()) {
    if (!p.alive || !p.cells.length) continue;
    let ateAny = false;
    for (const c of p.cells) {
      for (let i = ejectedMass.length - 1; i >= 0; i--) {
        const pellet = ejectedMass[i];
        if (pellet.ownerId === p.id && now < pellet.canEatAt) continue;
        const d = Math.hypot(c.x - pellet.x, c.y - pellet.y);
        if (d < c.r + pellet.r * 0.62) { c.mass += pellet.mass * CONFIG.EJECT_EAT_GAIN; ejectedMass.splice(i, 1); ateAny = true; }
      }
    }
    if (ateAny) updatePlayerDerived(p);
  }
}

/**
 * Rimuove una cella specifica dall'array di celle del giocatore, aggiorna i
 * dati derivati e imposta `alive = false` se non restano altre celle.
 * Aggiorna anche `lastCellLostAt` per la finestra di grazia.
 *
 * @param {Player} player - Il proprietario della cella.
 * @param {Cell}   cell   - La cella da rimuovere.
 * @returns {void}
 */
function removeCell(player, cell) {
  const idx = player.cells.findIndex(c => c.id === cell.id);
  if (idx >= 0) { player.cells.splice(idx, 1); player.lastCellLostAt = Date.now(); }
  updatePlayerDerived(player);
  if (!player.cells.length) player.alive = false;
}

/**
 * Gestisce le collisioni tra celle di giocatori diversi (PvP).
 * Una cella mangia un'altra se il suo raggio è almeno {@link CONFIG.PLAYER_EAT_RATIO}
 * volte quello della preda e il centroide del cacciatore è abbastanza vicino.
 * In caso di morte, notifica il perdente via TCP e aggiorna uccisioni/score.
 *
 * @returns {void}
 */
function handlePlayerCollisions() {
  const now = Date.now();
  const allCells = [];
  for (const p of players.values()) {
    if (!p.alive || !p.cells.length) continue;
    for (const c of p.cells) allCells.push({ player: p, cell: c });
  }

  for (let i = 0; i < allCells.length; i++) {
    for (let j = i + 1; j < allCells.length; j++) {
      const A = allCells[i], B = allCells[j];
      if (A.player.id === B.player.id) continue;
      if (areAllied(A.player, B.player, now)) continue;
      if (!A.player.alive || !B.player.alive) continue;
      if (!A.player.cells.includes(A.cell) || !B.player.cells.includes(B.cell)) continue;

      let hunter = null, prey = null;
      if (A.cell.r > B.cell.r * CONFIG.PLAYER_EAT_RATIO) { hunter = A; prey = B; }
      else if (B.cell.r > A.cell.r * CONFIG.PLAYER_EAT_RATIO) { hunter = B; prey = A; }
      if (!hunter) continue;

      // Finestra di grazia: evita che un giocatore splittato venga istantaneamente eliminato.
      if (prey.player.cells.length > 1 && now - prey.player.lastCellLostAt < CONFIG.CELL_LOSS_GRACE_MS) continue;

      const d = Math.hypot(hunter.cell.x - prey.cell.x, hunter.cell.y - prey.cell.y);
      if (d < hunter.cell.r - prey.cell.r * 0.22) {
        const preyScoreBefore = prey.player.score;
        hunter.cell.mass += prey.cell.mass * CONFIG.PLAYER_EAT_GAIN;
        hunter.player.kills += 1;
        removeCell(prey.player, prey.cell);
        updatePlayerDerived(hunter.player);

        if (prey.player.alive) {
          tcpSend(prey.player, { type: 'cellLost', remainingCells: prey.player.cells.length, message: `${hunter.player.name} ha mangiato una tua cella, ma sei ancora vivo.` });
        }

        if (!prey.player.alive) {
          tcpSend(prey.player, { type: 'dead', killer: { id: hunter.player.id, name: hunter.player.name, color: hunter.player.color }, score: Math.floor(preyScoreBefore), message: `${hunter.player.name} ti ha assorbito.` });
          if (prey.player.isBot) players.delete(prey.player.id);
          else broadcastTcp({ type: 'system', message: `${hunter.player.name} ha assorbito ${prey.player.name}.` });
        }
      }
    }
  }
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Crea uno snapshot del mondo visibile da un determinato giocatore.
 * Il raggio di visione è proporzionale alla dimensione del giocatore, con un
 * margine extra per eliminare il pop-in visivo.
 * Filtra i giocatori, il cibo e i pellet per distanza al centroide del giocatore.
 *
 * @param {Player} player - Il giocatore destinatario dello snapshot.
 * @returns {{
 *   type: 'snapshot',
 *   serverTime: number,
 *   world: { width: number, height: number },
 *   selfId: string,
 *   self: Object,
 *   players: Array,
 *   food: Array,
 *   pellets: Array,
 *   fullMap: false,
 *   overfetchRadius: number,
 *   leaderboard: Array
 * }} Lo snapshot serializzabile da inviare via UDP.
 */
function createSnapshotFor(player) {
  updatePlayerDerived(player);
  const viewRadius = clamp(2450 + player.r * 4, 2450, 3300);
  const viewR2 = viewRadius * viewRadius;

  const visiblePlayers = [];
  for (const p of players.values()) {
    if (!p.alive || !p.cells.length) continue;
    for (const c of p.cells) {
      const dx = c.x - player.x, dy = c.y - player.y;
      if (dx * dx + dy * dy <= viewR2 || p.id === player.id) visiblePlayers.push(publicCell(p, c));
    }
  }

  const visibleFood = [];
  for (const f of food) {
    const dx = f.x - player.x, dy = f.y - player.y;
    if (dx * dx + dy * dy <= viewR2) visibleFood.push({ id: f.id, x: Math.round(f.x), y: Math.round(f.y), r: Math.round(f.r * 10) / 10, color: f.color });
  }

  const visiblePellets = [];
  for (const pellet of ejectedMass) {
    const dx = pellet.x - player.x, dy = pellet.y - player.y;
    if (dx * dx + dy * dy <= viewR2) visiblePellets.push({ id: pellet.id, ownerId: pellet.ownerId, x: Math.round(pellet.x), y: Math.round(pellet.y), r: Math.round(pellet.r * 10) / 10, color: pellet.color });
  }

  return {
    type: 'snapshot',
    serverTime: Date.now(),
    world: { width: CONFIG.WORLD_WIDTH, height: CONFIG.WORLD_HEIGHT },
    selfId: player.id,
    self: publicPlayer(player),
    players: visiblePlayers,
    food: visibleFood,
    pellets: visiblePellets,
    fullMap: false,
    overfetchRadius: viewRadius,
    leaderboard: leaderboard()
  };
}

// ─── Game loop ────────────────────────────────────────────────────────────────

/** Timestamp dell'ultimo invio di snapshot (ms). */
let lastSnapshotAt = 0;
/** Timestamp dell'ultimo broadcast della classifica (ms). */
let lastLeaderboardAt = 0;
/** Timestamp dell'ultimo tick del game loop (ms). */
let lastTickAt = Date.now();

/**
 * Loop principale del gioco, eseguito a {@link CONFIG.TICK_RATE} fps.
 * Ogni tick:
 * 1. Calcola il delta time (max 50 ms per evitare salti fisici enormi).
 * 2. Aggiorna i bot, muove celle e pellet, gestisce fusioni e collisioni.
 * 3. Invia snapshot UDP ai client connessi secondo {@link CONFIG.SNAPSHOT_RATE}.
 * 4. Invia la classifica in broadcast TCP secondo {@link CONFIG.LEADERBOARD_RATE}.
 *
 * @returns {void}
 */
function gameLoop() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTickAt) / 1000);
  lastTickAt = now;

  updateBots(now);
  moveCells(dt);
  moveEjectedPellets(dt);
  handleSameOwnerCells(now);
  handleFoodCollisions();
  handleEjectedCollisions(now);
  handlePlayerCollisions();
  addBots();

  if (now - lastSnapshotAt >= 1000 / CONFIG.SNAPSHOT_RATE) {
    lastSnapshotAt = now;
    for (const p of players.values()) {
      if (!p.isBot && p.alive && p.cells.length && p.udp) udpSend(p, createSnapshotFor(p));
    }
  }

  if (now - lastLeaderboardAt >= 1000 / CONFIG.LEADERBOARD_RATE) {
    lastLeaderboardAt = now;
    broadcastTcp({ type: 'leaderboard', leaderboard: leaderboard(), at: now });
  }
}

// ─── Inizializzazione e avvio ────────────────────────────────────────────────

replenishFood();
addBots();

tcpServer.listen(TCP_PORT, HOST, () => {
  console.log(`[TCP] listening on ${HOST}:${TCP_PORT}`);
});

udpServer.bind(UDP_PORT, HOST, () => {
  console.log(`[UDP] listening on ${HOST}:${UDP_PORT}`);
  console.log(`Arena ${CONFIG.WORLD_WIDTH}x${CONFIG.WORLD_HEIGHT}, food=${CONFIG.FOOD_COUNT}, bots=${CONFIG.BOT_COUNT}`);
});

setInterval(gameLoop, 1000 / CONFIG.TICK_RATE);

/**
 * Gestione del segnale SIGINT (Ctrl+C):
 * notifica i client della chiusura imminente e termina ordinatamente i server.
 */
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  broadcastTcp({ type: 'system', message: 'Server in chiusura.' });
  tcpServer.close();
  udpServer.close();
  process.exit(0);
});