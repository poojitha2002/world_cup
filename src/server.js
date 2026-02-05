import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { PORT, SESSION_COOKIE, SESSION_TTL_MS, BET_COST, GOOGLE_CLIENT_ID } from './config.js';
import { readDb, updateDb, makeId } from './db.js';
import { isBetLocked, getWalletBalance, settleMatch } from './betting.js';
import { fetchWorldCupMatches } from './matchProvider.js';

const publicDir = path.resolve('public');

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';').map((v) => v.trim()).filter(Boolean);
  const cookies = {};
  for (const part of parts) {
    const [k, ...rest] = part.split('=');
    cookies[k] = decodeURIComponent(rest.join('='));
  }
  return cookies;
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function getCurrentUser(req, db) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const session = db.sessions.find((s) => s.id === sid && s.expiresAt > Date.now());
  if (!session) return null;
  return db.users.find((u) => u.id === session.userId) || null;
}

async function verifyGoogleIdToken(token) {
  const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
  if (!resp.ok) return null;
  const payload = await resp.json();
  if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) return null;
  return payload;
}

async function syncMatches() {
  const incoming = await fetchWorldCupMatches();
  updateDb((db) => {
    for (const item of incoming) {
      const existing = db.matches.find((m) => m.id === item.id);
      if (existing) {
        Object.assign(existing, item, { updatedAt: new Date().toISOString() });
      } else {
        db.matches.push({ ...item, settledAt: null, updatedAt: new Date().toISOString() });
      }
    }
    for (const match of db.matches) {
      settleMatch(db, match.id);
    }
  });
}

setInterval(() => {
  syncMatches().catch(() => {});
}, 60_000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = readDb();
  const user = getCurrentUser(req, db);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/public/')) {
    const filePath = path.join(publicDir, url.pathname.replace('/public/', ''));
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const type = ext === '.css' ? 'text/css' : 'application/javascript';
      res.writeHead(200, { 'Content-Type': type });
      res.end(fs.readFileSync(filePath));
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/google') {
    const body = await readJson(req);
    if (!body.credential) return json(res, 400, { error: 'Missing credential' });
    const payload = await verifyGoogleIdToken(body.credential);
    if (!payload) return json(res, 401, { error: 'Invalid Google token' });

    const userRecord = updateDb((state) => {
      let u = state.users.find((x) => x.googleSub === payload.sub);
      if (!u) {
        u = {
          id: makeId('usr'),
          googleSub: payload.sub,
          name: payload.name,
          email: payload.email,
          createdAt: new Date().toISOString()
        };
        state.users.push(u);
        state.transactions.push({
          id: makeId('tx'),
          userId: u.id,
          amount: 100,
          type: 'welcome_bonus',
          createdAt: new Date().toISOString()
        });
      }
      state.sessions = state.sessions.filter((s) => s.expiresAt > Date.now());
      const sid = crypto.randomBytes(16).toString('hex');
      state.sessions.push({ id: sid, userId: u.id, expiresAt: Date.now() + SESSION_TTL_MS });
      u._sid = sid;
    }).users.find((x) => x.googleSub === payload.sub);

    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${userRecord._sid}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) {
      updateDb((state) => {
        state.sessions = state.sessions.filter((s) => s.id !== sid);
      });
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    return json(res, 200, { ok: true });
  }


  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'world-cup-betting' });
  }

  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    const matches = db.matches.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    const bets = user ? db.bets.filter((b) => b.userId === user.id) : [];
    return json(res, 200, {
      auth: Boolean(user),
      googleClientId: GOOGLE_CLIENT_ID,
      user: user
        ? { id: user.id, name: user.name, email: user.email, balance: getWalletBalance(db, user.id) }
        : null,
      rules: { betCost: BET_COST, lockAt: 'MATCH_STATUS_LIVE', timezone: 'IST' },
      matches,
      bets
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/bets') {
    if (!user) return json(res, 401, { error: 'Login required' });
    const body = await readJson(req);
    const { matchId, teamCode } = body;
    if (!matchId || !teamCode) return json(res, 400, { error: 'matchId and teamCode required' });

    let result;
    updateDb((state) => {
      const match = state.matches.find((m) => m.id === matchId);
      if (!match) {
        result = { status: 404, payload: { error: 'Match not found' } };
        return;
      }
      if (isBetLocked(match)) {
        result = { status: 409, payload: { error: 'Bet is locked because match is LIVE/COMPLETED' } };
        return;
      }
      if (![match.teamA, match.teamB].includes(teamCode)) {
        result = { status: 400, payload: { error: 'Invalid team selection' } };
        return;
      }
      const existing = state.bets.find((b) => b.userId === user.id && b.matchId === matchId);
      if (existing) {
        existing.teamCode = teamCode;
        existing.updatedAt = new Date().toISOString();
        result = { status: 200, payload: { ok: true, mode: 'updated' } };
        return;
      }
      state.bets.push({
        id: makeId('bet'),
        userId: user.id,
        matchId,
        teamCode,
        status: 'OPEN',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      state.transactions.push({
        id: makeId('tx'),
        userId: user.id,
        matchId,
        amount: -BET_COST,
        type: 'bet_entry',
        createdAt: new Date().toISOString()
      });
      result = { status: 200, payload: { ok: true, mode: 'created' } };
    });
    return json(res, result.status, result.payload);
  }

  if (req.method === 'POST' && url.pathname === '/api/sync') {
    await syncMatches();
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'Not found' });
});

syncMatches().catch(() => {});
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
