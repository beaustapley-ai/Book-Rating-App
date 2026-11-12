/* =====================================================================
   Book List — client
   ---------------------------------------------------------------------
   GitHub version. Differences from the Apps Script page:
     • calls go through API.call() (js/api.js) instead of google.script.run
     • S.self is the signed-in person's rater column; S.me is whoever's
       ratings are on screen. When they differ the app is view-only —
       you can look at anyone's stats but only change your own. The server
       enforces this too; the checks here just keep the buttons honest.
     • the app starts from auth.js (startApp) once someone is signed in
   ===================================================================== */

var S = {
  data: null,
  me: null,          // whose ratings are on screen
  self: null,        // the signed-in person's rater name
  user: null,        // the signed-in account
  isAdmin: false,
  started: false,
  grouped: true,
  q: '',
  filters: { genre: '', type: '', finished: '', mine: '' },
  addType: 'Series',
  rankDraft: null,
  importRows: null,
  topTab: 'series',
  radarTab: 'upcoming',
  libraryStale: false,
  topSub: 'mixed',
  expanded: {},      // seriesKey -> true
  sview: {},         // seriesKey -> {order:'num'|'rank'|'rate', who:person}
  busy: 0
};

var FIELDS = {
  SR: 'Series Ranking',
  SRT: 'Series Rating',
  BR: 'Book Ranking',
  BRT: 'Book Rating',
  OR: 'Overall Ranking',
  RD: 'Read'
};

var NEW_VALUE = '__new__';   // sentinel for the "add new…" option in combos

/* ---------- tiny helpers ---------- */
function $(id) { return document.getElementById(id); }
function el(tag, cls, html) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function keyOf(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function initials(n) {
  n = String(n || '?').trim();
  var p = n.split(/\s+/);
  return (p.length > 1 ? p[0][0] + p[1][0] : n.slice(0, 2)).toUpperCase();
}
function fmt(n) {
  if (n === null || n === undefined || n === '') return '—';
  return (Math.round(n * 10) / 10).toString();
}
function avg(arr) {
  var v = arr.filter(function (x) { return typeof x === 'number' && !isNaN(x); });
  if (!v.length) return null;
  return v.reduce(function (a, b) { return a + b; }, 0) / v.length;
}
function has(v) { return v !== null && v !== undefined && v !== ''; }

function toast(msg, isErr) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'on' + (isErr ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(function () { t.className = ''; }, isErr ? 5200 : 2600);
}
function busy(on) {
  S.busy += on ? 1 : -1;
  if (S.busy < 0) S.busy = 0;
  $('saving').className = S.busy > 0 ? 'on' : '';
}

/* =====================================================================
   WHO CAN EDIT WHAT
   ===================================================================== */

/** True when the ratings on screen are your own. */
function canEdit() { return !!S.self && S.me === S.self; }

/** Call before any rating/read write for S.me. Explains why not, if not. */
function guardEdit() {
  if (canEdit()) return true;
  if (!S.self) toast('Choose who you are first — open Account', true);
  else toast('View only — that\'s ' + S.me + '\'s list. Switch back to yours to change it.', true);
  return false;
}

/** Header label, the yellow "view only" strip and a body class for styling. */
function updateViewMode() {
  var viewing = !!S.me && S.me !== S.self;
  $('whoLabel').textContent = viewing ? 'Viewing' : 'Rating as';
  $('viewBanner').hidden = !viewing;
  $('viewBannerText').textContent = viewing
    ? 'Viewing ' + S.me + '\'s ratings — view only'
    : '';
  $('backToMe').style.display = S.self ? '' : 'none';
  document.body.classList.toggle('viewonly', viewing || !S.self);
}

function setViewing(person) {
  S.me = person;
  $('whoSelect').value = S.me;
  $('avatar').textContent = initials(S.me);
  updateViewMode();
  renderLibrary();
  $('rankPerson').value = S.me;
  $('topPerson').value = S.me;
  var v = activeView();
  if (v === 'rank') buildRankList();
  if (v === 'dash') renderDash();
  if (v === 'top') renderTop();
  if (v === 'radar') renderRadar();
}

/**
 * Apply a change on screen first, then write it. Apps Script round trips run
 * one to several seconds, and there is no reason to stare at the old value
 * while that happens. If the write fails the change is put back and you're
 * told — so the screen never quietly disagrees with the sheet.
 */
function optimistic(opts) {
  opts.apply();
  afterDataChange();
  busy(true);
  return opts.run()
    .then(function (res) {
      busy(false);
      if (!res || !res.ok) {
        opts.revert();
        afterDataChange();
        toast((res && res.error) || "Couldn't save — change undone", true);
        return false;
      }
      if (opts.msg) toast(opts.msg);
      return true;
    })
    .catch(function (e) {
      busy(false);
      opts.revert();
      afterDataChange();
      toast((e && e.message) || "Couldn't save — change undone", true);
      return false;
    });
}

/**
 * Repaints whatever is actually visible. The library is the expensive one
 * (every series, every book), so while a modal covers it we mark it stale and
 * redraw once on close.
 */
function afterDataChange() {
  readCache = null;
  var scrim = $('scrim');
  if (scrim && String(scrim.className).indexOf('on') !== -1) S.libraryStale = true;
  else renderLibrary();
  var v = activeView();
  if (v === 'top') renderTop();
  if (v === 'radar') renderRadar();
  updateRadarBadge();
}

/** Same shape as the old google.script.run wrappers, now over fetch. */
function call(fn, arg) {
  var p = arg === undefined ? API.call(fn) : API.call(fn, arg);
  return p.then(function (res) {
    if (fn === 'getData' && (!res || res.ok === false)) {
      throw new Error((res && res.error) || 'Could not load the spreadsheet.');
    }
    return res;
  });
}
function call2(fn, a, b) { return API.call(fn, a, b); }

function store(k, v) {
  var key = (window.CONFIG && CONFIG.STORAGE_PREFIX || 'booklist_') + k;
  try {
    if (v === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, v);
  } catch (e) { /* private mode — fine */ }
  return null;
}

/* =====================================================================
   READ / NOT READ
   ---------------------------------------------------------------------
   A blank book rating inside a series does NOT mean unread — it means the
   book wasn't worth scoring individually. Reading is judged at the series
   level: any series rating, series ranking, or any score on any book in it
   means that person has read the series. Standalone books stand alone.
   ===================================================================== */
var readCache = null;

/** Per person: which series have any score at all recorded against them. */
function buildReadCache() {
  readCache = {};
  (S.data.people || []).forEach(function (p) { readCache[p] = {}; });
  S.data.books.forEach(function (b) {
    if (!b.series || b.type === 'Standalone') return;
    var k = keyOf(b.series);
    (S.data.people || []).forEach(function (p) {
      if (readCache[p][k]) return;
      var r = b.ratings[p] || {};
      if (has(r[FIELDS.SRT]) || has(r[FIELDS.SR]) || has(r[FIELDS.BRT]) || has(r[FIELDS.BR])) {
        readCache[p][k] = true;
      }
    });
  });
}

function seriesHasScores(seriesName, person) {
  if (!readCache) buildReadCache();
  return !!(readCache[person] && readCache[person][keyOf(seriesName)]);
}

/**
 * Has `person` read this book?
 *   explicit Read = Yes/No  → that, full stop
 *   otherwise, standalone   → any book rating or overall ranking
 *   otherwise, in a series  → has anything been scored anywhere in the series
 */
function readBook(book, person) {
  var r = book.ratings[person] || {};
  if (r[FIELDS.RD] === 'Yes') return true;
  if (r[FIELDS.RD] === 'No') return false;
  if (book.series && book.type !== 'Standalone') return seriesHasScores(book.series, person);
  return has(r[FIELDS.BRT]) || has(r[FIELDS.OR]);
}

/** True when the Yes/No was typed rather than worked out. */
function readIsExplicit(book, person) {
  var r = book.ratings[person] || {};
  return r[FIELDS.RD] === 'Yes' || r[FIELDS.RD] === 'No';
}

/** A series counts as read if any of its books do. */
function readSeries(seriesName, person) {
  return booksOfSeries(seriesName).some(function (b) { return readBook(b, person); });
}

function booksOfSeries(seriesName) {
  var k = keyOf(seriesName);
  return S.data.books.filter(function (b) { return keyOf(b.series) === k; });
}

function readCount(seriesName, person) {
  return booksOfSeries(seriesName).filter(function (b) { return readBook(b, person); }).length;
}

/* =====================================================================
   NARRATORS
   ---------------------------------------------------------------------
   A dual or full-cast recording is one cell — "Michael Kramer & Kate
   Reading" — so the credit is split before anyone is counted, and a book
   with two readers counts once for each of them. The split has to agree
   with splitNarrators_() in Code.gs or the roster and the tap-through
   would disagree about who exists.
   ===================================================================== */
function narratorsOf(b) {
  return String(b && b.narrator || '').split(/\s*(?:&|,|\band\b)\s*/i)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

/** Does this book credit that narrator, among however many it lists? */
function narratedBy(b, name) {
  var k = keyOf(name);
  return narratorsOf(b).some(function (n) { return keyOf(n) === k; });
}

function booksByNarrator(name) {
  return S.data.books.filter(function (b) { return narratedBy(b, name); });
}

/**
 * The narrator credit used most often in a series, as a suggestion when adding
 * the next book. Whole cells are compared, not split names, so a dual-narrated
 * series suggests the pair rather than one half of it. A series with no clear
 * majority — one that changed reader partway — suggests nothing rather than
 * guessing between them.
 */
function commonNarrator(seriesName) {
  var count = {}, label = {}, best = '', bestN = 0, tied = false;
  booksOfSeries(seriesName).forEach(function (b) {
    var v = String(b.narrator || '').trim();
    if (!v) return;
    var k = keyOf(v);
    label[k] = v;
    count[k] = (count[k] || 0) + 1;
    if (count[k] > bestN) { bestN = count[k]; best = k; tied = false; }
    else if (count[k] === bestN && k !== best) tied = true;
  });
  return tied ? '' : (label[best] || '');
}

/**
 * Every narrator, with how many of their books are in the list and how many
 * the given person has read. Sorted by books read, then by total.
 */
function narratorTally(person) {
  var map = {};
  S.data.books.forEach(function (b) {
    narratorsOf(b).forEach(function (nm) {
      var k = keyOf(nm);
      if (!map[k]) map[k] = { name: nm, of: 0, read: 0 };
      map[k].of++;
      if (person && readBook(b, person)) map[k].read++;
    });
  });
  return Object.keys(map).map(function (k) { return map[k]; })
    .sort(function (a, b) {
      // Books read is the headline. Ties break alphabetically rather than by
      // how many of their books happen to be in the list, which says nothing
      // about how much you've listened to them.
      return b.read - a.read || a.name.localeCompare(b.name);
    });
}

/* Dates arrive as "2020-10-02" or free text; show the year where space is tight. */
function yearOf(v) {
  var m = /(\d{4})/.exec(String(v || ''));
  return m ? m[1] : '';
}

var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var FULL_MONTHS = ['January','February','March','April','May','June','July','August',
  'September','October','November','December'];

/**
 * Parses whatever is in a date cell.
 * Returns {d: Date, p: 'day'|'month'|'year'} or null.
 * A part-known date resolves to the earliest day it could be, and `p` records
 * how much we actually know, so the UI doesn't show a day countdown to "2027".
 */
function parseRel(v) {
  if (v instanceof Date) return { d: new Date(v.getFullYear(), v.getMonth(), v.getDate()), p: 'day' };
  var str = String(v === null || v === undefined ? '' : v).trim();
  if (!str) return null;

  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str);
  if (m) return { d: new Date(+m[1], +m[2] - 1, +m[3]), p: 'day' };
  m = /^(\d{4})-(\d{1,2})$/.exec(str);
  if (m) return { d: new Date(+m[1], +m[2] - 1, 1), p: 'month' };
  m = /^(\d{4})$/.exec(str);
  if (m) return { d: new Date(+m[1], 0, 1), p: 'year' };

  // Date.parse will happily invent a day out of "Late October 2027 maybe", so
  // only hand it strings that are already unambiguously a single date.
  var CLEAN_DATE = /^(?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}\/\d{1,2}\/\d{1,2})$/;
  if (CLEAN_DATE.test(str)) {
    var t = Date.parse(str);
    if (!isNaN(t)) {
      var dt = new Date(t);
      return { d: new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()), p: 'day' };
    }
  }

  // Otherwise pull out whatever month and year the text does contain.
  var y = /(\d{4})/.exec(str);
  if (y) {
    var mon = -1;
    MONTHS.forEach(function (abbr, i) {
      // \b on both sides, so "maybe" doesn't read as May
      if (new RegExp('\\b(' + abbr + '|' + FULL_MONTHS[i] + ')\\b', 'i').test(str)) mon = i;
    });
    return mon >= 0
      ? { d: new Date(+y[1], mon, 1), p: 'month' }
      : { d: new Date(+y[1], 0, 1), p: 'year' };
  }
  return null;
}

function todayMid() {
  var n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
function daysFromToday(d) {
  return Math.round((d.getTime() - todayMid().getTime()) / 86400000);
}
function prettyDate(rel) {
  if (!rel) return '';
  if (rel.p === 'day') return MONTHS[rel.d.getMonth()] + ' ' + rel.d.getDate() + ', ' + rel.d.getFullYear();
  if (rel.p === 'month') return MONTHS[rel.d.getMonth()] + ' ' + rel.d.getFullYear();
  return String(rel.d.getFullYear());
}

/**
 * Has `person` read every book in this series that is actually out?
 * Undated books count as released — they're almost all backlist.
 */
function caughtUpOn(seriesName, person) {
  var out = booksOfSeries(seriesName).filter(function (b) {
    var rel = parseRel(b.released);
    return !rel || rel.d <= todayMid();
  });
  if (!out.length) return false;
  return out.every(function (b) { return readBook(b, person); });
}

/* =====================================================================
   BOOT
   ===================================================================== */

/** Called by auth.js once someone is signed in and linked to a rater. */
function startApp(user) {
  S.user = user;
  S.self = user && user.rater ? user.rater : null;
  S.isAdmin = !!(user && user.role === 'admin');
  if (S.started) { refresh(true); return; }
  S.started = true;
  boot();
}

function boot() {
  busy(true);
  call('getData').then(function (d) {
    busy(false);
    applyData(d);
    S.me = S.self && d.people.indexOf(S.self) !== -1 ? S.self : (d.people[0] || null);
    if (!d.people.length) {
      $('libraryList').innerHTML = '<div class="empty">No rater columns found in the sheet.</div>';
    }
    hydrate();
  }).catch(function (e) {
    busy(false);
    if (e && e.auth) return;            // auth.js is already showing the sign-in screen
    $('libraryList').innerHTML =
      '<div class="empty">Could not load the spreadsheet.<br><span class="tiny">' +
      esc(e && e.message || e) + '</span></div>';
    toast('Load failed', true);
  });
}

/** Takes in a getData payload, including who the server says you are. */
function applyData(d) {
  S.data = d;
  readCache = null;
  if (d.me) {
    S.user = d.me;
    S.self = d.me.rater || null;
    S.isAdmin = d.me.role === 'admin';
    if (window.Auth) Auth.user = d.me;
  }
}

function hydrate() {
  readCache = null;
  buildWhoSelect();
  updateViewMode();
  buildFilterChips();
  buildCombos();
  renderLibrary();
  renderPeople();
  renderAccountCard();
  renderSheetInfo();
  buildRankControls();
  buildTopControls();
  updateRadarBadge();
  updateImportTabStatus();
  if (S.isAdmin && window.Auth) Auth.renderAdmin('adminList');
  $('adminWrap').hidden = !S.isAdmin;
}

function refresh(silent) {
  if (!silent) busy(true);
  return call('getData').then(function (d) {
    if (!silent) busy(false);
    applyData(d);
    if (!S.me || d.people.indexOf(S.me) === -1) S.me = S.self || d.people[0] || null;
    hydrate();
    var v = activeView();
    if (v === 'dash') renderDash();
    if (v === 'rank') buildRankList();
    if (v === 'top') renderTop();
    if (v === 'radar') renderRadar();
  }).catch(function (e) {
    if (!silent) busy(false);
    if (e && e.auth) return;
    toast('Refresh failed', true);
  });
}

/* =====================================================================
   NAV
   ===================================================================== */
function activeView() {
  var v = document.querySelector('.view.active');
  return v ? v.id.replace('view-', '') : 'library';
}
function go(name) {
  ['library', 'radar', 'top', 'dash', 'rank', 'add', 'more'].forEach(function (n) {
    var v = $('view-' + n);
    if (v) v.className = 'view' + (n === name ? ' active' : '');
  });
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {
    b.className = b.getAttribute('data-go') === name ? 'active' : '';
  });
  $('fab').className = name === 'library' ? 'fab on' : 'fab';
  window.scrollTo(0, 0);
  if (name === 'dash') renderDash();
  if (name === 'rank') buildRankList();
  if (name === 'top') renderTop();
  if (name === 'radar') renderRadar();
}

function buildWhoSelect() {
  var sel = $('whoSelect');
  sel.innerHTML = '';
  (S.data.people || []).forEach(function (p) {
    var o = el('option'); o.value = p;
    o.textContent = p + (p === S.self ? ' (you)' : '');
    sel.appendChild(o);
  });
  if (S.me) sel.value = S.me;
  $('avatar').textContent = initials(S.me);
}

/* =====================================================================
   LIBRARY
   ===================================================================== */
function buildFilterChips() {
  var box = $('filterChips');
  box.innerHTML = '';
  var chips = [
    { k: 'mine', v: 'unread', label: "Haven't read" },
    { k: 'mine', v: 'read', label: 'Read' },
    { k: 'mine', v: 'unscored', label: 'Read, not scored' },
    { k: 'type', v: 'Series', label: 'Series' },
    { k: 'type', v: 'Standalone', label: 'Standalone' },
    { k: 'finished', v: 'Yes', label: 'Complete' },
    { k: 'finished', v: 'No', label: 'Ongoing' }
  ];
  (S.data.genres || []).forEach(function (g) { chips.push({ k: 'genre', v: g, label: g }); });

  chips.forEach(function (c) {
    var b = el('button', 'chip' + (S.filters[c.k] === c.v ? ' on' : ''), esc(c.label));
    b.onclick = function () {
      S.filters[c.k] = (S.filters[c.k] === c.v) ? '' : c.v;
      buildFilterChips();
      renderLibrary();
    };
    box.appendChild(b);
  });
}

function myR(book, field) {
  if (!S.me) return null;
  var r = book.ratings && book.ratings[S.me];
  return r ? r[field] : null;
}

function passesFilter(b) {
  var f = S.filters;
  if (f.genre && keyOf(b.genre) !== keyOf(f.genre)) return false;
  if (f.type && b.type !== f.type) return false;
  if (f.finished && keyOf(b.finished) !== keyOf(f.finished)) return false;
  if (f.mine && S.me) {
    var isRead = readBook(b, S.me);
    if (f.mine === 'read' && !isRead) return false;
    if (f.mine === 'unread' && isRead) return false;
    if (f.mine === 'unscored' && (!isRead || has(myR(b, FIELDS.BRT)))) return false;
  }
  if (S.q) {
    var hay = (b.title + ' ' + b.series + ' ' + b.author + ' ' +
      b.narrator + ' ' + b.genre).toLowerCase();
    var terms = S.q.toLowerCase().split(/\s+/).filter(Boolean);
    for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) === -1) return false;
  }
  return true;
}

/**
 * value === null + hasRead     → "–"   (read it, never scored it)
 * value === null + !hasRead    → "··"  (dashed outline: hasn't read it)
 */
function scorePill(person, value, hasRead, what) {
  if (has(value)) {
    return '<span class="score" title="' + esc(person + "'s " + what) + '"><i>' +
      esc(initials(person)) + '</i><b>' + esc(fmt(value)) + '</b></span>';
  }
  if (hasRead) {
    return '<span class="score n0" title="' + esc(person + ' has read this but not scored it') +
      '"><i>' + esc(initials(person)) + '</i><b>–</b></span>';
  }
  return '<span class="score unread" title="' + esc(person + " hasn't read this") + '"><i>' +
    esc(initials(person)) + '</i><b>··</b></span>';
}

function renderLibrary() {
  if (!S.data) return;
  var list = $('libraryList');
  var books = S.data.books.filter(passesFilter);
  var sort = $('sortBy').value;

  $('libraryCount').textContent = books.length + ' of ' + S.data.books.length + ' books' +
    (S.filters.genre || S.filters.type || S.filters.finished || S.filters.mine || S.q ? ' · filtered' : '');

  if (!books.length) {
    list.innerHTML = '<div class="empty">Nothing matches those filters.</div>';
    return;
  }

  list.innerHTML = '';
  if (!S.grouped) { renderFlat(list, books, sort); return; }

  var groups = [], byKey = {};
  books.forEach(function (b) {
    var k = (b.type === 'Standalone' || !b.series) ? '__standalone__' : keyOf(b.series);
    if (!byKey[k]) {
      byKey[k] = { key: k, name: k === '__standalone__' ? 'Standalone books' : b.series,
        standalone: k === '__standalone__', books: [] };
      groups.push(byKey[k]);
    }
    byKey[k].books.push(b);
  });

  groups.forEach(function (g) {
    var first = g.books[0];
    g.author = first.author; g.genre = first.genre;
    g.finished = first.finished; g.nextRelease = first.nextRelease;
    g.srank = g.standalone ? null : (first.ratings[S.me] || {})[FIELDS.SR];
    g.srating = g.standalone ? null : (first.ratings[S.me] || {})[FIELDS.SRT];
    g.avgBook = avg(g.books.map(function (b) { return myR(b, FIELDS.BRT); }));
    g.books.sort(function (a, b) { return numish(a.bookNum) - numish(b.bookNum); });
  });

  sortGroups(groups, sort);
  groups.forEach(function (g) { list.appendChild(seriesNode(g)); });
}

function numish(v) { var n = parseFloat(v); return isNaN(n) ? 9999 : n; }
function nullLast(v) { return has(v) ? v : Infinity; }
function nullLastDesc(v) { return has(v) ? v : -Infinity; }

function sortGroups(groups, sort) {
  if (sort === 'seriesRank') {
    groups.sort(function (a, b) { return nullLast(a.srank) - nullLast(b.srank) || a.name.localeCompare(b.name); });
  } else if (sort === 'seriesRating') {
    groups.sort(function (a, b) { return nullLastDesc(b.srating) - nullLastDesc(a.srating) || a.name.localeCompare(b.name); });
  } else if (sort === 'bookRating') {
    groups.sort(function (a, b) { return nullLastDesc(b.avgBook) - nullLastDesc(a.avgBook) || a.name.localeCompare(b.name); });
  } else if (sort === 'overallRank') {
    groups.forEach(function (g) {
      g._best = Math.min.apply(null, g.books.map(function (b) { return nullLast(myR(b, FIELDS.OR)); }));
    });
    groups.sort(function (a, b) { return a._best - b._best || a.name.localeCompare(b.name); });
  } else if (sort === 'released') {
    groups.forEach(function (g) {
      g._newest = g.books.map(function (b) { return String(b.released || ''); }).sort().pop() || '';
    });
    groups.sort(function (a, b) { return String(b._newest).localeCompare(String(a._newest)); });
  } else if (sort === 'title' || sort === 'author') {
    groups.sort(function (a, b) {
      var av = sort === 'title' ? a.name : (a.author || 'zzz');
      var bv = sort === 'title' ? b.name : (b.author || 'zzz');
      return av.localeCompare(bv);
    });
  }
  groups.sort(function (a, b) { return (a.standalone ? 1 : 0) - (b.standalone ? 1 : 0); });
}

function seriesNode(g) {
  var node = el('div', 'series');
  node.setAttribute('data-key', g.key);
  var hd = el('div', 'series-hd');

  hd.appendChild(el('div', 'caret',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>'));

  var main = el('div', 'grow');
  main.innerHTML =
    '<div class="row" style="gap:7px;align-items:baseline">' +
      (g.srank ? '<span class="rank">#' + esc(g.srank) + '</span>' : '') +
      '<span class="series-name">' + esc(g.name) + '</span></div>';

  var bits = [];
  if (!g.standalone) bits.push(g.books.length + ' book' + (g.books.length === 1 ? '' : 's'));
  if (g.author && !g.standalone) bits.push(esc(g.author));
  if (g.genre) bits.push(esc(g.genre));
  main.innerHTML += '<div class="series-meta">' + bits.join(' · ') + '</div>';

  var tags = el('div', 'wrapflex series-scores');
  if (!g.standalone) {
    if (keyOf(g.finished) === 'yes') tags.appendChild(el('span', 'tag good', 'Complete'));
    else if (keyOf(g.finished) === 'no') tags.appendChild(el('span', 'tag warn', 'Ongoing'));
    if (g.nextRelease) tags.appendChild(el('span', 'tag', 'Next: ' + esc(g.nextRelease)));
    (S.data.people || []).forEach(function (p) {
      var t = el('span');
      t.innerHTML = scorePill(p, (g.books[0].ratings[p] || {})[FIELDS.SRT], readSeries(g.name, p), 'series rating');
      tags.appendChild(t.firstChild);
    });
  }
  main.appendChild(tags);
  hd.appendChild(main);
  node.appendChild(hd);

  var body = el('div', 'books');
  node.appendChild(body);

  hd.onclick = function () {
    var open = node.className.indexOf('open') !== -1;
    if (open) { node.className = 'series'; delete S.expanded[g.key]; }
    else { node.className = 'series open'; S.expanded[g.key] = true; paintSeriesBody(node, g); }
  };

  if (S.expanded[g.key] || S.q || g.standalone) {
    node.className = 'series open';
    S.expanded[g.key] = true;
    paintSeriesBody(node, g);
  }
  return node;
}

/** Everything that used to live in the series modal, rendered in place. */
function paintSeriesBody(node, g) {
  var body = node.querySelector('.books');
  body.innerHTML = '';

  if (!g.standalone) {
    var st = sview(g.key);
    var strip = el('div', 'sview');

    var seg = el('div', 'seg');
    [['num', '# Book order'], ['rank', 'Ranking'], ['rate', 'Rating']].forEach(function (o) {
      var b = el('button', st.order === o[0] ? 'on' : '', o[1]);
      b.onclick = function (e) {
        e.stopPropagation();
        st.order = o[0];
        paintSeriesBody(node, g);
      };
      seg.appendChild(b);
    });
    strip.appendChild(seg);

    if ((S.data.people || []).length > 1) {
      var who = el('select');
      (S.data.people || []).forEach(function (p) {
        var o = el('option'); o.value = p; o.textContent = p; who.appendChild(o);
      });
      who.value = st.who;
      who.onclick = function (e) { e.stopPropagation(); };
      who.onchange = function () { st.who = who.value; paintSeriesBody(node, g); };
      strip.appendChild(who);
    }

    if (canEdit()) {
      var mark = el('button', 'btn sm', 'Mark read…');
      mark.style.marginLeft = 'auto';
      mark.onclick = function (e) { e.stopPropagation(); markReadFlow(g); };
      strip.appendChild(mark);
    }
    body.appendChild(strip);

    var line = el('div', 'readline');
    line.innerHTML = (S.data.people || []).map(function (p) {
      var n = readCount(g.name, p);
      return '<b>' + esc(p) + '</b> ' + (n ? n + '/' + g.books.length + ' read' : 'not read');
    }).join(' · ');
    body.appendChild(line);
  }

  var st2 = g.standalone ? null : sview(g.key);
  var byRank = !!st2 && st2.order === 'rank';
  var mine = !!st2 && !!S.self && st2.who === S.self;

  if (byRank && !g.standalone) {
    var hint = el('div', 'sortnote');
    hint.textContent = mine
      ? 'Drag the handle to set your order for ' + g.name + '.'
      : 'Showing ' + st2.who + "'s order — view only." +
        (S.self ? ' Switch the name to ' + S.self + ' to drag your own.' : '');
    body.appendChild(hint);
  }

  var ordered = orderedBooks(g);
  ordered.forEach(function (b, i) {
    body.appendChild(bookNode(b, g.standalone, g.standalone ? 0 : i + 1, byRank && mine));
  });

  if (byRank && mine && ordered.length > 1) {
    makeSortable(body, function (ids) {
      commitOrder(FIELDS.BR, st2.who, ids.map(Number),
        'Reordered ' + g.name).then(function (ok2) {
          if (ok2) paintSeriesBody(node, g);
        });
    });
  }
}

function sview(key) {
  if (!S.sview[key]) S.sview[key] = { order: 'num', who: S.me };
  var st = S.sview[key];
  if (!st.who || (S.data.people || []).indexOf(st.who) === -1) st.who = S.me;
  return st;
}

function orderedBooks(g) {
  var arr = g.books.slice();
  if (g.standalone) return arr;
  var st = sview(g.key);
  if (st.order === 'rank') {
    arr.sort(function (a, b) {
      return nullLast((a.ratings[st.who] || {})[FIELDS.BR]) - nullLast((b.ratings[st.who] || {})[FIELDS.BR]) ||
        numish(a.bookNum) - numish(b.bookNum);
    });
  } else if (st.order === 'rate') {
    arr.sort(function (a, b) {
      return nullLastDesc((b.ratings[st.who] || {})[FIELDS.BRT]) - nullLastDesc((a.ratings[st.who] || {})[FIELDS.BRT]) ||
        numish(a.bookNum) - numish(b.bookNum);
    });
  } else {
    arr.sort(function (a, b) { return numish(a.bookNum) - numish(b.bookNum); });
  }
  return arr;
}

/**
 * pos > 0 draws a position badge (only meaningful when not in book order).
 * draggable adds the grip and marks the row for makeSortable.
 */
function bookNode(b, standalone, pos, draggable) {
  var n = el('div', 'book');
  var st = standalone ? null : sview(keyOf(b.series));
  var showPos = pos && st && st.order !== 'num';

  if (draggable) {
    n.setAttribute('data-sortid', String(b.row));
    var grip = el('span');
    grip.innerHTML = gripHtml();
    n.appendChild(grip.firstChild);
  }

  var tog = el('button', 'rtog', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>');
  var isRead = S.me ? readBook(b, S.me) : false;
  tog.className = 'rtog' + (isRead ? (readIsExplicit(b, S.me) ? ' on' : ' inferred') : '');
  tog.title = !S.me ? '' : (isRead
    ? (readIsExplicit(b, S.me) ? S.me + ' has read this' : 'Counted as read — nothing recorded against this book specifically')
    : S.me + " hasn't read this");
  tog.onclick = function (e) { e.stopPropagation(); toggleRead(b); };
  n.appendChild(tog);

  if (showPos) n.appendChild(el('div', 'ord-pos', String(pos)));
  n.appendChild(el('div', 'booknum', esc(standalone ? '•' : (b.bookNum === '' ? '?' : b.bookNum))));

  var mid = el('div', 'grow');
  var sub = [];
  if (standalone && b.author) sub.push(esc(b.author));
  if (b.released) sub.push(esc(yearOf(b.released) || b.released));
  if (myR(b, FIELDS.BR)) sub.push('#' + myR(b, FIELDS.BR) + ' in series');
  if (myR(b, FIELDS.OR)) sub.push('#' + myR(b, FIELDS.OR) + ' overall');
  var chips = narratorChips(b);
  if (chips) sub.push(chips);
  mid.innerHTML = '<div class="book-title trunc">' + esc(b.title) + '</div>' +
    (sub.length ? '<div class="book-sub trunc">' + sub.join(' · ') + '</div>' : '');
  n.appendChild(mid);
  bindNarrators(mid);

  var pills = el('div', 'row');
  pills.style.gap = '4px';
  (S.data.people || []).forEach(function (p) {
    var t = el('span');
    t.innerHTML = scorePill(p, (b.ratings[p] || {})[FIELDS.BRT], readBook(b, p), 'book rating');
    pills.appendChild(t.firstChild);
  });
  n.appendChild(pills);

  n.onclick = function (e) { e.stopPropagation(); openBook(b.row); };
  return n;
}

/** Flips the Read flag for the active person, writing an explicit Yes or No. */
function toggleRead(b) {
  if (!guardEdit()) return;
  var want = readBook(b, S.me) ? 'No' : 'Yes';
  var prev = (b.ratings[S.me] || {})[FIELDS.RD];
  optimistic({
    apply: function () {
      if (!b.ratings[S.me]) b.ratings[S.me] = {};
      b.ratings[S.me][FIELDS.RD] = want;
    },
    revert: function () { b.ratings[S.me][FIELDS.RD] = prev; },
    run: function () { return call('saveRatings', { row: b.row, person: S.me, values: { Read: want } }); },
    msg: want === 'Yes' ? 'Marked read' : 'Marked unread'
  });
}

/** "All read" / "none" / "read through book N" for a whole series at once. */
function markReadFlow(g) {
  if (!guardEdit()) return;
  var answer = prompt(
    'Mark ' + g.name + ' for ' + S.me + '.\n\n' +
    'Type a book number to mark everything up to and including it as read\n' +
    '(the rest get marked unread), or type ALL, or type NONE.',
    '');
  if (answer === null) return;
  answer = String(answer).trim();
  if (!answer) return;

  var marks;
  if (/^all$/i.test(answer)) {
    marks = g.books.map(function (b) { return { row: b.row, read: 'Yes' }; });
  } else if (/^none$/i.test(answer)) {
    marks = g.books.map(function (b) { return { row: b.row, read: 'No' }; });
  } else {
    var upto = parseFloat(answer);
    if (isNaN(upto)) { toast('Enter a book number, ALL or NONE', true); return; }
    marks = g.books.map(function (b) {
      var n = parseFloat(b.bookNum);
      return { row: b.row, read: (!isNaN(n) && n <= upto) ? 'Yes' : 'No' };
    });
  }

  busy(true);
  call('setRead', { person: S.me, marks: marks }).then(function (res) {
    busy(false);
    if (!res || !res.ok) { toast(res && res.error || 'Failed', true); return; }
    marks.forEach(function (m) {
      var b = bookByRow(m.row);
      if (!b) return;
      if (!b.ratings[S.me]) b.ratings[S.me] = {};
      b.ratings[S.me][FIELDS.RD] = m.read;
    });
    readCache = null;
    renderLibrary();
    toast(res.changed + ' book' + (res.changed === 1 ? '' : 's') + ' updated');
  }).catch(function (e) { busy(false); toast((e && e.message) || 'Failed', true); });
}

function renderFlat(list, books, sort) {
  var arr = books.slice();
  if (sort === 'overallRank') arr.sort(function (a, b) { return nullLast(myR(a, FIELDS.OR)) - nullLast(myR(b, FIELDS.OR)); });
  else if (sort === 'bookRating') arr.sort(function (a, b) { return nullLastDesc(myR(b, FIELDS.BRT)) - nullLastDesc(myR(a, FIELDS.BRT)); });
  else if (sort === 'released') arr.sort(function (a, b) { return String(b.released || '').localeCompare(String(a.released || '')); });
  else if (sort === 'title') arr.sort(function (a, b) { return a.title.localeCompare(b.title); });
  else if (sort === 'author') arr.sort(function (a, b) { return (a.author || 'zzz').localeCompare(b.author || 'zzz'); });
  else if (sort === 'seriesRank') arr.sort(function (a, b) { return nullLast(myR(a, FIELDS.SR)) - nullLast(myR(b, FIELDS.SR)) || numish(a.bookNum) - numish(b.bookNum); });
  else if (sort === 'seriesRating') arr.sort(function (a, b) { return nullLastDesc(myR(b, FIELDS.SRT)) - nullLastDesc(myR(a, FIELDS.SRT)); });

  arr.forEach(function (b) {
    var n = bookNode(b, true, 0, false);
    n.style.paddingLeft = '14px';
    if (b.series && b.type !== 'Standalone') {
      var mid = n.querySelector('.grow');
      var subEl = mid.querySelector('.book-sub');
      var extra = esc(b.series) + (b.bookNum !== '' ? ' #' + esc(b.bookNum) : '');
      if (subEl) subEl.innerHTML = extra + ' · ' + subEl.innerHTML;
      else mid.innerHTML += '<div class="book-sub trunc">' + extra + '</div>';
    }
    list.appendChild(n);
  });
}

/* =====================================================================
   BOOK MODAL
   ===================================================================== */
function seriesByName(name) {
  return (S.data.series || []).filter(function (s) { return keyOf(s.name) === keyOf(name); })[0] || null;
}

function bookByRow(row) {
  for (var i = 0; i < S.data.books.length; i++) if (S.data.books[i].row === row) return S.data.books[i];
  return null;
}

/**
 * Mirrors the server rule for deleting: fine if nobody else has scored or
 * marked this book. Series-wide scores only count when it's the last book
 * left in its series, since they're copied onto every row.
 */
function othersHaveData(b) {
  var onlyBook = !b.series || booksOfSeries(b.series).length <= 1;
  var fields = [FIELDS.BR, FIELDS.BRT, FIELDS.OR, FIELDS.RD].concat(onlyBook ? [FIELDS.SR, FIELDS.SRT] : []);
  return (S.data.people || []).some(function (p) {
    if (p === S.self) return false;
    var r = b.ratings[p] || {};
    return fields.some(function (f) { return has(r[f]); });
  });
}

function openBook(row) {
  var b = bookByRow(row);
  if (!b) return;
  var isSeries = b.type !== 'Standalone' && !!b.series;

  $('m-title').textContent = b.title;
  var sub = [];
  sub.push(isSeries ? esc(b.series) + (b.bookNum !== '' ? ' · Book ' + esc(b.bookNum) : '') : 'Standalone');
  if (b.author) sub.push(esc(b.author));
  var mChips = narratorChips(b);
  if (mChips) sub.push(mChips);
  if (b.genre) sub.push(esc(b.genre));
  $('m-sub').innerHTML = sub.join(' · ');
  bindNarrators($('m-sub'));

  var body = $('m-body');
  body.innerHTML = '';

  if (!S.me) {
    body.appendChild(el('div', 'readonly-note', 'Nobody has a rating column yet.'));
  } else {
    var ro = !canEdit();
    body.appendChild(el('div', 'sect-title', ro
      ? esc(S.me) + '\'s ratings — view only'
      : 'Your ratings — ' + esc(S.me)));
    if (ro) {
      body.appendChild(el('div', 'readonly-note',
        S.self
          ? 'You\'re looking at ' + esc(S.me) + '\'s list. Switch back to ' + esc(S.self) + ' (top right) to rate this.'
          : 'Choose who you are under Account to start rating.'));
    }
    var box = el('div', 'card pad');
    if (ro) box.style.marginTop = '10px';

    var rows = isSeries ? [
      { f: FIELDS.SRT, label: 'Series rating', hint: 'How good is ' + b.series + ' overall? (1–10)', max: 10, step: 0.5 },
      { f: FIELDS.SR, label: 'Series ranking', hint: 'Position among all series — the rest shift to make room', max: 999, step: 1, rank: true },
      { f: FIELDS.BRT, label: 'Book rating', hint: 'This book on its own — leave blank if it isn\'t worth splitting out', max: 10, step: 0.5 },
      { f: FIELDS.BR, label: 'Rank in series', hint: 'Position within ' + b.series + ' — the rest shift to make room', max: 999, step: 1, rank: true },
      { f: FIELDS.OR, label: 'Overall book ranking', hint: 'Position across every book — the rest shift to make room', max: 9999, step: 1, rank: true }
    ] : [
      { f: FIELDS.BRT, label: 'Book rating', hint: '1–10', max: 10, step: 0.5 },
      { f: FIELDS.OR, label: 'Overall book ranking', hint: 'Position across every book — the rest shift to make room', max: 9999, step: 1, rank: true }
    ];
    box.appendChild(readRow(b, ro));
    rows.forEach(function (r) { box.appendChild(rateRow(b, r, ro)); });
    body.appendChild(box);


    var others = (S.data.people || []).filter(function (p) { return p !== S.me; });
    if (others.length) {
      body.appendChild(el('div', 'sect-title', 'Everyone else'));
      var t = el('div', 'card');
      var html = '<div class="scroll-x"><table class="tbl"><thead><tr><th>Person</th><th>Status</th>' +
        (isSeries ? '<th class="num">Series</th>' : '') +
        '<th class="num">Book</th>' +
        (isSeries ? '<th class="num">In series</th>' : '') +
        '<th class="num">Overall</th></tr></thead><tbody>';
      others.forEach(function (p) {
        var r = b.ratings[p] || {};
        html += '<tr><td>' + esc(p) + (p === S.self ? ' <span class="tiny muted">(you)</span>' : '') + '</td>' +
          '<td>' + (readBook(b, p) ? '<span class="tag good">Read</span>' : '<span class="tag unread">Not read</span>') + '</td>' +
          (isSeries ? '<td class="num">' + fmt(r[FIELDS.SRT]) + '</td>' : '') +
          '<td class="num">' + fmt(r[FIELDS.BRT]) + '</td>' +
          (isSeries ? '<td class="num">' + (r[FIELDS.BR] ? '#' + r[FIELDS.BR] : '—') + '</td>' : '') +
          '<td class="num">' + (r[FIELDS.OR] ? '#' + r[FIELDS.OR] : '—') + '</td></tr>';
      });
      t.innerHTML = html + '</tbody></table></div>';
      body.appendChild(t);
    }
  }

  /* ---- details (shared — anyone signed in can fix these) ---- */
  var canDelete = S.isAdmin || !othersHaveData(b);
  body.appendChild(el('div', 'sect-title', 'Details'));
  var d = el('div', 'card pad');
  d.innerHTML =
    '<div class="grid2">' + fldHtml('e-title', 'Title', b.title) +
      (isSeries ? fldHtml('e-booknum', 'Book number', b.bookNum) : '') + '</div>' +
    '<div class="grid2">' + fldHtml('e-released', 'Release date', b.released) +
      fldHtml('e-series', 'Series', b.series) + '</div>' +
    '<div class="grid2">' +
      '<label class="fld"><span>Author</span><select id="e-author-sel"></select>' +
      '<input type="text" id="e-author" placeholder="New author name" style="display:none;margin-top:7px"></label>' +
      '<label class="fld"><span>Genre</span><select id="e-genre-sel"></select>' +
      '<input type="text" id="e-genre" placeholder="New genre" style="display:none;margin-top:7px"></label>' +
    '</div>' +
    '<div class="grid2">' +
      '<label class="fld"><span>Narrator</span><select id="e-narrator-sel"></select>' +
      '<input type="text" id="e-narrator" placeholder="New narrator name" style="display:none;margin-top:7px"></label>' +
      '<div></div>' +
    '</div>' +
    '<div class="tiny muted" style="margin:-4px 0 12px">Narrator is per book, not per series — ' +
      'plenty of series change reader partway. Two readers: &ldquo;Name &amp; Name&rdquo;.</div>' +
    (isSeries ?
      '<div class="grid2">' +
        '<label class="fld"><span>Series finished?</span><select id="e-finished">' +
          '<option value="">—</option>' +
          '<option value="No"' + (keyOf(b.finished) === 'no' ? ' selected' : '') + '>No — still going</option>' +
          '<option value="Yes"' + (keyOf(b.finished) === 'yes' ? ' selected' : '') + '>Yes — complete</option>' +
        '</select></label>' +
        fldHtml('e-next', 'Next book release', b.nextRelease) +
      '</div>' +
      '<div class="tiny muted" style="margin:-4px 0 12px">Genre, finished and next-release apply to the whole series.</div>'
      : '') +
    '<div class="row" style="gap:8px"><button class="btn primary grow" id="saveDetails">Save details</button>' +
    (canDelete ? '<button class="btn danger sm" id="delBook">Delete</button>' : '') + '</div>' +
    (canDelete ? '' : '<div class="tiny muted" style="margin-top:8px">Someone else has scored this book, so only an admin can delete it.</div>');
  body.appendChild(d);

  combo('e-author-sel', 'e-author', S.data.authors || [], 'author', b.author);
  combo('e-narrator-sel', 'e-narrator', S.data.narrators || [], 'narrator', b.narrator);
  combo('e-genre-sel', 'e-genre', S.data.genres || [], 'genre', b.genre);

  $('saveDetails').onclick = function () { saveDetails(b, isSeries); };
  if ($('delBook')) $('delBook').onclick = function () { deleteBookFlow(b); };

  openModal();
}

function openModal() {
  $('scrim').className = 'scrim on';
  document.body.style.overflow = 'hidden';
}

function fldHtml(id, label, value) {
  return '<label class="fld"><span>' + esc(label) + '</span>' +
    '<input type="text" id="' + id + '" value="' + esc(value) + '" autocomplete="off"></label>';
}

/** Explicit "have you read it" row, with what the app would otherwise assume. */
function readRow(book, ro) {
  var wrap = el('div', 'rate-row');
  var r = book.ratings[S.me] || {};
  var explicit = readIsExplicit(book, S.me);
  var isRead = readBook(book, S.me);
  var you = ro ? S.me : 'you';
  var why = explicit
    ? (ro ? S.me + ' set this' : 'You set this yourself')
    : (isRead
        ? 'Assumed read — ' + (book.series && book.type !== 'Standalone'
            ? you + (ro ? ' has' : ' have') + ' scores in ' + book.series
            : 'it has a rating')
        : 'Assumed unread — nothing recorded against it');
  wrap.appendChild(el('div', 'rate-lbl', '<b>' + (ro ? 'Read it?' : 'Have you read it?') +
    '</b><span>' + esc(why) + '</span>'));

  var seg = el('div', 'seg');
  [['Yes', 'Yes'], ['No', 'No'], ['', 'Auto']].forEach(function (o) {
    var cur = r[FIELDS.RD] || '';
    var b = el('button', cur === o[0] ? 'on' : '', o[1]);
    if (ro) b.disabled = true;
    b.onclick = function () {
      if (!guardEdit()) return;
      var prev = (book.ratings[S.me] || {})[FIELDS.RD];
      function paint(v) {
        Array.prototype.forEach.call(seg.children, function (c, i) {
          c.className = (i === ['Yes', 'No', ''].indexOf(v || '')) ? 'on' : '';
        });
      }
      optimistic({
        apply: function () {
          if (!book.ratings[S.me]) book.ratings[S.me] = {};
          book.ratings[S.me][FIELDS.RD] = o[0] || null;
          paint(o[0]);
        },
        revert: function () { book.ratings[S.me][FIELDS.RD] = prev; paint(prev); },
        run: function () { return call('saveRatings', { row: book.row, person: S.me, values: { Read: o[0] } }); },
        msg: 'Saved'
      });
    };
    seg.appendChild(b);
  });
  wrap.appendChild(seg);
  return wrap;
}

function rateRow(book, spec, ro) {
  var wrap = el('div', 'rate-row');
  wrap.appendChild(el('div', 'rate-lbl', '<b>' + esc(spec.label) + '</b><span>' + esc(spec.hint) + '</span>'));

  var cur = (book.ratings[S.me] || {})[spec.f];
  var st = el('div', 'stepper');
  var minus = el('button', null, '−');
  var input = el('input');
  input.type = 'number'; input.step = spec.step; input.min = 0; input.max = spec.max;
  input.value = has(cur) ? cur : '';
  input.placeholder = '–';
  var plus = el('button', null, '+');

  if (ro) {
    minus.disabled = true; plus.disabled = true; input.disabled = true;
    st.appendChild(minus); st.appendChild(input); st.appendChild(plus);
    wrap.appendChild(st);
    return wrap;
  }

  var timer = null;
  function commit() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (!guardEdit()) return;
      var raw = input.value === '' ? '' : parseFloat(input.value);
      if (raw !== '' && isNaN(raw)) return;

      // A rank is a position, so typing one has to shuffle everything else
      // rather than leaving you with two #3s.
      if (spec.rank && raw !== '') {
        var scope = spec.f === FIELDS.BR ? book.series : null;
        var ids = orderForPosition(spec.f, S.me, scope, spec.f === FIELDS.SR ? book.series : book.row, raw);
        if (!ids) return;
        commitOrder(spec.f, S.me, ids, spec.label + ' set to #' + Math.max(1, Math.round(raw)))
          .then(function (ok2) {
            if (!ok2) return;
            var fresh = bookByRow(book.row);
            var now = fresh && (fresh.ratings[S.me] || {})[spec.f];
            if (has(now)) input.value = now;
          });
        return;
      }

      var vals = {}; vals[spec.f] = raw;
      var prev = (book.ratings[S.me] || {})[spec.f];
      var next = raw === '' ? null : raw;
      optimistic({
        apply: function () { applyLocal(book, spec.f, next); },
        revert: function () { applyLocal(book, spec.f, prev); input.value = has(prev) ? prev : ''; },
        run: function () { return call('saveRatings', { row: book.row, person: S.me, values: vals }); },
        msg: spec.label + ' saved'
      });
    }, 420);
  }
  function bump(delta) {
    var v = parseFloat(input.value);
    if (isNaN(v)) v = delta > 0 ? spec.step : 0;
    else v = v + delta;
    input.value = Math.round(Math.max(0, Math.min(spec.max, v)) * 10) / 10;
    commit();
  }
  minus.onclick = function () { bump(-spec.step); };
  plus.onclick = function () { bump(spec.step); };
  input.oninput = commit;

  st.appendChild(minus); st.appendChild(input); st.appendChild(plus);
  wrap.appendChild(st);
  return wrap;
}

function applyLocal(book, field, value) {
  var seriesLevel = (field === FIELDS.SR || field === FIELDS.SRT);
  S.data.books.forEach(function (b) {
    var same = seriesLevel
      ? (b.series && keyOf(b.series) === keyOf(book.series))
      : (b.row === book.row);
    if (!same) return;
    if (!b.ratings[S.me]) b.ratings[S.me] = {};
    b.ratings[S.me][field] = value;
  });
  var s = seriesByName(book.series);
  if (s && seriesLevel) {
    if (!s.ratings[S.me]) s.ratings[S.me] = {};
    s.ratings[S.me][field] = value;
  }
}

function saveDetails(b, isSeries) {
  var payload = {
    row: b.row,
    title: $('e-title').value,
    released: $('e-released').value,
    author: comboValue('e-author-sel', 'e-author'),
    narrator: comboValue('e-narrator-sel', 'e-narrator'),
    genre: comboValue('e-genre-sel', 'e-genre')
  };
  if (isSeries) {
    payload.bookNum = $('e-booknum').value;
    payload.finished = $('e-finished').value;
    payload.nextRelease = $('e-next').value;
  }

  // A changed series name in a multi-book series is almost always a rename.
  var newSeries = $('e-series') ? $('e-series').value.trim() : b.series;
  var siblings = booksOfSeries(b.series).length;
  var doRename = false;
  if (isSeries && newSeries && keyOf(newSeries) !== keyOf(b.series)) {
    doRename = siblings > 1 && confirm(
      'Rename the whole "' + b.series + '" series to "' + newSeries + '" (' + siblings + ' books)?\n\n' +
      'Cancel moves just this book across instead.');
    if (!doRename) payload.series = newSeries;
  }

  busy(true);
  call('updateBook', payload).then(function (res) {
    if (!res || !res.ok) { busy(false); toast(res && res.error || 'Save failed', true); return; }
    if (doRename) {
      return call2('renameSeries', b.series, newSeries).then(function (r2) {
        busy(false);
        if (!r2 || !r2.ok) { toast(r2 && r2.error || 'Rename failed', true); return; }
        toast(r2.message);
        closeModal();
        refresh(true);
      });
    }
    busy(false);
    toast('Details saved');
    closeModal();
    refresh(true);
  }).catch(function (e) { busy(false); toast((e && e.message) || 'Save failed', true); });
}

function deleteBookFlow(b) {
  if (!confirm('Delete "' + b.title + '" from the sheet? This removes the row.')) return;
  busy(true);
  call('deleteBook', b.row).then(function (res) {
    busy(false);
    if (!res || !res.ok) { toast(res && res.error || 'Delete failed', true); return; }
    toast(res.message || 'Deleted');
    closeModal();
    refresh(true);
  }).catch(function (e) { busy(false); toast((e && e.message) || 'Delete failed', true); });
}

/** The tappable "🎧 Name" chip. Two readers give two separate chips. */
function narratorChips(b) {
  var list = narratorsOf(b);
  if (!list.length) return '';
  return list.map(function (nm, i) {
    return '<span class="narr" data-narr="' + esc(nm) + '">' +
      (i === 0 ? '<span class="narr-ic">🎧</span>' : '') + esc(nm) + '</span>';
  }).join('<span class="muted"> &amp; </span>');
}

/** Wires every narrator chip inside a container to open that narrator. */
function bindNarrators(box) {
  if (!box) return;
  Array.prototype.forEach.call(box.querySelectorAll('[data-narr]'), function (n) {
    n.onclick = function (e) {
      e.stopPropagation();
      openNarrator(n.getAttribute('data-narr'));
    };
  });
}

/**
 * Everything one narrator has read, grouped by series.
 *
 * This reuses the book modal rather than adding a view to the nav: it is a
 * detour off a book, not a place you navigate to, and going back should land
 * you where you were.
 */
function openNarrator(name) {
  var books = booksByNarrator(name);
  if (!books.length) return;

  var readN = S.me ? books.filter(function (b) { return readBook(b, S.me); }).length : 0;

  $('m-title').textContent = name;
  var sub = [books.length + ' book' + (books.length === 1 ? '' : 's') + ' in your list'];
  if (S.me) sub.push(readN + ' read by ' + S.me);
  $('m-sub').innerHTML = esc(sub.join(' · '));

  // Group by series, standalones last, each group in book order.
  var groups = {}, order = [];
  books.forEach(function (b) {
    var g = (b.type !== 'Standalone' && b.series) ? b.series : '\u0000standalone';
    if (!groups[g]) { groups[g] = []; order.push(g); }
    groups[g].push(b);
  });
  order.sort(function (a, b) {
    if (a === '\u0000standalone') return 1;
    if (b === '\u0000standalone') return -1;
    return groups[b].length - groups[a].length || a.localeCompare(b);
  });

  var body = $('m-body');
  body.innerHTML = '';

  order.forEach(function (g) {
    var items = groups[g].slice().sort(function (a, b) {
      var an = a.bookNum === '' ? 1e9 : Number(a.bookNum);
      var bn = b.bookNum === '' ? 1e9 : Number(b.bookNum);
      return an - bn || String(a.title).localeCompare(String(b.title));
    });
    var standalone = g === '\u0000standalone';
    var mine = S.me ? items.filter(function (b) { return readBook(b, S.me); }).length : 0;

    body.appendChild(el('div', 'sect-title',
      (standalone ? 'Standalone' : g) + ' — ' + items.length +
      (S.me ? ' · ' + mine + ' read' : '')));

    var card = el('div', 'card');
    var html = '';
    items.forEach(function (b) {
      var isRead = S.me ? readBook(b, S.me) : false;
      // A co-narrated book says so here, so a shared credit isn't mistaken
      // for a solo one just because you arrived from this narrator's page.
      var others = narratorsOf(b).filter(function (n) { return keyOf(n) !== keyOf(name); });
      html += '<div class="narr-row" data-row="' + b.row + '">' +
        '<span class="narr-dot' + (isRead ? ' on' : '') + '"></span>' +
        '<span class="booknum">' + esc(standalone ? '•' : (b.bookNum === '' ? '?' : b.bookNum)) + '</span>' +
        '<span class="grow trunc">' + esc(b.title) +
        (others.length ? '<span class="tiny muted"> · with ' + esc(others.join(' & ')) + '</span>' : '') +
        '</span>' +
        (b.released ? '<span class="tiny muted">' + esc(yearOf(b.released) || '') + '</span>' : '') +
        '</div>';
    });
    card.innerHTML = html;
    body.appendChild(card);

    Array.prototype.forEach.call(card.querySelectorAll('[data-row]'), function (n) {
      n.onclick = function () { openBook(Number(n.getAttribute('data-row'))); };
    });
  });

  openModal();
}

function closeModal() {
  $('scrim').className = 'scrim';
  document.body.style.overflow = '';
  if (S.libraryStale) { S.libraryStale = false; renderLibrary(); }
}

/* =====================================================================
   TOP 20
   ---------------------------------------------------------------------
   Ordered by rating. Equal ratings are genuinely equal: they share a
   position number. A manual rank only breaks the tie for display order,
   it doesn't separate them.
   ===================================================================== */
var EVERYONE = '__everyone__';

function buildTopControls() {
  var sel = $('topPerson');
  var prev = sel.value;
  sel.innerHTML = '';
  (S.data.people || []).forEach(function (p) {
    var o = el('option'); o.value = p; o.textContent = p + (p === S.self ? ' (you)' : ''); sel.appendChild(o);
  });
  var o2 = el('option'); o2.value = EVERYONE; o2.textContent = 'Everyone — group average';
  sel.appendChild(o2);
  sel.value = (prev && (prev === EVERYONE || (S.data.people || []).indexOf(prev) !== -1)) ? prev : (S.me || EVERYONE);
}

function scoreFor(entity, field, who) {
  if (who !== EVERYONE) return (entity.ratings[who] || {})[field];
  return avg((S.data.people || []).map(function (p) { return (entity.ratings[p] || {})[field]; }));
}
function rankFor(entity, field, who) {
  if (who === EVERYONE) return null;
  return (entity.ratings[who] || {})[field];
}

/**
 * Sorts by rating, breaks ties with your manual rank, and numbers the result
 * 1, 2, 3 … straight down. Positions are never shared: a list that showed
 * eight #1s was impossible to drag into an order and told you less than the
 * order itself does. Rows that match their neighbour's rating still get a
 * "tied" marker, so the information is kept without the repeated numbers.
 */
function sortRanked(items) {
  items.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    var ar = has(a.rank) ? a.rank : Infinity;
    var br = has(b.rank) ? b.rank : Infinity;
    if (ar !== br) return ar - br;
    return String(a.label).localeCompare(String(b.label));
  });
  items.forEach(function (it, i) {
    it.pos = i + 1;
    var prev = items[i - 1], next = items[i + 1];
    it.tied = (prev && prev.score === it.score) || (next && next.score === it.score);
  });
  return items;
}

/** The displayed slice. The full list stays available for saving an order. */
function topSlice(items, limit) {
  return sortRanked(items).slice(0, limit);
}

function renderTop() {
  if (!S.data) return;
  var who = $('topPerson').value || S.me;
  var tab = S.topTab;
  $('topSubTabs').style.display = tab === 'all' ? 'flex' : 'none';

  var items = [], note = '', unit = '';

  if (tab === 'series') {
    unit = 'series';
    (S.data.series || []).forEach(function (s) {
      var sc = scoreFor(s, FIELDS.SRT, who);
      if (!has(sc)) return;
      items.push({ score: sc, rank: rankFor(s, FIELDS.SR, who), label: s.name,
        sub: (s.author || '') + ' · ' + s.count + ' books', kind: 'series', ref: s.name });
    });
    note = 'Series ordered by ' + whoLabel(who) + ' series rating.';
  } else if (tab === 'standalone') {
    unit = 'standalone books';
    S.data.books.forEach(function (b) {
      if (b.series && b.type !== 'Standalone') return;
      var sc = scoreFor(b, FIELDS.BRT, who);
      if (!has(sc)) return;
      items.push({ score: sc, rank: rankFor(b, FIELDS.OR, who), label: b.title,
        sub: b.author || '', kind: 'book', ref: b.row });
    });
    note = 'Standalone books ordered by ' + whoLabel(who) + ' book rating.';
  } else if (S.topSub === 'mixed') {
    unit = 'entries';
    (S.data.series || []).forEach(function (s) {
      var sc = scoreFor(s, FIELDS.SRT, who);
      if (!has(sc)) return;
      items.push({ score: sc, rank: rankFor(s, FIELDS.SR, who), label: s.name,
        sub: 'Series · ' + s.count + ' books' + (s.author ? ' · ' + s.author : ''), kind: 'series', ref: s.name });
    });
    S.data.books.forEach(function (b) {
      if (b.series && b.type !== 'Standalone') return;
      var sc = scoreFor(b, FIELDS.BRT, who);
      if (!has(sc)) return;
      items.push({ score: sc, rank: rankFor(b, FIELDS.OR, who), label: b.title,
        sub: 'Standalone' + (b.author ? ' · ' + b.author : ''), kind: 'book', ref: b.row });
    });
    note = 'Whole series (series rating) against standalone books (book rating), same 1–10 scale.';
  } else {
    unit = 'books';
    S.data.books.forEach(function (b) {
      var sc = scoreFor(b, FIELDS.BRT, who);
      if (!has(sc)) return;
      items.push({ score: sc, rank: rankFor(b, FIELDS.OR, who), label: b.title,
        sub: (b.series && b.type !== 'Standalone' ? b.series + (b.bookNum !== '' ? ' #' + b.bookNum : '') : 'Standalone'),
        kind: 'book', ref: b.row });
    });
    note = 'Every book on its own book rating.';
  }

  var all = sortRanked(items);              // full order; the top 20 is its prefix
  var top = all.slice(0, 20);

  // Dragging writes a manual rank, so it needs one person — you — and one rank column.
  var rankField = tab === 'series' ? FIELDS.SR : FIELDS.OR;
  var mixed = tab === 'all' && S.topSub === 'mixed';
  var canDrag = !!S.self && who === S.self && !mixed && top.length > 1;

  $('topNote').textContent = note + ' ' + items.length + ' rated ' + unit + ' to choose from.' +
    (canDrag ? ' Drag the handle to set your order.'
             : (mixed ? ' Series and standalone books use different rank columns, so this mixed view is read-only — drag on the other tabs.'
                      : (who === EVERYONE ? ' A group average has no order of its own to save.'
                                          : ' View only — this is ' + who + '\'s list.')));

  var box = $('topList');
  if (!top.length) {
    box.innerHTML = '<div class="empty">' + esc(whoLabel(who)) +
      ' hasn\'t rated anything here yet.</div>';
    return;
  }

  var html = '';
  top.forEach(function (it) {
    var medal = it.pos === 1 ? ' gold' : (it.pos === 2 ? ' silver' : (it.pos === 3 ? ' bronze' : ''));
    html += '<div class="top-row' + medal + '" data-kind="' + it.kind + '" data-ref="' + esc(it.ref) + '"' +
      (canDrag ? ' data-sortid="' + esc(it.ref) + '"' : '') + '>' +
      (canDrag ? gripHtml() : '') +
      '<div class="top-pos">' + it.pos + '</div>' +
      '<div class="grow"><div style="font-weight:600;font-size:14.5px" class="trunc">' + esc(it.label) + '</div>' +
      '<div class="tiny muted trunc">' + esc(it.sub) +
      (it.tied ? ' · <span class="tie">tied</span>' : '') +
      (has(it.rank) ? ' · ranked #' + it.rank : '') + '</div></div>' +
      '<div class="top-score">' + fmt(it.score) + '</div></div>';
  });
  box.innerHTML = html;

  Array.prototype.forEach.call(box.querySelectorAll('.top-row'), function (n) {
    n.onclick = function () {
      if (n.getAttribute('data-kind') === 'series') revealSeries(n.getAttribute('data-ref'));
      else openBook(Number(n.getAttribute('data-ref')));
    };
  });

  if (canDrag) {
    makeSortable(box, function (visibleIds, movedId, toIndex) {
      // The visible rows are the first 20 of `all`, so a move inside them maps
      // straight onto the full list — everything below 20 keeps its order.
      var fullIds = all.map(function (x) { return x.ref; });
      var fromIndex = -1;
      fullIds.forEach(function (x, i) { if (String(x) === String(movedId)) fromIndex = i; });
      if (fromIndex === -1) return;
      fullIds.splice(fromIndex, 1);
      fullIds.splice(toIndex, 0, movedId);
      commitOrder(rankField, who, fullIds,
        'Moved to #' + (toIndex + 1) + ' in your order');
    });
  }
}

/** Jumps to the Library with that series expanded — no separate page. */
function revealSeries(name) {
  var key = keyOf(name);
  S.expanded[key] = true;
  S.q = '';
  $('q').value = '';
  ['genre', 'type', 'finished', 'mine'].forEach(function (k) { S.filters[k] = ''; });
  buildFilterChips();
  go('library');
  renderLibrary();
  setTimeout(function () {
    var node = document.querySelector('.series[data-key="' + key.replace(/"/g, '\\"') + '"]');
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'start' });
  }, 60);
}

function whoLabel(who) { return who === EVERYONE ? "the group's average" : who + "'s"; }



/* =====================================================================
   DRAG TO REORDER
   ---------------------------------------------------------------------
   Pointer events rather than HTML5 drag-and-drop, so it works the same
   with a finger as with a mouse. Nothing moves in the DOM mid-drag — the
   row lifts, a line shows where it would land, and the list re-renders
   once on drop.
   ===================================================================== */
function makeSortable(box, onCommit) {
  var rows = Array.prototype.slice.call(box.querySelectorAll('[data-sortid]'));
  if (rows.length < 2) return;

  rows.forEach(function (row, index) {
    var grip = row.querySelector('.grip');
    if (!grip) return;

    grip.onpointerdown = function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      var startY = e.clientY;
      var from = index, to = index;
      var marked = null;

      document.body.classList.add('sorting');
      row.classList.add('lifted');
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}

      function clearMark() {
        if (marked) { marked.classList.remove('drop-above', 'drop-below'); marked = null; }
      }

      function onMove(ev) {
        row.style.transform = 'translateY(' + (ev.clientY - startY) + 'px)';
        var y = ev.clientY, next = from;
        for (var i = 0; i < rows.length; i++) {
          if (i === from) continue;
          var r = rows[i].getBoundingClientRect();
          var mid = r.top + r.height / 2;
          if (i < from && y < mid) { next = i; break; }
          if (i > from && y > mid) next = i;
        }
        if (next !== to) {
          clearMark();
          to = next;
          if (to !== from) {
            marked = rows[to];
            marked.classList.add(to < from ? 'drop-above' : 'drop-below');
          }
        }
      }

      function onUp() {
        grip.onpointermove = null;
        grip.onpointerup = null;
        grip.onpointercancel = null;
        document.body.classList.remove('sorting');
        row.classList.remove('lifted');
        row.style.transform = '';
        clearMark();
        if (to !== from) {
          var ids = rows.map(function (r) { return r.getAttribute('data-sortid'); });
          var moved = ids.splice(from, 1)[0];
          ids.splice(to, 0, moved);
          onCommit(ids, moved, to);
        }
      }

      grip.onpointermove = onMove;
      grip.onpointerup = onUp;
      grip.onpointercancel = onUp;
    };
  });
}

function gripHtml() {
  return '<button class="grip" aria-label="Drag to reorder" title="Drag to reorder">' +
    '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/>' +
    '<circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/>' +
    '<circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg></button>';
}

/* =====================================================================
   RANK SCOPES
   ---------------------------------------------------------------------
   A rank is a position in a list, so setting one has to renumber the
   others. Each rank field owns a different list:
     Series Ranking  — every series
     Book Ranking    — the books inside one series
     Overall Ranking — every book
   ===================================================================== */

/** Everything that could carry this rank, as {id, rank, sort}. */
function rankUniverse(field, person, seriesName) {
  if (field === FIELDS.SR) {
    return (S.data.series || []).map(function (sr) {
      var r = sr.ratings[person] || {};
      return { id: sr.name, rank: r[FIELDS.SR], score: r[FIELDS.SRT], label: sr.name };
    });
  }
  var books = field === FIELDS.BR
    ? booksOfSeries(seriesName)
    : S.data.books;
  return books.map(function (b) {
    var r = b.ratings[person] || {};
    return { id: b.row, rank: r[field], score: r[FIELDS.BRT], label: b.title };
  });
}

/** Just the ones that already have a rank, in rank order. */
function rankedOrder(field, person, seriesName) {
  return rankUniverse(field, person, seriesName)
    .filter(function (x) { return has(x.rank); })
    .sort(function (a, b) { return a.rank - b.rank; })
    .map(function (x) { return x.id; });
}

/**
 * Puts `id` at 1-based `position` and renumbers everything around it.
 * Returns the new id order, or null when nothing would change.
 */
function orderForPosition(field, person, seriesName, id, position) {
  var ids = rankedOrder(field, person, seriesName);
  var sid = String(id);
  var at = -1;
  ids.forEach(function (x, i) { if (String(x) === sid) at = i; });
  if (at !== -1) ids.splice(at, 1);

  var pos = Math.round(Number(position));
  if (!pos || pos < 1) pos = 1;
  if (pos > ids.length + 1) pos = ids.length + 1;
  ids.splice(pos - 1, 0, id);

  if (at === pos - 1 && ids.length === rankedOrder(field, person, seriesName).length) return null;
  return ids;
}

/**
 * Writes an order, showing it immediately and putting it back if the write fails.
 * Only ever for your own list — the server would refuse anyone else's anyway.
 */
function commitOrder(field, person, ids, msg) {
  if (!S.self || person !== S.self) {
    toast(S.self ? 'View only — you can only reorder your own list' : 'Choose who you are first — open Account', true);
    return Promise.resolve(false);
  }
  var before = ids.map(function (id) { return [id, currentRank(field, person, id)]; });
  return optimistic({
    apply: function () { ids.forEach(function (id, i) { applyRankLocal(field, person, id, i + 1); }); },
    revert: function () { before.forEach(function (p) { applyRankLocal(field, person, p[0], p[1]); }); },
    run: function () { return call('saveRankOrder', { person: person, field: field, order: ids }); },
    msg: msg || 'Reordered'
  });
}

function currentRank(field, person, id) {
  if (field === FIELDS.SR) {
    var sr = seriesByName(id);
    return sr ? (sr.ratings[person] || {})[field] : null;
  }
  var bk = bookByRow(Number(id));
  return bk ? (bk.ratings[person] || {})[field] : null;
}

/** Mirrors a written rank into the in-memory copy so the UI doesn't lag. */
function applyRankLocal(field, person, id, rank) {
  if (field === FIELDS.SR) {
    S.data.books.forEach(function (b) {
      if (keyOf(b.series) !== keyOf(id)) return;
      if (!b.ratings[person]) b.ratings[person] = {};
      b.ratings[person][field] = rank;
    });
    var sr = seriesByName(id);
    if (sr) {
      if (!sr.ratings[person]) sr.ratings[person] = {};
      sr.ratings[person][field] = rank;
    }
    return;
  }
  var bk = bookByRow(Number(id));
  if (!bk) return;
  if (!bk.ratings[person]) bk.ratings[person] = {};
  bk.ratings[person][field] = rank;
}

/* =====================================================================
   RADAR — what's coming, what quietly landed, what needs looking up
   ===================================================================== */

/* How far each list looks. Pass 0 for "no limit". */
var RADAR_UPCOMING_DAYS = 180;   // Upcoming — about half a year ahead
var RADAR_LANDED_DAYS = 365;     // Just landed — anything out in the past year

/**
 * Books with a date in the future, soonest first, out to the horizon.
 *
 * A date known only to the month or the year is anchored at the start of its
 * period, so it passes the horizon test whenever the earliest day it could
 * land on does. "Mar 2027" belongs on a list of what's coming even though
 * nobody has named the day yet — that's the whole point of the vague chip.
 */
function radarUpcoming(windowDays) {
  var w = windowDays === undefined ? RADAR_UPCOMING_DAYS : windowDays;
  var out = [];
  S.data.books.forEach(function (b) {
    var rel = parseRel(b.released);
    if (!rel || rel.d <= todayMid()) return;
    var days = daysFromToday(rel.d);
    if (w && days > w) return;
    out.push({ book: b, rel: rel, days: days,
      caughtUp: b.series && b.type !== 'Standalone' ? caughtUpOn(b.series, S.me) : true });
  });
  out.sort(function (a, b) {
    if (a.caughtUp !== b.caughtUp) return a.caughtUp ? -1 : 1;   // waiting-on first
    return a.rel.d - b.rel.d || a.book.title.localeCompare(b.book.title);
  });
  return out;
}

/** Future-dated books past the horizon — counted in a footer, not listed. */
function radarBeyond(windowDays) {
  var w = windowDays === undefined ? RADAR_UPCOMING_DAYS : windowDays;
  if (!w) return [];
  var out = [];
  S.data.books.forEach(function (b) {
    var rel = parseRel(b.released);
    if (!rel || rel.d <= todayMid()) return;
    var days = daysFromToday(rel.d);
    if (days > w) out.push({ book: b, rel: rel, days: days });
  });
  out.sort(function (a, b) { return a.rel.d - b.rel.d || a.book.title.localeCompare(b.book.title); });
  return out;
}

/**
 * Out in the last year and still unread — the ones that slip past you.
 *
 * A month-and-year date counts: it is anchored at the 1st, so "Jun 2026" reads
 * as out since June. A bare year does not — anchoring that at January 1st
 * would claim a release date the sheet never actually gives.
 *
 * This list deliberately ignores the series-level read inference. A book that
 * came out three weeks ago cannot be covered by "I've read this series", and
 * every new book in a series you've rated would otherwise be assumed read and
 * never surface here — which is the exact thing this list exists to catch.
 * Only an explicit Read = Yes takes a book off it.
 */
function radarLanded(windowDays) {
  var w = windowDays === undefined ? RADAR_LANDED_DAYS : windowDays;
  var out = [];
  S.data.books.forEach(function (b) {
    var rel = parseRel(b.released);
    if (!rel || (rel.p !== 'day' && rel.p !== 'month')) return;
    var ago = -daysFromToday(rel.d);
    if (ago < 0 || (w && ago > w)) return;
    if (S.me && readIsExplicit(b, S.me) && readBook(b, S.me)) return;
    out.push({ book: b, rel: rel, days: ago });
  });
  out.sort(function (a, b) { return a.days - b.days || a.book.title.localeCompare(b.book.title); });
  return out;
}

/** Ongoing series with nothing dated ahead of them. */
function radarNoDate() {
  var out = [];
  (S.data.series || []).forEach(function (sr) {
    if (keyOf(sr.finished) === 'yes') return;             // series is done, nothing to wait for
    var books = booksOfSeries(sr.name);
    var future = 0, undated = [], newest = null;
    books.forEach(function (b) {
      var rel = parseRel(b.released);
      if (!rel) { undated.push(b); return; }
      if (rel.d > todayMid()) future++;
      else if (!newest || rel.d > newest.rel.d) newest = { book: b, rel: rel };
    });
    if (future) return;             // its next book is dated, so there is nothing to look up
    out.push({
      series: sr, undated: undated, newest: newest,
      note: norm(sr.nextRelease),
      score: has((sr.ratings[S.me] || {})[FIELDS.SRT]) ? (sr.ratings[S.me] || {})[FIELDS.SRT] : -1
    });
  });
  out.sort(function (a, b) { return b.score - a.score || a.series.name.localeCompare(b.series.name); });
  return out;
}

function norm(v) { return String(v === null || v === undefined ? '' : v).trim(); }

/** "180" → "6 months", "365" → "year", so the copy follows the constants. */
function windowLabel(days) {
  if (days % 365 === 0) return days === 365 ? 'year' : (days / 365) + ' years';
  if (days % 30 === 0) return days === 30 ? 'month' : (days / 30) + ' months';
  return days + ' days';
}

/** The chip label for a date we only know to the month or the year. */
function vagueWhen(rel) {
  return rel.p === 'month'
    ? MONTHS[rel.d.getMonth()] + ' ' + String(rel.d.getFullYear()).slice(2)
    : String(rel.d.getFullYear());
}

function countChip(n, unit, cls) {
  return '<div class="count' + (cls ? ' ' + cls : '') + '"><b>' + esc(n) +
    '</b><span>' + esc(unit) + '</span></div>';
}

function renderRadar() {
  if (!S.data) return;
  var box = $('radarList'), note = $('radarNote'), html = '';

  if (S.radarTab === 'upcoming') {
    var up = radarUpcoming();
    var beyond = radarBeyond();
    var horizon = windowLabel(RADAR_UPCOMING_DAYS);
    var waiting = up.filter(function (x) { return x.caughtUp; });
    note.textContent = up.length
      ? up.length + ' book' + (up.length === 1 ? '' : 's') + ' due in the next ' + horizon + ' · ' +
        waiting.length + ' in series ' + (S.me || 'you') + ' ' +
        (waiting.length === 1 ? 'is' : 'are') + ' caught up on'
      : 'Nothing dated in the next ' + horizon + '.';

    if (!up.length) {
      box.innerHTML = '<div class="empty">No release dates in the next ' + esc(horizon) + '.<br>' +
        '<span class="tiny">' +
        (beyond.length
          ? beyond.length + ' book' + (beyond.length === 1 ? ' is' : 's are') + ' dated further out.'
          : 'Check "No date known" for series that need looking up.') +
        '</span></div>';
      return;
    }

    var lastGroup = null;
    up.forEach(function (x) {
      var group = x.caughtUp
        ? (canEdit() ? "You're caught up — waiting on these" : S.me + ' is caught up — waiting on these')
        : 'Still catching up';
      if (group !== lastGroup) { html += '<div class="rad-group">' + esc(group) + '</div>'; lastGroup = group; }

      var chip;
      if (x.rel.p !== 'day') {
        chip = countChip(vagueWhen(x.rel), 'expected', 'vague');
      } else {
        chip = countChip(x.days, x.days === 1 ? 'day' : 'days', x.days <= 30 ? 'soon' : '');
      }

      html += '<div class="rad-row" data-row="' + x.book.row + '">' + chip +
        '<div class="grow"><div class="rad-title trunc">' + esc(x.book.title) + '</div>' +
        '<div class="rad-sub trunc">' +
        (x.book.series && x.book.type !== 'Standalone'
          ? esc(x.book.series) + (x.book.bookNum !== '' ? ' #' + esc(x.book.bookNum) : '') + ' · ' : '') +
        '<b>' + esc(prettyDate(x.rel)) + '</b>' +
        (x.rel.p !== 'day' ? ' · date not firm' : '') +
        '</div></div>' +
        (x.caughtUp ? '<span class="waiting">waiting</span>' : '') +
        '</div>';
    });

    if (beyond.length) {
      html += '<div class="rad-group">' + beyond.length + ' more book' +
        (beyond.length === 1 ? '' : 's') + ' dated further than ' + esc(horizon) + ' out</div>';
    }

  } else if (S.radarTab === 'landed') {
    var land = radarLanded();
    var back = windowLabel(RADAR_LANDED_DAYS);
    note.textContent = land.length
      ? land.length + ' book' + (land.length === 1 ? '' : 's') +
        ' out in the last ' + back + ' that ' + (S.me || 'you') + ' hasn\'t read.' +
        (canEdit() ? ' Tap the circle to mark one read.' : '')
      : 'Nothing released in the last ' + back + ' is sitting unread.';

    if (!land.length) {
      box.innerHTML = '<div class="empty">All caught up on the last ' + esc(back) + '.</div>';
      return;
    }
    land.forEach(function (x) {
      var chip;
      if (x.rel.p !== 'day') chip = countChip(vagueWhen(x.rel), 'out', 'out vague');
      else if (x.days === 0) chip = countChip('today', 'out now', 'out vague');
      else chip = countChip(x.days, x.days === 1 ? 'day ago' : 'days ago', 'out');

      html += '<div class="rad-row" data-row="' + x.book.row + '">' + chip +
        '<div class="grow"><div class="rad-title trunc">' + esc(x.book.title) + '</div>' +
        '<div class="rad-sub trunc">' +
        (x.book.series && x.book.type !== 'Standalone'
          ? esc(x.book.series) + (x.book.bookNum !== '' ? ' #' + esc(x.book.bookNum) : '')
          : 'Standalone') +
        ' · <b>' + esc(prettyDate(x.rel)) + '</b>' +
        (x.rel.p !== 'day' ? ' · day not known' : '') + '</div></div>' +
        (canEdit()
          ? '<button class="rtog" data-read="' + x.book.row + '" title="Mark read">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>' +
            '</button>'
          : '') +
        '</div>';
    });

  } else {
    var nd = radarNoDate();
    var blanks = S.data.books.filter(function (b) { return !parseRel(b.released); }).length;
    note.textContent = nd.length
      ? nd.length + ' ongoing series with nothing dated ahead of ' +
        (nd.length === 1 ? 'it' : 'them') + ', best-rated first.'
      : 'Every ongoing series has something dated ahead of it.';

    if (!nd.length) {
      box.innerHTML = '<div class="empty">Nothing to look up.</div>';
      return;
    }
    nd.forEach(function (x) {
      var bits = [];
      if (x.newest) bits.push('last out <b>' + esc(prettyDate(x.newest.rel)) + '</b>');
      if (x.undated.length) bits.push(x.undated.length + ' book' + (x.undated.length === 1 ? '' : 's') + ' here with no date');
      if (x.note) bits.push('sheet says &ldquo;' + esc(x.note) + '&rdquo;');
      if (!bits.length) bits.push('nothing recorded');

      html += '<div class="rad-row" data-series="' + esc(x.series.name) + '">' +
        countChip('?', 'no date', 'vague') +
        '<div class="grow"><div class="rad-title trunc">' + esc(x.series.name) + '</div>' +
        '<div class="rad-sub trunc">' + bits.join(' · ') + '</div></div>' +
        (x.score >= 0 ? '<span class="behind">rated ' + fmt(x.score) + '</span>' : '') +
        '</div>';
    });
    if (blanks) {
      html += '<div class="rad-group">' + blanks + ' book' + (blanks === 1 ? '' : 's') +
        ' anywhere in the list still have no release date</div>';
    }
  }

  box.innerHTML = html;

  Array.prototype.forEach.call(box.querySelectorAll('.rad-row'), function (n) {
    n.onclick = function () {
      if (n.getAttribute('data-series')) revealSeries(n.getAttribute('data-series'));
      else openBook(Number(n.getAttribute('data-row')));
    };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-read]'), function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      var bk = bookByRow(Number(b.getAttribute('data-read')));
      if (bk) toggleRead(bk);
    };
  });
}

/** Little count on the Radar nav item — the whole point is to notice these. */
function updateRadarBadge() {
  var dot = $('landedDot');
  if (!dot || !S.data) return;
  var n = radarLanded().length;
  dot.textContent = n > 99 ? '99+' : String(n);
  dot.hidden = !n;
}

/* =====================================================================
   DASHBOARD
   ===================================================================== */
function renderDash() {
  if (!S.data) return;
  var box = $('dashBody');
  var books = S.data.books, people = S.data.people || [], series = S.data.series || [];
  if (!books.length) { box.innerHTML = '<div class="empty">No books yet.</div>'; return; }

  var standalone = books.filter(function (b) { return b.type === 'Standalone' || !b.series; });
  var complete = series.filter(function (s) { return keyOf(s.finished) === 'yes'; }).length;
  var html = '';

  html += '<div class="sect-title">At a glance</div><div class="stats">' +
    tile(books.length, 'Books') + tile(series.length, 'Series') +
    tile(standalone.length, 'Standalone') + tile(complete + '/' + series.length, 'Complete') +
    tile((S.data.genres || []).length, 'Genres') +
    tile((S.data.narrators || []).length, 'Narrators') + tile(people.length, 'Raters') +
    (S.me ? tile(books.filter(function (b) { return readBook(b, S.me); }).length, esc(S.me) + ' read') : '') +
    '</div>';

  /* who has read what */
  html += '<div class="sect-title">Who has read what</div><div class="card pad">';
  people.forEach(function (p) {
    var readBooks = books.filter(function (b) { return readBook(b, p); }).length;
    var readSer = series.filter(function (s) { return readSeries(s.name, p); }).length;
    var scored = books.filter(function (b) { return has((b.ratings[p] || {})[FIELDS.BRT]); }).length;
    html += '<div class="bar-row"><div class="bar-lbl"><b>' + esc(p) + '</b> · books read</div>' +
      bar(readBooks, books.length) + '<div class="bar-val">' + readBooks + '/' + books.length + '</div></div>';
    html += '<div class="bar-row"><div class="bar-lbl" style="color:var(--ink-3)">series read</div>' +
      bar(readSer, Math.max(series.length, 1)) + '<div class="bar-val">' + readSer + '/' + series.length + '</div></div>';
    html += '<div class="bar-row"><div class="bar-lbl" style="color:var(--ink-3)">books scored</div>' +
      bar(scored, books.length) + '<div class="bar-val">' + scored + '</div></div>';
  });
  html += '</div>';

  /* group leaderboards */
  var seriesScored = series.map(function (s) {
    var vals = people.map(function (p) { return (s.ratings[p] || {})[FIELDS.SRT]; });
    return { s: s, avg: avg(vals), vals: vals };
  }).filter(function (x) { return x.avg !== null; })
    .sort(function (a, b) { return b.avg - a.avg || a.s.name.localeCompare(b.s.name); });

  if (seriesScored.length) {
    html += '<div class="sect-title">Series — group average</div><div class="card"><div class="scroll-x"><table class="tbl"><thead><tr>' +
      '<th style="width:34px" class="num">#</th><th>Series</th>' +
      people.map(function (p) { return '<th class="num">' + esc(initials(p)) + '</th>'; }).join('') +
      '<th class="num">Avg</th></tr></thead><tbody>';
    seriesScored.slice(0, 15).forEach(function (x, i) {
      html += '<tr><td class="num muted">' + (i + 1) + '</td><td>' + esc(x.s.name) +
        '<div class="tiny muted trunc">' + esc(x.s.author || '') + '</div></td>' +
        x.vals.map(function (v, j) {
          return '<td class="num">' + (has(v) ? fmt(v) : (readSeries(x.s.name, people[j]) ? '–' : '<span class="muted">··</span>')) + '</td>';
        }).join('') +
        '<td class="num"><b>' + fmt(x.avg) + '</b></td></tr>';
    });
    html += '</tbody></table></div></div>';
  }

  /* disagreements */
  if (people.length > 1) {
    var diffs = [];
    series.forEach(function (s) {
      var vals = people.map(function (p) { return { p: p, v: (s.ratings[p] || {})[FIELDS.SRT] }; })
        .filter(function (x) { return has(x.v); });
      if (vals.length < 2) return;
      var sorted = vals.slice().sort(function (a, b) { return a.v - b.v; });
      var lo = sorted[0], hi = sorted[sorted.length - 1];
      if (hi.v - lo.v > 0) diffs.push({ name: s.name, gap: hi.v - lo.v, hi: hi, lo: lo });
    });
    diffs.sort(function (a, b) { return b.gap - a.gap; });
    if (diffs.length) {
      html += '<div class="sect-title">Biggest disagreements</div><div class="card">';
      diffs.slice(0, 8).forEach(function (d) {
        html += '<div class="rank-item"><div class="rank-pos">' + fmt(d.gap) + '</div>' +
          '<div class="grow"><div style="font-weight:600" class="trunc">' + esc(d.name) + '</div>' +
          '<div class="tiny muted">' + esc(d.hi.p) + ' ' + fmt(d.hi.v) + ' · ' + esc(d.lo.p) + ' ' + fmt(d.lo.v) + '</div></div></div>';
      });
      html += '</div>';
    }

    /* what one has read and another hasn't */
    html += '<div class="sect-title">Reading gaps</div>';
    people.forEach(function (q) {
      var missing = series.filter(function (s) {
        return !readSeries(s.name, q) && people.some(function (p) { return p !== q && readSeries(s.name, p); });
      });
      if (!missing.length) return;
      missing.sort(function (a, b) {
        return (avg(people.map(function (p) { return (b.ratings[p] || {})[FIELDS.SRT]; })) || 0) -
               (avg(people.map(function (p) { return (a.ratings[p] || {})[FIELDS.SRT]; })) || 0);
      });
      html += '<div class="card" style="margin-bottom:10px"><div class="pad" style="padding-bottom:6px">' +
        '<b>' + esc(q) + '</b> hasn\'t read <span class="tag acc">' + missing.length + ' series</span> ' +
        'someone else has</div>';
      missing.slice(0, 6).forEach(function (s) {
        var others = people.filter(function (p) { return p !== q && readSeries(s.name, p); });
        html += '<div class="ord-row" style="padding:8px 14px" data-series="' + esc(s.name) + '">' +
          '<div class="grow"><div style="font-weight:600;font-size:13.5px" class="trunc">' + esc(s.name) + '</div>' +
          '<div class="tiny muted trunc">' + esc(others.join(', ')) + ' · ' + s.count + ' books</div></div>' +
          '<div class="top-score" style="font-size:14px">' +
          fmt(avg(others.map(function (p) { return (s.ratings[p] || {})[FIELDS.SRT]; }))) + '</div></div>';
      });
      if (missing.length > 6) html += '<div class="tiny muted" style="padding:8px 14px">…and ' + (missing.length - 6) + ' more.</div>';
      html += '</div>';
    });
  }

  /* genres */
  var byGenre = {};
  books.forEach(function (b) { var g = b.genre || 'Uncategorised'; byGenre[g] = (byGenre[g] || 0) + 1; });
  var gArr = Object.keys(byGenre).map(function (g) { return { g: g, n: byGenre[g] }; })
    .sort(function (a, b) { return b.n - a.n; });
  var gMax = gArr.length ? gArr[0].n : 1;
  html += '<div class="sect-title">Books by genre</div><div class="card pad">';
  gArr.forEach(function (x) {
    html += '<div class="bar-row"><div class="bar-lbl">' + esc(x.g) + '</div>' + bar(x.n, gMax) +
      '<div class="bar-val">' + x.n + '</div></div>';
  });
  html += '</div>';

  /* authors — counted by books actually READ, not books sitting in the list */
  var byAuthor = {}, inList = {};
  books.forEach(function (b) {
    if (!b.author) return;
    inList[b.author] = (inList[b.author] || 0) + 1;
    if (S.me && readBook(b, S.me)) byAuthor[b.author] = (byAuthor[b.author] || 0) + 1;
  });
  var aArr = Object.keys(byAuthor).map(function (a) { return { a: a, n: byAuthor[a], of: inList[a] }; })
    .sort(function (x, y) { return y.n - x.n || x.a.localeCompare(y.a); }).slice(0, 10);
  if (aArr.length) {
    var aMax = aArr[0].n;
    html += '<div class="sect-title">Most-read authors — ' + esc(S.me || '') + '</div><div class="card pad">';
    aArr.forEach(function (x) {
      html += '<div class="bar-row"><div class="bar-lbl">' + esc(x.a) +
        (x.of > x.n ? ' <span class="muted">of ' + x.of + '</span>' : '') + '</div>' +
        bar(x.n, aMax) + '<div class="bar-val">' + x.n + '</div></div>';
    });
    html += '<div class="tiny muted" style="margin-top:8px">Counts books actually read. ' +
      'Books in the list that haven\'t been read don\'t count toward an author.</div></div>';
  }

  /* narrators — same rule as authors: counted by books actually READ. A book
     with two readers counts for each of them, so these totals can exceed the
     number of books. */
  var nArr = narratorTally(S.me).filter(function (x) { return x.read > 0; }).slice(0, 10);
  if (nArr.length) {
    var nMax = nArr[0].read;
    var voices = narratorTally(S.me).length;
    html += '<div class="sect-title">Most-heard narrators — ' + esc(S.me || '') + '</div><div class="card pad">';
    nArr.forEach(function (x) {
      html += '<div class="bar-row"><div class="bar-lbl"><span class="narr" data-narr="' + esc(x.name) + '">' +
        esc(x.name) + '</span>' +
        (x.of > x.read ? ' <span class="muted">of ' + x.of + '</span>' : '') + '</div>' +
        bar(x.read, nMax) + '<div class="bar-val">' + x.read + '</div></div>';
    });
    html += '<div class="tiny muted" style="margin-top:8px">' + voices +
      ' narrators across the library. Tap a name for everything they\'ve read. ' +
      'A book with two narrators counts for both.</div></div>';
  } else if (S.me) {
    var anyNarr = (S.data.narrators || []).length;
    if (!anyNarr) {
      html += '<div class="sect-title">Narrators</div><div class="card pad">' +
        '<div class="tiny muted">No narrators recorded yet. Add them per book under Details.</div></div>';
    }
  }

  box.innerHTML = html;
  Array.prototype.forEach.call(box.querySelectorAll('[data-series]'), function (n) {
    n.onclick = function () { revealSeries(n.getAttribute('data-series')); };
  });
  bindNarrators(box);
}

function tile(v, label) { return '<div class="stat"><b>' + esc(v) + '</b><span>' + esc(label) + '</span></div>'; }
function bar(v, max) {
  var pct = max ? Math.round((v / max) * 100) : 0;
  return '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>';
}

/* =====================================================================
   REORDER
   ===================================================================== */
function buildRankControls() {
  var sel = $('rankPerson');
  sel.innerHTML = '';
  (S.data.people || []).forEach(function (p) {
    var o = el('option'); o.value = p; o.textContent = p + (p === S.self ? ' (you)' : ''); sel.appendChild(o);
  });
  if (S.me) sel.value = S.me;

  var ss = $('rankSeries');
  ss.innerHTML = '';
  (S.data.series || []).forEach(function (s) {
    var o = el('option'); o.value = s.name; o.textContent = s.name + ' (' + s.count + ')';
    ss.appendChild(o);
  });
}

function buildRankList() {
  if (!S.data) return;
  var type = $('rankType').value, person = $('rankPerson').value || S.me;
  $('rankSeriesWrap').style.display = type === 'inseries' ? 'block' : 'none';

  var items = [];
  if (type === 'series') {
    items = (S.data.series || []).map(function (s) {
      var r = s.ratings[person] || {};
      return { id: s.name, label: s.name, sub: (s.author || '') + ' · ' + s.count + ' books',
        rank: r[FIELDS.SR], score: r[FIELDS.SRT] };
    });
  } else if (type === 'overall') {
    items = S.data.books.map(function (b) {
      var r = b.ratings[person] || {};
      return { id: b.row, label: b.title,
        sub: b.series && b.type !== 'Standalone' ? b.series + (b.bookNum !== '' ? ' #' + b.bookNum : '') : 'Standalone',
        rank: r[FIELDS.OR], score: r[FIELDS.BRT] };
    });
  } else {
    var name = $('rankSeries').value;
    items = S.data.books.filter(function (b) { return keyOf(b.series) === keyOf(name); })
      .map(function (b) {
        var r = b.ratings[person] || {};
        return { id: b.row, label: b.title, sub: 'Book ' + b.bookNum, rank: r[FIELDS.BR], score: r[FIELDS.BRT] };
      });
  }

  var ranked = items.filter(function (i) { return has(i.rank); }).sort(function (a, b) { return a.rank - b.rank; });
  var unranked = items.filter(function (i) { return !has(i.rank); });
  S.rankDraft = { type: type, person: person, items: ranked.concat(unranked), dirty: false,
    readonly: !S.self || person !== S.self };
  paintRankList();
}

function paintRankList() {
  var box = $('rankList');
  box.innerHTML = '';
  var d = S.rankDraft;
  var ro = !d || d.readonly;
  $('rankSortByRating').disabled = ro;
  $('rankNote').textContent = ro && d
    ? 'View only — this is ' + d.person + '\'s ranking. Pick yourself under "Whose ranking" to reorder yours.'
    : 'Drag rows, or use the arrows. Positions become the rank numbers in the sheet.';
  if (!d || !d.items.length) {
    box.innerHTML = '<div class="empty">Nothing to rank here yet.</div>';
    $('rankSave').disabled = true;
    return;
  }
  $('rankSave').disabled = ro || !d.dirty;

  d.items.forEach(function (it, i) {
    var n = el('div', 'rank-item');
    if (!ro) n.setAttribute('draggable', 'true');
    n.setAttribute('data-i', i);
    n.innerHTML = '<div class="rank-pos">' + (i + 1) + '</div>' +
      '<div class="grow"><div style="font-weight:600;font-size:14px" class="trunc">' + esc(it.label) + '</div>' +
      '<div class="tiny muted trunc">' + esc(it.sub || '') +
      (has(it.score) ? ' · rated ' + fmt(it.score) : '') + '</div></div>' +
      (ro ? '' : '<div class="arrows"><button data-up="' + i + '">▲</button><button data-down="' + i + '">▼</button></div>');
    box.appendChild(n);
  });

  if (ro) return;
  Array.prototype.forEach.call(box.querySelectorAll('[data-up]'), function (b) {
    b.onclick = function () { move(Number(b.getAttribute('data-up')), -1); };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-down]'), function (b) {
    b.onclick = function () { move(Number(b.getAttribute('data-down')), 1); };
  });
  wireDrag(box);
}

function move(i, dir) {
  var arr = S.rankDraft.items, j = i + dir;
  if (j < 0 || j >= arr.length) return;
  var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  S.rankDraft.dirty = true;
  paintRankList();
}

function wireDrag(box) {
  var dragFrom = null;
  Array.prototype.forEach.call(box.children, function (n) {
    n.ondragstart = function (e) {
      dragFrom = Number(n.getAttribute('data-i'));
      n.className = 'rank-item drag';
      try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (err) {}
      e.dataTransfer.effectAllowed = 'move';
    };
    n.ondragend = function () { n.className = 'rank-item'; };
    n.ondragover = function (e) { e.preventDefault(); n.className = 'rank-item over'; };
    n.ondragleave = function () { n.className = 'rank-item'; };
    n.ondrop = function (e) {
      e.preventDefault();
      n.className = 'rank-item';
      var to = Number(n.getAttribute('data-i'));
      if (dragFrom === null || dragFrom === to) return;
      var arr = S.rankDraft.items;
      arr.splice(to, 0, arr.splice(dragFrom, 1)[0]);
      S.rankDraft.dirty = true;
      dragFrom = null;
      paintRankList();
    };
  });
}

function saveRankOrder() {
  var d = S.rankDraft;
  if (!d || d.readonly) return;
  var field = d.type === 'series' ? FIELDS.SR : (d.type === 'overall' ? FIELDS.OR : FIELDS.BR);
  commitOrder(field, d.person, d.items.map(function (i) { return i.id; }), 'Order saved')
    .then(function (ok2) {
      if (!ok2) return;
      d.dirty = false;
      buildRankList();          // rebuild from memory, no round trip back
    });
}

/* =====================================================================
   COMBO BOXES  (existing values + "add new…")
   ===================================================================== */
function combo(selId, inputId, values, noun, current) {
  var sel = $(selId), input = $(inputId);
  if (!sel || !input) return;
  sel.innerHTML = '';
  var blank = el('option'); blank.value = ''; blank.textContent = '—';
  sel.appendChild(blank);
  values.forEach(function (v) {
    var o = el('option'); o.value = v; o.textContent = v; sel.appendChild(o);
  });
  var add = el('option');
  add.value = NEW_VALUE;
  add.textContent = '➕  New ' + noun + '…';
  sel.appendChild(add);

  if (current && values.indexOf(current) === -1 && keyOf(current)) {
    var o2 = el('option'); o2.value = current; o2.textContent = current;
    sel.insertBefore(o2, add);
  }
  sel.value = current || '';
  input.value = '';
  input.style.display = 'none';

  sel.onchange = function () {
    var isNew = sel.value === NEW_VALUE;
    input.style.display = isNew ? 'block' : 'none';
    if (isNew) input.focus();
    if (selId === 'f-series-sel') onSeriesPicked();
  };
}

function comboValue(selId, inputId) {
  var sel = $(selId), input = $(inputId);
  if (!sel) return '';
  if (sel.value === NEW_VALUE) return (input ? input.value.trim() : '');
  return sel.value;
}

function buildCombos() {
  combo('f-series-sel', 'f-series', (S.data.series || []).map(function (s) { return s.name; }), 'series', '');
  combo('f-author-sel', 'f-author', S.data.authors || [], 'author', '');
  combo('f-narrator-sel', 'f-narrator', S.data.narrators || [], 'narrator', '');
  combo('f-genre-sel', 'f-genre', S.data.genres || [], 'genre', '');
}

/* =====================================================================
   ADD
   ===================================================================== */
function onSeriesPicked() {
  var name = comboValue('f-series-sel', 'f-series');
  var s = seriesByName(name);
  var hint = $('addHint');
  if (!s) {
    hint.textContent = name ? 'New series — it will be created when you add this book.' : '';
    return;
  }
  setComboIfEmpty('f-author-sel', 'f-author', s.author);
  setComboIfEmpty('f-genre-sel', 'f-genre', s.genre);
  setComboIfEmpty('f-narrator-sel', 'f-narrator', commonNarrator(name));
  if (!$('f-finished').value) $('f-finished').value = keyOf(s.finished) === 'yes' ? 'Yes' : (keyOf(s.finished) === 'no' ? 'No' : '');
  if (!$('f-next').value) $('f-next').value = s.nextRelease || '';
  if (!$('f-booknum').value) {
    var nums = S.data.books.filter(function (b) { return keyOf(b.series) === keyOf(name); })
      .map(function (b) { return parseFloat(b.bookNum); }).filter(function (n) { return !isNaN(n); });
    if (nums.length) $('f-booknum').value = Math.max.apply(null, nums) + 1;
  }
  hint.textContent = s.name + ' already has ' + s.count + ' book' + (s.count === 1 ? '' : 's') +
    '. Everyone\'s series ratings and rankings carry over automatically.';
}

function setComboIfEmpty(selId, inputId, value) {
  if (!value) return;
  var sel = $(selId);
  if (!sel || sel.value) return;
  for (var i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value === value) { sel.value = value; return; }
  }
}

function addBook() {
  var title = $('f-title').value.trim();
  if (!title) { toast('Title is required', true); return; }
  var isSeries = S.addType === 'Series';
  var series = isSeries ? comboValue('f-series-sel', 'f-series') : '';
  if (isSeries && !series) { toast('Pick a series, or choose "New series…"', true); return; }

  var payload = {
    title: title,
    series: series,
    type: S.addType,
    bookNum: isSeries ? $('f-booknum').value.trim() : '',
    author: comboValue('f-author-sel', 'f-author'),
    narrator: comboValue('f-narrator-sel', 'f-narrator'),
    genre: comboValue('f-genre-sel', 'f-genre'),
    finished: $('f-finished').value,
    released: $('f-released').value.trim(),
    nextRelease: isSeries ? $('f-next').value.trim() : ''
  };

  busy(true);
  $('addBtn').disabled = true;
  call('addBook', payload).then(function (res) {
    busy(false);
    $('addBtn').disabled = false;
    if (!res || !res.ok) { toast(res && res.error || 'Could not add', true); return; }
    toast(res.message || 'Added');
    $('f-title').value = '';
    $('f-booknum').value = '';
    $('f-released').value = '';
    $('addHint').textContent = '';
    var newRow = res.row;
    // Land on your own ratings for the new book, even if you were browsing someone else's.
    if (S.self && S.me !== S.self) setViewing(S.self);
    refresh(true).then(function () { go('library'); if (newRow) openBook(newRow); });
  }).catch(function (e) {
    busy(false); $('addBtn').disabled = false;
    toast((e && e.message) || 'Could not add', true);
  });
}

function applyAddType() {
  var isSeries = S.addType === 'Series';
  $('seriesFields').style.display = isSeries ? 'block' : 'none';
  $('nextWrap').style.display = isSeries ? 'block' : 'none';
  $('finLabel').textContent = isSeries ? 'Series finished?' : 'Finished reading?';
  $('addHint').textContent = '';
}

/* =====================================================================
   PEOPLE  —  everyone's columns, who holds them, and your own rename
   ===================================================================== */
function accountFor(rater) {
  var list = (S.data && S.data.accounts) || [];
  for (var i = 0; i < list.length; i++) if (keyOf(list[i].rater) === keyOf(rater)) return list[i];
  return null;
}

function renderPeople() {
  var box = $('peopleList');
  box.innerHTML = '';
  var people = S.data.people || [];
  if (!people.length) { box.innerHTML = '<div class="empty">No raters yet.</div>'; return; }
  people.forEach(function (p) {
    var readSer = (S.data.series || []).filter(function (s) { return readSeries(s.name, p); }).length;
    var scored = S.data.books.filter(function (b) { return has((b.ratings[p] || {})[FIELDS.BRT]); }).length;
    var acct = accountFor(p);
    var who = p === S.self ? '<span class="tag good">you</span>'
      : (acct && acct.active ? '<span class="tag">' + esc(acct.name) + '</span>'
                             : '<span class="tag unread">not signed in yet</span>');
    var canRename = p === S.self || S.isAdmin;
    var n = el('div', 'rank-item');
    n.innerHTML = '<div class="avatar" style="width:32px;height:32px;font-size:12px">' + esc(initials(p)) + '</div>' +
      '<div class="grow"><div style="font-weight:650">' + esc(p) + ' ' + who + '</div>' +
      '<div class="tiny muted">' + readSer + ' series read · ' + scored + ' books scored</div></div>' +
      '<button class="btn sm" data-view="' + esc(p) + '">' + (p === S.self ? 'Mine' : 'View') + '</button>' +
      (canRename ? '<button class="btn sm" data-rename="' + esc(p) + '">Rename</button>' : '');
    box.appendChild(n);
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-view]'), function (b) {
    b.onclick = function () { setViewing(b.getAttribute('data-view')); go('library'); };
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-rename]'), function (b) {
    b.onclick = function () {
      var old = b.getAttribute('data-rename');
      var nn = prompt('Rename ' + old + ' to:', old);
      if (!nn || nn === old) return;
      busy(true);
      call2('renamePerson', old, nn).then(function (res) {
        busy(false);
        if (!res || !res.ok) { toast(res && res.error || 'Failed', true); return; }
        if (S.me === old) S.me = nn;
        toast(res.message);
        refresh(true);
      }).catch(function (e) { busy(false); toast((e && e.message) || 'Failed', true); });
    };
  });
}

function renderAccountCard() {
  var u = S.user || {};
  $('acctAvatar').textContent = initials(u.name || S.self || '?');
  $('acctName').textContent = u.name || 'Signed in';
  $('acctSub').textContent = (S.self ? 'Rating as ' + S.self : 'No rating column yet') +
    (S.isAdmin ? ' · admin' : '');
}

function renderSheetInfo() {
  $('sheetInfo').innerHTML = 'Tab <b>' + esc(S.data.sheetName) + '</b> · ' + S.data.books.length +
    ' rows · ' + (S.data.people || []).length + ' raters';
  // Only the owner can open the sheet, so the Import tab path is admin-only.
  $('impTabChip').style.display = S.isAdmin ? '' : 'none';
  if (S.data.spreadsheetUrl) $('openSheet').href = S.data.spreadsheetUrl;
}

/* =====================================================================
   IMPORT
   ===================================================================== */
function updateImportTabStatus() {
  var n = S.data ? S.data.importPending : 0;
  $('importTabStatus').innerHTML = n
    ? '<span class="tag acc">' + n + ' row' + (n === 1 ? '' : 's') + ' waiting in the Import tab</span>'
    : '<span class="muted">Import tab is empty.</span>';
}

function doPreview(rows, source) {
  busy(true);
  call('previewImport', rows).then(function (res) {
    busy(false);
    if (!res || !res.ok) { toast(res && res.error || 'Preview failed', true); return; }
    S.importRows = res.preview.newBooks;
    S.importSource = source;
    paintPreview(res.preview);
  }).catch(function (e) { busy(false); toast((e && e.message) || 'Preview failed', true); });
}

function paintPreview(p) {
  var box = $('previewBox'), n = p.newBooks.length;
  var html = '<hr class="sep" style="margin:4px 0 14px">';
  html += '<div class="wrapflex" style="margin-bottom:10px">' +
    '<span class="tag good">' + n + ' new</span>' +
    (p.duplicates.length ? '<span class="tag warn">' + p.duplicates.length + ' already there</span>' : '') +
    (p.invalid.length ? '<span class="tag" style="background:var(--bad-soft);color:var(--bad)">' + p.invalid.length + ' unusable</span>' : '') +
    (p.newSeries.length ? '<span class="tag acc">' + p.newSeries.length + ' new series</span>' : '') + '</div>';

  if (p.newSeries.length) {
    html += '<div class="tiny muted" style="margin-bottom:10px">New series: ' + p.newSeries.map(esc).join(', ') + '</div>';
  }

  if (n) {
    html += '<div class="scroll-x" style="max-height:280px;overflow-y:auto;border:1px solid var(--line);border-radius:8px">' +
      '<table class="tbl"><thead><tr><th>Title</th><th>Series</th><th class="num">#</th><th>Author</th></tr></thead><tbody>';
    p.newBooks.slice(0, 200).forEach(function (r) {
      html += '<tr><td>' + esc(r.title) + '</td><td class="muted">' + esc(r.series || '—') +
        '</td><td class="num muted">' + esc(r.bookNum || '') + '</td><td class="muted">' + esc(r.author || '') + '</td></tr>';
    });
    html += '</tbody></table></div>';
    if (n > 200) html += '<div class="tiny muted" style="margin-top:6px">…and ' + (n - 200) + ' more.</div>';
    html += '<button class="btn primary block" id="commitBtn" style="margin-top:12px">Import ' + n + ' book' + (n === 1 ? '' : 's') + '</button>';
  } else {
    html += '<div class="small muted">Nothing new to import.</div>';
    if (S.importSource === 'tab' && p.duplicates.length) {
      html += '<button class="btn block" id="clearTabBtn" style="margin-top:10px">Clear the Import tab anyway</button>';
    }
  }

  if (p.duplicates.length) {
    html += '<details style="margin-top:10px"><summary class="small muted" style="cursor:pointer">Skipped rows</summary>' +
      '<div class="tiny muted" style="margin-top:6px">' +
      p.duplicates.slice(0, 60).map(function (d) { return esc(d.title) + ' — ' + esc(d._reason || 'duplicate'); }).join('<br>') +
      '</div></details>';
  }

  box.innerHTML = html;
  if ($('commitBtn')) $('commitBtn').onclick = commitImport;
  if ($('clearTabBtn')) $('clearTabBtn').onclick = function () {
    call('clearImportTab').then(function () { toast('Import tab cleared'); refresh(true); $('previewBox').innerHTML = ''; });
  };
}

function commitImport() {
  if (!S.importRows || !S.importRows.length) return;
  var btn = $('commitBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Importing…';
  busy(true);
  call('commitImport', S.importRows).then(function (res) {
    busy(false);
    if (!res || !res.ok) { toast(res && res.error || 'Import failed', true); btn.disabled = false; btn.textContent = 'Retry import'; return; }
    toast(res.message);
    $('previewBox').innerHTML = '';
    $('csvText').value = '';
    S.importRows = null;
    if (S.importSource === 'tab') call('clearImportTab').then(function () { refresh(true); });
    else refresh(true);
  }).catch(function (e) { busy(false); toast((e && e.message) || 'Import failed', true); btn.disabled = false; });
}

function previewFromText() {
  var text = $('csvText').value;
  if (!text.trim()) { toast('Paste some rows first', true); return; }
  busy(true);
  call('parseDelimited', text).then(function (res) {
    busy(false);
    if (!res || !res.ok) { toast(res && res.error || 'Could not read that', true); return; }
    if (!res.rows.length) { toast('No rows found', true); return; }
    doPreview(res.rows, 'paste');
  }).catch(function (e) { busy(false); toast((e && e.message) || 'Could not read that', true); });
}

function syncFromTab() {
  busy(true);
  call('readImportTab').then(function (res) {
    busy(false);
    if (!res || !res.ok) { toast(res && res.error || 'Could not read the Import tab', true); return; }
    if (!res.rows.length) { toast('The Import tab is empty', true); return; }
    doPreview(res.rows, 'tab');
  }).catch(function (e) { busy(false); toast((e && e.message) || 'Could not read the Import tab', true); });
}

function handleFile(file) {
  if (!file) return;
  var rd = new FileReader();
  rd.onload = function () { $('csvText').value = String(rd.result || '').slice(0, 400000); previewFromText(); };
  rd.readAsText(file);
}

/* =====================================================================
   WIRING
   ===================================================================== */
document.addEventListener('DOMContentLoaded', function () {

  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {
    b.onclick = function () { go(b.getAttribute('data-go')); };
  });
  $('fab').onclick = function () { go('add'); };
  $('goAdd').onclick = function () { go('add'); };
  $('goRank').onclick = function () { go('rank'); };
  $('fab').className = 'fab on';

  $('whoSelect').onchange = function () { setViewing($('whoSelect').value); };
  $('backToMe').onclick = function () { if (S.self) setViewing(S.self); };
  $('accountBtn').onclick = function () { if (window.Auth) Auth.openAccount(); };
  $('openAccount').onclick = function () { if (window.Auth) Auth.openAccount(); };

  var qTimer;
  $('q').oninput = function () {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { S.q = $('q').value.trim(); renderLibrary(); }, 180);
  };
  $('sortBy').onchange = renderLibrary;
  $('groupToggle').onclick = function () {
    S.grouped = !S.grouped;
    $('groupToggle').textContent = S.grouped ? 'Grouped' : 'Flat list';
    $('groupToggle').className = 'chip' + (S.grouped ? '' : ' on');
    renderLibrary();
  };

  $('closeModal').onclick = closeModal;
  $('scrim').onclick = function (e) { if (e.target === $('scrim')) closeModal(); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  /* top 20 */
  $('topPerson').onchange = renderTop;
  Array.prototype.forEach.call(document.querySelectorAll('[data-top]'), function (b) {
    b.onclick = function () {
      S.topTab = b.getAttribute('data-top');
      Array.prototype.forEach.call(document.querySelectorAll('[data-top]'), function (x) {
        x.className = 'chip' + (x === b ? ' on' : '');
      });
      renderTop();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-topsub]'), function (b) {
    b.onclick = function () {
      S.topSub = b.getAttribute('data-topsub');
      Array.prototype.forEach.call(document.querySelectorAll('[data-topsub]'), function (x) {
        x.className = 'chip' + (x === b ? ' on' : '');
      });
      renderTop();
    };
  });

  /* radar */
  Array.prototype.forEach.call(document.querySelectorAll('[data-radar]'), function (b) {
    b.onclick = function () {
      S.radarTab = b.getAttribute('data-radar');
      Array.prototype.forEach.call(document.querySelectorAll('[data-radar]'), function (x) {
        x.className = 'chip' + (x === b ? ' on' : '');
      });
      renderRadar();
    };
  });

  /* reorder */
  $('rankType').onchange = buildRankList;
  $('rankPerson').onchange = buildRankList;
  $('rankSeries').onchange = buildRankList;
  $('rankSave').onclick = saveRankOrder;
  $('rankSortByRating').onclick = function () {
    if (!S.rankDraft || S.rankDraft.readonly) return;
    S.rankDraft.items.sort(function (a, b) {
      return nullLastDesc(b.score) - nullLastDesc(a.score) || String(a.label).localeCompare(String(b.label));
    });
    S.rankDraft.dirty = true;
    paintRankList();
    toast('Sorted by rating — press Save to keep it');
  };

  /* add */
  Array.prototype.forEach.call(document.querySelectorAll('[data-addtype]'), function (b) {
    b.onclick = function () {
      S.addType = b.getAttribute('data-addtype');
      Array.prototype.forEach.call(document.querySelectorAll('[data-addtype]'), function (x) {
        x.className = 'chip' + (x === b ? ' on' : '');
      });
      applyAddType();
    };
  });
  $('f-series').oninput = onSeriesPicked;
  $('addBtn').onclick = addBook;
  applyAddType();

  $('refreshBtn').onclick = function () { refresh(); toast('Reloaded'); };

  /* import */
  Array.prototype.forEach.call(document.querySelectorAll('[data-imp]'), function (b) {
    b.onclick = function () {
      var which = b.getAttribute('data-imp');
      Array.prototype.forEach.call(document.querySelectorAll('[data-imp]'), function (x) {
        x.className = 'chip' + (x === b ? ' on' : '');
      });
      $('imp-paste').style.display = which === 'paste' ? 'block' : 'none';
      $('imp-tab').style.display = which === 'tab' ? 'block' : 'none';
      $('previewBox').innerHTML = '';
    };
  });
  $('previewBtn').onclick = previewFromText;
  $('syncTabBtn').onclick = syncFromTab;

  var dz = $('dropzone');
  dz.onclick = function () { $('fileInput').click(); };
  $('fileInput').onchange = function (e) { handleFile(e.target.files[0]); };
  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.className = 'dropzone hot'; });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.className = 'dropzone'; });
  });
  dz.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // No boot() here any more — auth.js signs you in, then calls startApp().
});
