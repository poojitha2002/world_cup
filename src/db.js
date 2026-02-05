import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { DB_PATH, BET_COST, SESSION_TTL_MS } from './config.js';
import { calculateWinnerShare } from './betting.js';

function ensureDir() {
  const dir = DB_PATH.split('/').slice(0, -1).join('/');
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function execSql(sql, json = false) {
  ensureDir();
  const args = [DB_PATH];
  if (json) args.push('-json');
  args.push(sql);
  const out = execFileSync('sqlite3', args, { encoding: 'utf8' });
  return json ? JSON.parse(out || '[]') : out;
}

export function initDb() {
  execSql(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_sub TEXT UNIQUE,
    name TEXT,
    email TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    expires_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    team_a TEXT,
    team_b TEXT,
    start_time TEXT,
    status TEXT,
    winner_team TEXT,
    settled_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    match_id TEXT,
    team_code TEXT,
    status TEXT,
    created_at TEXT,
    updated_at TEXT,
    UNIQUE(user_id, match_id)
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    match_id TEXT,
    amount INTEGER,
    type TEXT,
    created_at TEXT
  );
  `);
}

export function getSessionUser(sessionId) {
  if (!sessionId) return null;
  const now = Date.now();
  const rows = execSql(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id=${esc(sessionId)} AND s.expires_at > ${now}
    LIMIT 1;
  `, true);
  return rows[0] || null;
}

export function createGoogleSession(payload) {
  const now = new Date().toISOString();
  const sid = crypto.randomBytes(16).toString('hex');
  const uidRow = execSql(`SELECT id FROM users WHERE google_sub=${esc(payload.sub)} LIMIT 1;`, true)[0];
  let userId = uidRow?.id;
  if (!userId) {
    userId = crypto.randomUUID();
    execSql(`INSERT INTO users(id, google_sub, name, email, created_at) VALUES(${esc(userId)},${esc(payload.sub)},${esc(payload.name)},${esc(payload.email)},${esc(now)});`);
    execSql(`INSERT INTO transactions(id,user_id,match_id,amount,type,created_at) VALUES(${esc(crypto.randomUUID())},${esc(userId)},NULL,100,'welcome_bonus',${esc(now)});`);
  }
  execSql(`DELETE FROM sessions WHERE expires_at <= ${Date.now()};`);
  execSql(`INSERT INTO sessions(id,user_id,expires_at) VALUES(${esc(sid)},${esc(userId)},${Date.now() + SESSION_TTL_MS});`);
  return sid;
}

export function deleteSession(sessionId) {
  if (!sessionId) return;
  execSql(`DELETE FROM sessions WHERE id=${esc(sessionId)};`);
}

export function getWalletBalance(userId) {
  const row = execSql(`SELECT COALESCE(SUM(amount),0) AS balance FROM transactions WHERE user_id=${esc(userId)};`, true)[0];
  return Number(row?.balance || 0);
}

export function getMatchesAndBets(userId) {
  const matches = execSql(`SELECT id,team_a AS teamA,team_b AS teamB,start_time AS startTime,status,winner_team AS winnerTeam,settled_at AS settledAt,updated_at AS updatedAt FROM matches ORDER BY datetime(start_time);`, true);
  const bets = userId ? execSql(`SELECT id,user_id AS userId,match_id AS matchId,team_code AS teamCode,status,created_at AS createdAt,updated_at AS updatedAt FROM bets WHERE user_id=${esc(userId)};`, true) : [];
  return { matches, bets };
}

export function syncMatches(incoming) {
  const now = new Date().toISOString();
  for (const m of incoming) {
    execSql(`
      INSERT INTO matches(id,team_a,team_b,start_time,status,winner_team,settled_at,updated_at)
      VALUES(${esc(m.id)},${esc(m.teamA)},${esc(m.teamB)},${esc(m.startTime)},${esc(m.status)},${esc(m.winnerTeam)},NULL,${esc(now)})
      ON CONFLICT(id) DO UPDATE SET
        team_a=excluded.team_a,
        team_b=excluded.team_b,
        start_time=excluded.start_time,
        status=excluded.status,
        winner_team=excluded.winner_team,
        updated_at=excluded.updated_at;
    `);
  }
  const ids = execSql(`SELECT id FROM matches WHERE settled_at IS NULL AND status IN ('COMPLETED','NO_RESULT');`, true);
  for (const row of ids) settleMatch(row.id);
}

export function placeBet(userId, matchId, teamCode) {
  const match = execSql(`SELECT id,team_a,team_b,status FROM matches WHERE id=${esc(matchId)} LIMIT 1;`, true)[0];
  if (!match) return { status: 404, payload: { error: 'Match not found' } };
  if (['LIVE', 'COMPLETED', 'NO_RESULT'].includes(match.status)) {
    return { status: 409, payload: { error: 'Bet is locked because match is LIVE/COMPLETED' } };
  }
  if (![match.team_a, match.team_b].includes(teamCode)) {
    return { status: 400, payload: { error: 'Invalid team selection' } };
  }
  const now = new Date().toISOString();
  const existing = execSql(`SELECT id FROM bets WHERE user_id=${esc(userId)} AND match_id=${esc(matchId)} LIMIT 1;`, true)[0];
  if (existing) {
    execSql(`UPDATE bets SET team_code=${esc(teamCode)}, updated_at=${esc(now)} WHERE id=${esc(existing.id)};`);
    return { status: 200, payload: { ok: true, mode: 'updated' } };
  }
  execSql(`INSERT INTO bets(id,user_id,match_id,team_code,status,created_at,updated_at) VALUES(${esc(crypto.randomUUID())},${esc(userId)},${esc(matchId)},${esc(teamCode)},'OPEN',${esc(now)},${esc(now)});`);
  execSql(`INSERT INTO transactions(id,user_id,match_id,amount,type,created_at) VALUES(${esc(crypto.randomUUID())},${esc(userId)},${esc(matchId)},-${BET_COST},'bet_entry',${esc(now)});`);
  return { status: 200, payload: { ok: true, mode: 'created' } };
}

function settleMatch(matchId) {
  const match = execSql(`SELECT id,status,winner_team FROM matches WHERE id=${esc(matchId)} LIMIT 1;`, true)[0];
  if (!match) return;
  const bets = execSql(`SELECT id,user_id,team_code FROM bets WHERE match_id=${esc(matchId)};`, true);
  const now = new Date().toISOString();

  if (match.status === 'NO_RESULT') {
    for (const bet of bets) {
      execSql(`INSERT INTO transactions(id,user_id,match_id,amount,type,created_at) VALUES(${esc(`${bet.id}_refund`)},${esc(bet.user_id)},${esc(matchId)},${BET_COST},'refund',${esc(now)});`);
      execSql(`UPDATE bets SET status='REFUNDED' WHERE id=${esc(bet.id)};`);
    }
    execSql(`UPDATE matches SET settled_at=${esc(now)} WHERE id=${esc(matchId)};`);
    return;
  }

  if (match.status !== 'COMPLETED' || !match.winner_team) return;
  const winners = bets.filter((b) => b.team_code === match.winner_team);
  const share = calculateWinnerShare(bets.length, BET_COST, winners.length);

  for (const bet of bets) {
    if (bet.team_code === match.winner_team) {
      execSql(`INSERT INTO transactions(id,user_id,match_id,amount,type,created_at) VALUES(${esc(`${bet.id}_payout`)},${esc(bet.user_id)},${esc(matchId)},${share},'payout',${esc(now)});`);
      execSql(`UPDATE bets SET status='WON' WHERE id=${esc(bet.id)};`);
    } else {
      execSql(`UPDATE bets SET status='LOST' WHERE id=${esc(bet.id)};`);
    }
  }
  execSql(`UPDATE matches SET settled_at=${esc(now)} WHERE id=${esc(matchId)};`);
}
