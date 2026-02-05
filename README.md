# T20 World Cup Virtual Betting (Responsive Web App)

This app allows users to place a **100-coin bet** on a match winner and update the pick any number of times **until the match turns LIVE**. As soon as status becomes `LIVE`, bet edits are blocked server-side.

## Storage (updated)
- **Current implementation:** SQLite relational DB (`data/db.sqlite`) with tables for users, sessions, matches, bets, and transactions.
- This is significantly safer than JSON file storage for concurrent usage around ~200 users on a single app instance.
- For horizontal scaling / multi-instance production, migrate to PostgreSQL.

## Key rules implemented
- One bet per user per match.
- Bet cost deducted only on first submission for a match.
- Bet updates are free before lock.
- Lock condition is status `LIVE`/`COMPLETED`/`NO_RESULT`.
- Settlement on completion:
  - pool = `number_of_bets * 100`
  - winner share = `floor(pool / winner_count)`
- `NO_RESULT` refunds all bettors.
- Negative wallet balance is allowed.

## Free API options for cricket live status (2026 T20 WC)
- CricAPI (free tier, limited requests)
- CricketData.org (free tier, limited)

You can wire either provider into `src/matchProvider.js`.

## Run locally
```bash
node src/server.js
```
Open `http://localhost:3000`.

## Host on Render (quickest)
This repository includes `Dockerfile` + `render.yaml`.

1. Push this repo to GitHub.
2. Go to Render → **New +** → **Blueprint**.
3. Select your GitHub repo.
4. Render reads `render.yaml` and deploys automatically.
5. Set env var:
   - `GOOGLE_CLIENT_ID=your-google-oauth-client-id`
6. Open the generated URL.

## Google Auth setup
Set environment variable:
```bash
export GOOGLE_CLIENT_ID="your-google-oauth-client-id"
```
Frontend uses Google Identity Services and backend validates token through Google `tokeninfo` endpoint.

## Simulate LIVE/COMPLETED
Edit `data/mockMatches.json` statuses and click **Refresh Match Status**.
