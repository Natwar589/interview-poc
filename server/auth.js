// Email sign-in codes. A visitor gives their name and email; the server makes a 6-digit
// code and posts it to the webhook (LOGIN_WEBHOOK_URL, else VISIT_WEBHOOK_URL) together
// with a ready-to-send subject and message body; the webhook's flow emails it. Entering
// the code sets a signed session cookie carrying the name and email. Codes live only in
// memory (hashed), so a restart cancels codes that were sent but not yet used.
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'ia_session';
const SESSION_DAYS = 7;
const CODE_DIGITS = 6;
const CODE_TTL_MS = 10 * 60_000;
const MAX_CODE_TRIES = 5; // wrong entries before a code is cancelled
const RESEND_AFTER_MS = 30_000; // per email
const MAX_SENDS = 5; // codes per IP per window, so nobody can spam inboxes through us
const SEND_WINDOW_MS = 10 * 60_000;
const MAX_NAME = 60;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

/** Trimmed, single-line, at most MAX_NAME characters; '' if nothing usable. */
export function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** Lower-cased email if it looks like one, else ''. */
export function cleanEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : '';
}

/** Session token: "<expiry ms>.<{name,email} as base64url JSON>.<HMAC of both>". */
export function signSession(key, user, expiresAt = Date.now() + SESSION_DAYS * 86_400_000) {
  const payload = Buffer.from(JSON.stringify({ name: user.name, email: user.email })).toString('base64url');
  const body = `${expiresAt}.${payload}`;
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
}

/** Returns { name, email } for a valid, unexpired token, otherwise null. */
export function verifySession(key, token, now = Date.now()) {
  const [exp, payload, mac] = String(token ?? '').split('.');
  if (!exp || !payload || !mac || !(Number(exp) > now)) return null;
  const expected = crypto.createHmac('sha256', key).update(`${exp}.${payload}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { name, email } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return { name: String(name ?? ''), email: String(email ?? '') };
  } catch {
    return null;
  }
}

export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** What the email says. Plain text plus a simple HTML version for flows that send HTML. */
export function codeEmail({ name, code, appName = 'Interview Assistant' }) {
  const minutes = CODE_TTL_MS / 60_000;
  const first = name.split(' ')[0] || 'there';
  const subject = `Your ${appName} sign-in code: ${code}`;
  const body =
    `Hi ${first},\n\n` +
    `Your sign-in code is ${code}\n\n` +
    `Enter it on the sign-in page to open ${appName}. It expires in ${minutes} minutes.\n\n` +
    `If you didn't ask for this code, you can ignore this email.`;
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html =
    `<p>Hi ${esc(first)},</p>` +
    `<p>Your sign-in code is</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:8px 0 16px">${code}</p>` +
    `<p>Enter it on the sign-in page to open ${esc(appName)}. It expires in ${minutes} minutes.</p>` +
    `<p style="color:#8c8378">If you didn't ask for this code, you can ignore this email.</p>`;
  return { subject, body, html, expiresInMinutes: minutes };
}

/** Pending codes, one per email, stored hashed. */
export class CodeStore {
  constructor({ ttlMs = CODE_TTL_MS, maxTries = MAX_CODE_TRIES, resendAfterMs = RESEND_AFTER_MS } = {}) {
    this.ttlMs = ttlMs;
    this.maxTries = maxTries;
    this.resendAfterMs = resendAfterMs;
    this.codes = new Map(); // email -> { hash, name, expiresAt, sentAt, tries }
  }

  /** Seconds to wait before another code can be sent to this email (0 = now). */
  waitSeconds(email, now = Date.now()) {
    const c = this.codes.get(email);
    return c ? Math.max(0, Math.ceil((c.sentAt + this.resendAfterMs - now) / 1000)) : 0;
  }

  issue(email, name, now = Date.now()) {
    const code = String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
    this.codes.set(email, { hash: sha256(`${email}:${code}`), name, expiresAt: now + this.ttlMs, sentAt: now, tries: 0 });
    return code;
  }

  cancel(email) {
    this.codes.delete(email);
  }

  /** { ok: true, name } | { ok: false, reason: 'expired' | 'wrong' | 'locked' } */
  check(email, code, now = Date.now()) {
    const c = this.codes.get(email);
    if (!c || c.expiresAt <= now) {
      this.codes.delete(email);
      return { ok: false, reason: 'expired' };
    }
    const given = sha256(`${email}:${String(code ?? '').replace(/\D/g, '')}`);
    if (crypto.timingSafeEqual(given, c.hash)) {
      this.codes.delete(email); // one use only
      return { ok: true, name: c.name };
    }
    if (++c.tries >= this.maxTries) {
      this.codes.delete(email);
      return { ok: false, reason: 'locked' };
    }
    return { ok: false, reason: 'wrong' };
  }
}

/** Counts events per key in a sliding window (code requests per IP). */
export class RateLimiter {
  constructor({ max = MAX_SENDS, windowMs = SEND_WINDOW_MS } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> [timestamps]
  }

  /** Records a hit; false if the key is over the limit (the hit is not recorded then). */
  take(key, now = Date.now()) {
    const recent = (this.hits.get(key) || []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

/**
 * Wires email-code login into an Express app. Returns `isAuthed(req)` for the WebSocket.
 * Options:
 *   webhookUrl      where codes are posted (login is off without it)
 *   sessionSecret   signs session cookies; without it a random one is used and
 *                   sessions end when the server restarts
 *   allowedEmails   optional list; empty = anyone with an email address can sign in
 *   loginPage       path of the sign-in HTML
 *   onLogin({ name, email, req, res })  runs after each successful sign-in
 */
export function setupAuth(app, { webhookUrl, sessionSecret, allowedEmails = [], loginPage, onLogin }) {
  if (!webhookUrl) return { enabled: false, isAuthed: () => true };
  const key = sha256(`interview-assistant-session:${sessionSecret || crypto.randomBytes(32).toString('hex')}`);
  const allowed = new Set(allowedEmails.map(cleanEmail).filter(Boolean));
  const codes = new CodeStore();
  const sendLimiter = new RateLimiter();
  const session = (req) => verifySession(key, readCookie(req.headers.cookie, SESSION_COOKIE));
  const isAuthed = (req) => session(req) !== null;
  const secure = (req) => req.secure || req.get('x-forwarded-proto') === 'https';

  app.get('/login', (req, res) => {
    if (isAuthed(req)) return res.redirect('/');
    res.set('Cache-Control', 'no-store').sendFile(loginPage);
  });

  // Step 1: name + email -> code sent through the webhook.
  app.post('/login/code', async (req, res) => {
    const name = cleanName(req.body?.name);
    const email = cleanEmail(req.body?.email);
    if (!name) return res.status(400).json({ error: 'Please tell us your name.' });
    if (!email) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (allowed.size && !allowed.has(email)) {
      console.warn(`[auth] code refused for ${email} (not in ALLOWED_EMAILS)`);
      return res.status(403).json({ error: "This email isn't on the list of people who can sign in." });
    }
    const wait = codes.waitSeconds(email);
    if (wait) return res.status(429).json({ error: `Please wait ${wait} s before asking for another code.`, wait });
    if (!sendLimiter.take(req.ip)) return res.status(429).json({ error: 'Too many codes requested. Please try again in 10 minutes.' });

    const code = codes.issue(email, name);
    try {
      const r = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'login_code', name, email, code, ...codeEmail({ name, code }), at: new Date().toISOString() }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`webhook answered ${r.status}`);
      console.log(`[auth] code sent to ${email}`);
      res.json({ ok: true, email });
    } catch (err) {
      codes.cancel(email);
      console.warn(`[auth] could not send code to ${email}: ${err.message}`);
      res.status(502).json({ error: "We couldn't send the email just now. Please try again in a moment." });
    }
  });

  // Step 2: email + code -> session.
  app.post('/login/verify', (req, res) => {
    const email = cleanEmail(req.body?.email);
    const result = codes.check(email, req.body?.code);
    if (!result.ok) {
      const error = {
        expired: 'That code has expired. Please ask for a new one.',
        locked: 'Too many wrong tries. Please ask for a new code.',
        wrong: "That code didn't match. Please check the email and try again.",
      }[result.reason];
      return res.status(401).json({ error, restart: result.reason !== 'wrong' });
    }
    const user = { name: result.name, email };
    console.log(`[auth] signed in: ${user.name} <${email}>`);
    res.cookie(SESSION_COOKIE, signSession(key, user), {
      maxAge: SESSION_DAYS * 86_400_000,
      httpOnly: true,
      sameSite: 'lax',
      secure: secure(req),
    });
    onLogin?.({ ...user, req, res });
    res.json({ ok: true });
  });

  app.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.redirect(303, '/login');
  });

  // Who is signed in, for the greeting; 401 lets the page notice an expired session
  // (a refused WebSocket can't say why).
  app.get('/session', (req, res) => {
    const s = session(req);
    if (!s) return res.sendStatus(401);
    res.set('Cache-Control', 'no-store').json(s);
  });

  // Everything registered after this needs a session.
  app.use((req, res, next) => {
    if (isAuthed(req)) return next();
    if (req.method === 'GET' && req.accepts('html') && !req.path.includes('.')) return res.redirect('/login');
    if (req.path === '/index.html') return res.redirect('/login');
    res.sendStatus(401);
  });

  return { enabled: true, isAuthed, allowedCount: allowed.size, persistentSessions: !!sessionSecret };
}
