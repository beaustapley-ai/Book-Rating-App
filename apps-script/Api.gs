/**
 * ============================================================================
 *  BOOK LIST APP  —  JSON API for the GitHub Pages site
 * ============================================================================
 *  The page on GitHub posts  { action, args: [...], token }  as text/plain
 *  (text/plain keeps the browser from sending a CORS preflight, which Apps
 *  Script can't answer). Every response is JSON.
 *
 *  Deploy as a Web app:  Execute as = Me,  Who has access = Anyone.
 *  "Anyone" is safe because nothing below runs without a valid session token,
 *  apart from the three sign-in actions.
 *
 *  The permission rules live here, not in the page:
 *    • any signed-in person can read everything and add / edit books
 *    • rating, read and ranking writes always go to YOUR rater columns —
 *      whatever "person" the page sends is ignored and replaced
 *    • deleting a book is admin-only once someone else has scored it
 *    • the Import tab and account management are admin-only
 * ============================================================================
 */

function doGet() {
  return json_({ ok: true, app: CONFIG.APP_TITLE + ' API',
    note: 'This is the data service. Open the GitHub Pages site to use the app.' });
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = String(req.action || '');
    var args = Array.isArray(req.args) ? req.args : [];
    var R = routes_();

    if (R.pub[action]) {
      out = R.pub[action](args[0] || {});
    } else if (R.user[action] || R.admin[action]) {
      var ctx = verifyToken_(req.token);
      if (!ctx) {
        out = { ok: false, auth: false, error: 'Please sign in again.' };
      } else if (R.admin[action]) {
        if (ctx.user.role !== 'admin') throw new Error('Only an admin can do that.');
        out = R.admin[action](ctx, args[0] || {});
      } else {
        out = R.user[action](ctx, args);
      }
    } else {
      out = { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return json_(out);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ---------------------------------------------------------------------------
// ROUTES
//   Built inside a function: Apps Script loads files one after another, so a
//   top-level table could run before Auth.gs / Code.gs have defined these.
// ---------------------------------------------------------------------------
function routes_() {
  return { pub: API_PUBLIC_(), user: API_USER_(), admin: API_ADMIN_() };
}

function API_PUBLIC_() { return {
  'auth.google': authGoogle_,
  'auth.login': authLogin_,
  'auth.signup': authSignup_
}; }

// Handlers get (ctx, argsArray). ctx = { user, claims }.
function API_USER_() { return {
  'auth.me': function (ctx) { return authMe_(ctx); },
  'auth.claim': function (ctx, a) { return authClaim_(ctx, a[0] || {}); },
  'auth.profile': function (ctx, a) { return authProfile_(ctx, a[0] || {}); },
  'auth.password': function (ctx, a) { return authPassword_(ctx, a[0] || {}); },
  'auth.linkGoogle': function (ctx, a) { return authLinkGoogle_(ctx, a[0] || {}); },
  'auth.removeEmail': function (ctx, a) { return authRemoveEmail_(ctx, a[0] || {}); },
  'auth.signOutAll': function (ctx) { return authSignOutAll_(ctx); },

  getData: apiGetData_,

  // Your own columns only — "person" is always overwritten with your rater.
  saveRatings: function (ctx, a) { return saveRatings(asMe_(ctx, a[0])); },
  saveRankOrder: function (ctx, a) { return saveRankOrder(asMe_(ctx, a[0])); },
  setRead: function (ctx, a) { return setRead(asMe_(ctx, a[0])); },

  // Shared book details — anyone signed in.
  addBook: function (ctx, a) { return addBook(a[0] || {}); },
  updateBook: function (ctx, a) { return updateBook(a[0] || {}); },
  renameSeries: function (ctx, a) { return renameSeries(a[0], a[1]); },
  previewImport: function (ctx, a) { return previewImport(a[0] || []); },
  commitImport: function (ctx, a) { return commitImport(a[0] || []); },
  parseDelimited: function (ctx, a) { return parseDelimited(a[0] || ''); },

  deleteBook: apiDeleteBook_,
  renamePerson: apiRenamePerson_,

  // The Import tab lives in the sheet, which only the owner can open.
  readImportTab: function (ctx) { needAdmin_(ctx); return readImportTab(); },
  clearImportTab: function (ctx) { needAdmin_(ctx); return clearImportTab(); }
}; }

function API_ADMIN_() { return {
  'admin.users': function () { return adminUsers_(); },
  'admin.unlink': adminUnlink_,
  'admin.resetPassword': adminResetPassword_,
  'admin.setRole': adminSetRole_,
  'admin.deleteUser': adminDeleteUser_
}; }


// ---------------------------------------------------------------------------
// GUARDS
// ---------------------------------------------------------------------------
function asMe_(ctx, payload) {
  if (!ctx.user.rater) throw new Error('Pick your name first — open Account and choose who you are.');
  payload = payload || {};
  payload.person = ctx.user.rater;
  return payload;
}

function needAdmin_(ctx) {
  if (ctx.user.role !== 'admin') throw new Error('Only an admin can do that.');
}


// ---------------------------------------------------------------------------
// WRAPPED ACTIONS
// ---------------------------------------------------------------------------
function apiGetData_(ctx) {
  var d = getData();
  var users = readUsers_();
  d.me = publicUser_(ctx.user);
  d.isAdmin = ctx.user.role === 'admin';
  // Which account holds each rater column — names only, no contact details.
  d.accounts = users.filter(function (u) { return u.rater; })
    .map(function (u) { return { rater: u.rater, name: u.name, active: !!u.lastLogin }; });
  if (!d.isAdmin) {
    delete d.spreadsheetUrl;     // only the owner can open the sheet anyway
    d.importPending = 0;
  }
  return d;
}

/**
 * Deleting a row deletes everyone's scores on it, so a non-admin may only
 * delete a book nobody else has touched. Series-wide fields (series rating /
 * ranking) are copied onto every row of a series, so they only count when
 * this is the last book left in that series.
 */
function apiDeleteBook_(ctx, a) {
  var row = Number(a[0]);
  if (ctx.user.role !== 'admin') {
    var lay = readLayout_();
    assertRow_(lay, row);
    var vals = lay.sheet.getRange(row, 1, 1, lay.lastCol).getValues()[0];
    var onlyBook = seriesRowsFor_(lay, row).length <= 1;
    var fields = ['Book Ranking', 'Book Rating', 'Overall Ranking', 'Read']
      .concat(onlyBook ? SERIES_LEVEL_PERSON : []);
    lay.people.forEach(function (p) {
      if (key_(p.name) === key_(ctx.user.rater)) return;
      fields.forEach(function (f) {
        var col = p.cols[f];
        if (col && norm_(vals[col - 1]) !== '') {
          throw new Error(p.name + ' has already scored or marked this book, so only an admin can delete it.');
        }
      });
    });
  }
  return deleteBook(row);
}

/** You can rename your own column; an admin can rename anyone's. */
function apiRenamePerson_(ctx, a) {
  var oldName = norm_(a[0]), newName = norm_(a[1]);
  if (key_(oldName) !== key_(ctx.user.rater) && ctx.user.role !== 'admin') {
    throw new Error('You can only rename your own column.');
  }
  if (!newName) throw new Error('Name is required.');
  var clash = readLayout_().people.some(function (p) {
    return key_(p.name) === key_(newName) && key_(p.name) !== key_(oldName);
  });
  if (clash) throw new Error(newName + ' is already on the list.');
  var res = renamePerson(oldName, newName);
  if (res.ok) renameRaterInUsers_(oldName, newName);
  return res;
}
