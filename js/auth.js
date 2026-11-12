/* =====================================================================
   Book List — sign-in, claiming a column, account & admin
   ---------------------------------------------------------------------
   Flow:
     page loads → saved session? → auth.me
                              ↘ no → sign-in screen
     signed in  → linked to a rater column? → startApp()
                                         ↘ no → "Who are you?" claim screen
   Relies on $, el, esc, toast, initials from app.js.
   ===================================================================== */
var Auth = (function () {
  var BOOK_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
  var claimable = [];
  var A = { user: null };

  /* ---------- screen helpers ---------- */
  function show(html) {
    $('authBody').innerHTML = html;
    $('auth').className = 'auth on';
    document.body.classList.add('locked');
  }
  function hide() {
    $('auth').className = 'auth';
    document.body.classList.remove('locked');
  }
  function brand(sub) {
    return '<div class="auth-brand">' + BOOK_SVG + 'Book List</div>' +
      '<div class="auth-sub">' + sub + '</div>';
  }
  function msgBox(text, ok) {
    return text ? '<div class="' + (ok ? 'auth-ok' : 'auth-err') + '">' + esc(text) + '</div>' : '';
  }
  function loading(text) {
    show(brand('') + '<div class="loading" style="padding:26px 0"><span class="spinner"></span>' + esc(text) + '</div>');
  }
  function setBusy(btn, on, label) {
    if (!btn) return;
    btn.disabled = on;
    if (on) { btn._label = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span> ' + esc(label || 'Working…'); }
    else if (btn._label) btn.innerHTML = btn._label;
  }
  function onEnter(ids, fn) {
    ids.forEach(function (id) {
      var n = $(id);
      if (n) n.onkeydown = function (e) { if (e.key === 'Enter') fn(); };
    });
  }

  /* ---------- Google button ---------- */
  function googleOn() { return !!(window.CONFIG && CONFIG.GOOGLE_CLIENT_ID); }

  /** Renders the Google button into `targetId`; cb gets the ID token. */
  function renderGoogle(targetId, cb, text) {
    if (!googleOn()) return;
    var tries = 0;
    (function wait() {
      var box = $(targetId);
      if (!box) return;
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.initialize({
          client_id: CONFIG.GOOGLE_CLIENT_ID,
          callback: function (r) { cb(r.credential); },
          auto_select: false,
          cancel_on_tap_outside: true
        });
        box.innerHTML = '';
        google.accounts.id.renderButton(box, {
          theme: 'outline', size: 'large', shape: 'pill',
          text: text || 'continue_with', width: Math.min(320, box.clientWidth || 320)
        });
        return;
      }
      if (++tries > 60) { box.innerHTML = '<div class="tiny muted">Google sign-in didn\'t load. Use email or phone below.</div>'; return; }
      setTimeout(wait, 150);
    })();
  }

  /* ---------- start ---------- */
  A.start = function () {
    API.onSignedOut = function (why) {
      A.user = null;
      signInScreen(why || 'You were signed out. Please sign in again.');
    };
    if (!API.configured()) {
      show(brand('Almost there') + msgBox('Set API_URL in js/config.js to your Apps Script web app URL, then reload.'));
      return;
    }
    if (API.token()) {
      loading('Signing you in…');
      API.call('auth.me').then(handleSession).catch(function (e) {
        if (!(e && e.auth)) signInScreen((e && e.message) || 'Could not reach the server.');
      });
    } else {
      signInScreen();
    }
  };

  function handleSession(res) {
    if (!res || !res.ok) { signInScreen(res && res.error); return; }
    A.user = res.user;
    claimable = res.claimable || [];
    if (res.needsClaim) { claimScreen(); return; }
    hide();
    startApp(res.user);
  }

  /* ---------- sign in ---------- */
  function signInScreen(err) {
    show(brand('Sign in to see the list and add your ratings.') +
      msgBox(err) +
      (googleOn() ? '<div class="gbtn" id="gSignIn"></div><div class="divider">or</div>' : '') +
      '<label class="fld"><span>Email or phone</span>' +
        '<input type="text" id="a-id" autocomplete="username" inputmode="email" placeholder="you@example.com or 480 555 0100"></label>' +
      '<label class="fld"><span>Password</span>' +
        '<input type="password" id="a-pw" autocomplete="current-password"></label>' +
      '<button class="btn primary block" id="a-go">Sign in</button>' +
      '<div class="auth-foot">New here? <button class="linkbtn" id="a-toSignup">Create an account</button></div>' +
      '<div class="tiny muted" style="text-align:center;margin-top:10px">Phone sign-in works once a phone number is saved on your account.</div>');

    renderGoogle('gSignIn', googleSignIn);
    function go() {
      var id = $('a-id').value.trim(), pw = $('a-pw').value;
      if (!id || !pw) { toast('Enter your email or phone and password', true); return; }
      setBusy($('a-go'), true, 'Signing in…');
      API.call('auth.login', { id: id, password: pw }).then(function (res) {
        if (!res.ok) { setBusy($('a-go'), false); signInScreen(res.error); $('a-id').value = id; return; }
        handleSession(res);
      }).catch(function (e) { setBusy($('a-go'), false); signInScreen(e.message); });
    }
    $('a-go').onclick = go;
    onEnter(['a-id', 'a-pw'], go);
    $('a-toSignup').onclick = function () { signUpScreen(); };
  }

  function googleSignIn(idToken) {
    loading('Checking with Google…');
    API.call('auth.google', { idToken: idToken }).then(function (res) {
      if (!res.ok) { signInScreen(res.error); return; }
      handleSession(res);
    }).catch(function (e) { signInScreen(e.message); });
  }

  /* ---------- sign up ---------- */
  function signUpScreen(err, keep) {
    keep = keep || {};
    show(brand('Join the list — add books, rate them, compare with everyone.') +
      msgBox(err) +
      (googleOn() ? '<div class="gbtn" id="gSignUp"></div><div class="divider">or with email</div>' : '') +
      '<label class="fld"><span>Your name</span><input type="text" id="s-name" autocomplete="name" value="' + esc(keep.name || '') + '"></label>' +
      '<label class="fld"><span>Email</span><input type="email" id="s-email" autocomplete="email" value="' + esc(keep.email || '') + '"></label>' +
      '<label class="fld"><span>Phone <span class="muted" style="font-weight:500">(optional — lets you sign in with it)</span></span>' +
        '<input type="tel" id="s-phone" autocomplete="tel" value="' + esc(keep.phone || '') + '"></label>' +
      '<label class="fld"><span>Password <span class="muted" style="font-weight:500">(8+ characters)</span></span>' +
        '<input type="password" id="s-pw" autocomplete="new-password"></label>' +
      '<button class="btn primary block" id="s-go">Create account</button>' +
      '<div class="auth-foot">Already have one? <button class="linkbtn" id="s-toSignin">Sign in</button></div>');

    renderGoogle('gSignUp', googleSignIn, 'signup_with');
    function go() {
      var v = { name: $('s-name').value.trim(), email: $('s-email').value.trim(),
        phone: $('s-phone').value.trim(), password: $('s-pw').value };
      setBusy($('s-go'), true, 'Creating…');
      API.call('auth.signup', v).then(function (res) {
        if (!res.ok) { signUpScreen(res.error, v); return; }
        handleSession(res);
      }).catch(function (e) { signUpScreen(e.message, v); });
    }
    $('s-go').onclick = go;
    onEnter(['s-name', 's-email', 's-phone', 's-pw'], go);
    $('s-toSignin').onclick = function () { signInScreen(); };
  }

  /* ---------- claim: who are you? ---------- */
  function claimScreen(err) {
    var first = String(A.user && A.user.name || '').split(/\s+/)[0] || '';
    var list = claimable.map(function (n) {
      return '<button class="claim-btn" data-claim="' + esc(n) + '">' +
        '<span class="avatar">' + esc(initials(n)) + '</span>' +
        '<span class="grow"><b>I\'m ' + esc(n) + '</b><div class="tiny muted">Take over ' + esc(n) +
        '\'s existing ratings</div></span></button>';
    }).join('');
    show(brand('Welcome, ' + esc(first || 'friend') + '! One last step.') +
      msgBox(err) +
      (list
        ? '<div class="sect-title" style="margin-top:0">Already on the list?</div>' + list +
          '<div class="divider">or</div>'
        : '') +
      '<div class="sect-title" style="margin-top:0">I\'m new here</div>' +
      '<label class="fld"><span>Name for your rating column</span>' +
        '<input type="text" id="c-name" value="' + esc(first) + '" autocomplete="off"></label>' +
      '<button class="btn primary block" id="c-new">Start my column</button>' +
      '<div class="auth-foot"><button class="linkbtn" id="c-out">Sign out</button></div>');

    Array.prototype.forEach.call(document.querySelectorAll('[data-claim]'), function (b) {
      b.onclick = function () {
        var n = b.getAttribute('data-claim');
        if (!confirm('Link your account to ' + n + '\'s ratings? Only do this if you are ' + n + '.')) return;
        claim({ rater: n });
      };
    });
    $('c-new').onclick = function () {
      var n = $('c-name').value.trim();
      if (!n) { toast('Enter a name', true); return; }
      claim({ newName: n });
    };
    onEnter(['c-name'], function () { $('c-new').click(); });
    $('c-out').onclick = A.signOut;
  }

  function claim(args) {
    loading(args.newName ? 'Adding your column to the sheet…' : 'Linking your account…');
    API.call('auth.claim', args).then(function (res) {
      if (!res.ok) { claimScreen(res.error); return; }
      handleSession(res);
    }).catch(function (e) { claimScreen(e.message); });
  }

  /* ---------- sign out ---------- */
  A.signOut = function () {
    API.token(null);
    try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) {}
    location.reload();
  };

  /* =====================================================================
     ACCOUNT (opens in the shared modal)
     ===================================================================== */
  A.openAccount = function (note, ok) {
    var u = A.user || {};
    $('m-title').textContent = 'Your account';
    $('m-sub').textContent = (u.name || '') + (u.rater ? ' · rating as ' + u.rater : '') +
      (u.role === 'admin' ? ' · admin' : '');
    var body = $('m-body');

    var emails = (u.emails || []).map(function (e) {
      return '<div class="email-row"><span class="grow trunc">' + esc(e) + '</span>' +
        ((u.emails || []).length > 1 ? '<button class="btn sm" data-rmemail="' + esc(e) + '">Remove</button>' : '') +
        '</div>';
    }).join('');

    body.innerHTML = msgBox(note, ok) +
      '<div class="sect-title" style="margin-top:0">Profile</div>' +
      '<div class="card pad">' +
        '<label class="fld"><span>Name</span><input type="text" id="p-name" value="' + esc(u.name || '') + '"></label>' +
        '<label class="fld"><span>Phone <span class="muted" style="font-weight:500">— saving one lets you sign in with phone + password</span></span>' +
          '<input type="tel" id="p-phone" value="' + esc(u.phone || '') + '" placeholder="480 555 0100"></label>' +
        '<button class="btn primary block" id="p-save">Save profile</button>' +
      '</div>' +

      '<div class="sect-title">Sign-in emails</div>' +
      '<div class="card pad">' + (emails || '<div class="tiny muted">None</div>') +
        (googleOn()
          ? '<div class="tiny muted" style="margin:12px 0 8px">Link another Google account (adds its email):</div>' +
            '<div class="gbtn" id="gLink"></div>'
          : '') +
      '</div>' +

      '<div class="sect-title">' + (u.hasPassword ? 'Change password' : 'Set a password') + '</div>' +
      '<div class="card pad">' +
        (u.hasPassword
          ? '<label class="fld"><span>Current password</span><input type="password" id="p-cur" autocomplete="current-password"></label>'
          : '<div class="tiny muted" style="margin-bottom:10px">Add a password to sign in with your email or phone, not just Google.</div>') +
        '<label class="fld"><span>New password (8+ characters)</span><input type="password" id="p-new" autocomplete="new-password"></label>' +
        '<button class="btn block" id="p-pw">Save password</button>' +
        (u.hasPassword
          ? '<div class="tiny muted" style="margin-top:8px">Forgot it? Sign out, sign in with Google, then set a new one here within 10 minutes — no current password needed.</div>'
          : '') +
      '</div>' +

      '<div class="sect-title">Session</div>' +
      '<div class="card pad">' +
        '<div class="row" style="gap:8px">' +
          '<button class="btn grow" id="p-out">Sign out</button>' +
          '<button class="btn danger grow" id="p-outall">Sign out everywhere</button>' +
        '</div>' +
      '</div>';

    $('p-save').onclick = function () {
      var btn = this;
      setBusy(btn, true, 'Saving…');
      API.call('auth.profile', { name: $('p-name').value, phone: $('p-phone').value }).then(function (res) {
        if (!res.ok) { setBusy(btn, false); toast(res.error, true); return; }
        A.user = res.user; A.openAccount(res.message, true);
        if (typeof refresh === 'function') refresh(true);
      }).catch(function (e) { setBusy(btn, false); toast(e.message, true); });
    };

    $('p-pw').onclick = function () {
      var btn = this;
      var args = { password: $('p-new').value };
      if ($('p-cur')) args.current = $('p-cur').value;
      setBusy(btn, true, 'Saving…');
      API.call('auth.password', args).then(function (res) {
        if (!res.ok) { setBusy(btn, false); toast(res.error, true); return; }
        A.user = res.user; A.openAccount(res.message, true);
      }).catch(function (e) { setBusy(btn, false); toast(e.message, true); });
    };

    Array.prototype.forEach.call(body.querySelectorAll('[data-rmemail]'), function (b) {
      b.onclick = function () {
        var e = b.getAttribute('data-rmemail');
        if (!confirm('Stop using ' + e + ' to sign in?')) return;
        API.call('auth.removeEmail', { email: e }).then(function (res) {
          if (!res.ok) { toast(res.error, true); return; }
          A.user = res.user; A.openAccount(res.message, true);
        }).catch(function (err) { toast(err.message, true); });
      };
    });

    renderGoogle('gLink', function (idToken) {
      API.call('auth.linkGoogle', { idToken: idToken }).then(function (res) {
        if (!res.ok) { toast(res.error, true); return; }
        A.user = res.user; A.openAccount(res.message, true);
      }).catch(function (err) { toast(err.message, true); });
    }, 'continue_with');

    $('p-out').onclick = A.signOut;
    $('p-outall').onclick = function () {
      if (!confirm('Sign out on every phone and computer, including this one?')) return;
      API.call('auth.signOutAll').then(function () { A.signOut(); }).catch(function () { A.signOut(); });
    };

    openModal();
  };

  /* =====================================================================
     ADMIN — account list under More
     ===================================================================== */
  A.renderAdmin = function (boxId) {
    var box = $(boxId);
    if (!box) return;
    API.call('admin.users').then(function (res) {
      if (!res.ok) { box.innerHTML = '<div class="empty">' + esc(res.error) + '</div>'; return; }
      var me = A.user || {};
      box.innerHTML = res.users.map(function (u) {
        var self = u.id === me.id;
        var methods = [];
        if (u.emails.length) methods.push(u.emails.join(', '));
        if (u.phone) methods.push(u.phone);
        return '<div class="acct-row">' +
          '<div class="avatar">' + esc(initials(u.name)) + '</div>' +
          '<div class="grow" style="min-width:0">' +
            '<div style="font-weight:650">' + esc(u.name) +
              (u.role === 'admin' ? ' <span class="tag acc">admin</span>' : '') +
              (self ? ' <span class="tag good">you</span>' : '') + '</div>' +
            '<div class="tiny muted trunc">' + esc(u.rater ? 'Column: ' + u.rater : 'No column yet') +
              ' · ' + (u.lastLogin ? 'last in ' + esc(u.lastLogin) : 'never signed in') +
              (u.hasPassword ? ' · has password' : '') + '</div>' +
            '<div class="tiny muted trunc">' + esc(methods.join(' · ')) + '</div>' +
          '</div>' +
          (self ? '' :
            '<div class="acct-actions">' +
              (u.rater ? '<button class="btn sm" data-act="unlink" data-id="' + esc(u.id) + '" data-name="' + esc(u.name) + '">Unlink</button>' : '') +
              '<button class="btn sm" data-act="reset" data-id="' + esc(u.id) + '" data-name="' + esc(u.name) + '">Reset password</button>' +
              '<button class="btn sm" data-act="role" data-role="' + (u.role === 'admin' ? 'member' : 'admin') + '" data-id="' + esc(u.id) + '" data-name="' + esc(u.name) + '">' +
                (u.role === 'admin' ? 'Make member' : 'Make admin') + '</button>' +
              '<button class="btn sm danger" data-act="delete" data-id="' + esc(u.id) + '" data-name="' + esc(u.name) + '">Remove</button>' +
            '</div>') +
          '</div>';
      }).join('') +
      (res.claimable.length
        ? '<div class="acct-row tiny muted">Columns anyone can claim right now: ' + esc(res.claimable.join(', ')) + '</div>'
        : '');

      Array.prototype.forEach.call(box.querySelectorAll('[data-act]'), function (b) {
        b.onclick = function () {
          var act = b.getAttribute('data-act'), id = b.getAttribute('data-id'), name = b.getAttribute('data-name');
          var call, ask;
          if (act === 'unlink') { ask = 'Unlink ' + name + ' from their column? Their ratings stay; the column becomes claimable again.'; call = ['admin.unlink', { id: id }]; }
          if (act === 'reset') { ask = 'Give ' + name + ' a temporary password? It also signs them out everywhere.'; call = ['admin.resetPassword', { id: id }]; }
          if (act === 'role') { ask = null; call = ['admin.setRole', { id: id, role: b.getAttribute('data-role') }]; }
          if (act === 'delete') { ask = 'Remove ' + name + '\'s account? Their ratings stay in the sheet.'; call = ['admin.deleteUser', { id: id }]; }
          if (ask && !confirm(ask)) return;
          API.call(call[0], call[1]).then(function (res) {
            if (!res.ok) { toast(res.error, true); return; }
            if (res.tempPassword) prompt('Temporary password for ' + name + ' — send it to them:', res.tempPassword);
            else toast(res.message);
            // refresh() re-renders this list too (hydrate → renderAdmin)
            if (typeof refresh === 'function') refresh(true); else A.renderAdmin(boxId);
          }).catch(function (e) { toast(e.message, true); });
        };
      });
    }).catch(function (e) {
      if (!(e && e.auth)) box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    });
  };

  return A;
})();

document.addEventListener('DOMContentLoaded', function () { Auth.start(); });
