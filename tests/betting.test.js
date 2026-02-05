import test from 'node:test';
import assert from 'node:assert/strict';
import { settleMatch, isBetLocked } from '../src/betting.js';

test('locks bet when match is live', () => {
  assert.equal(isBetLocked({ status: 'LIVE' }), true);
  assert.equal(isBetLocked({ status: 'SCHEDULED' }), false);
});

test('settles payout for winners', () => {
  const db = {
    matches: [{ id: 'm1', status: 'COMPLETED', winnerTeam: 'IND', settledAt: null }],
    bets: [
      { id: 'b1', matchId: 'm1', userId: 'u1', teamCode: 'IND' },
      { id: 'b2', matchId: 'm1', userId: 'u2', teamCode: 'AUS' }
    ],
    transactions: []
  };
  const res = settleMatch(db, 'm1');
  assert.equal(res.settled, true);
  assert.equal(db.transactions.find((tx) => tx.userId === 'u1')?.amount, 200);
  assert.equal(db.bets.find((b) => b.id === 'b1')?.status, 'WON');
});
