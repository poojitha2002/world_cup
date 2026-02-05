import { BET_COST } from './config.js';

export function isBetLocked(match) {
  return match.status === 'LIVE' || match.status === 'COMPLETED' || match.status === 'NO_RESULT';
}

export function getWalletBalance(db, userId) {
  return db.transactions.filter((tx) => tx.userId === userId).reduce((sum, tx) => sum + tx.amount, 0);
}

export function settleMatch(db, matchId) {
  const match = db.matches.find((m) => m.id === matchId);
  if (!match || match.settledAt) return { settled: false, reason: 'No match or already settled' };
  const bets = db.bets.filter((bet) => bet.matchId === matchId);
  if (match.status === 'NO_RESULT') {
    for (const bet of bets) {
      db.transactions.push({
        id: `${bet.id}_refund`,
        userId: bet.userId,
        matchId,
        amount: BET_COST,
        type: 'refund',
        createdAt: new Date().toISOString()
      });
      bet.status = 'REFUNDED';
    }
    match.settledAt = new Date().toISOString();
    return { settled: true, reason: 'refund' };
  }
  if (match.status !== 'COMPLETED' || !match.winnerTeam) {
    return { settled: false, reason: 'Match not ready' };
  }

  const winnerBets = bets.filter((b) => b.teamCode === match.winnerTeam);
  const totalPool = bets.length * BET_COST;
  const share = winnerBets.length ? Math.floor(totalPool / winnerBets.length) : 0;

  for (const bet of bets) {
    if (bet.teamCode === match.winnerTeam) {
      db.transactions.push({
        id: `${bet.id}_payout`,
        userId: bet.userId,
        matchId,
        amount: share,
        type: 'payout',
        createdAt: new Date().toISOString()
      });
      bet.status = 'WON';
    } else {
      bet.status = 'LOST';
    }
  }

  match.settledAt = new Date().toISOString();
  return { settled: true, reason: 'completed', share };
}
