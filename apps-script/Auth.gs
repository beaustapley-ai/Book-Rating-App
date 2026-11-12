/**
 * ============================================================================
 *  BOOK LIST APP  —  Accounts & sign-in
 * ============================================================================
 *  Who someone is lives in a hidden "Users" tab:
 *
 *      ID | Name | Rater | Emails | Phone | Role | Created | Last Login
 *
 *  "Rater" is the name on that person's banner in the book list ("Beau",
 *  "Kyler"). That link is the whole permission model: you can write to your
 *  own rater columns and nobody else's.
 *
 *  Passwords never touch the sheet. A salted, iterated HMAC-SHA256 hash is
 *  kept in Script Properties under "cred:<id>", alongside a session version
 *  number that "sign out everywhere" bumps.
 *
 *  Three ways in, all landing on the same account:
 *    • Sign in with Google  — the ID token is checked with Google, then the
 *                              email is matched against the Emails column
 *    • email + password
 *    • phone + password     — once a phone number is saved on the profile
 *
 *  Sessions are signed tokens (HMAC with a secret in Script Properties), so
 *  checking one costs a sheet read for the user row and nothing else.
 * ============================================================================
 */

var AUTH = {
  USERS_TAB: 'Users',

  // Paste the OAuth Client ID from Google Cloud here — the same value as
  // GOOGLE_CLIENT_ID in js/config.js. Leave blank to turn Google sign-in off.
  GOOGLE_CLIENT_ID: '249149311702-slfvkd2pehnkv51nsugchrh8u6i2kieq.apps.googleusercontent.com',

  SESSION_DAYS: 30,
  PW_MIN: 8,
  PW_ITERATIONS: 1000,      // stored per password, so raising it later is safe
  MAX_FAILS: 6,             // wrong passwords before a cooling-off period
  LOCKOUT_SECONDS: 900,
  FRESH_GOOGLE_MINUTES: 10, // a fresh Google sign-in can set a new password without the old one

  // Created the first time the Users tab is made. Rater must match the banner
  // name in row 1 of the book list ("Beau Section" → "Beau").
  SEED: [
    { name: 'Beau Stapley', rater: 'Beau', emails: 'beaustapley@hotmail.com', role: 'admin' },
    { name: 'Kyler Kent', rater: 'Kyler', emails: 'kylersm6@gmail.com', role: 'member' }
  ]
};

var USER_COLS = ['ID', 'Name', 'Rater', 'Emails', 'Phone', 'Role', 'Created', 'Last Login'];


// ---------------------------------------------------------------------------
// ONE-TIME SETUP  —  run from the editor (also grants the Google-check permission)
// ---------------------------------------------------------------------------
function setupAuth() {
  var sh = usersSheet_();
  secret_();
  var users = readUsers_();
  var msg = 'Sign-in ready.\n\n' +
    'Users tab: ' + sh.getName() + ' (hidden)\n' +
    'Accounts: ' + users.map(function (u) {
      return u.name + (u.rater ? ' → ' + u.rater : '') + (u.role === 'admin' ? ' (admin)' : '');
    }).join(', ') + '\n' +
    'Google sign-in: ' + (AUTH.GOOGLE_CLIENT_ID ? 'on' : 'OFF — paste GOOGLE_CLIENT_ID into Auth.gs');
  // Touch UrlFetchApp so the authorisation prompt includes it now rather than
  // failing on the first real Google sign-in.
  try { UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo', { muteHttpExceptions: true }); } catch (e) {}
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return msg;
}


// ---------------------------------------------------------------------------
// USERS TAB
// ---------------------------------------------------------------------------
function usersSheet_() {
  var book = ss_();
  var sh = book.getSheetByName(AUTH.USERS_TAB);
  if (sh) return sh;

  sh = book.insertSheet(AUTH.USERS_TAB);
  sh.getRange(1, 1, 1, USER_COLS.length).setValues([USER_COLS])
    .setFontWeight('bold').setBackground('#efe6dc');
  sh.setFrozenRows(1);
  var now = new Date();
  var rows = AUTH.SEED.map(function (s) {
    return [newId_(), s.name, s.rater, s.emails, '', s.role, now, ''];
  });
  if (rows.length) sh.getRange(2, 1, rows.length, USER_COLS.length).setValues(rows);
  sh.getRange(1, 1).setNote(
    'Managed by the Book List app. Rater must match a banner name on the book list.\n' +
    'Emails: comma-separated, any of them works for Google or password sign-in.\n' +
    'Passwords are NOT stored here (they are hashed in Script Properties).');
  sh.hideSheet();
  return sh;
}

function readUsers_() {
  var sh = usersSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, USER_COLS.length).getValues();
  var out = [];
  vals.forEach(function (v, i) {
    if (!norm_(v[0])) return;
    out.push({
      row: i + 2,
      id: norm_(v[0]),
      name: norm_(v[1]),
      rater: norm_(v[2]),
      emails: norm_(v[3]).split(/[,;\s]+/).map(normEmail_).filter(Boolean),
      phone: normPhone_(v[4]),
      role: key_(v[5]) === 'admin' ? 'admin' : 'member',
      created: v[6],
      lastLogin: v[7]
    });
  });
  return out;
}

function userRowValues_(u) {
  return [u.id, u.name, u.rater || '', (u.emails || []).join(', '),
    u.phone ? "'" + u.phone : '',          // leading ' keeps Sheets from eating the +
    u.role || 'member', u.created || new Date(), u.lastLogin || ''];
}

/** Writes an existing user back to their row, or appends a new one. */
function saveUser_(u) {
  var sh = usersSheet_();
  if (u.row) {
    sh.getRange(u.row, 1, 1, USER_COLS.length).setValues([userRowValues_(u)]);
  } else {
    sh.appendRow(userRowValues_(u));
    u.row = sh.getLastRow();
  }
  return u;
}

function deleteUser_(u) {
  usersSheet_().deleteRow(u.row);
  PropertiesService.getScriptProperties().deleteProperty('cred:' + u.id);
}

function byId_(users, id) {
  for (var i = 0; i < users.length; i++) if (users[i].id === id) return users[i];
  return null;
}
function byEmail_(users, email) {
  email = normEmail_(email);
  if (!email) return null;
  for (var i = 0; i < users.length; i++) if (users[i].emails.indexOf(email) !== -1) return users[i];
  return null;
}
function byPhone_(users, phone) {
  phone = normPhone_(phone);
  if (!phone) return null;
  for (var i = 0; i < users.length; i++) if (users[i].phone === phone) return users[i];
  return null;
}
function byRater_(users, rater) {
  var k = key_(rater);
  if (!k) return null;
  for (var i = 0; i < users.length; i++) if (key_(users[i].rater) === k) return users[i];
  return null;
}

function newId_() { return 'u_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }

function normEmail_(e) {
  e = norm_(e).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : '';
}

/**
 * Phone numbers are stored as +<digits>. Ten digits are taken as a US number,
 * so "(480) 555-0100", "480.555.0100" and "+1 480 555 0100" all match.
 */
function normPhone_(p) {
  var d = String(p === null || p === undefined ? '' : p).replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.length === 10) d = '1' + d;
  if (d.length < 8 || d.length > 15) return '';
  return '+' + d;
}


// ---------------------------------------------------------------------------
// SECRETS, PASSWORDS, SESSIONS
// ---------------------------------------------------------------------------
function props_() { return PropertiesService.getScriptProperties(); }

function secret_() {
  var p = props_();
  var s = p.getProperty('SESSION_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    p.setProperty('SESSION_SECRET', s);
  }
  return s;
}

function cred_(id) {
  try { return JSON.parse(props_().getProperty('cred:' + id) || '{}'); } catch (e) { return {}; }
}
function saveCred_(id, rec) { props_().setProperty('cred:' + id, JSON.stringify(rec)); }

function hashPw_(pw, salt, iter) {
  var key = Utilities.newBlob(salt).getBytes();
  var h = Utilities.computeHmacSha256Signature(Utilities.newBlob(String(pw)).getBytes(), key);
  for (var i = 1; i < iter; i++) h = Utilities.computeHmacSha256Signature(h, key);
  return Utilities.base64Encode(h);
}

function setPassword_(id, pw) {
  checkPwRules_(pw);
  var rec = cred_(id);
  rec.salt = Utilities.getUuid();
  rec.iter = AUTH.PW_ITERATIONS;
  rec.hash = hashPw_(pw, rec.salt, rec.iter);
  saveCred_(id, rec);
}

function checkPassword_(id, pw) {
  var rec = cred_(id);
  if (!rec.hash) return false;
  return hashPw_(pw, rec.salt, rec.iter || AUTH.PW_ITERATIONS) === rec.hash;
}

function checkPwRules_(pw) {
  if (String(pw || '').length < AUTH.PW_MIN) {
    throw new Error('Passwords need at least ' + AUTH.PW_MIN + ' characters.');
  }
}

function b64u_(s) { return Utilities.base64EncodeWebSafe(s).replace(/=+$/, ''); }
function sign_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, secret_())).replace(/=+$/, '');
}

/** method: 'google' | 'password' — remembered so a fresh Google sign-in can reset a password. */
function makeToken_(u, method) {
  var now = Date.now();
  var body = b64u_(JSON.stringify({
    u: u.id, v: cred_(u.id).tv || 0, m: method || 'session',
    i: now, x: now + AUTH.SESSION_DAYS * 86400000
  }));
  return body + '.' + sign_(body);
}

/** Returns { user, claims } for a valid token, or null. */
function verifyToken_(token) {
  token = String(token || '');
  var dot = token.indexOf('.');
  if (dot < 1) return null;
  var body = token.slice(0, dot), sig = token.slice(dot + 1);
  if (sign_(body) !== sig) return null;
  var claims;
  try {
    var pad = body + '==='.slice((body.length + 3) % 4);
    claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pad)).getDataAsString());
  } catch (e) { return null; }
  if (!claims || !claims.u || Date.now() > claims.x) return null;
  var user = byId_(readUsers_(), claims.u);
  if (!user) return null;
  if ((cred_(user.id).tv || 0) !== (claims.v || 0)) return null;   // signed out everywhere
  return { user: user, claims: claims };
}

/** Wrong-password counter, per sign-in name, in the script cache. */
function tooManyFails_(id) {
  return Number(CacheService.getScriptCache().get('fail:' + id) || 0) >= AUTH.MAX_FAILS;
}
function noteFail_(id) {
  var c = CacheService.getScriptCache();
  c.put('fail:' + id, String(Number(c.get('fail:' + id) || 0) + 1), AUTH.LOCKOUT_SECONDS);
}
function clearFails_(id) { CacheService.getScriptCache().remove('fail:' + id); }


// ---------------------------------------------------------------------------
// GOOGLE
// ---------------------------------------------------------------------------
function verifyGoogle_(idToken) {
  if (!AUTH.GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not switched on yet.');
  if (!idToken) throw new Error('Google did not send a sign-in token. Try again.');
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' +
    encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Google sign-in could not be verified. Try again.');
  var t = JSON.parse(res.getContentText());
  if (t.aud !== AUTH.GOOGLE_CLIENT_ID) throw new Error('That Google sign-in was meant for a different app.');
  if (['accounts.google.com', 'https://accounts.google.com'].indexOf(t.iss) === -1) {
    throw new Error('That Google sign-in did not come from Google.');
  }
  if (String(t.email_verified) !== 'true') throw new Error('Google has not verified that email address yet.');
  if (Number(t.exp) * 1000 < Date.now()) throw new Error('That Google sign-in expired. Try again.');
  var email = normEmail_(t.email);
  if (!email) throw new Error('Google did not share an email address.');
  return { email: email, name: norm_(t.name || t.given_name || email.split('@')[0]) };
}


// ---------------------------------------------------------------------------
// RESPONSES
// ---------------------------------------------------------------------------
function publicUser_(u) {
  return {
    id: u.id, name: u.name, rater: u.rater || '', role: u.role,
    emails: u.emails.slice(), phone: u.phone || '',
    hasPassword: !!cred_(u.id).hash
  };
}

/**
 * Raters a newcomer may claim: a banner nobody holds, or one held only by a
 * pre-filled account that has never signed in (that's how Kyler can sign in
 * with a different email and still end up with his ratings). Admin accounts
 * are never up for grabs.
 */
function claimable_(users) {
  var out = [];
  readLayout_().people.forEach(function (p) {
    var holder = byRater_(users, p.name);
    if (!holder || (!holder.lastLogin && holder.role !== 'admin')) out.push(p.name);
  });
  return out;
}

function sessionResult_(u, method, users) {
  return {
    ok: true,
    token: makeToken_(u, method),
    user: publicUser_(u),
    needsClaim: !u.rater,
    claimable: u.rater ? [] : claimable_(users || readUsers_())
  };
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}


// ---------------------------------------------------------------------------
// PUBLIC ACTIONS  (no session needed)
// ---------------------------------------------------------------------------

/** args = { idToken } */
function authGoogle_(args) {
  var g = verifyGoogle_(args.idToken);
  return withLock_(function () {
    var users = readUsers_();
    var u = byEmail_(users, g.email);
    if (!u) {
      u = { id: newId_(), name: g.name, rater: '', emails: [g.email], phone: '',
        role: 'member', created: new Date() };
      users.push(u);
    }
    u.lastLogin = new Date();
    saveUser_(u);
    return sessionResult_(u, 'google', users);
  });
}

/** args = { id: email or phone, password } */
function authLogin_(args) {
  var raw = norm_(args.id);
  var isEmail = raw.indexOf('@') !== -1;
  var id = isEmail ? normEmail_(raw) : normPhone_(raw);
  if (!id) throw new Error(isEmail ? 'That email address doesn\'t look right.' : 'Enter your email or phone number.');
  if (tooManyFails_(id)) throw new Error('Too many tries. Wait 15 minutes, or sign in with Google.');

  var users = readUsers_();
  var u = isEmail ? byEmail_(users, id) : byPhone_(users, id);
  if (u && !cred_(u.id).hash) {
    throw new Error('That account doesn\'t have a password yet. Sign in with Google, then set one under Account.');
  }
  if (!u || !checkPassword_(u.id, args.password)) {
    noteFail_(id);
    throw new Error('That ' + (isEmail ? 'email' : 'phone number') + ' and password don\'t match.');
  }
  clearFails_(id);
  return withLock_(function () {
    var fresh = byId_(readUsers_(), u.id);
    fresh.lastLogin = new Date();
    saveUser_(fresh);
    return sessionResult_(fresh, 'password');
  });
}

/** args = { name, email, phone, password } */
function authSignup_(args) {
  var name = norm_(args.name);
  var email = normEmail_(args.email);
  var phone = norm_(args.phone) ? normPhone_(args.phone) : '';
  if (!name) throw new Error('Enter your name.');
  if (!email) throw new Error('Enter a valid email address.');
  if (norm_(args.phone) && !phone) throw new Error('That phone number doesn\'t look right.');
  checkPwRules_(args.password);

  return withLock_(function () {
    var users = readUsers_();
    if (byEmail_(users, email)) {
      throw new Error('There\'s already an account for that email. Sign in instead — or use Google if that\'s how it was set up.');
    }
    if (phone && byPhone_(users, phone)) throw new Error('That phone number is already on another account.');
    var u = { id: newId_(), name: name, rater: '', emails: [email], phone: phone,
      role: 'member', created: new Date(), lastLogin: new Date() };
    saveUser_(u);
    setPassword_(u.id, args.password);
    users.push(u);
    return sessionResult_(u, 'password', users);
  });
}


// ---------------------------------------------------------------------------
// SIGNED-IN ACTIONS
// ---------------------------------------------------------------------------

/** Who am I — also slides the session forward. */
function authMe_(ctx) {
  return sessionResult_(ctx.user, ctx.claims.m);
}

/**
 * args = { rater: 'Kyler' }   → take over an existing, unclaimed rater
 * args = { newName: 'Sam' }   → start a fresh rater column
 */
function authClaim_(ctx, args) {
  if (ctx.user.rater) throw new Error('You\'re already linked to ' + ctx.user.rater + '.');

  if (args.newName) {
    var name = norm_(args.newName);
    if (!name) throw new Error('Enter a name for your column.');
    var taken = readLayout_().people.some(function (p) { return key_(p.name) === key_(name); });
    if (taken) throw new Error(name + ' is already on the list. Pick it from the list above if it\'s you, or use a different name.');
    var added = addPerson(name);              // takes its own lock
    if (!added.ok) throw new Error(added.error);
    return withLock_(function () {
      var users = readUsers_();
      var me = byId_(users, ctx.user.id);
      me.rater = name;
      saveUser_(me);
      return sessionResult_(me, ctx.claims.m, users);
    });
  }

  var want = norm_(args.rater);
  return withLock_(function () {
    var users = readUsers_();
    var me = byId_(users, ctx.user.id);
    var open = claimable_(users);
    var match = null;
    open.forEach(function (n) { if (key_(n) === key_(want)) match = n; });
    if (!match) throw new Error(want + ' has already been claimed. Ask Beau if that\'s a mistake.');

    // A pre-filled account that never signed in folds into this one, so its
    // email keeps working for Google sign-in.
    var holder = byRater_(users, match);
    me.rater = match;
    if (holder && holder.id !== me.id) {
      holder.emails.forEach(function (e) { if (me.emails.indexOf(e) === -1) me.emails.push(e); });
      if (!me.phone && holder.phone) me.phone = holder.phone;
    }
    saveUser_(me);
    if (holder && holder.id !== me.id) deleteUser_(holder);   // after the save: rows shift
    return sessionResult_(byId_(readUsers_(), me.id), ctx.claims.m);
  });
}

/** args = { name, phone } — either may be omitted. */
function authProfile_(ctx, args) {
  return withLock_(function () {
    var users = readUsers_();
    var me = byId_(users, ctx.user.id);
    if ('name' in args) {
      var nm = norm_(args.name);
      if (!nm) throw new Error('Name can\'t be blank.');
      me.name = nm;
    }
    if ('phone' in args) {
      if (!norm_(args.phone)) {
        me.phone = '';
      } else {
        var ph = normPhone_(args.phone);
        if (!ph) throw new Error('That phone number doesn\'t look right.');
        var other = byPhone_(users, ph);
        if (other && other.id !== me.id) throw new Error('That phone number is on another account.');
        me.phone = ph;
      }
    }
    saveUser_(me);
    return { ok: true, user: publicUser_(me), message: 'Profile saved.' };
  });
}

/**
 * args = { current, password }
 * The current password is needed once one exists — unless you signed in with
 * Google in the last few minutes, which is how a forgotten password gets reset.
 */
function authPassword_(ctx, args) {
  var me = ctx.user;
  if (cred_(me.id).hash) {
    var freshGoogle = ctx.claims.m === 'google' &&
      Date.now() - ctx.claims.i < AUTH.FRESH_GOOGLE_MINUTES * 60000;
    if (!freshGoogle && !checkPassword_(me.id, args.current)) {
      throw new Error('Your current password isn\'t right. (Forgot it? Sign out, sign in with Google, then set a new one.)');
    }
  }
  setPassword_(me.id, args.password);
  return { ok: true, user: publicUser_(me), message: 'Password saved.' };
}

/** args = { idToken } — adds that Google account's email to yours. */
function authLinkGoogle_(ctx, args) {
  var g = verifyGoogle_(args.idToken);
  return withLock_(function () {
    var users = readUsers_();
    var me = byId_(users, ctx.user.id);
    var other = byEmail_(users, g.email);
    if (other && other.id !== me.id) throw new Error(g.email + ' is already linked to ' + other.name + '.');
    if (me.emails.indexOf(g.email) === -1) me.emails.push(g.email);
    saveUser_(me);
    return { ok: true, user: publicUser_(me), message: 'Linked ' + g.email + '.' };
  });
}

/** args = { email } */
function authRemoveEmail_(ctx, args) {
  return withLock_(function () {
    var users = readUsers_();
    var me = byId_(users, ctx.user.id);
    var e = normEmail_(args.email);
    if (me.emails.length <= 1) throw new Error('Keep at least one email on your account.');
    me.emails = me.emails.filter(function (x) { return x !== e; });
    saveUser_(me);
    return { ok: true, user: publicUser_(me), message: 'Removed ' + e + '.' };
  });
}

function authSignOutAll_(ctx) {
  var rec = cred_(ctx.user.id);
  rec.tv = (rec.tv || 0) + 1;
  saveCred_(ctx.user.id, rec);
  return { ok: true, message: 'Signed out on every device.' };
}


// ---------------------------------------------------------------------------
// ADMIN ACTIONS
// ---------------------------------------------------------------------------
function adminUsers_() {
  var users = readUsers_();
  return {
    ok: true,
    users: users.map(function (u) {
      var p = publicUser_(u);
      p.lastLogin = u.lastLogin ? Utilities.formatDate(new Date(u.lastLogin), Session.getScriptTimeZone(), 'MMM d, yyyy') : '';
      return p;
    }),
    claimable: claimable_(users)
  };
}

/** args = { id } — frees that person's rater so it can be claimed again. */
function adminUnlink_(ctx, args) {
  return withLock_(function () {
    var u = byId_(readUsers_(), args.id);
    if (!u) throw new Error('No such account.');
    if (u.id === ctx.user.id) throw new Error('You can\'t unlink yourself.');
    var was = u.rater;
    u.rater = '';
    saveUser_(u);
    return { ok: true, message: u.name + ' unlinked from ' + (was || 'nothing') + '.' };
  });
}

/** args = { id } — sets a temporary password and signs them out everywhere. */
function adminResetPassword_(ctx, args) {
  var u = byId_(readUsers_(), args.id);
  if (!u) throw new Error('No such account.');
  var temp = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  setPassword_(u.id, temp);
  var rec = cred_(u.id);
  rec.tv = (rec.tv || 0) + 1;
  saveCred_(u.id, rec);
  // A reset usually follows a lock-out, so lift it.
  u.emails.concat(u.phone ? [u.phone] : []).forEach(clearFails_);
  return { ok: true, tempPassword: temp,
    message: 'Temporary password for ' + u.name + ': ' + temp };
}

/** args = { id, role: 'admin'|'member' } */
function adminSetRole_(ctx, args) {
  return withLock_(function () {
    var users = readUsers_();
    var u = byId_(users, args.id);
    if (!u) throw new Error('No such account.');
    var role = args.role === 'admin' ? 'admin' : 'member';
    if (role === 'member' && u.role === 'admin' &&
        users.filter(function (x) { return x.role === 'admin'; }).length < 2) {
      throw new Error('There has to be at least one admin.');
    }
    u.role = role;
    saveUser_(u);
    return { ok: true, message: u.name + ' is now ' + (role === 'admin' ? 'an admin' : 'a member') + '.' };
  });
}

/** args = { id } — removes the account. Their ratings stay in the sheet. */
function adminDeleteUser_(ctx, args) {
  return withLock_(function () {
    var u = byId_(readUsers_(), args.id);
    if (!u) throw new Error('No such account.');
    if (u.id === ctx.user.id) throw new Error('You can\'t remove your own account.');
    deleteUser_(u);
    return { ok: true, message: 'Removed ' + u.name + '. Their ratings are still in the sheet.' };
  });
}

/** Keeps the Users tab in step when a rater's banner is renamed. */
function renameRaterInUsers_(oldName, newName) {
  withLock_(function () {
    readUsers_().forEach(function (u) {
      if (key_(u.rater) === key_(oldName)) { u.rater = norm_(newName); saveUser_(u); }
    });
  });
}
