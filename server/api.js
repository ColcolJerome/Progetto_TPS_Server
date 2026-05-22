/**
 * @file api.js
 * @description Server HTTP/REST per Agar.io clone.
 * Gestisce: registrazione, login, profilo, leaderboard, aggiornamento stats.
 * @requires express
 * @requires mysql2/promise
 * @requires argon2
 * @requires jsonwebtoken
 */

import express from 'express';
import mysql from 'mysql2/promise';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

// ─── Configurazione ──────────────────────────────────────────────────────────

/** @constant {number} API_PORT - Porta su cui ascolta il server Express. */
const API_PORT = Number(process.env.API_PORT || 3000);

/** @constant {string} JWT_SECRET - Chiave segreta per firmare i token JWT. */
const JWT_SECRET = process.env.JWT_SECRET || 'cambia-questa-chiave-in-produzione';

/** @constant {string} JWT_EXPIRES - Durata di validità del token JWT. */
const JWT_EXPIRES = '7d';

/**
 * @constant {mysql.Pool} pool
 * @description Pool di connessioni MySQL verso il database `agar_db`.
 */
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: 'agar_db',
  waitForConnections: true,
  connectionLimit: 10,
});

// ─── App Express ─────────────────────────────────────────────────────────────

/** @type {express.Application} */
const app = express();

app.use(express.json());

// ─── Middleware globali ───────────────────────────────────────────────────────

/**
 * Middleware di sicurezza: aggiunge header HTTP anti-XSS di base ad ogni risposta.
 *
 * @param {express.Request} req
 * @param {express.Response} res
 * @param {express.NextFunction} next
 * @returns {void}
 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ─── Middleware auth JWT ──────────────────────────────────────────────────────

/**
 * Middleware di autenticazione JWT.
 * Legge il token dall'header `Authorization: Bearer <token>`.
 * Se il token è valido, aggiunge {@link req.userId} e {@link req.username} alla request.
 *
 * @param {express.Request} req - Oggetto richiesta Express.
 * @param {express.Response} res - Oggetto risposta Express.
 * @param {express.NextFunction} next - Funzione per passare al middleware successivo.
 * @returns {void}
 */
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

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Sanitizza una stringa di input dell'utente rimuovendo tag HTML e caratteri
 * potenzialmente pericolosi per prevenire attacchi XSS e SQL injection.
 *
 * @param {string} str - Stringa da sanitizzare.
 * @param {number} [maxLen=255] - Lunghezza massima della stringa risultante.
 * @returns {string} La stringa sanitizzata e troncata.
 */
function sanitizeStr(str, maxLen = 255) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>"'`]/g, '')
    .trim()
    .slice(0, maxLen);
}

// ─── ROUTE: Registrazione ─────────────────────────────────────────────────────

/**
 * @route POST /api/register
 * @summary Registrazione di un nuovo utente.
 * @description Crea le credenziali (email + password hashata con Argon2id) e il
 * profilo utente in una singola transazione. Restituisce immediatamente un JWT
 * così l'utente risulta già autenticato.
 *
 * @param {express.Request} req
 * @param {Object} req.body
 * @param {string} req.body.email - Indirizzo email (deve essere univoco).
 * @param {string} req.body.password - Password in chiaro (minimo 6 caratteri).
 * @param {string} req.body.username - Username pubblico (2-32 caratteri, deve essere univoco).
 * @param {express.Response} res
 * @returns {Promise<void>} 201 `{ token, username }` oppure errore 400/409/500.
 */
app.post('/api/register', async (req, res) => {
  const email = sanitizeStr(req.body.email || '').toLowerCase();
  const password = req.body.password || '';
  const username = sanitizeStr(req.body.username || '', 32);

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
    const hash = await argon2.hash(password, { type: argon2.argon2id });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [credResult] = await conn.execute(
        'INSERT INTO Credenziali (Email, Password) VALUES (?, ?)',
        [email, hash]
      );
      const idCredenziali = credResult.insertId;

      const [utenteResult] = await conn.execute(
        'INSERT INTO Utente (Username, IdCredenziali) VALUES (?, ?)',
        [username, idCredenziali]
      );
      const userId = utenteResult.insertId;

      await conn.commit();
      conn.release();

      const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
      res.status(201).json({ token, username });

    } catch (err) {
      await conn.rollback();
      conn.release();
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

/**
 * @route POST /api/login
 * @summary Autenticazione di un utente esistente.
 * @description Verifica le credenziali tramite Argon2 e, se corrette, restituisce
 * un token JWT. La risposta di errore è volutamente generica per non rivelare
 * se un'email è già registrata (prevenzione user enumeration).
 *
 * @param {express.Request} req
 * @param {Object} req.body
 * @param {string} req.body.email - Indirizzo email dell'utente.
 * @param {string} req.body.password - Password in chiaro.
 * @param {express.Response} res
 * @returns {Promise<void>} 200 `{ token, username }` oppure errore 400/401/500.
 */
app.post('/api/login', async (req, res) => {
  const email = sanitizeStr(req.body.email || '').toLowerCase();
  const password = req.body.password || '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email e password sono obbligatori' });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT c.IdCredenziali, c.Password, u.IdUtente, u.Username
       FROM Credenziali c
       JOIN Utente u ON u.IdCredenziali = c.IdCredenziali
       WHERE c.Email = ?`,
      [email]
    );

    if (rows.length === 0) {
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

// ─── ROUTE: Profilo ───────────────────────────────────────────────────────────

/**
 * @route GET /api/profile
 * @summary Restituisce il profilo e le statistiche dell'utente autenticato.
 * @description Il K/D ratio viene calcolato lato server: se `DeathCount` è 0
 * si usa `KillCount` come valore grezzo per evitare divisioni per zero.
 * @security BearerAuth
 *
 * @param {express.Request} req - Arricchita da {@link auth} con `req.userId`.
 * @param {express.Response} res
 * @returns {Promise<void>} 200 con oggetto profilo oppure errore 404/500.
 *
 * @example
 * // Risposta di successo
 * {
 *   id: 42,
 *   username: "PlayerOne",
 *   email: "player@example.com",
 *   highestScore: 15000,
 *   killCount: 37,
 *   deathCount: 5,
 *   kd: "7.40"
 * }
 */
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
      kd: u.DeathCount > 0 ? (u.KillCount / u.DeathCount).toFixed(2) : u.KillCount.toFixed(2),
    });
  } catch (err) {
    console.error('[API] profile error:', err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// ─── ROUTE: Modifica username ─────────────────────────────────────────────────

/**
 * @route PATCH /api/profile/username
 * @summary Aggiorna l'username dell'utente autenticato.
 * @security BearerAuth
 *
 * @param {express.Request} req
 * @param {Object} req.body
 * @param {string} req.body.username - Nuovo username (2-32 caratteri, deve essere univoco).
 * @param {express.Response} res
 * @returns {Promise<void>} 200 `{ username }` oppure errore 400/409/500.
 */
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

/**
 * @route GET /api/leaderboard
 * @summary Restituisce la classifica globale ordinata per punteggio più alto.
 * @description Rotta pubblica, non richiede autenticazione.
 * Il numero massimo di risultati è limitato a 50 per evitare query troppo pesanti.
 *
 * @param {express.Request} req
 * @param {Object} req.query
 * @param {string} [req.query.limit="10"] - Numero di giocatori da restituire (max 50).
 * @param {express.Response} res
 * @returns {Promise<void>} 200 con array di `{ Username, HighestScore, KillCount, DeathCount }`.
 */
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

// ─── ROUTE: Aggiornamento stats ───────────────────────────────────────────────

/**
 * @route POST /api/stats
 * @summary Aggiorna le statistiche dell'utente al termine di una partita.
 * @description Chiamato dal client a fine partita. `HighestScore` viene aggiornato
 * solo se il nuovo punteggio supera il record attuale (usando `GREATEST`).
 * `KillCount` e `DeathCount` vengono invece sempre incrementati.
 * @security BearerAuth
 *
 * @param {express.Request} req
 * @param {Object} req.body
 * @param {number} req.body.score - Punteggio ottenuto nella partita (>= 0).
 * @param {number} req.body.kills - Numero di kill nella partita (>= 0).
 * @param {boolean} req.body.died - `true` se il giocatore è morto durante la partita.
 * @param {express.Response} res
 * @returns {Promise<void>} 200 `{ ok: true }` oppure errore 500.
 */
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

/**
 * Avvia il server Express in ascolto su `127.0.0.1` (loopback only).
 * Il server non è raggiungibile direttamente dalla rete esterna;
 * le richieste arrivano tramite il reverse proxy configurato in `client.js`.
 */
app.listen(API_PORT, '127.0.0.1', () => {
  console.log(`[API] in ascolto su http://127.0.0.1:${API_PORT}`);
  console.log(`[API] raggiungibile dal browser tramite http://localhost:8080/api/...`);
});