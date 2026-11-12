/**
 * ============================================================================
 *  BOOK LIST APP  —  Server side (Google Apps Script)
 * ============================================================================
 *  Works directly against the existing "wide" spreadsheet layout:
 *
 *    Row 1 : merged person banners ...............  "Beau Section" | "Kyler Section"
 *    Row 2 : column headers ......................  Title | Series | ... | Book Rating | ...
 *    Row 3+: data
 *
 *  Each person occupies a repeating block of columns:
 *      Series Ranking | Series Rating | Book Ranking | Book Rating |
 *      Overall Ranking | Read
 *
 *  "Series Ranking"  = where the series sits on that person's all-time list
 *  "Series Rating"   = a 1-10 score for the series, independent of the list
 *  "Book Ranking"    = the book's rank WITHIN its series
 *  "Overall Ranking" = the book's rank across the whole library
 *  "Read"            = Yes / No / blank. Blank means "work it out from the
 *                      scores"; Yes or No is an explicit answer that wins.
 *
 *  setup() adds any of these columns that aren't there yet, plus the
 *  book-level "Release Date" column, without disturbing existing data.
 *
 *  GITHUB VERSION (Nov 2026): the web page now lives on GitHub Pages.
 *  doGet() / include() moved to Api.gs, which is the only way in from the
 *  outside — every call is checked against the signed-in user there before
 *  it reaches the functions in this file. Nothing below serves HTML.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
var CONFIG = {
  SPREADSHEET_ID: '1uiPvu9CmEWlkjS0sz8jux5RLiB7WlGaj-Wxf3tRd39E',
  IMPORT_TAB: 'Import',
  HEADER_ROW: 2,           // row holding the column names
  BANNER_ROW: 1,           // row holding "<Name> Section" merged banners
  DATA_START_ROW: 3,       // first row of real data
  APP_TITLE: 'Book List',
  READ_CONTROL: 'dropdown' // 'dropdown' (Yes / No) or 'checkbox' (TRUE / FALSE)
};

var CORE_FIELDS = ['Title', 'Series', 'Type', 'Book #', 'Author', 'Narrator', 'Genre', 'Finished', 'Release Date'];
var PERSON_FIELDS = ['Series Ranking', 'Series Rating', 'Book Ranking', 'Book Rating', 'Overall Ranking', 'Read'];
var TAIL_FIELDS = ['Next Book Released Date'];

// Person fields holding text rather than a number.
var PERSON_TEXT_FIELDS = ['Read'];

// Core columns that get added if the sheet doesn't have them yet,
// as [field, insert immediately after this existing column].
var CORE_ADDITIONS = [['Release Date', 'Finished'], ['Narrator', 'Author']];

// Header spellings that mean the same column. Whatever is already in the sheet
// keeps its own wording — nothing is renamed.
var HEADER_ALIASES = {
  'Release Date': ['Released Date', 'Release date', 'Released', 'Published', 'Publication Date'],
  'Book #': ['Book Number', 'Book No', 'Book No.', '#'],
  'Narrator': ['Audiobook Narrator', 'Narrated By', 'Narrated by', 'Reader', 'Voice'],
  'Next Book Released Date': ['Next Book Release Date', 'Next Release', 'Next Book']
};

// Fields that are properties of the SERIES, not of an individual book.
// Editing them anywhere propagates to every row of that series.
var SERIES_LEVEL_CORE = ['Type', 'Genre', 'Finished'];
var SERIES_LEVEL_TAIL = ['Next Book Released Date'];
var SERIES_LEVEL_PERSON = ['Series Ranking', 'Series Rating'];


// ---------------------------------------------------------------------------
// WEB APP ENTRY POINT  —  moved to Api.gs (doGet / doPost)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// SPREADSHEET / LAYOUT HELPERS
// ---------------------------------------------------------------------------

function ss_() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

/** Finds the main data tab: the first sheet whose header row contains "Title". */
function mainSheet_() {
  var book = ss_();
  var sheets = book.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    if (sh.getName() === CONFIG.IMPORT_TAB) continue;
    if (sh.getLastColumn() < 3 || sh.getLastRow() < CONFIG.HEADER_ROW) continue;
    var hdr = sh.getRange(CONFIG.HEADER_ROW, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(function (v) { return String(v).trim(); });
    if (hdr.indexOf('Title') !== -1) return sh;
  }
  throw new Error('Could not find the book list tab. Expected a sheet with "Title" in row ' +
    CONFIG.HEADER_ROW + '.');
}

function norm_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim();
}

function key_(v) {
  return norm_(v).toLowerCase();
}

/** Empty string for blanks, otherwise the raw value trimmed if it's a string. */
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'MMMM d, yyyy');
  if (typeof v === 'string') return v.trim();
  return v;
}

function num_(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

/** Normalises whatever is in a Read cell to 'Yes', 'No', or null (= undecided). */
function readFlag_(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  var s = norm_(v);
  if (!s) return null;
  if (/^(y|yes|true|read|done|1|x|✓)$/i.test(s)) return 'Yes';
  if (/^(n|no|false|unread|0)$/i.test(s)) return 'No';
  return null;
}

/** Locates a column by its canonical name or any accepted alias. */
function findHeader_(header, field) {
  var names = [field].concat(HEADER_ALIASES[field] || []);
  for (var i = 0; i < names.length; i++) {
    for (var c = 0; c < header.length; c++) {
      if (key_(header[c]) === key_(names[i])) return c;
    }
  }
  return -1;
}

/**
 * Reads the sheet's shape.
 * Returns { sheet, lastCol, core:{Title:1,...}, tail:{...},
 *           people:[{name, start, cols:{'Series Rating':9,...}}] }
 *
 * Memoised for the life of one execution. Apps Script globals reset between
 * calls, so this can never serve a stale layout to a later request — it just
 * stops loops like addMissingBooks() re-reading the header rows every pass.
 * Anything that adds or moves a COLUMN must call forgetLayout_().
 */
var LAYOUT_MEMO_ = null;

function forgetLayout_() { LAYOUT_MEMO_ = null; }

function readLayout_(sheet) {
  if (!sheet && LAYOUT_MEMO_) return LAYOUT_MEMO_;
  sheet = sheet || mainSheet_();
  var lastCol = sheet.getLastColumn();
  var banner = sheet.getRange(CONFIG.BANNER_ROW, 1, 1, lastCol).getValues()[0].map(norm_);
  var header = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, lastCol).getValues()[0].map(norm_);

  var core = {}, tail = {};
  CORE_FIELDS.forEach(function (f) {
    var idx = findHeader_(header, f);
    if (idx !== -1) core[f] = idx + 1;
  });
  TAIL_FIELDS.forEach(function (f) {
    var idx = findHeader_(header, f);
    if (idx !== -1) tail[f] = idx + 1;
  });

  if (!core['Title']) throw new Error('Missing a "Title" column in row ' + CONFIG.HEADER_ROW + '.');

  // Person blocks start where a banner cell is non-empty AND the header under it
  // is one of the person field names.
  var people = [];
  for (var c = 0; c < lastCol; c++) {
    if (!banner[c]) continue;
    if (PERSON_FIELDS.indexOf(header[c]) === -1) continue;
    var name = banner[c].replace(/\s*section\s*$/i, '').trim();
    if (!name) continue;

    // Walk forward while headers keep looking like person fields and no new banner starts.
    var cols = {};
    var cc = c;
    while (cc < lastCol) {
      if (cc > c && banner[cc]) break;                       // next person's banner
      if (PERSON_FIELDS.indexOf(header[cc]) === -1) break;   // left the block
      if (cols[header[cc]] === undefined) cols[header[cc]] = cc + 1;
      cc++;
    }
    people.push({ name: name, start: c + 1, end: cc, cols: cols });
    c = cc - 1;
  }

  var lay = { sheet: sheet, lastCol: lastCol, core: core, tail: tail,
    people: people, header: header };
  LAYOUT_MEMO_ = lay;
  return lay;
}


// ---------------------------------------------------------------------------
// SETUP  —  run once from the editor
// ---------------------------------------------------------------------------

/**
 * Prepares the spreadsheet:
 *   1. adds the "Overall Ranking" column to any person block missing it
 *   2. creates the "Import" staging tab
 * Safe to run repeatedly.
 */
function setup() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var core = ensureCoreColumns_();
    var added = ensurePersonFields_();
    applyReadValidation_();
    ensureImportTab_();
    var lay = readLayout_();
    var msg = 'Setup complete.\n\n' +
      'Tab: ' + lay.sheet.getName() + '\n' +
      'Read control: ' + CONFIG.READ_CONTROL + '\n' +
      'People: ' + lay.people.map(function (p) { return p.name; }).join(', ') + '\n' +
      'Books: ' + Math.max(0, lay.sheet.getLastRow() - CONFIG.DATA_START_ROW + 1) + '\n' +
      'Core columns added: ' + (core.length ? core.join(', ') : 'none') + '\n' +
      'Rating columns added: ' + (added.length ? added.join(', ') : 'none') + '\n' +
      'Import tab: ready';
    Logger.log(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/** Adds any missing book-level column (currently just Release Date). */
function ensureCoreColumns_() {
  forgetLayout_();
  var sheet = mainSheet_();
  var added = [];
  CORE_ADDITIONS.forEach(function (pair) {
    var field = pair[0], afterField = pair[1];
    var lay = readLayout_(sheet);
    if (lay.core[field]) return;
    var anchor = lay.core[afterField];
    if (!anchor) anchor = lay.core['Title'];
    forgetLayout_();
    sheet.insertColumnAfter(anchor);
    var newCol = anchor + 1;
    sheet.getRange(CONFIG.HEADER_ROW, newCol).setValue(field);
    sheet.getRange(CONFIG.HEADER_ROW, anchor).copyTo(
      sheet.getRange(CONFIG.HEADER_ROW, newCol),
      SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sheet.getRange(CONFIG.HEADER_ROW, newCol).setValue(field);
    added.push(field);
  });
  return added;
}

/**
 * Makes sure every person's block has all of PERSON_FIELDS, appending any
 * that are missing to the end of their block and re-merging their banner.
 */
function ensurePersonFields_() {
  forgetLayout_();
  var sheet = mainSheet_();
  var added = [];
  // Re-read the layout after each insert because column indexes shift.
  for (var guard = 0; guard < 200; guard++) {
    var lay = readLayout_(sheet);
    var target = null, missing = null;
    for (var i = 0; i < lay.people.length && !target; i++) {
      for (var f = 0; f < PERSON_FIELDS.length; f++) {
        if (!lay.people[i].cols[PERSON_FIELDS[f]]) {
          target = lay.people[i];
          missing = PERSON_FIELDS[f];
          break;
        }
      }
    }
    if (!target) break;

    var insertAt = target.end;              // last column of the block
    forgetLayout_();
    sheet.insertColumnAfter(insertAt);
    var newCol = insertAt + 1;
    sheet.getRange(CONFIG.HEADER_ROW, newCol).setValue(missing);

    // Extend the banner merge to cover the new column.
    var label = norm_(sheet.getRange(CONFIG.BANNER_ROW, target.start).getValue())
      || (target.name + ' Section');
    setBanner_(sheet, target.start, newCol - target.start + 1, label);
    added.push(target.name + ' → ' + missing);
  }
  return added;
}

/**
 * Turns every person's Read column into a proper control — a Yes/No dropdown
 * by default, or a tickbox if CONFIG.READ_CONTROL is 'checkbox'. Applied to
 * the whole column below the header so new rows inherit it.
 *
 * Existing values are untouched: a dropdown with "Reject input" off would let
 * stray text through, so it warns instead of blocking, and switching to
 * checkbox leaves any Yes/No text readable by the app either way.
 */
function applyReadValidation(style) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var n = applyReadValidation_(style);
    SpreadsheetApp.flush();
    return { ok: true, columns: n,
      message: 'Read control applied to ' + n + ' column' + (n === 1 ? '' : 's') + '.' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

function applyReadValidation_(style) {
  style = (style || CONFIG.READ_CONTROL || 'dropdown').toLowerCase();
  var lay = readLayout_();
  var sheet = lay.sheet;
  var lastRow = Math.max(sheet.getMaxRows(), CONFIG.DATA_START_ROW);
  var height = lastRow - CONFIG.DATA_START_ROW + 1;
  if (height < 1) return 0;

  var rule = (style === 'checkbox')
    ? SpreadsheetApp.newDataValidation().requireCheckbox().setAllowInvalid(true).build()
    : SpreadsheetApp.newDataValidation()
        .requireValueInList(['Yes', 'No'], true)
        .setAllowInvalid(true)
        .setHelpText('Yes = read it. No = have not read it. Blank = let the app work it out.')
        .build();

  var count = 0;
  lay.people.forEach(function (p) {
    var col = p.cols['Read'];
    if (!col) return;
    var range = sheet.getRange(CONFIG.DATA_START_ROW, col, height, 1);
    range.clearDataValidations();
    range.setDataValidation(rule);
    range.setHorizontalAlignment('center');
    count++;
  });
  return count;
}

/** Convenience wrappers you can pick straight from the Run menu. */
function useReadDropdowns() { return applyReadValidation('dropdown'); }
function useReadCheckboxes() { return applyReadValidation('checkbox'); }

/**
 * Re-merges a person's banner across `width` columns and writes the label.
 * The label goes on the top-left cell only — the rest of a merged range is
 * a shadow that reads back blank, which is exactly what readLayout_() uses
 * to tell where one person's block ends and the next begins.
 */
function setBanner_(sheet, startCol, width, label) {
  forgetLayout_();            // the banner is what defines where a person's block starts
  var range = sheet.getRange(CONFIG.BANNER_ROW, startCol, 1, width);
  range.breakApart();
  range.merge();
  sheet.getRange(CONFIG.BANNER_ROW, startCol).setValue(label);
  range.setHorizontalAlignment('center');
}

function ensureImportTab_() {
  var book = ss_();
  var sh = book.getSheetByName(CONFIG.IMPORT_TAB);
  var headers = ['Title', 'Series', 'Type', 'Book #', 'Author', 'Narrator', 'Genre', 'Finished', 'Release Date', 'Next Book Released Date'];
  if (!sh) {
    sh = book.insertSheet(CONFIG.IMPORT_TAB);
  }
  var existing = sh.getRange(1, 1, 1, headers.length).getValues()[0].map(norm_);
  if (existing.join('|') !== headers.join('|')) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#e8eaf6');
    sh.setFrozenRows(1);
    sh.getRange(2, 1, 1, 1).setNote(
      'Paste rows here (Title / Series / Type / Book # / Author / Genre / Finished / Release Date / Next Book Released Date),\n' +
      'then open the app and use Import → "Sync from Import tab".\n' +
      'Type = "Series" or "Standalone". Finished = Yes/No.\n' +
      'Rows are cleared after a successful sync.');
  }
  return sh.getName();
}


// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

/** Main payload the client renders from. */
function getData() {
  var lay = readLayout_();
  var sheet = lay.sheet;
  var lastRow = sheet.getLastRow();
  var books = [];

  if (lastRow >= CONFIG.DATA_START_ROW) {
    var n = lastRow - CONFIG.DATA_START_ROW + 1;
    var values = sheet.getRange(CONFIG.DATA_START_ROW, 1, n, lay.lastCol).getValues();

    for (var r = 0; r < n; r++) {
      var row = values[r];
      var title = norm_(row[lay.core['Title'] - 1]);
      if (!title) continue;

      var b = {
        row: CONFIG.DATA_START_ROW + r,
        title: title,
        series: lay.core['Series'] ? norm_(row[lay.core['Series'] - 1]) : '',
        type: lay.core['Type'] ? norm_(row[lay.core['Type'] - 1]) : '',
        bookNum: lay.core['Book #'] ? cell_(row[lay.core['Book #'] - 1]) : '',
        author: lay.core['Author'] ? norm_(row[lay.core['Author'] - 1]) : '',
        narrator: lay.core['Narrator'] ? norm_(row[lay.core['Narrator'] - 1]) : '',
        genre: lay.core['Genre'] ? norm_(row[lay.core['Genre'] - 1]) : '',
        finished: lay.core['Finished'] ? norm_(row[lay.core['Finished'] - 1]) : '',
        released: lay.core['Release Date'] ? cell_(row[lay.core['Release Date'] - 1]) : '',
        nextRelease: lay.tail['Next Book Released Date']
          ? cell_(row[lay.tail['Next Book Released Date'] - 1]) : '',
        ratings: {}
      };
      if (!b.type) b.type = b.series ? 'Series' : 'Standalone';

      lay.people.forEach(function (p) {
        var o = {};
        PERSON_FIELDS.forEach(function (f) {
          if (!p.cols[f]) { o[f] = null; return; }
          var raw = row[p.cols[f] - 1];
          o[f] = PERSON_TEXT_FIELDS.indexOf(f) !== -1 ? readFlag_(raw) : num_(raw);
        });
        b.ratings[p.name] = o;
      });
      books.push(b);
    }
  }

  return {
    ok: true,
    people: lay.people.map(function (p) { return p.name; }),
    fields: PERSON_FIELDS,
    books: books,
    series: buildSeries_(books, lay.people.map(function (p) { return p.name; })),
    genres: uniqueSorted_(books.map(function (b) { return b.genre; })),
    authors: uniqueSorted_(books.map(function (b) { return b.author; })),
    narrators: narratorRoster_(books),
    sheetName: lay.sheet.getName(),
    spreadsheetUrl: ss_().getUrl(),
    importPending: countImportRows_()
  };
}

function uniqueSorted_(arr) {
  var seen = {}, out = [];
  arr.forEach(function (v) {
    v = norm_(v);
    if (!v || seen[v.toLowerCase()]) return;
    seen[v.toLowerCase()] = 1;
    out.push(v);
  });
  return out.sort(function (a, b) { return a.localeCompare(b); });
}

/**
 * A book's narrators as separate names.
 *
 * Dual and full-cast recordings are stored in one cell as "Michael Kramer &
 * Kate Reading", so the credit has to be split before anyone can be counted.
 * Commas and the word "and" are accepted too, since that is how most people
 * type a cast list by hand. The one spelling to avoid is "Bevine, Victor" —
 * last-name-first would read as two people. The filled-in data all uses
 * "First Last & First Last".
 */
function splitNarrators_(v) {
  return norm_(v).split(/\s*(?:&|,|\band\b)\s*/i)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

/** Every distinct narrator across the library, A–Z. */
function narratorRoster_(books) {
  var all = [];
  books.forEach(function (b) {
    splitNarrators_(b.narrator).forEach(function (nm) { all.push(nm); });
  });
  return uniqueSorted_(all);
}

/** Rolls books up into series objects. Standalone books are not included. */
function buildSeries_(books, people) {
  var map = {}, order = [];
  books.forEach(function (b) {
    if (!b.series || b.type === 'Standalone') return;
    var k = key_(b.series);
    if (!map[k]) {
      map[k] = {
        name: b.series, key: k, count: 0, books: [],
        author: b.author, genre: b.genre, finished: b.finished,
        nextRelease: b.nextRelease, ratings: {}
      };
      people.forEach(function (p) {
        map[k].ratings[p] = { 'Series Ranking': null, 'Series Rating': null, bookRatings: [] };
      });
      order.push(k);
    }
    var s = map[k];
    s.count++;
    s.books.push(b.row);
    if (!s.author && b.author) s.author = b.author;
    if (!s.genre && b.genre) s.genre = b.genre;
    if (!s.finished && b.finished) s.finished = b.finished;
    if (!s.nextRelease && b.nextRelease) s.nextRelease = b.nextRelease;
    people.forEach(function (p) {
      var r = b.ratings[p] || {};
      if (r['Series Ranking'] !== null && s.ratings[p]['Series Ranking'] === null)
        s.ratings[p]['Series Ranking'] = r['Series Ranking'];
      if (r['Series Rating'] !== null && s.ratings[p]['Series Rating'] === null)
        s.ratings[p]['Series Rating'] = r['Series Rating'];
      if (r['Book Rating'] !== null) s.ratings[p].bookRatings.push(r['Book Rating']);
    });
  });

  return order.map(function (k) {
    var s = map[k];
    Object.keys(s.ratings).forEach(function (p) {
      var br = s.ratings[p].bookRatings;
      s.ratings[p].avgBookRating = br.length
        ? Math.round((br.reduce(function (a, b) { return a + b; }, 0) / br.length) * 10) / 10
        : null;
      delete s.ratings[p].bookRatings;
    });
    return s;
  });
}

function countImportRows_() {
  var sh = ss_().getSheetByName(CONFIG.IMPORT_TAB);
  if (!sh) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  var n = 0;
  vals.forEach(function (r) { if (norm_(r[0])) n++; });
  return n;
}


// ---------------------------------------------------------------------------
// WRITE  —  ratings & rankings
// ---------------------------------------------------------------------------

/**
 * Saves one person's values for one book.
 * Series-level fields propagate to every row of the same series.
 *
 * payload = { row: 12, person: 'Beau', values: {'Book Rating': 9, 'Series Rating': 10} }
 */
function saveRatings(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var lay = readLayout_();
    var person = findPerson_(lay, payload.person);
    var row = Number(payload.row);
    assertRow_(lay, row);

    // Only look up the series block if a series-level field is actually being
    // written — a plain book rating shouldn't pay for reading the whole column.
    var seriesRows = null;

    Object.keys(payload.values || {}).forEach(function (field) {
      if (PERSON_FIELDS.indexOf(field) === -1) return;
      var col = person.cols[field];
      if (!col) return;
      var v = payload.values[field];

      if (PERSON_TEXT_FIELDS.indexOf(field) !== -1) {
        v = readFlag_(v) || '';
      } else {
        v = (v === '' || v === null || v === undefined) ? '' : Number(v);
        if (v !== '' && isNaN(v)) v = '';
      }

      if (SERIES_LEVEL_PERSON.indexOf(field) !== -1) {
        if (seriesRows === null) seriesRows = seriesRowsFor_(lay, row);
        if (seriesRows.length) { writeDown_(lay.sheet, seriesRows, col, v); return; }
      }
      lay.sheet.getRange(row, col).setValue(v);
    });

    // No flush: Apps Script commits when the call returns, and flushing here
    // just makes the caller wait for a round trip it doesn't need.
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

function findPerson_(lay, name) {
  var want = key_(name);
  for (var i = 0; i < lay.people.length; i++) {
    if (key_(lay.people[i].name) === want) return lay.people[i];
  }
  throw new Error('Unknown person: "' + name + '". Add them first.');
}

function assertRow_(lay, row) {
  if (!row || row < CONFIG.DATA_START_ROW || row > lay.sheet.getLastRow()) {
    throw new Error('That book is no longer at row ' + row + '. Refresh and try again.');
  }
}

/**
 * Writes one value down a set of rows using as few Sheets calls as possible.
 * Series rows are contiguous, so this is almost always a single setValues —
 * where it used to be one setValue per row (38 calls for Drizzt).
 */
function writeDown_(sheet, rows, col, value) {
  if (!rows.length) return 0;
  var calls = 0, start = rows[0], prev = rows[0], run = 1;
  for (var i = 1; i <= rows.length; i++) {
    if (i < rows.length && rows[i] === prev + 1) { prev = rows[i]; run++; continue; }
    var block = [];
    for (var k = 0; k < run; k++) block.push([value]);
    sheet.getRange(start, col, run, 1).setValues(block);
    calls++;
    if (i < rows.length) { start = rows[i]; prev = rows[i]; run = 1; }
  }
  return calls;
}

/** All row numbers belonging to the same series as the given row. */
function seriesRowsFor_(lay, row) {
  if (!lay.core['Series']) return [];
  var seriesName = key_(lay.sheet.getRange(row, lay.core['Series']).getValue());
  if (!seriesName) return [];
  var last = lay.sheet.getLastRow();
  if (last < CONFIG.DATA_START_ROW) return [];
  var vals = lay.sheet.getRange(CONFIG.DATA_START_ROW, lay.core['Series'],
    last - CONFIG.DATA_START_ROW + 1, 1).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    if (key_(vals[i][0]) === seriesName) out.push(CONFIG.DATA_START_ROW + i);
  }
  return out;
}


/**
 * Writes a whole ordered ranking list at once (used by the drag/reorder screens).
 * payload = { person, field: 'Overall Ranking'|'Book Ranking'|'Series Ranking',
 *             order: [row, row, ...] }      // position in array = rank
 */
function saveRankOrder(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var lay = readLayout_();
    var person = findPerson_(lay, payload.person);
    var field = payload.field;
    if (PERSON_FIELDS.indexOf(field) === -1) throw new Error('Unknown field: ' + field);
    var col = person.cols[field];
    if (!col) throw new Error('Column "' + field + '" not found for ' + person.name + '. Run setup().');

    var order = payload.order || [];
    var lastRow = lay.sheet.getLastRow();
    if (lastRow < CONFIG.DATA_START_ROW) return { ok: true };

    var n = lastRow - CONFIG.DATA_START_ROW + 1;
    var colVals = lay.sheet.getRange(CONFIG.DATA_START_ROW, col, n, 1).getValues();

    if (field === 'Series Ranking') {
      // order is a list of series names; apply the rank to every row of that series.
      var seriesCol = lay.sheet.getRange(CONFIG.DATA_START_ROW, lay.core['Series'], n, 1).getValues();
      var rankBySeries = {};
      order.forEach(function (name, i) { rankBySeries[key_(name)] = i + 1; });
      for (var i = 0; i < n; i++) {
        var k = key_(seriesCol[i][0]);
        if (rankBySeries[k]) colVals[i][0] = rankBySeries[k];
      }
    } else {
      var rankByRow = {};
      order.forEach(function (row, i) { rankByRow[Number(row)] = i + 1; });
      for (var j = 0; j < n; j++) {
        var rowNum = CONFIG.DATA_START_ROW + j;
        if (rankByRow[rowNum]) colVals[j][0] = rankByRow[rowNum];
      }
    }

    lay.sheet.getRange(CONFIG.DATA_START_ROW, col, n, 1).setValues(colVals);
    SpreadsheetApp.flush();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}


/**
 * Sets the Read flag for one person across many rows in a single write.
 * Used by "mark whole series read" and "read through book N".
 *
 * payload = { person, marks: [{row: 12, read: 'Yes'|'No'|''}, ...] }
 */
function setRead(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var lay = readLayout_();
    var person = findPerson_(lay, payload.person);
    var col = person.cols['Read'];
    if (!col) throw new Error('No "Read" column for ' + person.name + '. Run setup().');

    var lastRow = lay.sheet.getLastRow();
    if (lastRow < CONFIG.DATA_START_ROW) return { ok: true, changed: 0 };
    var n = lastRow - CONFIG.DATA_START_ROW + 1;
    var vals = lay.sheet.getRange(CONFIG.DATA_START_ROW, col, n, 1).getValues();

    var changed = 0;
    (payload.marks || []).forEach(function (m) {
      var idx = Number(m.row) - CONFIG.DATA_START_ROW;
      if (idx < 0 || idx >= n) return;
      var want = readFlag_(m.read) || '';
      if (vals[idx][0] !== want) { vals[idx][0] = want; changed++; }
    });

    lay.sheet.getRange(CONFIG.DATA_START_ROW, col, n, 1).setValues(vals);
    SpreadsheetApp.flush();
    return { ok: true, changed: changed };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}


// ---------------------------------------------------------------------------
// WRITE  —  books
// ---------------------------------------------------------------------------

/**
 * Adds one book. If it belongs to an existing series it is inserted directly
 * after that series' last row so the sheet stays grouped, and series-level
 * values (type/genre/finished/next release + everyone's series ranking+rating)
 * are inherited automatically.
 *
 * payload = { title, series, type, bookNum, author, genre, finished, nextRelease }
 */
function addBook(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var res = addBookInternal_(payload);
    SpreadsheetApp.flush();
    return { ok: true, row: res.row, message: 'Added "' + norm_(payload.title) + '".' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

function addBookInternal_(payload, layIn) {
  var lay = layIn || readLayout_();
  var sheet = lay.sheet;
  var title = norm_(payload.title);
  if (!title) throw new Error('Title is required.');

  var series = norm_(payload.series);
  var type = norm_(payload.type) || (series ? 'Series' : 'Standalone');
  if (type === 'Standalone') series = series || '';

  // Duplicate guard: same title + same series.
  if (findBookRow_(lay, title, series) !== -1) {
    throw new Error('"' + title + '" already exists' + (series ? ' in ' + series : '') + '.');
  }

  // Where to insert.
  var insertAfter;
  var sibling = null;
  if (series) {
    var rows = rowsOfSeries_(lay, series);
    if (rows.length) {
      insertAfter = rows[rows.length - 1];
      sibling = rows[0];
    }
  }
  if (!insertAfter) insertAfter = Math.max(sheet.getLastRow(), CONFIG.HEADER_ROW);

  sheet.insertRowAfter(insertAfter);
  var row = insertAfter + 1;

  // Inherit series-level values from a sibling row, then apply explicit input.
  var out = new Array(lay.lastCol).fill('');
  if (sibling) {
    var sibVals = sheet.getRange(sibling >= row ? sibling + 1 : sibling, 1, 1, lay.lastCol).getValues()[0];
    SERIES_LEVEL_CORE.forEach(function (f) {
      if (lay.core[f]) out[lay.core[f] - 1] = sibVals[lay.core[f] - 1];
    });
    SERIES_LEVEL_TAIL.forEach(function (f) {
      if (lay.tail[f]) out[lay.tail[f] - 1] = sibVals[lay.tail[f] - 1];
    });
    if (lay.core['Author']) out[lay.core['Author'] - 1] = sibVals[lay.core['Author'] - 1];
    // Narrator is inherited as a starting point, not as a series-level field:
    // most series keep one reader, but plenty swap mid-run (ACOTAR, Drizzt,
    // The Giver Quartet), so anything typed into the form overrides this and
    // editing one book's narrator never writes down the rest of the series.
    if (lay.core['Narrator']) out[lay.core['Narrator'] - 1] = sibVals[lay.core['Narrator'] - 1];
    lay.people.forEach(function (p) {
      SERIES_LEVEL_PERSON.forEach(function (f) {
        if (p.cols[f]) out[p.cols[f] - 1] = sibVals[p.cols[f] - 1];
      });
    });
  }

  setIf_(out, lay.core['Title'], title);
  setIf_(out, lay.core['Series'], series);
  setIf_(out, lay.core['Type'], type);
  setIf_(out, lay.core['Book #'], payload.bookNum);
  setIf_(out, lay.core['Author'], payload.author);
  setIf_(out, lay.core['Narrator'], payload.narrator);
  setIf_(out, lay.core['Genre'], payload.genre);
  setIf_(out, lay.core['Finished'], payload.finished);
  setIf_(out, lay.core['Release Date'], payload.released);
  setIf_(out, lay.tail['Next Book Released Date'], payload.nextRelease);

  sheet.getRange(row, 1, 1, lay.lastCol).setValues([out]);
  return { row: row };
}

function setIf_(arr, col, value) {
  if (!col) return;
  var v = (value === null || value === undefined) ? '' : (typeof value === 'string' ? value.trim() : value);
  if (v === '') return;   // don't wipe an inherited value with a blank
  arr[col - 1] = v;
}

function rowsOfSeries_(lay, seriesName) {
  if (!lay.core['Series']) return [];
  var last = lay.sheet.getLastRow();
  if (last < CONFIG.DATA_START_ROW) return [];
  var vals = lay.sheet.getRange(CONFIG.DATA_START_ROW, lay.core['Series'],
    last - CONFIG.DATA_START_ROW + 1, 1).getValues();
  var want = key_(seriesName), out = [];
  for (var i = 0; i < vals.length; i++) {
    if (key_(vals[i][0]) === want) out.push(CONFIG.DATA_START_ROW + i);
  }
  return out;
}

function findBookRow_(lay, title, series) {
  var last = lay.sheet.getLastRow();
  if (last < CONFIG.DATA_START_ROW) return -1;
  var n = last - CONFIG.DATA_START_ROW + 1;
  var titles = lay.sheet.getRange(CONFIG.DATA_START_ROW, lay.core['Title'], n, 1).getValues();
  var seriesVals = lay.core['Series']
    ? lay.sheet.getRange(CONFIG.DATA_START_ROW, lay.core['Series'], n, 1).getValues()
    : null;
  var wt = key_(title), wsName = key_(series);
  for (var i = 0; i < n; i++) {
    if (key_(titles[i][0]) !== wt) continue;
    if (seriesVals && key_(seriesVals[i][0]) !== wsName) continue;
    return CONFIG.DATA_START_ROW + i;
  }
  return -1;
}

/** Updates the descriptive fields of a book. Series-level fields propagate. */
function updateBook(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var lay = readLayout_();
    var row = Number(payload.row);
    assertRow_(lay, row);
    var seriesRows = seriesRowsFor_(lay, row);

    var map = [
      ['title', lay.core['Title'], false],
      ['series', lay.core['Series'], false],
      ['bookNum', lay.core['Book #'], false],
      ['author', lay.core['Author'], false],
      ['narrator', lay.core['Narrator'], false],
      ['released', lay.core['Release Date'], false],
      ['type', lay.core['Type'], true],
      ['genre', lay.core['Genre'], true],
      ['finished', lay.core['Finished'], true],
      ['nextRelease', lay.tail['Next Book Released Date'], true]
    ];

    map.forEach(function (m) {
      var field = m[0], col = m[1], isSeriesLevel = m[2];
      if (!col) return;
      if (!(field in payload)) return;
      var v = payload[field];
      v = (v === null || v === undefined) ? '' : (typeof v === 'string' ? v.trim() : v);
      if (isSeriesLevel && seriesRows.length > 1) {
        writeDown_(lay.sheet, seriesRows, col, v);
      } else {
        lay.sheet.getRange(row, col).setValue(v);
      }
    });

    SpreadsheetApp.flush();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

function deleteBook(row) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var lay = readLayout_();
    row = Number(row);
    assertRow_(lay, row);
    var title = norm_(lay.sheet.getRange(row, lay.core['Title']).getValue());
    lay.sheet.deleteRow(row);
    SpreadsheetApp.flush();
    return { ok: true, message: 'Deleted "' + title + '".' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

/** Renames a series everywhere it appears. */
function renameSeries(oldName, newName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var lay = readLayout_();
    if (!lay.core['Series']) throw new Error('No Series column.');
    var rows = rowsOfSeries_(lay, oldName);
    if (!rows.length) throw new Error('Series not found: ' + oldName);
    newName = norm_(newName);
    if (!newName) throw new Error('New name is required.');
    writeDown_(lay.sheet, rows, lay.core['Series'], newName);
    SpreadsheetApp.flush();
    return { ok: true, message: 'Renamed to "' + newName + '" (' + rows.length + ' books).' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}


// ---------------------------------------------------------------------------
// WRITE  —  people
// ---------------------------------------------------------------------------

/** Inserts a new 5-column person block just before the trailing columns. */
function addPerson(name) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    name = norm_(name);
    if (!name) throw new Error('Name is required.');
    var lay = readLayout_();
    for (var i = 0; i < lay.people.length; i++) {
      if (key_(lay.people[i].name) === key_(name)) throw new Error(name + ' is already in the list.');
    }

    var sheet = lay.sheet;
    // Insert after the last person block (or after the last core column if none).
    var insertAfter = lay.people.length
      ? lay.people[lay.people.length - 1].end
      : Math.max.apply(null, Object.keys(lay.core).map(function (k) { return lay.core[k]; }));

    forgetLayout_();
    sheet.insertColumnsAfter(insertAfter, PERSON_FIELDS.length);
    var start = insertAfter + 1;

    sheet.getRange(CONFIG.HEADER_ROW, start, 1, PERSON_FIELDS.length)
      .setValues([PERSON_FIELDS]);

    setBanner_(sheet, start, PERSON_FIELDS.length, name + ' Section');

    // Copy formatting from the previous person block if there is one.
    if (lay.people.length) {
      var prev = lay.people[lay.people.length - 1];
      var srcHdr = sheet.getRange(CONFIG.HEADER_ROW, prev.start, 1, PERSON_FIELDS.length);
      srcHdr.copyTo(sheet.getRange(CONFIG.HEADER_ROW, start, 1, PERSON_FIELDS.length),
        SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      sheet.getRange(CONFIG.HEADER_ROW, start, 1, PERSON_FIELDS.length).setValues([PERSON_FIELDS]);
    } else {
      sheet.getRange(CONFIG.HEADER_ROW, start, 1, PERSON_FIELDS.length)
        .setFontWeight('bold').setHorizontalAlignment('center');
    }

    SpreadsheetApp.flush();
    return { ok: true, message: 'Added ' + name + '.' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

/** Renames a person (updates the merged banner). Ratings are untouched. */
function renamePerson(oldName, newName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    newName = norm_(newName);
    if (!newName) throw new Error('Name is required.');
    var lay = readLayout_();
    var p = findPerson_(lay, oldName);
    setBanner_(lay.sheet, p.start, p.end - p.start + 1, newName + ' Section');
    SpreadsheetApp.flush();
    return { ok: true, message: 'Renamed to ' + newName + '.' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}


// ---------------------------------------------------------------------------
// BULK IMPORT
// ---------------------------------------------------------------------------

/**
 * Analyses candidate rows without writing anything.
 * rows = [{title, series, type, bookNum, author, genre, finished, nextRelease}, ...]
 * Returns { newBooks:[], duplicates:[], invalid:[], newSeries:[] }
 */
function previewImport(rows) {
  try {
    var lay = readLayout_();
    var existing = existingIndex_(lay);
    var seen = {};
    var out = { newBooks: [], duplicates: [], invalid: [], newSeries: [] };
    var newSeriesSeen = {};

    (rows || []).forEach(function (raw, i) {
      var r = normaliseImportRow_(raw);
      r._line = i + 1;
      if (!r.title) { out.invalid.push({ line: r._line, reason: 'Missing title', raw: raw }); return; }

      var k = key_(r.title) + '||' + key_(r.series);
      if (existing[k]) { r._reason = 'Already in the list'; out.duplicates.push(r); return; }
      if (seen[k]) { r._reason = 'Duplicated inside this import'; out.duplicates.push(r); return; }
      seen[k] = 1;

      if (r.series && !existing['series::' + key_(r.series)] && !newSeriesSeen[key_(r.series)]) {
        newSeriesSeen[key_(r.series)] = 1;
        out.newSeries.push(r.series);
      }
      out.newBooks.push(r);
    });

    return { ok: true, preview: out };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/** Writes the rows returned by previewImport (already de-duplicated). */
function commitImport(rows) {
  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    var added = 0, failed = [];
    (rows || []).forEach(function (raw) {
      var r = normaliseImportRow_(raw);
      if (!r.title) return;
      try {
        addBookInternal_(r);   // re-reads layout each time; rows shift as we insert
        added++;
      } catch (e) {
        failed.push({ title: r.title, reason: String(e && e.message || e) });
      }
    });
    SpreadsheetApp.flush();
    return { ok: true, added: added, failed: failed,
      message: 'Imported ' + added + ' book' + (added === 1 ? '' : 's') +
        (failed.length ? ', ' + failed.length + ' skipped.' : '.') };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

/** Reads the Import staging tab and returns it as candidate rows. */
function readImportTab() {
  try {
    var sh = ss_().getSheetByName(CONFIG.IMPORT_TAB);
    if (!sh) return { ok: false, error: 'No "' + CONFIG.IMPORT_TAB + '" tab. Run setup() first.' };
    var last = sh.getLastRow();
    if (last < 2) return { ok: true, rows: [] };
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(norm_);
    var vals = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
    var rows = [];
    vals.forEach(function (v) {
      var o = {};
      headers.forEach(function (h, i) { if (h) o[h] = cell_(v[i]); });
      if (norm_(o['Title'])) rows.push(fromSheetHeaders_(o));
    });
    return { ok: true, rows: rows };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/** Clears the Import tab body — called after a successful sync. */
function clearImportTab() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = ss_().getSheetByName(CONFIG.IMPORT_TAB);
    if (!sh) return { ok: true };
    var last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
    SpreadsheetApp.flush();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

function fromSheetHeaders_(o) {
  return {
    title: o['Title'], series: o['Series'], type: o['Type'], bookNum: o['Book #'],
    author: o['Author'], narrator: o['Narrator'], genre: o['Genre'], finished: o['Finished'],
    released: o['Release Date'], nextRelease: o['Next Book Released Date']
  };
}

function normaliseImportRow_(raw) {
  raw = raw || {};
  var title = norm_(raw.title);
  var series = norm_(raw.series);
  var type = norm_(raw.type);
  if (!type) type = series ? 'Series' : 'Standalone';
  else if (/^s(tand.?alone)?$/i.test(type) || /alone/i.test(type)) type = 'Standalone';
  else if (/series/i.test(type)) type = 'Series';

  var fin = norm_(raw.finished);
  if (/^(y|yes|true|complete|completed|done|1)$/i.test(fin)) fin = 'Yes';
  else if (/^(n|no|false|ongoing|0)$/i.test(fin)) fin = 'No';

  return {
    title: title,
    series: type === 'Standalone' ? '' : series,
    type: type,
    bookNum: raw.bookNum === undefined || raw.bookNum === null ? '' : cell_(raw.bookNum),
    author: norm_(raw.author),
    narrator: norm_(raw.narrator),
    genre: norm_(raw.genre),
    finished: fin,
    released: raw.released === undefined || raw.released === null ? '' : cell_(raw.released),
    nextRelease: raw.nextRelease === undefined ? '' : cell_(raw.nextRelease)
  };
}

function existingIndex_(lay) {
  var idx = {};
  var last = lay.sheet.getLastRow();
  if (last < CONFIG.DATA_START_ROW) return idx;
  var n = last - CONFIG.DATA_START_ROW + 1;
  var titles = lay.sheet.getRange(CONFIG.DATA_START_ROW, lay.core['Title'], n, 1).getValues();
  var series = lay.core['Series']
    ? lay.sheet.getRange(CONFIG.DATA_START_ROW, lay.core['Series'], n, 1).getValues()
    : null;
  for (var i = 0; i < n; i++) {
    var t = key_(titles[i][0]);
    if (!t) continue;
    var s = series ? key_(series[i][0]) : '';
    idx[t + '||' + s] = CONFIG.DATA_START_ROW + i;
    if (s) idx['series::' + s] = 1;
  }
  return idx;
}


// ---------------------------------------------------------------------------
// CSV PARSING (server side so the client stays small)
// ---------------------------------------------------------------------------

/**
 * text  = raw CSV/TSV pasted or read from an uploaded file
 * Returns candidate rows using a fuzzy header match.
 */
function parseDelimited(text) {
  try {
    text = String(text || '').replace(/^﻿/, '').trim();
    if (!text) return { ok: true, rows: [] };

    var delim = ',';
    var firstLine = text.split(/\r?\n/)[0];
    if (firstLine.indexOf('\t') !== -1) delim = '\t';
    else if (firstLine.indexOf(';') > firstLine.indexOf(',')) delim = ';';

    var grid = (delim === ',')
      ? Utilities.parseCsv(text)
      : Utilities.parseCsv(text, delim);

    if (!grid.length) return { ok: true, rows: [] };

    var headers = grid[0].map(function (h) { return key_(h); });
    var alias = {
      title: ['title', 'book', 'book title', 'name'],
      series: ['series', 'series name', 'saga'],
      type: ['type', 'format', 'kind'],
      bookNum: ['book #', 'book#', 'book number', 'number', 'num', '#', 'order', 'vol', 'volume'],
      author: ['author', 'authors', 'writer', 'by'],
      narrator: ['narrator', 'narrators', 'audiobook narrator', 'narrated by', 'reader', 'voice'],
      genre: ['genre', 'category', 'genres'],
      finished: ['finished', 'complete', 'completed', 'series finished', 'done'],
      released: ['release date', 'released', 'published', 'publication date', 'pub date', 'first published', 'date'],
      nextRelease: ['next book released date', 'next release', 'next book', 'next book date', 'release date']
    };

    var map = {};
    Object.keys(alias).forEach(function (field) {
      for (var i = 0; i < headers.length; i++) {
        if (alias[field].indexOf(headers[i]) !== -1) { map[field] = i; return; }
      }
    });

    // No recognisable header row → assume positional order.
    var startAt = 1;
    if (map.title === undefined) {
      map = { title: 0, series: 1, type: 2, bookNum: 3, author: 4, genre: 5, finished: 6, released: 7, nextRelease: 8 };
      startAt = 0;
    }

    var rows = [];
    for (var r = startAt; r < grid.length; r++) {
      var line = grid[r];
      if (!line || !line.join('').trim()) continue;
      var o = {};
      Object.keys(map).forEach(function (f) {
        var i = map[f];
        o[f] = (i !== undefined && i < line.length) ? line[i] : '';
      });
      if (norm_(o.title)) rows.push(o);
    }
    return { ok: true, rows: rows, detected: Object.keys(map) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}


// ---------------------------------------------------------------------------
// SPREADSHEET MENU (convenience when you're in the sheet itself)
// ---------------------------------------------------------------------------
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('📚 Book List')
      .addItem('Run setup', 'setup')
      .addItem('Set up sign-in (Users tab)', 'setupAuth')
      .addItem('Sync Import tab now', 'menuSyncImport')
      .addToUi();
  } catch (e) { /* not opened from the sheet */ }
}

// Menu items can't call functions ending in "_", so this one is public.
// Nothing serves HTML any more, so being public doesn't expose it to anyone.
function menuSyncImport() {
  var read = readImportTab();
  if (!read.ok) { SpreadsheetApp.getUi().alert(read.error); return; }
  var pv = previewImport(read.rows);
  if (!pv.ok) { SpreadsheetApp.getUi().alert(pv.error); return; }
  var res = commitImport(pv.preview.newBooks);
  if (res.ok) clearImportTab();
  SpreadsheetApp.getUi().alert(res.ok ? res.message : res.error);
}
