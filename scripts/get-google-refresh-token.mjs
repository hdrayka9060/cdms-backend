/**
 * One-time helper to mint a Google OAuth2 refresh token for the CDMS Google
 * Meet integration.
 *
 * Prerequisites (do these in the Google Cloud Console first):
 *   1. Create/select a project and enable the "Google Calendar API".
 *   2. OAuth consent screen → **set Publishing status to "In production"**
 *      (click "PUBLISH APP"). This is the PERMANENT FIX: while the app is in
 *      "Testing" mode, Google EXPIRES the refresh token after 7 DAYS — the #1
 *      cause of "Meet stopped creating". A published app's refresh token does
 *      not expire on a timer (only after ~6 months of no use, and the app uses
 *      it regularly). Do NOT rely on the "add test user" path for production.
 *   3. Credentials → Create OAuth client ID → application type "Desktop app".
 *   4. Put the client id + secret into cdms-backend/.env as
 *      GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
 *
 * Then run:  node scripts/get-google-refresh-token.mjs
 *
 * (Re-run this any time the token dies — but if step 2 is done, it shouldn't.)
 *
 * It prints an auth URL — open it, sign in with the dealership Google account,
 * grant access, and the script captures the redirect and prints the refresh
 * token. Paste that into .env as GOOGLE_REFRESH_TOKEN and restart the backend.
 *
 * Uses a loopback redirect (http://localhost:53682), which "Desktop app" OAuth
 * clients allow without pre-registering a redirect URI.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { auth as googleAuth } from '@googleapis/calendar';

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

function readEnvFile() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  const out = {};
  try {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // no .env — fall back to process.env only
  }
  return out;
}

const env = readEnvFile();
const clientId = process.env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;

const placeholder = (v, name) =>
  !v || v === `your_${name}`;

if (placeholder(clientId, 'google_client_id') || placeholder(clientSecret, 'google_client_secret')) {
  console.error(
    'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to real values in cdms-backend/.env\n' +
      '(from an OAuth "Desktop app" client) before running this script.',
  );
  process.exit(1);
}

const oauth2 = new googleAuth.OAuth2(clientId, clientSecret, REDIRECT);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  // Force a consent prompt so Google always returns a refresh_token (it omits
  // it on repeat authorizations otherwise).
  prompt: 'consent',
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get('code');
  if (!code) {
    res.statusCode = 400;
    res.end('Waiting for the OAuth redirect — no authorization code yet.');
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.end('Success! Refresh token captured. You can close this tab and return to the terminal.');
    console.log('\n=== Google refresh token ===\n');
    if (tokens.refresh_token) {
      console.log(tokens.refresh_token);
      console.log('\nPaste it into cdms-backend/.env as:');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('\nThen restart the backend — you should see "🎥 Google Meet ready" at boot.');
    } else {
      console.log(
        '(no refresh_token returned — revoke this app at https://myaccount.google.com/permissions and re-run)',
      );
    }
  } catch (e) {
    res.statusCode = 500;
    res.end('Token exchange failed: ' + (e?.message ?? e));
    console.error('Token exchange failed:', e);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 200);
  }
});

server.listen(PORT, () => {
  console.log('\n1. Open this URL in your browser (sign in with the dealership Google account):\n');
  console.log(authUrl + '\n');
  console.log(`2. Grant access — the script is listening on ${REDIRECT} for the redirect.\n`);
});
