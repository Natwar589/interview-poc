import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, readCookie, cleanName, cleanEmail, codeEmail, CodeStore, RateLimiter } from '../server/auth.js';

test('session token carries name and email and is tamper-proof', () => {
  const user = { name: 'Priya Sharma', email: 'priya@example.com' };
  const token = signSession('key', user);
  assert.deepEqual(verifySession('key', token), user);
  assert.equal(verifySession('other-key', token), null); // SESSION_SECRET changed
  const [exp, , mac] = token.split('.');
  const forged = `${exp}.${Buffer.from(JSON.stringify({ name: 'Admin', email: 'a@b.co' })).toString('base64url')}.${mac}`;
  assert.equal(verifySession('key', forged), null);
  assert.equal(verifySession('key', 'garbage'), null);
  assert.equal(verifySession('key', signSession('key', user, Date.now() - 1)), null); // expired
});

test('cookie parsing', () => {
  assert.equal(readCookie('a=1; ia_session=x.y.z; b=2', 'ia_session'), 'x.y.z');
  assert.equal(readCookie('', 'ia_session'), undefined);
});

test('name and email cleaning', () => {
  assert.equal(cleanName('  Priya \n Sharma  '), 'Priya Sharma');
  assert.equal(cleanName('   '), '');
  assert.equal(cleanEmail('  Priya@Example.COM '), 'priya@example.com');
  for (const bad of ['', 'priya', 'priya@', 'a b@c.de', 'x@y.z']) assert.equal(cleanEmail(bad), '', bad);
});

test('email text includes the code, a subject and both body formats', () => {
  const m = codeEmail({ name: 'Priya Sharma', code: '042917' });
  assert.match(m.subject, /042917/);
  assert.match(m.body, /^Hi Priya,/);
  assert.match(m.body, /042917/);
  assert.match(m.html, /042917/);
  assert.equal(m.expiresInMinutes, 10);
  assert.doesNotMatch(codeEmail({ name: '<b>x</b>', code: '1' }).html, /<b>x/); // escaped
});

test('codes: 6 digits, one use, wrong tries counted, expiry', () => {
  const store = new CodeStore({ ttlMs: 1000, maxTries: 3 });
  const code = store.issue('a@b.co', 'A', 0);
  assert.match(code, /^\d{6}$/);
  assert.deepEqual(store.check('a@b.co', '000000' === code ? '111111' : '000000', 1), { ok: false, reason: 'wrong' });
  assert.deepEqual(store.check('a@b.co', code, 2), { ok: true, name: 'A' });
  assert.deepEqual(store.check('a@b.co', code, 3), { ok: false, reason: 'expired' }); // already used

  const c2 = store.issue('a@b.co', 'A', 0);
  assert.deepEqual(store.check('a@b.co', c2, 1001), { ok: false, reason: 'expired' });

  const c3 = store.issue('a@b.co', 'A', 0);
  const wrong = c3 === '999999' ? '888888' : '999999';
  store.check('a@b.co', wrong, 1);
  store.check('a@b.co', wrong, 1);
  assert.deepEqual(store.check('a@b.co', wrong, 1), { ok: false, reason: 'locked' });
  assert.deepEqual(store.check('a@b.co', c3, 1), { ok: false, reason: 'expired' }); // cancelled
});

test('codes: resend wait per email', () => {
  const store = new CodeStore({ resendAfterMs: 30_000 });
  store.issue('a@b.co', 'A', 0);
  assert.equal(store.waitSeconds('a@b.co', 10_000), 20);
  assert.equal(store.waitSeconds('a@b.co', 30_000), 0);
  assert.equal(store.waitSeconds('other@b.co', 0), 0);
});

test('rate limiter: max hits per window', () => {
  const l = new RateLimiter({ max: 2, windowMs: 1000 });
  assert.ok(l.take('ip', 0));
  assert.ok(l.take('ip', 1));
  assert.ok(!l.take('ip', 2));
  assert.ok(l.take('ip', 1001)); // first hit left the window
});
