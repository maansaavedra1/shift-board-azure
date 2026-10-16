/**
 * Authentication for the dashboard: System ID + password login against
 * admin credentials defined entirely by indexed environment variables.
 *
 * There is no self-service signup and nothing is stored on disk. Each
 * admin is a numbered pair of env vars, set by whoever operates the
 * deployment:
 *
 *   ADMIN_1_ID=<system id>        ADMIN_1_PASSWORD=<that admin's password>
 *   ADMIN_2_ID=<system id>        ADMIN_2_PASSWORD=<password>
 *
 * This replaces the previous model (ADMIN_ALLOWLIST + self-registration +
 * data/admin-accounts.json), whose accounts file lived on container-local
 * storage and was lost on every restart/redeploy/scale event unless a
 * persistent volume was mounted — forcing admins to re-register.
 * Environment variables travel with the Container App's configuration, so
 * they survive restarts with no volume at all.
 *
 * Passwords are plaintext in the environment by design (see README's
 * Authentication section for the tradeoff). Keep them in the hosting
 * environment's secret store, never in source control or logs.
 */

const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'sb_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Signs session tokens. Falls back to a random value generated at process
// start if SESSION_SECRET isn't set — this still works, but it means every
// existing session is invalidated (everyone logged out) on every restart,
// since the signing key changes each time. Set SESSION_SECRET in a real
// deployment to avoid that.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set — using a random key for this process only. Everyone will be logged out on every restart until this is set explicitly.');
}

// Warn-once helper: getCredentials() runs on every protected request, so a
// misconfigured pair would otherwise log on every single call.
const warnedOnce = new Set();
function warnOnce(key, message) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(message);
}

// Reads the admin credentials from the environment and returns a
// { systemId: password } map. Scans for ADMIN_<n>_ID rather than assuming
// contiguous numbering, so gaps (ADMIN_1, ADMIN_3) are tolerated. Never
// throws — an unset/empty configuration returns {} (nobody can log in).
function getCredentials() {
  const creds = {};
  Object.keys(process.env).forEach((key) => {
    const match = /^ADMIN_(\d+)_ID$/.exec(key);
    if (!match) return;
    const n = match[1];
    const id = String(process.env[key] || '').trim();
    const password = process.env[`ADMIN_${n}_PASSWORD`];
    // A pair with BOTH values empty is an unused slot (e.g. docker-compose
    // passes blank ADMIN_3_* through) — ignore it silently. Only a
    // half-filled pair is a likely mistake worth warning about.
    if (!id && !password) return;
    if (!id || !password) {
      warnOnce(`pair-${n}`, `ADMIN_${n}_ID / ADMIN_${n}_PASSWORD: both must be set and non-empty — skipping this pair.`);
      return;
    }
    // Session tokens are "<systemId>.<expiry>.<signature>" — a System ID
    // containing a "." would split into the wrong number of parts and
    // silently fail verification on every request afterward.
    if (id.includes('.')) {
      warnOnce(`dot-${n}`, `ADMIN_${n}_ID contains a period, which breaks session tokens — skipping this pair.`);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(creds, id)) {
      warnOnce(`dup-${id}`, `System ID "${id}" is defined by more than one ADMIN_<n>_ID pair — the later one wins.`);
    }
    creds[id] = password;
  });
  return creds;
}

// Kept so existing callers keep working: the set of valid System IDs is
// simply the IDs present across the configured pairs.
function getAllowlist() {
  return Object.keys(getCredentials());
}

function accountExists(systemId) {
  return Object.prototype.hasOwnProperty.call(getCredentials(), String(systemId).trim());
}

// Constant-time password check. Both values are HMAC'd to fixed-length
// digests first so timingSafeEqual always compares equal-length buffers
// (a direct === or length-dependent comparison can leak information via
// timing). Unknown IDs are compared against a dummy value so a missing
// account takes the same path as a wrong password.
const digest = (value) => crypto.createHmac('sha256', SESSION_SECRET).update(String(value)).digest();

async function verifyLogin(systemId, password) {
  const id = String(systemId || '').trim();
  const creds = getCredentials();
  const known = Object.prototype.hasOwnProperty.call(creds, id);
  const stored = known ? creds[id] : '\u0000no-such-account';
  const matches = crypto.timingSafeEqual(digest(password || ''), digest(stored));
  return known && matches;
}

// --- Session tokens -----------------------------------------------------
// A simple signed cookie: "<systemId>.<expiryMs>.<hmacSignature>". No
// server-side session store needed — the signature alone proves it
// wasn't tampered with, and the expiry is checked on every request.

function createSessionToken(systemId) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${systemId}.${expiresAt}`;
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [systemId, expiresAtStr, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(`${systemId}.${expiresAtStr}`).digest('hex');

  // Constant-time comparison — avoids leaking timing information about
  // how much of the signature matched.
  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null;
  }

  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return null; // expired

  return { systemId };
}

// Express middleware — blocks the request with 401 unless a valid,
// unexpired session cookie is present AND that System ID is still
// configured in the environment. Sessions are stateless, so this
// per-request check is what makes revocation real: removing an admin's
// ADMIN_<n>_ID / ADMIN_<n>_PASSWORD pair and restarting ends their
// session on the very next request, not after the 12-hour TTL.
function requireSession(req, res, next) {
  const session = verifySessionToken(req.cookies && req.cookies[SESSION_COOKIE_NAME]);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Not logged in.' });
  }
  try {
    if (!accountExists(session.systemId)) {
      return res.status(401).json({ ok: false, error: 'Not logged in.' });
    }
  } catch (err) {
    console.error('Session check failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Temporarily unavailable. Please try again shortly.' });
  }
  req.systemId = session.systemId;
  next();
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  getCredentials,
  getAllowlist,
  accountExists,
  verifyLogin,
  createSessionToken,
  verifySessionToken,
  requireSession
};
