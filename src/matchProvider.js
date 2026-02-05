import fs from 'node:fs';

const MOCK_PATH = 'data/mockMatches.json';

export async function fetchWorldCupMatches() {
  if (fs.existsSync(MOCK_PATH)) {
    return JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
  }
  return [];
}
