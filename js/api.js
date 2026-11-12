/* =====================================================================
   Book List — talking to the Apps Script API
   ---------------------------------------------------------------------
   Replaces google.script.run. Every call is one POST of
     { action, args: [...], token }
   sent as text/plain so the browser skips the CORS preflight that Apps
   Script can't answer. The session token rides along on every call and is
   refreshed whenever the server hands back a new one.
   ===================================================================== */
var API = (function () {
  var KEY = (window.CONFIG && CONFIG.STORAGE_PREFIX || 'booklist_') + 'session';

  function token(v) {
    try {
      if (v === undefined) return localStorage.getItem(KEY);
      if (v === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, v);
    } catch (e) { /* private mode — session lasts until the tab closes */ }
    return null;
  }

  function configured() {
    return !!(window.CONFIG && CONFIG.API_URL && /^https:\/\//.test(CONFIG.API_URL));
  }

  /** API.call('saveRatings', payload) → Promise of the server's JSON. */
  function call(action) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (!configured()) return Promise.reject(new Error('API_URL is not set in js/config.js'));
    return fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, args: args, token: token() }),
      redirect: 'follow'
    }).then(function (r) {
      if (!r.ok) throw new Error('The server answered ' + r.status + '. Try again in a moment.');
      return r.json();
    }).then(function (res) {
      if (res && res.auth === false) {
        token(null);
        if (typeof API.onSignedOut === 'function') API.onSignedOut(res.error);
        var err = new Error(res.error || 'Please sign in again.');
        err.auth = true;
        throw err;
      }
      if (res && res.token) token(res.token);
      return res;
    });
  }

  return { call: call, token: token, configured: configured, onSignedOut: null };
})();
