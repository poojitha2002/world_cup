import test from 'node:test';
import assert from 'node:assert/strict';
import { isBetLocked, calculateWinnerShare } from '../src/betting.js';

test('locks bet when match is live', () => {
  assert.equal(isBetLocked({ status: 'LIVE' }), true);
  assert.equal(isBetLocked({ status: 'SCHEDULED' }), false);
});

test('calculates payout share from pool', () => {
  assert.equal(calculateWinnerShare(2, 100, 1), 200);
  assert.equal(calculateWinnerShare(3, 100, 2), 150);
});
