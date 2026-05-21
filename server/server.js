import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { CONFIG, clamp, rand, randomColor, safeJsonParse, sanitizeName } from '../shared/config.js';

const TCP_PORT = Number(process.env.TCP_PORT || CONFIG.TCP_PORT);
const UDP_PORT = Number(process.env.UDP_PORT || CONFIG.UDP_PORT);
const HOST = process.env.HOST || '0.0.0.0';

/** @type {Map<string, Player>} */
const players = new Map();
/** @type {Food[]} */
const food = [];
/** @type {Pellet[]} */
const ejectedMass = [];
let foodSeq = 0;
let pelletSeq = 0;
let botSeq = 0;
let cellSeq = 0;
let lastAllianceScanAt = 0;

/**
 * @typedef {Object} Cell
 * @property {string} id
 * @property {string} ownerId
 * @property {number} x
 * @property {number} y
 * @property {number} mass
 * @property {number} r
 * @property {number} vx
 * @property {number} vy
 * @property {number} bornAt
 * @property {number} mergeAt
 */

/**
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} token
 * @property {string} name
 * @property {string} color
 * @property {Cell[]} cells
 * @property {number} x
 * @property {number} y
 * @property {number} targetX
 * @property {number} targetY
 * @property {number} mass
 * @property {number} r
 * @property {number} score
 * @property {number} kills
 * @property {boolean} alive
 * @property {boolean} isBot
 * @property {net.Socket=} tcp
 * @property {{address:string, port:number}=} udp
 * @property {number} lastInputAt
 * @property {number} joinedAt
 * @property {number} lastBotDecision
 * @property {number} lastSplitAt
 * @property {number} lastEjectAt
 * @property {number} lastCellLostAt
 * @property {string|null} allyId
 * @property {number} allyUntil
 * @property {number} betrayAfter
 * @property {number} lastAllyActionAt
 * @property {number} supportUntil
 * @property {string|null} supportTargetId
 * @property {number} botWanderX
 * @property {number} botWanderY
 */

/**
 * @typedef {Object} Food
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} r
 * @property {number} mass
 * @property {string} color
 */

/**
 * Massa espulsa con W: è un pellet mobile, poi diventa mangiabile.
 * @typedef {Object} Pellet
 * @property {string} id
 * @property {string} ownerId
 * @property {number} x
 * @property {number} y
 * @property {number} r
 * @property {number} mass
 * @property {number} vx
 * @property {number} vy
 * @property {string} color
 * @property {number} bornAt
 * @property {number} canEatAt
 */

function radiusToMass(r) {
  return r * r;
}

function massToRadius(mass) {
  return Math.sqrt(Math.max(1, mass));
}

function makeId(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function randomPoint(margin = 50) {
  return {
    x: rand(margin, CONFIG.WORLD_WIDTH - margin),
    y: rand(margin, CONFIG.WORLD_HEIGHT - margin)
  };
}

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

function replenishFood() {
  while (food.length < CONFIG.FOOD_COUNT) food.push(makeFood());
}

function makeCell(player, x, y, mass, vx = 0, vy = 0, mergeDelayMs = 0) {
  const now = Date.now();
  return {
    id: `c-${++cellSeq}`,
    ownerId: player.id,
    x,
    y,
    mass,
    r: massToRadius(mass),
    vx,
    vy,
    bornAt: now,
    mergeAt: now + mergeDelayMs
  };
}

function updatePlayerDerived(player) {
  if (!player.cells.length) {
    player.mass = 0;
    player.r = 0;
    player.score = 0;
    return;
  }

  let total = 0;
  let wx = 0;
  let wy = 0;
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
    x: p.x,
    y: p.y,
    targetX: p.x,
    targetY: p.y,
    mass: initialMass,
    r: CONFIG.START_RADIUS,
    score: Math.floor(initialMass),
    kills: 0,
    alive: true,
    isBot,
    tcp,
    udp: undefined,
    lastInputAt: Date.now(),
    joinedAt: Date.now(),
    lastBotDecision: 0,
    lastSplitAt: 0,
    lastEjectAt: 0,
    lastCellLostAt: 0,
    allyId: null,
    allyUntil: 0,
    betrayAfter: 0,
    lastAllyActionAt: 0,
    supportUntil: 0,
    supportTargetId: null,
    botWanderX: p.x,
    botWanderY: p.y
  };
  player.cells.push(makeCell(player, p.x, p.y, initialMass));
  updatePlayerDerived(player);
  players.set(player.id, player);
  return player;
}

function respawnPlayer(player) {
  const p = randomPoint(120);
  const initialMass = radiusToMass(CONFIG.START_RADIUS);
  player.cells = [makeCell(player, p.x, p.y, initialMass)];
  player.x = p.x;
  player.y = p.y;
  player.targetX = p.x;
  player.targetY = p.y;
  player.alive = true;
  player.lastInputAt = Date.now();
  player.lastSplitAt = 0;
  player.lastEjectAt = 0;
  player.lastCellLostAt = 0;
  player.allyId = null;
  player.allyUntil = 0;
  player.betrayAfter = 0;
  player.lastAllyActionAt = 0;
  player.supportUntil = 0;
  player.supportTargetId = null;
  player.botWanderX = p.x;
  player.botWanderY = p.y;
  updatePlayerDerived(player);
  tcpSend(player, { type: 'respawned', self: publicPlayer(player) });
}

function addBots() {
  const botNames = ['Byte', 'Nodo', 'Udpino', 'Tcpella', 'Blob.js', 'Packet', 'Ping', 'Pong', 'Kernel', 'Arena', 'Socket', 'Daemon', 'John sql'];
  while ([...players.values()].filter(p => p.isBot).length < CONFIG.BOT_COUNT) {
    makePlayer({
      name: botNames[botSeq % botNames.length],
      color: randomColor(),
      isBot: true
    });
  }
}

function publicCell(player, cell) {
  // Campi essenziali per il rendering: evitando score/kills ripetuti su ogni cella
  // teniamo i pacchetti UDP più compatti.
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

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    x: Math.round(p.x),
    y: Math.round(p.y),
    r: Math.round(p.r * 10) / 10,
    score: Math.floor(p.score),
    kills: p.kills,
    isBot: p.isBot,
    cells: p.cells.map(c => publicCell(p, c))
  };
}

function tcpSend(player, message) {
  if (!player?.tcp || player.tcp.destroyed) return;
  try {
    player.tcp.write(`${JSON.stringify(message)}\n`);
  } catch {
    // Ignore broken sockets; close handler will clean up.
  }
}

function broadcastTcp(message) {
  for (const p of players.values()) {
    if (!p.isBot) tcpSend(p, message);
  }
}

function leaderboard() {
  return [...players.values()]
    .filter(p => p.alive && p.cells.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((p, index) => ({ rank: index + 1, id: p.id, name: p.name, score: Math.floor(p.score), r: Math.round(p.r), isBot: p.isBot, cells: p.cells.length }));
}

function sendError(socketOrPlayer, message) {
  const payload = `${JSON.stringify({ type: 'error', message })}\n`;
  if (socketOrPlayer?.write) socketOrPlayer.write(payload);
  else tcpSend(socketOrPlayer, { type: 'error', message });
}

function validateToken(id, token) {
  const player = players.get(id);
  if (!player || player.isBot || player.token !== token) return null;
  return player;
}

function handleTcpMessage(socket, raw, socketState) {
  const msg = safeJsonParse(raw);
  if (!msg || typeof msg !== 'object') {
    sendError(socket, 'JSON non valido');
    return;
  }

  if (msg.type === 'join') {
    if (socketState.playerId) {
      sendError(socket, 'Sei gia connesso');
      return;
    }

    const name = sanitizeName(msg.name, 'Blob');
    const color = typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color) ? msg.color : randomColor();
    const player = makePlayer({ name, color, tcp: socket, isBot: false });
    socketState.playerId = player.id;

    socket.write(`${JSON.stringify({
      type: 'welcome',
      id: player.id,
      token: player.token,
      name: player.name,
      color: player.color,
      tcpPort: TCP_PORT,
      udpPort: UDP_PORT,
      world: { width: CONFIG.WORLD_WIDTH, height: CONFIG.WORLD_HEIGHT },
      tickRate: CONFIG.TICK_RATE,
      snapshotRate: CONFIG.SNAPSHOT_RATE,
      maxCells: CONFIG.MAX_CELLS_PER_PLAYER,
      message: 'TCP ok: invia hello UDP per attivare gli snapshot real-time.'
    })}\n`);

    broadcastTcp({ type: 'system', message: `${player.name} è entrato in arena.` });
    console.log(`[TCP] join ${player.name} (${player.id}) from ${socket.remoteAddress}:${socket.remotePort}`);
    return;
  }

  const player = players.get(socketState.playerId);
  if (!player) {
    sendError(socket, 'Devi prima inviare {type:"join"}');
    return;
  }

  switch (msg.type) {
    case 'chat': {
      const text = String(msg.text || '').replace(/[\r\n]/g, ' ').trim().slice(0, 180);
      if (!text) return;
      broadcastTcp({
        type: 'chat',
        from: { id: player.id, name: player.name, color: player.color },
        text,
        at: Date.now()
      });
      break;
    }
    case 'ping': {
      tcpSend(player, { type: 'pong', at: Date.now(), echo: msg.at || null });
      break;
    }
    case 'respawn': {
      if (!player.alive || !player.cells.length) respawnPlayer(player);
      break;
    }
    default:
      sendError(player, `Tipo TCP non gestito: ${msg.type}`);
  }
}

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

  socket.on('error', err => {
    console.warn(`[TCP] socket error: ${err.message}`);
  });
});

const udpServer = dgram.createSocket('udp4');

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

    let dx = Number(tx) - cell.x;
    let dy = Number(ty) - cell.y;
    let len = Math.hypot(dx, dy);
    if (!Number.isFinite(len) || len < 1) {
      dx = player.targetX - player.x;
      dy = player.targetY - player.y;
      len = Math.hypot(dx, dy);
    }
    if (len < 1) {
      const a = Math.random() * Math.PI * 2;
      dx = Math.cos(a);
      dy = Math.sin(a);
      len = 1;
    }
    const nx = dx / len;
    const ny = dy / len;
    const childR = massToRadius(newMass);
    const child = makeCell(
      player,
      clamp(cell.x + nx * (cell.r + childR + 4), childR, CONFIG.WORLD_WIDTH - childR),
      clamp(cell.y + ny * (cell.r + childR + 4), childR, CONFIG.WORLD_HEIGHT - childR),
      newMass,
      nx * CONFIG.SPLIT_IMPULSE,
      ny * CONFIG.SPLIT_IMPULSE,
      CONFIG.MERGE_DELAY_MS
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

function directionFromCellToTarget(cell, player, tx, ty) {
  let dx = Number(tx) - cell.x;
  let dy = Number(ty) - cell.y;
  let len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1) {
    dx = player.targetX - cell.x;
    dy = player.targetY - cell.y;
    len = Math.hypot(dx, dy);
  }
  if (!Number.isFinite(len) || len < 1) {
    const a = Math.random() * Math.PI * 2;
    dx = Math.cos(a);
    dy = Math.sin(a);
    len = 1;
  }
  return { nx: dx / len, ny: dy / len };
}

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

  while (ejectedMass.length > CONFIG.EJECT_MAX_COUNT) ejectedMass.shift();
  updatePlayerDerived(player);
  tcpSend(player, { type: 'eject', pellets: count, mass: Math.floor(player.score) });
  return true;
}

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
  if (!player.udp || player.udp.address !== rinfo.address || player.udp.port !== rinfo.port) {
    player.udp = { address: rinfo.address, port: rinfo.port };
  }

  const tx = Number(msg.tx);
  const ty = Number(msg.ty);
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

function largestCell(player) {
  return player.cells.reduce((best, cell) => (!best || cell.mass > best.mass ? cell : best), null);
}

function areAllied(a, b, now = Date.now()) {
  if (!a || !b) return false;
  return a.allyId === b.id
    && b.allyId === a.id
    && a.allyUntil > now
    && b.allyUntil > now
    && now < a.betrayAfter
    && now < b.betrayAfter;
}

function clearAlliance(a, b) {
  if (a) {
    a.allyId = null;
    a.allyUntil = 0;
    a.betrayAfter = 0;
    a.supportUntil = 0;
    a.supportTargetId = null;
  }
  if (b && b.allyId === a?.id) {
    b.allyId = null;
    b.allyUntil = 0;
    b.betrayAfter = 0;
    b.supportUntil = 0;
    b.supportTargetId = null;
  }
}

function formAlliance(a, b, now = Date.now()) {
  if (!a || !b || a.id === b.id || !a.isBot || !b.isBot) return false;
  const until = now + CONFIG.BOT_ALLY_DURATION_MS + rand(-3500, 3500);
  const betrayAt = now + rand(CONFIG.BOT_ALLY_BETRAY_MIN_MS, CONFIG.BOT_ALLY_BETRAY_MAX_MS);
  a.allyId = b.id;
  b.allyId = a.id;
  a.allyUntil = b.allyUntil = until;
  // Non tradiscono necessariamente nello stesso istante.
  a.betrayAfter = betrayAt + rand(-900, 900);
  b.betrayAfter = betrayAt + rand(-900, 900);
  a.lastAllyActionAt = b.lastAllyActionAt = now;
  return true;
}

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

function findBestPreyFor(bot, now = Date.now()) {
  const biggest = largestCell(bot);
  if (!biggest) return null;
  let bestPrey = null;
  let bestPreyScore = 0;
  for (const enemy of allEnemyCells(bot, now)) {
    const d = Math.hypot(enemy.cell.x - biggest.x, enemy.cell.y - biggest.y);
    if (biggest.r > enemy.cell.r * CONFIG.PLAYER_EAT_RATIO && d < 980 + biggest.r * 2.4) {
      const score = enemy.cell.mass / (d + 90) * (enemy.player.isBot ? 0.9 : 1.15);
      if (score > bestPreyScore) {
        bestPreyScore = score;
        bestPrey = enemy;
      }
    }
  }
  return bestPrey;
}

function botCanDonate(bot, recipient = null) {
  if (!bot?.alive || !bot.cells?.length) return false;
  const big = largestCell(bot);
  if (!big || big.r < Math.max(28, CONFIG.EJECT_MIN_RADIUS)) return false;

  // Non deve autodistruggersi: dona solo se ha un margine reale.
  const safeFloor = radiusToMass(CONFIG.START_RADIUS) + CONFIG.EJECT_MASS * 5;
  if (bot.mass < safeFloor) return false;
  if (recipient && bot.mass < recipient.mass * 0.55) return false;
  if (bot.mass - CONFIG.EJECT_MASS < radiusToMass(24)) return false;
  return true;
}

function coordinateBotAlliances(now, bots) {
  // 1) Gestione tradimenti/scadenze.
  for (const bot of bots) {
    const ally = bot.allyId ? players.get(bot.allyId) : null;
    if (!ally || !ally.alive || !ally.cells.length || bot.allyUntil <= now || ally.allyUntil <= now) {
      if (bot.allyId) clearAlliance(bot, ally);
      continue;
    }

    if (now >= bot.betrayAfter && Math.random() < 0.055) {
      const botBig = largestCell(bot);
      const allyBig = largestCell(ally);
      clearAlliance(bot, ally);
      if (botBig && allyBig && botBig.r > allyBig.r * 1.08) {
        bot.targetX = ally.x;
        bot.targetY = ally.y;
      }
      broadcastTcp({ type: 'system', message: `${bot.name} ha tradito ${ally.name}!` });
    }
  }

  // 2) Supporto: scansione limitata, altrimenti la collaborazione succede troppo spesso.
  if (now - lastAllianceScanAt < 700) return;
  lastAllianceScanAt = now;

  // Se un bot sta per avere una kill, un alleato vicino può donargli pellet.
  for (const attacker of bots) {
    if (!attacker.alive || !attacker.cells.length) continue;
    const prey = findBestPreyFor(attacker, now);
    const attackerBig = largestCell(attacker);
    if (!prey || !attackerBig) continue;

    const distToPrey = Math.hypot(prey.cell.x - attackerBig.x, prey.cell.y - attackerBig.y);
    const splitRadius = massToRadius(attackerBig.mass / 2);
    // Supporto raro e sensato: solo se la preda è davvero raggiungibile e
    // l'attaccante non è già così forte da non avere bisogno di aiuto.
    const needsHelp = attackerBig.r < prey.cell.r * 1.75;
    const canBecomeKill = attackerBig.r > prey.cell.r * 1.10 || splitRadius > prey.cell.r * 1.02;
    const almostKill = distToPrey < 620 && needsHelp && canBecomeKill;
    if (!almostKill || Math.random() > 0.12) continue;

    let helper = null;
    let helperDist = Infinity;
    for (const candidate of bots) {
      if (candidate.id === attacker.id || !candidate.alive || !candidate.cells.length) continue;
      if (!botCanDonate(candidate, attacker)) continue;
      if (now - candidate.lastAllyActionAt < 1400) continue;
      const d = Math.hypot(candidate.x - attacker.x, candidate.y - attacker.y);
      if (d < Math.min(CONFIG.BOT_SUPPORT_RADIUS, 560) && d < helperDist) {
        // Se è già alleato di un altro, non cambia immediatamente idea.
        if (candidate.allyId && candidate.allyId !== attacker.id && candidate.allyUntil > now) continue;
        helper = candidate;
        helperDist = d;
      }
    }

    if (!helper) continue;
    formAlliance(helper, attacker, now);
    helper.supportUntil = now + 1600;
    helper.supportTargetId = attacker.id;
    attacker.supportUntil = now + 1600;
    attacker.supportTargetId = prey.player.id;

    helper.targetX = attacker.x;
    helper.targetY = attacker.y;
    // Spara 1 pellet per decisione verso l'alleato: abbastanza per creare cooperazione,
    // non così tanto da svuotare subito il helper.
    if (now - helper.lastAllyActionAt > 1400) {
      ejectMass(helper, attacker.x, attacker.y);
      helper.lastAllyActionAt = now;
      attacker.lastAllyActionAt = now;
    }
  }
}

function updateBots(now) {
  const bots = [...players.values()].filter(p => p.isBot && p.alive && p.cells.length);
  coordinateBotAlliances(now, bots);
  const enemiesCache = new Map();

  for (const bot of bots) {
    // Decisioni abbastanza frequenti ma non a ogni tick: evita jitter e riduce CPU.
    if (now - bot.lastBotDecision < rand(160, 340)) continue;
    bot.lastBotDecision = now;
    updatePlayerDerived(bot);

    const biggest = largestCell(bot);
    if (!biggest) continue;

    if (bot.supportUntil > now && bot.supportTargetId) {
      const target = players.get(bot.supportTargetId);
      if (target?.alive && target.cells.length) {
        bot.targetX = target.x;
        bot.targetY = target.y;
        if (botCanDonate(bot, target) && bot.allyId === target.id && now - bot.lastAllyActionAt > 1400 && Math.random() < 0.08) {
          ejectMass(bot, target.x, target.y);
          bot.lastAllyActionAt = now;
        }
        continue;
      }
    }

    const enemies = enemiesCache.get(bot.id) || allEnemyCells(bot, now);
    enemiesCache.set(bot.id, enemies);

    let fleeX = 0;
    let fleeY = 0;
    let danger = 0;
    let nearestThreat = null;
    let nearestThreatDist = Infinity;
    let bestPrey = null;
    let bestPreyScore = 0;

    for (const enemy of enemies) {
      const dx = enemy.cell.x - bot.x;
      const dy = enemy.cell.y - bot.y;
      const d = Math.hypot(dx, dy) || 1;

      // Minaccia se una cella nemica può assorbire almeno una nostra cella grande.
      const threatToBiggest = enemy.cell.r > biggest.r * CONFIG.PLAYER_EAT_RATIO;
      if (threatToBiggest) {
        const radius = 520 + enemy.cell.r * 3.2;
        if (d < radius) {
          const strength = ((radius - d) / radius) * Math.pow(enemy.cell.r / Math.max(1, biggest.r), 1.4);
          fleeX -= (dx / d) * strength;
          fleeY -= (dy / d) * strength;
          danger += strength;
          if (d < nearestThreatDist) {
            nearestThreat = enemy;
            nearestThreatDist = d;
          }
        }
      }

      // Preda: una cella nemica che la nostra più grande può mangiare.
      if (biggest.r > enemy.cell.r * CONFIG.PLAYER_EAT_RATIO) {
        const chaseRadius = 980 + biggest.r * 2.4;
        if (d < chaseRadius) {
          const score = enemy.cell.mass / (d + 90) * (enemy.player.isBot ? 0.9 : 1.15);
          if (score > bestPreyScore) {
            bestPreyScore = score;
            bestPrey = enemy;
          }
        }
      }
    }

    // Evita i bordi: altrimenti i bot grandi si incastrano facilmente.
    const edgeMargin = 260 + bot.r;
    if (bot.x < edgeMargin) fleeX += (edgeMargin - bot.x) / edgeMargin;
    if (bot.x > CONFIG.WORLD_WIDTH - edgeMargin) fleeX -= (bot.x - (CONFIG.WORLD_WIDTH - edgeMargin)) / edgeMargin;
    if (bot.y < edgeMargin) fleeY += (edgeMargin - bot.y) / edgeMargin;
    if (bot.y > CONFIG.WORLD_HEIGHT - edgeMargin) fleeY -= (bot.y - (CONFIG.WORLD_HEIGHT - edgeMargin)) / edgeMargin;

    if (danger > 0.12) {
      const len = Math.hypot(fleeX, fleeY) || 1;
      bot.targetX = clamp(bot.x + (fleeX / len) * (850 + bot.r * 2), 0, CONFIG.WORLD_WIDTH);
      bot.targetY = clamp(bot.y + (fleeY / len) * (850 + bot.r * 2), 0, CONFIG.WORLD_HEIGHT);
      continue;
    }

    if (bestPrey) {
      bot.targetX = bestPrey.cell.x;
      bot.targetY = bestPrey.cell.y;

      // Split offensivo solo quando è plausibile che metà cella possa mangiare la preda.
      const splitRadius = massToRadius(biggest.mass / 2);
      const dist = Math.hypot(bestPrey.cell.x - biggest.x, bestPrey.cell.y - biggest.y);
      const canSplitKill = splitRadius > bestPrey.cell.r * CONFIG.PLAYER_EAT_RATIO && dist < 520 + biggest.r * 2.2;
      if (canSplitKill && bot.cells.length <= Math.floor(CONFIG.MAX_CELLS_PER_PLAYER / 2) && Math.random() < 0.28) {
        splitPlayer(bot, bestPrey.cell.x, bestPrey.cell.y);
      }
      continue;
    }

    // Farming: preferisce pellet espulsi (più massa) e food vicini, non il più lontano globale.
    let bestResource = null;
    let bestResourceScore = 0;
    const search = 980 + bot.r * 3;

    for (const pellet of ejectedMass) {
      const d = Math.hypot(pellet.x - bot.x, pellet.y - bot.y);
      if (d > search) continue;
      const score = pellet.mass * 3.2 / (d + 80);
      if (score > bestResourceScore) {
        bestResourceScore = score;
        bestResource = pellet;
      }
    }

    // Campionamento limitato del food: evita di cambiare idea su pallini minuscoli lontani.
    for (const f of food) {
      const d = Math.hypot(f.x - bot.x, f.y - bot.y);
      if (d > search) continue;
      const score = f.mass / (d + 100);
      if (score > bestResourceScore) {
        bestResourceScore = score;
        bestResource = f;
      }
    }

    if (bestResource) {
      bot.targetX = bestResource.x;
      bot.targetY = bestResource.y;
      continue;
    }

    // Wander coerente: cambia punto solo quando lo raggiunge o ogni tanto, non ogni decisione.
    const wanderDist = Math.hypot(bot.botWanderX - bot.x, bot.botWanderY - bot.y);
    if (wanderDist < 160 || Math.random() < 0.035) {
      bot.botWanderX = clamp(bot.x + rand(-900, 900), 80, CONFIG.WORLD_WIDTH - 80);
      bot.botWanderY = clamp(bot.y + rand(-900, 900), 80, CONFIG.WORLD_HEIGHT - 80);
    }
    bot.targetX = bot.botWanderX;
    bot.targetY = bot.botWanderY;
  }
}

function moveCells(dt) {
  for (const p of players.values()) {
    if (!p.alive || !p.cells.length) continue;

    for (const c of p.cells) {
      c.r = massToRadius(c.mass);
      const dx = p.targetX - c.x;
      const dy = p.targetY - c.y;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        const speed = clamp(CONFIG.BASE_SPEED / Math.pow(c.r / CONFIG.START_RADIUS, 0.48), CONFIG.MIN_SPEED, CONFIG.BASE_SPEED);
        const splitPenalty = Math.min(0.92, 1 / Math.pow(p.cells.length, 0.09));
        const step = Math.min(len, speed * splitPenalty * dt);
        c.x += (dx / len) * step;
        c.y += (dy / len) * step;
      }

      // Velocità extra generata dallo split, con attrito esponenziale.
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      const friction = Math.exp(-3.8 * dt);
      c.vx *= friction;
      c.vy *= friction;
      if (Math.hypot(c.vx, c.vy) < 8) {
        c.vx = 0;
        c.vy = 0;
      }

      c.x = clamp(c.x, c.r, CONFIG.WORLD_WIDTH - c.r);
      c.y = clamp(c.y, c.r, CONFIG.WORLD_HEIGHT - c.r);

      // Leggero decadimento per evitare crescita infinita e mantenere ritmo arcade.
      if (p.mass > radiusToMass(CONFIG.START_RADIUS)) {
        c.mass *= (1 - CONFIG.MASS_DECAY_PER_TICK);
      }
      c.r = massToRadius(c.mass);
    }

    updatePlayerDerived(p);
  }
}

function moveEjectedPellets(dt) {
  for (let i = ejectedMass.length - 1; i >= 0; i--) {
    const pellet = ejectedMass[i];
    pellet.x += pellet.vx * dt;
    pellet.y += pellet.vy * dt;

    const friction = Math.exp(-2.6 * dt);
    pellet.vx *= friction;
    pellet.vy *= friction;
    if (Math.hypot(pellet.vx, pellet.vy) < 10) {
      pellet.vx = 0;
      pellet.vy = 0;
    }

    if (pellet.x < pellet.r) {
      pellet.x = pellet.r;
      pellet.vx = Math.abs(pellet.vx) * 0.25;
    } else if (pellet.x > CONFIG.WORLD_WIDTH - pellet.r) {
      pellet.x = CONFIG.WORLD_WIDTH - pellet.r;
      pellet.vx = -Math.abs(pellet.vx) * 0.25;
    }
    if (pellet.y < pellet.r) {
      pellet.y = pellet.r;
      pellet.vy = Math.abs(pellet.vy) * 0.25;
    } else if (pellet.y > CONFIG.WORLD_HEIGHT - pellet.r) {
      pellet.y = CONFIG.WORLD_HEIGHT - pellet.r;
      pellet.vy = -Math.abs(pellet.vy) * 0.25;
    }
  }
}

function handleSameOwnerCells(now) {
  for (const p of players.values()) {
    if (!p.alive || p.cells.length < 2) continue;

    // Importante: quando due celle si fondono facciamo ripartire la scansione.
    // La versione precedente faceva splice() dentro a un doppio for indicizzato e
    // poi continuava con indici ormai non validi; da qui il crash "a.x undefined".
    let merged;
    do {
      merged = false;

      outer:
      for (let i = 0; i < p.cells.length; i++) {
        for (let j = i + 1; j < p.cells.length; j++) {
          const a = p.cells[i];
          const b = p.cells[j];
          if (!a || !b) continue;

          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.hypot(dx, dy) || 0.0001;
          const nx = dx / d;
          const ny = dy / d;
          const mergeReady = now >= a.mergeAt && now >= b.mergeAt;

          if (mergeReady && d < (a.r + b.r) * 0.65) {
            const bigIndex = a.mass >= b.mass ? i : j;
            const smallIndex = a.mass >= b.mass ? j : i;
            const big = p.cells[bigIndex];
            const small = p.cells[smallIndex];
            if (!big || !small) continue;

            const totalMass = big.mass + small.mass;
            big.x = (big.x * big.mass + small.x * small.mass) / totalMass;
            big.y = (big.y * big.mass + small.y * small.mass) / totalMass;
            big.vx = (big.vx * big.mass + small.vx * small.mass) / totalMass;
            big.vy = (big.vy * big.mass + small.vy * small.mass) / totalMass;
            big.mass = totalMass;
            big.r = massToRadius(big.mass);
            big.mergeAt = Math.max(big.mergeAt, small.mergeAt);

            p.cells.splice(smallIndex, 1);
            merged = true;
            break outer;
          }

          // Fino alla ricombinazione le celle dello stesso player tendono a non impilarsi.
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

function handleFoodCollisions() {
  for (const p of players.values()) {
    if (!p.alive || !p.cells.length) continue;
    for (const c of p.cells) {
      for (let i = food.length - 1; i >= 0; i--) {
        const f = food[i];
        const d = Math.hypot(c.x - f.x, c.y - f.y);
        if (d < c.r + f.r * 0.55) {
          c.mass += f.mass * 0.9;
          food.splice(i, 1);
        }
      }
    }
    updatePlayerDerived(p);
  }
  replenishFood();
}

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
        if (d < c.r + pellet.r * 0.62) {
          c.mass += pellet.mass * CONFIG.EJECT_EAT_GAIN;
          ejectedMass.splice(i, 1);
          ateAny = true;
        }
      }
    }

    if (ateAny) updatePlayerDerived(p);
  }
}

function removeCell(player, cell) {
  const idx = player.cells.findIndex(c => c.id === cell.id);
  if (idx >= 0) {
    player.cells.splice(idx, 1);
    player.lastCellLostAt = Date.now();
  }
  updatePlayerDerived(player);
  if (!player.cells.length) {
    player.alive = false;
  }
}

function handlePlayerCollisions() {
  const now = Date.now();
  const allCells = [];
  for (const p of players.values()) {
    if (!p.alive || !p.cells.length) continue;
    for (const c of p.cells) allCells.push({ player: p, cell: c });
  }

  for (let i = 0; i < allCells.length; i++) {
    for (let j = i + 1; j < allCells.length; j++) {
      const A = allCells[i];
      const B = allCells[j];
      if (A.player.id === B.player.id) continue;
      if (areAllied(A.player, B.player, now)) continue;
      if (!A.player.alive || !B.player.alive) continue;
      if (!A.player.cells.includes(A.cell) || !B.player.cells.includes(B.cell)) continue;

      let hunter = null;
      let prey = null;
      if (A.cell.r > B.cell.r * CONFIG.PLAYER_EAT_RATIO) {
        hunter = A;
        prey = B;
      } else if (B.cell.r > A.cell.r * CONFIG.PLAYER_EAT_RATIO) {
        hunter = B;
        prey = A;
      }
      if (!hunter) continue;

      // Se un player splittato ha appena perso una cella, non facciamo sparire
      // tutte le altre nello stesso frame: la morte scatta solo quando le celle
      // sono davvero finite, non quando viene mangiata una singola parte.
      if (prey.player.cells.length > 1 && now - prey.player.lastCellLostAt < CONFIG.CELL_LOSS_GRACE_MS) continue;

      const d = Math.hypot(hunter.cell.x - prey.cell.x, hunter.cell.y - prey.cell.y);
      if (d < hunter.cell.r - prey.cell.r * 0.22) {
        const preyScoreBefore = prey.player.score;
        hunter.cell.mass += prey.cell.mass * CONFIG.PLAYER_EAT_GAIN;
        hunter.player.kills += 1;
        removeCell(prey.player, prey.cell);
        updatePlayerDerived(hunter.player);

        if (prey.player.alive) {
          tcpSend(prey.player, {
            type: 'cellLost',
            remainingCells: prey.player.cells.length,
            message: `${hunter.player.name} ha mangiato una tua cella, ma sei ancora vivo.`
          });
        }

        if (!prey.player.alive) {
          tcpSend(prey.player, {
            type: 'dead',
            killer: { id: hunter.player.id, name: hunter.player.name, color: hunter.player.color },
            score: Math.floor(preyScoreBefore),
            message: `${hunter.player.name} ti ha assorbito.`
          });

          if (prey.player.isBot) {
            players.delete(prey.player.id);
          } else {
            broadcastTcp({ type: 'system', message: `${hunter.player.name} ha assorbito ${prey.player.name}.` });
          }
        }
      }
    }
  }
}

function createSnapshotFor(player) {
  updatePlayerDerived(player);

  // Snapshot con margine extra: il client vede la normale visuale follow-player,
  // ma il server invia elementi ben oltre i bordi dello schermo per evitare pop-in
  // visibile quando ci si muove. Non è più una vista full-map.
  const viewRadius = clamp(2450 + player.r * 4, 2450, 3300);
  const viewR2 = viewRadius * viewRadius;

  const visiblePlayers = [];
  for (const p of players.values()) {
    if (!p.alive || !p.cells.length) continue;
    for (const c of p.cells) {
      const dx = c.x - player.x;
      const dy = c.y - player.y;
      if (dx * dx + dy * dy <= viewR2 || p.id === player.id) {
        visiblePlayers.push(publicCell(p, c));
      }
    }
  }

  const visibleFood = [];
  for (const f of food) {
    const dx = f.x - player.x;
    const dy = f.y - player.y;
    if (dx * dx + dy * dy <= viewR2) {
      visibleFood.push({
        id: f.id,
        x: Math.round(f.x),
        y: Math.round(f.y),
        r: Math.round(f.r * 10) / 10,
        color: f.color
      });
    }
  }

  const visiblePellets = [];
  for (const pellet of ejectedMass) {
    const dx = pellet.x - player.x;
    const dy = pellet.y - player.y;
    if (dx * dx + dy * dy <= viewR2) {
      visiblePellets.push({
        id: pellet.id,
        ownerId: pellet.ownerId,
        x: Math.round(pellet.x),
        y: Math.round(pellet.y),
        r: Math.round(pellet.r * 10) / 10,
        color: pellet.color
      });
    }
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

let lastSnapshotAt = 0;
let lastLeaderboardAt = 0;
let lastTickAt = Date.now();

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

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  broadcastTcp({ type: 'system', message: 'Server in chiusura.' });
  tcpServer.close();
  udpServer.close();
  process.exit(0);
});
