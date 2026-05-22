/**
 * api.js — Server HTTP/REST per Agar.io clone
 * Gestisce: registrazione, login, profilo, leaderboard, aggiornamento stats
 * Stack: Express + mysql2 + argon2 + jsonwebtoken
 */

import express from 'express';
import mysql from 'mysql2/promise';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

// ─── Configurazione ──────────────────────────────────────────────────────────

const API_PORT = Number(process.env.API_PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'cambia-questa-chiave-in-produzione';
const JWT_EXPIRES = '7d'; // token valido 7 giorni

// Pool MySQL — cambia host/user/password se necessario
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: 'agar_db',
  waitForConnections: true,
  connectionLimit: 10,
});

// ─── App Express ─────────────────────────────────────────────────────────────

const app = express();

app.use(express.json());

// ─── Sicurezza: header anti-XSS di base ──────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ─── Middleware auth JWT ──────────────────────────────────────────────────────
// Legge il token da Authorization: Bearer <token>
// Se valido, aggiunge req.userId e req.username
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token mancante' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.username = payload.username;
    next();
  } catch {
    res.status(401).json({ error: 'Token non valido o scaduto' });
  }
}

// ─── Helper: sanitizza input utente contro XSS/injection ─────────────────────
function sanitizeStr(str, maxLen = 255) {
  if (typeof str !== 'string') return '';
  // Rimuove tag HTML e caratteri pericolosi
  return str
    .replace(/[<>"'`]/g, '')
    .trim()
    .slice(0, maxLen);
}

// ─── ROUTE: Registrazione ─────────────────────────────────────────────────────
// POST /api/register   body: { email, password, username }
app.post('/api/register', async (req, res) => {
  const email = sanitizeStr(req.body.email || '').toLowerCase();
  const password = req.body.password || '';
  const username = sanitizeStr(req.body.username || '', 32);

  // Validazione base
  if (!email || !password || !username) {
    return res.status(400).json({ error: 'Email, password e username sono obbligatori' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email non valida' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password troppo corta (minimo 6 caratteri)' });
  }
  if (username.length < 2) {
    return res.status(400).json({ error: 'Username troppo corto (minimo 2 caratteri)' });
  }

  try {
    // Hash della password con Argon2id (il più sicuro)
    const hash = await argon2.hash(password, { type: argon2.argon2id });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Inserisce credenziali
      const [credResult] = await conn.execute(
        'INSERT INTO Credenziali (Email, Password) VALUES (?, ?)',
        [email, hash]
      );
      const idCredenziali = credResult.insertId;

      // Inserisce utente
      const [utenteResult] = await conn.execute(
        'INSERT INTO Utente (Username, IdCredenziali) VALUES (?, ?)',
        [username, idCredenziali]
      );
      const userId = utenteResult.insertId;

      await conn.commit();
      conn.release();

      // Crea subito un JWT così l'utente è già loggato dopo la registrazione
      const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
      res.status(201).json({ token, username });

    } catch (err) {
      await conn.rollback();
      conn.release();
      // Errore di duplicato (email o username già esistente)
      if (err.code === 'ER_DUP_ENTRY') {
        const msg = err.message.includes('idx_email')
          ? 'Email già registrata'
          : 'Username già in uso';
        return res.status(409).json({ error: msg });
      }
      throw err;
    }
  } catch (err) {
    console.error('[API] register error:', err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// ─── ROUTE: Login ─────────────────────────────────────────────────────────────
// POST /api/login   body: { email, password }
app.post('/api/login', async (req, res) => {
  const email = sanitizeStr(req.body.email || '').toLowerCase();
  const password = req.body.password || '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email e password sono obbligatori' });
  }

  try {
    // Query che unisce Credenziali e Utente in una sola select
    const [rows] = await pool.execute(
      `SELECT c.IdCredenziali, c.Password, u.IdUtente, u.Username
       FROM Credenziali c
       JOIN Utente u ON u.IdCredenziali = c.IdCredenziali
       WHERE c.Email = ?`,
      [email]
    );

    if (rows.length === 0) {
      // Risposta generica per non rivelare se l'email esiste
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const row = rows[0];
    const valid = await argon2.verify(row.Password, password);
    if (!valid) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const token = jwt.sign(
      { userId: row.IdUtente, username: row.Username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({ token, username: row.Username });

  } catch (err) {
    console.error('[API] login error:', err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// ─── ROUTE: Profilo e statistiche del giocatore loggato ──────────────────────
// GET /api/profile   (richiede JWT)
app.get('/api/profile', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.IdUtente, u.Username, u.HighestScore, u.KillCount, u.DeathCount, c.Email
       FROM Utente u
       JOIN Credenziali c ON c.IdCredenziali = u.IdCredenziali
       WHERE u.IdUtente = ?`,
      [req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Utente non trovato' });

    const u = rows[0];
    res.json({
      id: u.IdUtente,
      username: u.Username,
      email: u.Email,
      highestScore: u.HighestScore,
      killCount: u.KillCount,
      deathCount: u.DeathCount,
      // K/D ratio calcolato lato server
      kd: u.DeathCount > 0 ? (u.KillCount / u.DeathCount).toFixed(2) : u.KillCount.toFixed(2),
    });
  } catch (err) {
    console.error('[API] profile error:', err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// ─── ROUTE: Modifica username ─────────────────────────────────────────────────
// PATCH /api/profile/username   body: { username }   (richiede JWT)
app.patch('/api/profile/username', auth, async (req, res) => {
  const newUsername = sanitizeStr(req.body.username || '', 32);

  if (newUsername.length < 2) {
    return res.status(400).json({ error: 'Username troppo corto (minimo 2 caratteri)' });
  }

  try {
    await pool.execute(
      'UPDATE Utente SET Username = ? WHERE IdUtente = ?',
      [newUsername, req.userId]
    );
    res.json({ username: newUsername });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Username già in uso' });
    }
    console.error('[API] username update error:', err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// ─── ROUTE: Leaderboard ───────────────────────────────────────────────────────
// GET /api/leaderboard?limit=10
// Pubblica, non richiede JWT
app.get('/api/leaderboard', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  try {
    const [rows] = await pool.execute(
      `SELECT Username, HighestScore, KillCount, DeathCount
       FROM Utente
       ORDER BY HighestScore DESC
       LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('[API] leaderboard error:', err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// ─── ROUTE: Aggiornamento stats dopo partita ───────────────────────────────────
// POST /api/stats   body: { score, kills, died }   (richiede JWT)
// Viene chiamato dal client a fine partita
app.post('/api/stats', auth, async (req, res) => {
  const score = Math.max(0, Number(req.body.score) || 0);
  const kills = Math.max(0, Number(req.body.kills) || 0);
  const died = req.body.died ? 1 : 0;

  try {
    await pool.execute(
      `UPDATE Utente SET
         HighestScore = GREATEST(HighestScore, ?),
         KillCount    = KillCount + ?,
         DeathCount   = DeathCount + ?
       WHERE IdUtente = ?`,
      [score, kills, died, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[API] stats update error:', err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// ─── Avvio server ─────────────────────────────────────────────────────────────
// Ascolta solo su 127.0.0.1: raggiungibile dal bridge in client.js, non dalla rete
app.listen(API_PORT, '127.0.0.1', () => {
  console.log(`[API] in ascolto su http://127.0.0.1:${API_PORT}`);
  console.log(`[API] raggiungibile dal browser tramite http://localhost:8080/api/...`);
});
