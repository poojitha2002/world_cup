import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { PORT, SESSION_COOKIE, SESSION_TTL_MS, BET_COST, GOOGLE_CLIENT_ID } from './config.js';
import {
  initDb,
  getSessionUser,
  createGoogleSession,
  deleteSession,
  getWalletBalance,
  getMatchesAndBets,
  syncMatches,
  placeBet
} from './db.js';
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

async function verifyGoogleIdToken(token) {
  const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
  if (!resp.ok) return null;
  const payload = await resp.json();
  if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) return null;
  return payload;
}

async function doSyncMatches() {
  const incoming = await fetchWorldCupMatches();
  syncMatches(incoming);
}

setInterval(() => {
  doSyncMatches().catch(() => {});
}, 60_000);

initDb();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sid = parseCookies(req)[SESSION_COOKIE];
  const user = getSessionUser(sid);

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

    const sessionId = createGoogleSession(payload);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    deleteSession(sid);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'world-cup-betting' });
  }

  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    const data = getMatchesAndBets(user?.id);
    return json(res, 200, {
      auth: Boolean(user),
      googleClientId: GOOGLE_CLIENT_ID,
      user: user ? { id: user.id, name: user.name, email: user.email, balance: getWalletBalance(user.id) } : null,
      rules: { betCost: BET_COST, lockAt: 'MATCH_STATUS_LIVE', timezone: 'IST' },
      matches: data.matches,
      bets: data.bets
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/bets') {
    if (!user) return json(res, 401, { error: 'Login required' });
    const body = await readJson(req);
    const { matchId, teamCode } = body;
    if (!matchId || !teamCode) return json(res, 400, { error: 'matchId and teamCode required' });
    const result = placeBet(user.id, matchId, teamCode);
    return json(res, result.status, result.payload);
  }

  if (req.method === 'POST' && url.pathname === '/api/sync') {
    await doSyncMatches();
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'Not found' });
});

doSyncMatches().catch(() => {});
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
