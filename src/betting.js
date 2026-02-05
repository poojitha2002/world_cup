export function isBetLocked(match) {
  return match.status === 'LIVE' || match.status === 'COMPLETED' || match.status === 'NO_RESULT';
}

export function calculateWinnerShare(totalBets, betCost, winnerCount) {
  const totalPool = totalBets * betCost;
  return winnerCount > 0 ? Math.floor(totalPool / winnerCount) : 0;
}
