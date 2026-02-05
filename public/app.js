let state;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

function formatIST(iso) {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
}

function render() {
  const userBox = document.getElementById('userBox');
  const authSection = document.getElementById('authSection');
  if (state.auth) {
    userBox.innerHTML = `<div class="card"><b>${state.user.name}</b><br/><small>${state.user.email}</small><br/>Balance: <b>${state.user.balance}</b> coins<br/><button id="logoutBtn" class="secondary">Logout</button></div>`;
    authSection.classList.add('hidden');
    document.getElementById('logoutBtn').onclick = async () => {
      await api('/api/logout', { method: 'POST' });
      await load();
    };
  } else {
    userBox.innerHTML = '';
    authSection.classList.remove('hidden');
    if (state.googleClientId && window.google?.accounts?.id) {
      window.google.accounts.id.initialize({
        client_id: state.googleClientId,
        callback: async (response) => {
          try {
            await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential: response.credential }) });
            await load();
          } catch (e) { alert(e.message); }
        }
      });
      window.google.accounts.id.renderButton(document.getElementById('googleBtn'), { theme: 'outline', size: 'large' });
    } else {
      document.getElementById('googleBtn').innerHTML = '<p class="muted">Set GOOGLE_CLIENT_ID in env to enable Google login.</p>';
    }
  }

  const list = document.getElementById('matchList');
  list.innerHTML = '';
  for (const match of state.matches) {
    const myBet = state.bets.find((b) => b.matchId === match.id);
    const locked = ['LIVE', 'COMPLETED', 'NO_RESULT'].includes(match.status);
    const item = document.createElement('article');
    item.className = 'match';
    item.innerHTML = `
      <h3>${match.teamA} vs ${match.teamB}</h3>
      <div class="tag ${match.status}">${match.status}</div>
      <p>Start (IST): ${formatIST(match.startTime)}</p>
      <p>${locked ? 'Bet locked (match is live or finished)' : 'Bet open'}</p>
      <p>Your bet: <b>${myBet?.teamCode || 'None'}</b></p>
      <div class="options">
        <button data-team="${match.teamA}" ${locked || !state.auth ? 'disabled' : ''}>${match.teamA}</button>
        <button data-team="${match.teamB}" ${locked || !state.auth ? 'disabled' : ''}>${match.teamB}</button>
      </div>
    `;
    item.querySelectorAll('button[data-team]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api('/api/bets', { method: 'POST', body: JSON.stringify({ matchId: match.id, teamCode: btn.dataset.team }) });
          await load();
        } catch (e) { alert(e.message); }
      };
    });
    list.appendChild(item);
  }
}

async function load() {
  state = await api('/api/bootstrap');
  render();
}

document.getElementById('syncBtn').onclick = async () => {
  await api('/api/sync', { method: 'POST' });
  await load();
};

load();
