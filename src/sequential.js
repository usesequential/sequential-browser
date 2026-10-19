/**
 * sequential.js: the Sequential browser SDK. One tag for analytics AND session replay.
 * Docs: https://www.usesequential.com/docs/sequential
 *
 * THE TAG (spec §5.6.2):
 *   <script async src="https://cdn.usesequential.com/sdk/sequential/v1/sequential.js"
 *           data-key="sq_sequential_…" data-api="https://<ingest host>"></script>
 *   data-key          REQUIRED. The project's `sequential` ingest key.
 *   data-api          REQUIRED. The CDN is not the ingest host, so it cannot be derived from src.
 *   data-opt-out      optional. Start opted out (not stored). Stops replay too, and sends no
 *                     config request until optIn().
 * OPTED OUT (G-12): no id or session value is written, no cookie, no localStorage, no sessionStorage. The ids live in
 * memory and are written on optIn(). optOut() deletes them and keeps one mark, __sq_opt=1 (the choice only), so the
 * opt-out holds across page loads; optIn() deletes it. data-opt-out writes nothing.
 *   data-autocapture="false"  optional. Autocapture is on by default.
 *   data-context-cookie-domain  optional. `Domain=` for the context cookie, for a backend on another subdomain.
 * WITHOUT ATTRIBUTES (a loader that cannot set them, such as a GTM gallery template's injectScript), set before this
 * file loads: window.sequentialConfig = { key: 'sq_sequential_…', api: 'https://<ingest host>', release: '…' }.
 * Read once, only when this file's own tag has no data-key, and only when it is an own property of window holding a
 * plain object with a valid key; otherwise the page's tags decide, as before. api must be an https origin. Only
 * key, api and release are read.
 * THE CONTEXT COOKIE `__sq_ctx` (BE spec 2026-10-12 backend SDK §4.4): the visitor id and the session id, for the
 * site's own backend. Written while the SDK records, when the value changes or the last write is 15 minutes old.
 * Path=/; SameSite=Lax; Secure on https; Max-Age = the session idle limit; no HttpOnly; no Domain unless the tag
 * sets one. optOut() and reset() clear it.
 * The install snippet's stub queues calls in `window.sequential._q`; they replay in order below.
 *
 * DELIVERY: hand-written ES5, no build step (ruling S7). The /v1/ path floats, so every fix
 * reaches every site; vercel.json serves it with max-age=300, must-revalidate (ruling S16).
 *
 * SOURCE OF TRUTH: this file restates by hand, in the FE repo,
 *   src/lib/sdk/sequential.core.ts         identity, session, batching, transport
 *   src/lib/sdk/sequential.autocapture.ts  redaction, clicks, pageviews, form submits
 * Read the reasons there. src/lib/sdk/sequential.served.test.ts runs THIS file, so a drift
 * fails. The boot, recorder and unload wiring exist only here (spec §5.5, §5.6, BE repo
 * docs/superpowers/specs/2026-09-23-sequential-sdk-design.md). The fully commented copy of this
 * file is at FE commit cac6164; this copy keeps the code byte-for-byte the same.
 *
 * Browser APIs go through `window`/`document` and elements are duck-typed, so the file runs in
 * a test window and across realms. NOTHING HERE MAY THROW INTO THE HOST PAGE, except
 * `capture()`'s reserved-name check (§5.2 / S13).
 */
(function (injectedTag) {
  'use strict';

  function noop() {}

  function logError(message) {
    try {
      if (window.console && window.console.error) window.console.error('[sequential] ' + message);
    } catch (e) {}
  }

  function logWarn(message) {
    try {
      if (window.console && window.console.warn) window.console.warn('[sequential] ' + message);
    } catch (e) {}
  }

  // sequential.core.ts ORIGIN_REFUSED_WARNING, word for word.
  var ORIGIN_REFUSED_WARNING =
    "Events refused: this website is not on the project's allowed websites (origin_not_allowed). This page sends no more events.";

  // ─── the script tag (§5.6.2) ──────────────────────────────────────────────

  // window.sequentialConfig (see the header) is page data, and the recorder loads from its api host. So it is used
  // only when it is an OWN property of window (a polluted Object.prototype or an element named sequentialConfig is
  // not) holding a plain object, and only when its key is valid; otherwise ownTag() goes on to the page's tags. It is
  // returned as a tag-shaped object, so attr()/hasAttr() and every check below them stay the same for both paths.
  var CONFIG_KEY_PATTERN = /^sq_sequential_[A-Za-z0-9]{1,64}$/;
  var CONFIG_API_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/*$/;
  var CONFIG_NAMES = ['key', 'api', 'release'];

  function ownValue(object, name) {
    return Object.prototype.hasOwnProperty.call(object, name) ? object[name] : undefined;
  }

  // Its prototype is null or an Object.prototype (of any realm: one whose own prototype is null).
  function isPlainObject(value) {
    if (!value || typeof value !== 'object') return false;
    var proto = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null;
  }

  function configString(config, name) {
    var value = ownValue(config, name);
    return typeof value === 'string' ? value.trim() : null;
  }

  function configTag() {
    try {
      var config = ownValue(window, 'sequentialConfig');
      if (!isPlainObject(config)) return null;

      var key = configString(config, 'key');
      if (key === null || !CONFIG_KEY_PATTERN.test(key)) {
        logError(
          key === null
            ? 'window.sequentialConfig has no key; it is not used.'
            : 'window.sequentialConfig.key is not a Sequential ingest key (sq_sequential_…); it is not used.'
        );
        return null;
      }
      var values = { 'data-key': key };
      var api = configString(config, 'api');
      if (api !== null) {
        if (CONFIG_API_PATTERN.test(api)) values['data-api'] = api;
        else
          logError(
            'window.sequentialConfig.api must be an https:// origin, such as https://api.usesequential.com.'
          );
      }
      var release = configString(config, 'release');
      if (release !== null && release !== '') values['data-release'] = release;

      var unread = [];
      var names = Object.keys(config);
      for (var i = 0; i < names.length; i++) {
        if (!inList(CONFIG_NAMES, names[i])) unread.push(names[i]);
      }
      if (unread.length) {
        logWarn(
          ('window.sequentialConfig.' + unread.sort().join(', ')).slice(0, 120) +
            ': not read (only key, api and release are). To hold events until consent, fire the tag after consent' +
            ' or call sequential.optOut().'
        );
      }

      return {
        getAttribute: function (name) {
          return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null;
        },
        hasAttribute: function (name) {
          return Object.prototype.hasOwnProperty.call(values, name);
        }
      };
    } catch (e) {
      return null;
    }
  }

  function ownTag() {
    try {
      var current = document.currentScript;
      if (current && current.getAttribute && current.getAttribute('data-key')) return current;

      // Before the page-wide search, which takes ANY script[data-key], another vendor's too.
      var fromConfig = configTag();
      if (fromConfig) return fromConfig;

      var tags = document.querySelectorAll('script[data-key]');
      return tags.length ? tags[tags.length - 1] : null;
    } catch (e) {
      return null;
    }
  }

  function attr(tag, name) {
    try {
      var value = tag && tag.getAttribute ? tag.getAttribute(name) : null;
      return value == null ? null : String(value);
    } catch (e) {
      return null;
    }
  }

  function hasAttr(tag, name) {
    try {
      return !!(tag && tag.hasAttribute && tag.hasAttribute(name));
    } catch (e) {
      return false;
    }
  }

  // The backend's build-identity rule (BE src/adapters/release.ts), as in sequential.core.ts.
  var RELEASE_PATTERN = /^[\x20-\x7E]{1,64}$/;
  var RELEASE_PLACEHOLDERS = ['undefined', 'null', 'none', '(null)'];

  function normalizeRelease(value) {
    if (typeof value !== 'string') return undefined;
    var s = value.trim();
    if (!RELEASE_PATTERN.test(s) || inList(RELEASE_PLACEHOLDERS, s.toLowerCase())) return undefined;
    return s;
  }

  var TAG = injectedTag || ownTag(); // injectedTag: from init() of @usesequential/browser; the script tag passes none.
  var KEY = attr(TAG, 'data-key');
  var API_HOST = attr(TAG, 'data-api');
  var AUTOCAPTURE_ENABLED = attr(TAG, 'data-autocapture') !== 'false';
  var DETECT_IDENTITY = attr(TAG, 'data-identity-text') !== 'off';
  var OPT_OUT_ATTRIBUTE = hasAttr(TAG, 'data-opt-out');
  var RELEASE_ATTRIBUTE = attr(TAG, 'data-release');
  var RELEASE = normalizeRelease(RELEASE_ATTRIBUTE);
  var COOKIE_DOMAIN = attr(TAG, 'data-context-cookie-domain');
  // No `;` or space, so the value cannot add a cookie attribute.
  if (COOKIE_DOMAIN !== null && !/^[A-Za-z0-9.-]+$/.test(COOKIE_DOMAIN)) {
    logError('data-context-cookie-domain is not a domain; the context cookie is host-only.');
    COOKIE_DOMAIN = null;
  }
  if (RELEASE_ATTRIBUTE !== null && RELEASE === undefined) {
    logError('data-release is not a release (1 to 64 printable ASCII characters); events are sent without one.');
  }

  // No key or no API: every method stays present and inert, so a bad tag never throws.
  var DISABLED = false;
  if (!KEY) {
    logError('the script tag has no data-key — no events will be sent.');
    DISABLED = true;
  } else if (!API_HOST) {
    logError(
      'the script tag has no data-api — no events will be sent. The CDN origin is not the ' +
        'ingest origin, so it cannot be guessed from this script’s own src.'
    );
    DISABLED = true;
  }

  var API = API_HOST ? String(API_HOST).replace(/\/+$/, '') : '';
  var INGEST_URL = API + '/i/v1/e';

  // ─── storage (§5.4: best-effort, never throws) ────────────────────────────

  var DISTINCT_ID_KEY = '__sq_did';
  var ACCOUNT_ID_KEY = '__sq_aid';
  var ACCOUNT_HASH_KEY = '__sq_ath';
  var SESSION_KEY = '__sq_sid';
  var OPT_OUT_KEY = '__sq_opt';
  var CONTEXT_COOKIE = '__sq_ctx';
  var CONTEXT_COOKIE_MAX = 600;
  // A live session rewrites the cookie when the last write is this old: half its Max-Age (ruling R6).
  var CONTEXT_COOKIE_REFRESH_MS = 15 * 60 * 1000;

  var REPLAY_SID_KEY = '__lx_replay_sid';

  var IDLE_LIMIT_MS = 30 * 60 * 1000;
  var ABSOLUTE_LIMIT_MS = 24 * 60 * 60 * 1000;

  var MAX_BATCH_EVENTS = 25;
  var MAX_BATCH_BYTES = 32 * 1024;
  var FLUSH_INTERVAL_MS = 5000;
  var REQUEST_TIMEOUT_MS = 10000;
  var MAX_SEND_ATTEMPTS = 3;
  var RETRY_BASE_MS = 500;
  // A 429 (the backend's per-project event rate limit): pause for the server's retry time, clamped; hold the refused
  // batch and what is captured meanwhile, capped, the oldest dropped first (sequential.core.ts holdRateLimited).
  var RATE_LIMIT_DEFAULT_SEC = 60;
  var RATE_LIMIT_MIN_SEC = 1;
  var RATE_LIMIT_MAX_SEC = 300;
  var MAX_HELD_EVENTS = 100;
  var MAX_HELD_BYTES = 128 * 1024;

  var redactor = null;

  var EXCEPTION_MESSAGE_MAX = 256;
  var EXCEPTION_STACK_MAX = 2048;

  var REDACTED_FALLBACK = '[redacted]';

  var ephemeral = false;

  // G-12 (sequential.core.ts storeItem): storage stays off until the stub queue has run and the visitor is not opted
  // out, so a queued optOut() also writes nothing. Meanwhile each write waits in `held` (null removes).
  var storageOn = false;
  var held = {};
  // What optOut() deletes: every key the SDK writes, except the __sq_opt mark it then sets.
  var STORED_KEYS = [
    ['localStorage', '__sq_did'],
    ['localStorage', '__sq_aid'],
    ['localStorage', '__sq_ath'],
    ['localStorage', '__sq_ith'],
    ['sessionStorage', '__sq_sid'],
    ['sessionStorage', '__lx_replay_sid']
  ];

  // False only when the browser refused the write.
  function storeItem(area, key, value) {
    if (!storageOn) {
      held[area + ':' + key] = [area, key, value];
      return true;
    }
    try {
      if (value === null) window[area].removeItem(key);
      else window[area].setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function startStorage() {
    storageOn = true;
    var writes = held;
    held = {};
    for (var name in writes) {
      if (!Object.prototype.hasOwnProperty.call(writes, name)) continue;
      var w = writes[name];
      if (!storeItem(w[0], w[1], w[2]) && (w[1] === '__sq_did' || w[1] === '__sq_sid')) ephemeral = true;
    }
  }

  // ─── ids ──────────────────────────────────────────────────────────────────

  function fillRandom(bytes) {
    for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  function uuidv7(timestampMs) {
    var bytes = new Uint8Array(16);
    try {
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
      else fillRandom(bytes);
    } catch (e) {
      fillRandom(bytes);
    }
    var ts = Math.max(0, Math.floor(timestampMs) || 0);
    bytes[0] = Math.floor(ts / 1099511627776) & 255;
    bytes[1] = Math.floor(ts / 4294967296) & 255;
    bytes[2] = Math.floor(ts / 16777216) & 255;
    bytes[3] = Math.floor(ts / 65536) & 255;
    bytes[4] = Math.floor(ts / 256) & 255;
    bytes[5] = ts & 255;
    bytes[6] = (bytes[6] & 15) | 112;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = '';
    for (var i = 0; i < 16; i++) {
      var part = bytes[i].toString(16);
      hex += part.length === 1 ? '0' + part : part;
    }
    return (
      hex.slice(0, 8) +
      '-' +
      hex.slice(8, 12) +
      '-' +
      hex.slice(12, 16) +
      '-' +
      hex.slice(16, 20) +
      '-' +
      hex.slice(20)
    );
  }

  // ─── identity (§5.4) ──────────────────────────────────────────────────────

  var memoryDistinctId = null;

  function readDistinctId() {
    try {
      return window.localStorage.getItem(DISTINCT_ID_KEY);
    } catch (e) {
      ephemeral = true;
      return memoryDistinctId;
    }
  }

  function writeDistinctId(id) {
    memoryDistinctId = id;
    if (!storeItem('localStorage', DISTINCT_ID_KEY, id)) ephemeral = true;
  }

  // A held write first: before the stub queue has run, a repeat identify() or account() must see the first one's hash.
  function readLocal(key, fallback) {
    var waiting = held['localStorage:' + key];
    if (waiting) return waiting[2];
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return fallback;
    }
  }

  function writeLocal(key, value) {
    storeItem('localStorage', key, value);
  }

  // ─── account (sequential.core.ts accountIdOf / accountTraitsOf / accountHash; BE #429 is the contract) ───

  var ACCOUNT_ID_MAX = 200;
  var ACCOUNT_TRAITS_MAX_KEYS = 50;
  var ACCOUNT_TRAIT_KEY_MAX = 100;
  var ACCOUNT_TRAIT_VALUE_MAX = 1000;

  function accountIdOf(value) {
    var s;
    if (typeof value === 'string') s = value;
    else if (typeof value === 'number' && isFinite(value)) s = String(value);
    else return null;
    s = s.replace(/^\s+|\s+$/g, '');
    return s.length > 0 && s.length <= ACCOUNT_ID_MAX ? s : null;
  }

  function accountTraitsOf(value) {
    var out = [];
    if (!value || typeof value !== 'object' || Object.prototype.toString.call(value) === '[object Array]') return out;
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length && out.length < ACCOUNT_TRAITS_MAX_KEYS; i++) {
      var name = keys[i];
      var raw = value[name];
      if (name.length === 0 || name.length > ACCOUNT_TRAIT_KEY_MAX) continue;
      var v;
      if (typeof raw === 'string') v = raw;
      else if ((typeof raw === 'number' && isFinite(raw)) || typeof raw === 'boolean') v = String(raw);
      else continue;
      if (v.length > ACCOUNT_TRAIT_VALUE_MAX) continue;
      out.push({ name: name, value: v });
    }
    return out;
  }

  function accountHash(id, traits) {
    var pairs = [];
    for (var i = 0; i < traits.length; i++) pairs.push([traits[i].name, traits[i].value]);
    var text = JSON.stringify([id, pairs]);
    var h = 0x811c9dc5;
    for (var j = 0; j < text.length; j++) {
      h ^= text.charCodeAt(j);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(16);
  }

  // __sq_ith: a hash of the last identify id + traits sent (keys sorted, values as JSON), never the traits themselves.
  function identifyHash(id, props) {
    var keys = Object.keys(props).sort();
    var pairs = [];
    for (var i = 0; i < keys.length; i++) {
      var v = JSON.stringify(props[keys[i]]);
      pairs.push([keys[i], v === undefined ? '' : v]);
    }
    var text = JSON.stringify([id, pairs]);
    var h = 0x811c9dc5;
    for (var j = 0; j < text.length; j++) {
      h ^= text.charCodeAt(j);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(16);
  }

  var IDENTIFY_HASH_KEY = '__sq_ith';
  var memoryIdentifyHash = null;
  var accountId = null;
  var memoryAccountHash = null;
  try {
    accountId = accountIdOf(readLocal(ACCOUNT_ID_KEY, null));
  } catch (e) {
    accountId = null;
  }

  function readOptOut() {
    try {
      return window.localStorage.getItem(OPT_OUT_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  // ─── session (§5.4: 30 min idle OR 24 h absolute, whichever comes first) ───

  var memorySession = null;

  function readSession() {
    var raw;
    try {
      raw = window.sessionStorage.getItem(SESSION_KEY);
    } catch (e) {
      ephemeral = true;
      return memorySession;
    }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.id === 'string' &&
        typeof parsed.startedAt === 'number' &&
        typeof parsed.lastActivity === 'number'
      ) {
        return { id: parsed.id, startedAt: parsed.startedAt, lastActivity: parsed.lastActivity };
      }
    } catch (e) {}
    return null;
  }

  function writeSession(record) {
    memorySession = record;
    if (!storeItem('sessionStorage', SESSION_KEY, JSON.stringify(record))) ephemeral = true;
    publishReplaySessionId(record.id);
  }

  var publishedSessionId = null;

  // The recorder reads __lx_replay_sid as a PLAIN id once at boot, so publish on every rotation:
  // the next page load then pins the id analytics uses (orig. comment at cac6164).
  function publishReplaySessionId(id) {
    if (!id || id === publishedSessionId) return;
    publishedSessionId = id;
    storeItem('sessionStorage', REPLAY_SID_KEY, id);
  }

  function startNewSession(t) {
    var fresh = { id: uuidv7(t), startedAt: t, lastActivity: t };
    writeSession(fresh);
    return fresh;
  }

  var optedOut = readOptOut() || OPT_OUT_ATTRIBUTE;

  var stopped = false;
  var distinctId;
  var session;

  try {
    distinctId = readDistinctId();
    if (!distinctId) {
      distinctId = uuidv7(Date.now());
      writeDistinctId(distinctId);
    }
    session = readSession();
    if (!session) session = startNewSession(Date.now());
    else publishReplaySessionId(session.id);
  } catch (e) {
    ephemeral = true;
    var bootTime = Date.now();
    distinctId = uuidv7(bootTime);
    memoryDistinctId = distinctId;
    session = { id: uuidv7(bootTime), startedAt: bootTime, lastActivity: bootTime };
    memorySession = session;
  }

  // ─── the context cookie __sq_ctx (sequential.core.ts syncContextCookie) ───
  // It keeps the anonymous id identify() sent as $anon_distinct_id; after a reload it carries the stored id (core.ts).

  var contextDistinctId = distinctId;
  var contextOn = false;
  var contextWritten = null;
  var contextWrittenAt = 0;

  function writeContextCookie(value) {
    contextWritten = value;
    contextWrittenAt = Date.now();
    try {
      var secure = window.location.protocol === 'https:';
      document.cookie =
        CONTEXT_COOKIE +
        '=' +
        value +
        '; Path=/; Max-Age=' +
        (value ? IDLE_LIMIT_MS / 1000 : 0) +
        '; SameSite=Lax' +
        (COOKIE_DOMAIN ? '; Domain=' + COOKIE_DOMAIN : '') +
        (secure ? '; Secure' : '');
    } catch (e) {}
  }

  // Before this page wrote one, a clear is for a cookie an earlier page left: only when it is there.
  function clearContextCookie() {
    if (contextWritten === '' || DISABLED) return;
    if (contextWritten === null && !hasContextCookie()) return;
    writeContextCookie('');
  }

  function hasContextCookie() {
    try {
      return (';' + document.cookie).replace(/\s/g, '').indexOf(';' + CONTEXT_COOKIE + '=') !== -1;
    } catch (e) {
      return true;
    }
  }

  function syncContextCookie() {
    if (!contextOn || optedOut || stopped) return;
    // A stored session that has ended is not current: the next event starts a new one and writes that.
    var t = Date.now();
    if (t - session.lastActivity >= IDLE_LIMIT_MS || t - session.startedAt >= ABSOLUTE_LIMIT_MS) return;
    var value = encodeURIComponent(
      'v1;d=' + encodeURIComponent(contextDistinctId) + ';s=' + encodeURIComponent(session.id)
    );
    if (value.length > CONTEXT_COOKIE_MAX) value = '';
    // The same value again gives the cookie a fresh Max-Age. A clear ('') is never repeated.
    var refresh = value !== '' && t - contextWrittenAt >= CONTEXT_COOKIE_REFRESH_MS;
    if (value !== contextWritten || refresh) writeContextCookie(value);
  }

  function touchSession() {
    var t = Date.now();
    var idleExpired = t - session.lastActivity >= IDLE_LIMIT_MS;
    var absoluteExpired = t - session.startedAt >= ABSOLUTE_LIMIT_MS;
    if (idleExpired || absoluteExpired) {
      session = startNewSession(t);
    } else {
      session = { id: session.id, startedAt: session.startedAt, lastActivity: t };
      writeSession(session);
    }
    syncContextCookie();
    return session.id;
  }

  // ─── transport (§5.5) ─────────────────────────────────────────────────────

  var superProps = {};
  var queue = [];
  var queueBytes = 0;
  var flushTimer = null;
  var pauseTimer = null;
  // Events already put back once after a 429 (a batch is resent once). An array, not a WeakSet: this file is ES5.
  var resentOnce = [];

  function assign(target, source) {
    if (!source) return target;
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    }
    return target;
  }

  function byteLength(value) {
    try {
      if (window.TextEncoder) return new window.TextEncoder().encode(value).length;
    } catch (e) {}

    return value.length;
  }

  function timeoutSignal() {
    try {
      if (window.AbortSignal && window.AbortSignal.timeout) {
        return window.AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      }
    } catch (e) {}
    return undefined;
  }

  function scheduleFlushTimer() {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush();
    }, FLUSH_INTERVAL_MS);
  }

  function clearFlushTimer() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function buildEnvelope(events) {
    try {
      return JSON.stringify({ key: KEY, sent_at: new Date(Date.now()).toISOString(), events: events });
    } catch (e) {
      return null;
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function canSend() {
    try {
      return typeof window.fetch === 'function';
    } catch (e) {
      return false;
    }
  }

  function postOnce(body) {
    try {
      return window
        .fetch(INGEST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          signal: timeoutSignal()
        })
        .then(
          function (res) {
            return res;
          },
          function () {
            return null;
          }
        );
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function refusalCode(res) {
    return Promise.resolve()
      .then(function () {
        return res.json();
      })
      .then(
        function (b) {
          return !!b && typeof b.error === 'string' ? b.error : null;
        },
        function () {
          return null;
        }
      );
  }

  function stopSending() {
    stopped = true;
    clearContextCookie();
    queue = [];
    queueBytes = 0;
    clearFlushTimer();
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
  }

  // A refusal's JSON body, read ONCE (a fetch Response body can be read only once), or null (sequential.core.ts bodyOf).
  function bodyOf(res) {
    return Promise.resolve()
      .then(function () {
        return res.json();
      })
      .then(
        function (b) {
          return b && typeof b === 'object' ? b : null;
        },
        function () {
          return null;
        }
      );
  }

  function retryAfterSecOf(res, b) {
    var sec = b && typeof b.retry_after_sec === 'number' ? b.retry_after_sec : NaN;
    if (!isFinite(sec)) {
      try {
        var h = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
        if (h != null && /^\s*\d+\s*$/.test(h)) sec = Number(h);
      } catch (e) {}
    }
    if (!isFinite(sec)) sec = RATE_LIMIT_DEFAULT_SEC;
    return Math.min(RATE_LIMIT_MAX_SEC, Math.max(RATE_LIMIT_MIN_SEC, Math.ceil(sec)));
  }

  function sizeOf(e) {
    try {
      return byteLength(JSON.stringify(e));
    } catch (err) {
      return 0;
    }
  }

  function trimHeld() {
    while (queue.length > MAX_HELD_EVENTS || (queue.length > 1 && queueBytes > MAX_HELD_BYTES)) {
      queueBytes -= sizeOf(queue.shift());
    }
  }

  function holdRateLimited(events, sec) {
    if (stopped) return;
    var again = [];
    for (var i = 0; i < events.length; i++) {
      if (resentOnce.indexOf(events[i]) === -1) {
        again.push(events[i]);
        resentOnce.push(events[i]);
      }
    }
    while (resentOnce.length > 2 * MAX_HELD_EVENTS) resentOnce.shift();
    queue = again.concat(queue);
    queueBytes = 0;
    for (var j = 0; j < queue.length; j++) queueBytes += sizeOf(queue[j]);
    clearFlushTimer();
    if (pauseTimer !== null) clearTimeout(pauseTimer);
    pauseTimer = setTimeout(function () {
      pauseTimer = null;
      flush();
    }, sec * 1000);
    trimHeld();
  }

  function attemptSend(body, attempt, events) {
    function retry() {
      if (attempt >= MAX_SEND_ATTEMPTS) return;
      return sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1)).then(function () {
        if (!stopped) return attemptSend(body, attempt + 1, events);
      });
    }
    return postOnce(body).then(function (res) {
      if (res) {
        if (res.ok) return;

        if (res.status === 429) {
          return bodyOf(res).then(function (b) {
            holdRateLimited(events, retryAfterSecOf(res, b));
          });
        }
        // The backend is shedding load: hold and wait like a 429. Any other 503 keeps the quick retry.
        if (res.status === 503) {
          return bodyOf(res).then(function (b) {
            if (b && b.error === 'overloaded') {
              holdRateLimited(events, retryAfterSecOf(res, b));
              return;
            }
            return retry();
          });
        }
        if (res.status === 401) return;
        if (res.status === 402) {
          return refusalCode(res).then(function (code) {
            if (code && code.indexOf('billing_') === 0) stopSending();
          });
        }
        if (res.status === 403) {
          return refusalCode(res).then(function (code) {
            if (code !== 'origin_not_allowed' || stopped) return;
            stopSending();
            logWarn(ORIGIN_REFUSED_WARNING);
          });
        }

        if (res.status < 500) return;
      }
      return retry();
    });
  }

  function flush() {
    try {
      if (queue.length === 0) return Promise.resolve();
      clearFlushTimer();
      // Paused by a 429: the pause's own timer flushes what is held when it ends.
      if (pauseTimer !== null) return Promise.resolve();
      var events = queue;
      queue = [];
      queueBytes = 0;
      if (!canSend()) return Promise.resolve();
      var body = buildEnvelope(events);
      if (body === null) return Promise.resolve();
      return attemptSend(body, 1, events)['catch'](noop);
    } catch (e) {
      return Promise.resolve();
    }
  }

  function drain() {
    try {
      if (optedOut || DISABLED || stopped) return null;
      if (queue.length === 0) return null;
      clearFlushTimer();
      var events = queue;
      queue = [];
      queueBytes = 0;
      var body = buildEnvelope(events);
      if (body === null) return null;
      return { url: INGEST_URL, body: body };
    } catch (e) {
      return null;
    }
  }

  function captureInternal(name, props, at) {
    try {
      if (optedOut || DISABLED || stopped) return;
      var sessionId = touchSession();

      var eventProps = {};
      var url = currentUrl();
      if (url !== undefined) eventProps.$current_url = url;
      // Before super properties and the call's props, so register({ $release }) still wins.
      if (RELEASE !== undefined) eventProps.$release = RELEASE;
      eventProps = assign(assign(eventProps, superProps), props);

      if (ephemeral) eventProps.$ephemeral_id = true;

      // `at`: a dead click is known 2.5 s after it happened, and is dated at the click.
      var now = typeof at === 'number' ? at : Date.now();
      var outgoing = {
        event: name,
        uuid: uuidv7(now),
        ts: new Date(now).toISOString(),
        distinct_id: distinctId,
        session_id: sessionId,
        props: eventProps
      };
      if (accountId !== null) outgoing.account_id = accountId;

      var size;
      try {
        size = byteLength(JSON.stringify(outgoing));
      } catch (e) {
        return;
      }

      queue.push(outgoing);
      queueBytes += size;
      if (pauseTimer !== null) trimHeld();

      if (queue.length >= MAX_BATCH_EVENTS || queueBytes >= MAX_BATCH_BYTES) {
        clearFlushTimer();
        flush();
      } else {
        scheduleFlushTimer();
      }
    } catch (e) {}
  }

  // ─── the public surface (§5.1, §5.2) ──────────────────────────────────────

  function capture(event, props) {
    if (typeof event === 'string' && event.charAt(0) === '$') {
      throw new Error(
        'Sequential: "' +
          event +
          '" is a reserved event name — event names starting with "$" are reserved for ' +
          "Sequential's own events. Choose a different name for your own event."
      );
    }
    captureInternal(event, props);
  }

  // ─── identity text (spec #475 §6, as sequential.core.ts) ───
  var idWords = [];
  var idEmails = [];

  function idTokens(text) {
    var s = String(text);
    return (s.normalize ? s.normalize('NFKC') : s).toLowerCase().split(/[\s!-\/:-@[-`{-~]+/);
  }

  function learnIdentity(id, props) {
    if (id !== distinctId) idWords = idEmails = [];
    if (id.indexOf('@') > 0) idEmails.push(id.toLowerCase());
    for (var k in props) {
      var v = props[k];
      if (typeof v == 'string') {
        if (/e-?mail/i.test(k)) idEmails.push(v.toLowerCase());
        else if (/^\$?name$|(first|last|full|display|nick|given|family)[_-]?name$|surname$/i.test(k)) idWords = idWords.concat(idTokens(v));
      }
    }
  }

  function namesPerson(text) {
    var w = idTokens(text);
    for (var i = 0; i < idEmails.length; i++) if (String(text).toLowerCase().indexOf(idEmails[i]) >= 0) return true;
    for (i = 0; i < w.length; i++) if (w[i].length > 2 && inList(idWords, w[i])) return true;
  }

  function inAccountUi(node) {
    for (var i = 0; node && node.getAttribute && i++ < 4; node = node.parentNode) {
      if (/(\b|_)(avatar|account|profile|user[-_]?menu)(\b|_)/.test((node.getAttribute('class') + ' ' + node.id + ' ' + node.getAttribute('data-testid')).toLowerCase()) || /account|profile|user/i.test(node.getAttribute('aria-label'))) return true;
    }
  }

  learnIdentity(String(distinctId));

  function identify(newDistinctId, props) {
    try {
      if (optedOut || DISABLED) return;
      if (typeof newDistinctId !== 'string' || newDistinctId.length === 0) return;
      learnIdentity(newDistinctId, props);
      var previous = distinctId;
      var hasTraits = props !== undefined && props !== null && typeof props === 'object' && Object.keys(props).length > 0;
      var hash = hasTraits ? identifyHash(newDistinctId, props) : null;
      if (previous === newDistinctId) {
        // Same person again (a reload): changed traits still go out; the same traits, or none, send nothing.
        if (hash === null || hash === readLocal(IDENTIFY_HASH_KEY, memoryIdentifyHash)) return;
        memoryIdentifyHash = hash;
        writeLocal(IDENTIFY_HASH_KEY, hash);
        captureInternal('$identify', assign({}, props));
        return;
      }
      memoryIdentifyHash = hash;
      writeLocal(IDENTIFY_HASH_KEY, hash);
      distinctId = newDistinctId;
      writeDistinctId(newDistinctId);
      contextDistinctId = previous;

      var merged = assign({}, props);
      merged.$anon_distinct_id = previous;
      captureInternal('$identify', merged);
    } catch (e) {}
  }

  // $account on an id change (empty traits too) or on traits that differ from the last sent (__sq_ath).
  function account(rawId, rawTraits) {
    try {
      if (optedOut || DISABLED) return;
      var id = accountIdOf(rawId);
      if (id === null) {
        logError('account() needs an id of 1 to ' + ACCOUNT_ID_MAX + ' characters (a string or a number); the call was ignored.');
        return;
      }
      var traits = rawTraits === undefined ? [] : accountTraitsOf(rawTraits);
      var hash = accountHash(id, traits);
      var changed = id !== accountId;
      var lastHash = readLocal(ACCOUNT_HASH_KEY, memoryAccountHash);
      accountId = id;
      writeLocal(ACCOUNT_ID_KEY, id);
      if (!changed && (rawTraits === undefined || hash === lastHash)) return;
      memoryAccountHash = hash;
      writeLocal(ACCOUNT_HASH_KEY, hash);
      var props = {};
      for (var i = 0; i < traits.length; i++) props[traits[i].name] = traits[i].value;
      captureInternal('$account', { account_props: props });
    } catch (e) {}
  }

  function register(props) {
    try {
      superProps = assign(assign({}, superProps), props);
    } catch (e) {}
  }

  function unregister(propKey) {
    try {
      var next = assign({}, superProps);
      delete next[propKey];
      superProps = next;
    } catch (e) {}
  }

  function reset() {
    try {
      superProps = {};
      memoryDistinctId = null;
      idWords = idEmails = [];
      accountId = null;
      memoryAccountHash = null;
      memoryIdentifyHash = null;
      writeLocal(ACCOUNT_ID_KEY, null);
      writeLocal(ACCOUNT_HASH_KEY, null);
      writeLocal(IDENTIFY_HASH_KEY, null);
      distinctId = uuidv7(Date.now());
      writeDistinctId(distinctId);
      session = startNewSession(Date.now());
      clearContextCookie();
      contextDistinctId = distinctId;
      syncContextCookie();
    } catch (e) {}
  }

  function optOut() {
    try {
      optedOut = true;

      queue = [];
      queueBytes = 0;
      clearFlushTimer();
      clearContextCookie();
      forgetStorage();
      // The one key an opted-out visitor keeps: the choice, with no id (G-12).
      try {
        window.localStorage.setItem(OPT_OUT_KEY, '1');
      } catch (e) {}
      // C1: the recorder stops too (BE recorder-boot.js). The page flag reaches one still loading, and stands in for a
      // storage write that failed; the hook stops one that is running and drops what it holds.
      window.__lxReplayOptedOut = true;
      if (typeof window.__lxReplayOptOut === 'function') window.__lxReplayOptOut();
    } catch (e) {}
  }

  // G-12: delete the ids the SDK stored and write none while opted out. They wait for optIn(), so they hold for this page.
  function forgetStorage() {
    storageOn = false;
    held = {};
    for (var i = 0; i < STORED_KEYS.length; i++) {
      try {
        window[STORED_KEYS[i][0]].removeItem(STORED_KEYS[i][1]);
      } catch (e) {}
    }
    writeDistinctId(distinctId);
    writeSession(session);
    if (publishedSessionId) storeItem('sessionStorage', REPLAY_SID_KEY, publishedSessionId);
    if (accountId !== null) writeLocal(ACCOUNT_ID_KEY, accountId);
  }

  function optIn() {
    try {
      optedOut = false;
      try {
        window.localStorage.removeItem(OPT_OUT_KEY);
      } catch (e) {}
      if (!DISABLED) startStorage();
      // A recorder that boots from here records; one this page load already stopped stays stopped (fail closed).
      window.__lxReplayOptedOut = false;

      bootSequence();
      syncContextCookie();
    } catch (e) {}
  }

  function captureException(error, props) {
    try {
      if (optedOut || DISABLED) return;
      var isErrorLike = !!error && typeof error === 'object' && typeof error.message === 'string';
      var message = isErrorLike ? error.message : String(error);
      var stack = isErrorLike && typeof error.stack === 'string' ? error.stack : undefined;
      var merged = assign({}, props);
      merged.$exception_message = redactor
        ? redactor.boundedRedact(message, EXCEPTION_MESSAGE_MAX)
        : REDACTED_FALLBACK;
      merged.$exception_stack =
        redactor && stack !== undefined ? redactor.boundedRedact(stack, EXCEPTION_STACK_MAX) : undefined;
      captureInternal('$exception', merged);
    } catch (e) {}
  }

  // ─── redaction (restated from sequential.autocapture.ts) ──────────────────

  function cap(s, max) {
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  function luhn(digits) {
    if (!/^[0-9]+$/.test(digits)) return false;
    var sum = 0;
    var alt = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var n = digits.charCodeAt(i) - 48;
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  var TOKEN_CHAR = /[A-Za-z0-9._%+~/=@-]/;
  var CARD_RUN_CHAR = /[0-9 -]/;
  var DIGIT_CHAR = /[0-9]/;

  var CARD_SCAN_MAX = 25;

  function createRedactor(rules) {
    var REDACTED = (rules && rules.redacted) || '[redacted]';
    var list = (rules && rules.value_patterns) || [];
    var patterns = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];

      if (p.luhn_group && !p.luhn_strip) {
        throw new Error('sequential: rule "' + p.source + '" has luhn_group without luhn_strip');
      }
      patterns.push({
        re: new RegExp(p.source, p.flags),
        keepGroup: p.keep_group,
        prefixGroup: p.prefix_group,
        luhnGroup: p.luhn_group,
        luhnStrip: p.luhn_strip ? new RegExp(p.luhn_strip, 'g') : null
      });
    }

    function replaceWith(p) {
      return function (match) {
        var rest = Array.prototype.slice.call(arguments, 1);
        function group(n) {
          return n ? String(rest[n - 1] == null ? '' : rest[n - 1]) : '';
        }
        if (p.luhnGroup) {
          return luhn(group(p.luhnGroup).replace(p.luhnStrip, ''))
            ? group(p.prefixGroup) + REDACTED
            : match;
        }

        if (p.prefixGroup) return group(p.prefixGroup) + REDACTED;
        if (p.keepGroup) return group(p.keepGroup) + ' ' + REDACTED;
        return REDACTED;
      };
    }

    function redactText(input) {
      var s = String(input);
      for (var i = 0; i < patterns.length; i++) {
        patterns[i].re.lastIndex = 0;
        s = s.replace(patterns[i].re, replaceWith(patterns[i]));
      }
      return s;
    }

    function boundedRedact(input, max) {
      var s = String(input);
      var stripped = false;
      if (s.length > max * 2) {
        var sliced = s.slice(0, max * 2);
        var j = sliced.length;
        var tailIsCardRun = true;
        while (j > 0 && TOKEN_CHAR.test(sliced.charAt(j - 1))) {
          if (!CARD_RUN_CHAR.test(sliced.charAt(j - 1))) tailIsCardRun = false;
          j--;
        }
        var runEnd = tailIsCardRun ? sliced.length : j;
        var k = j;
        var sawDigit = false;
        while (k > 0 && k > runEnd - CARD_SCAN_MAX && CARD_RUN_CHAR.test(sliced.charAt(k - 1))) {
          if (DIGIT_CHAR.test(sliced.charAt(k - 1))) sawDigit = true;
          k--;
        }
        if (sawDigit) j = k;
        s = sliced.slice(0, j);
        stripped = j < sliced.length;
      }
      var out = redactText(s);
      if (stripped) out = out ? out + ' ' + REDACTED : REDACTED;
      return cap(out, max);
    }

    return { redactText: redactText, boundedRedact: boundedRedact };
  }

  // ─── autocapture (§5.3) ───────────────────────────────────────────────────

  var INTERACTIVE_SELECTOR = 'a, button, input[type="submit"], [role="button"], [data-sq]';
  var CLICK_TEXT_MAX = 128;

  var EL_DATA_MAX_ATTRS = 12;
  var EL_DATA_VALUE_MAX = 128;

  var EL_ID_MAX = 128;
  var EL_SELECTOR_MAX = 256;

  var URL_MAX = 512;

  var TEXT_OPAQUE_TAGS = ['textarea', 'select'];

  function isEditable(el) {
    try {
      if (!el || !el.getAttribute) return false;
      var value = el.getAttribute('contenteditable');
      return value !== null && String(value).toLowerCase() !== 'false';
    } catch (e) {
      return false;
    }
  }

  var TEXT_SCAN_MAX = CLICK_TEXT_MAX * 4;

  function inList(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i] === value) return true;
    return false;
  }

  var NEVER_READ_INPUT_TYPES = ['password', 'email', 'tel'];

  var LABEL_INPUT_TYPES = ['submit', 'button', 'reset'];

  function tagNameOf(el) {
    return el && el.tagName ? String(el.tagName).toLowerCase() : '';
  }

  function matchesSelector(el, selector) {
    try {
      var fn = el.matches || el.msMatchesSelector || el.webkitMatchesSelector;
      return fn ? fn.call(el, selector) : false;
    } catch (e) {
      return false;
    }
  }

  function closestMatching(el, selector) {
    try {
      if (el.closest) return el.closest(selector);
    } catch (e) {}
    var node = el;
    while (node && node.nodeType === 1) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function isMasked(el) {
    return !!closestMatching(el, '[data-sq-mask], [data-sq-private]');
  }

  function subtreeText(el) {
    var out = '';
    function visit(node) {
      for (var child = node.firstChild; child !== null; child = child.nextSibling) {
        if (out.length >= TEXT_SCAN_MAX) return;
        if (child.nodeType === 3) {
          out += child.nodeValue == null ? '' : child.nodeValue;
          continue;
        }
        if (child.nodeType !== 1) continue;
        if (inList(TEXT_OPAQUE_TAGS, tagNameOf(child))) continue;
        if (isEditable(child)) continue;
        if (child.hasAttribute && (child.hasAttribute('data-sq-mask') || child.hasAttribute('data-sq-private'))) continue;
        visit(child);
      }
    }
    visit(el);
    return out;
  }

  function rawClickText(el) {
    if (isEditable(el)) return undefined;
    var tag = tagNameOf(el);
    if (tag === 'input') {
      var type = String(el.type || '').toLowerCase();
      if (inList(NEVER_READ_INPUT_TYPES, type)) return undefined;
      if (inList(LABEL_INPUT_TYPES, type)) return String(el.value || '').trim() || undefined;
      return undefined;
    }
    if (inList(TEXT_OPAQUE_TAGS, tag)) return undefined;
    var text = subtreeText(el).trim();
    return text || undefined;
  }

  // sequential.autocapture.ts hashRouteOf: only a #/ or #!/ route is kept, cut before ? & #; too long → dropped.
  function hashRouteOf(fragment) {
    if (!/^#!?\//.test(fragment)) return '';
    var end = fragment.slice(1).search(/[?&#]/);
    var route = end >= 0 ? fragment.slice(0, end + 1) : fragment;
    return route.length > URL_MAX ? '' : route;
  }

  function safeUrl(raw, rdct) {
    var s = String(raw);
    var hash = s.indexOf('#');
    var route = '';
    if (hash >= 0) {
      route = hashRouteOf(s.slice(hash));
      s = s.slice(0, hash);
    }
    s = s.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#@]*@/, '$1');
    return rdct.boundedRedact(s + route, URL_MAX);
  }

  function currentUrl() {
    if (!redactor) return undefined;
    try {
      return safeUrl(String(window.location.href), redactor);
    } catch (e) {
      return undefined;
    }
  }

  function stableSelector(el, noIds) {
    var parts = [];
    var node = el;
    var root = document.documentElement;
    while (node && node !== root && node.nodeType === 1) {
      if (node.id && !noIds) {
        parts.unshift('#' + node.id);
        break;
      }
      var parent = node.parentNode;
      if (!parent || parent.nodeType !== 1) {
        parts.unshift(tagNameOf(node));
        break;
      }
      var children = parent.children || [];
      var sameTag = 0;
      var index = 0;
      for (var i = 0; i < children.length; i++) {
        if (children[i].tagName === node.tagName) {
          sameTag++;
          if (children[i] === node) index = sameTag;
        }
      }
      parts.unshift(sameTag > 1 ? tagNameOf(node) + ':nth-of-type(' + index + ')' : tagNameOf(node));
      node = parent;
    }
    return parts.join(' > ') || tagNameOf(el);
  }

  function dataAttrs(el, rdct) {
    var out;
    var count = 0;
    try {
      var attrs = el.attributes;
      if (!attrs) return undefined;
      for (var i = 0; i < attrs.length; i++) {
        var name = attrs[i].name;
        if (name.indexOf('data-') !== 0) continue;
        var key = name.slice(5).replace(/-([a-z0-9])/g, function (_m, c) {
          return c.toUpperCase();
        });
        if (key === 'sqMask') continue;
        if (count >= EL_DATA_MAX_ATTRS) break;
        if (!out) out = {};

        out[key] = rdct.boundedRedact(String(attrs[i].value), EL_DATA_VALUE_MAX);
        count++;
      }
    } catch (e) {
      return out;
    }
    return out;
  }

  var autocaptureStarted = false;
  // Set by startAutocapture: sends an open rage burst before the unload path drains the queue.
  var flushOpenSignals = noop;

  function installRedactor(rules) {
    try {
      redactor = createRedactor(rules);
      return true;
    } catch (e) {
      logError('the redaction rules could not be compiled — autocapture stays off.');
      redactor = null;
      return false;
    }
  }

  function pageKey(href) {
    try {
      var u = new URL(href);
      return u.pathname + u.search + (/^#!?\//.test(u.hash) ? u.hash : '');
    } catch (e) {
      return String(href);
    }
  }

  // $nav (sequential.autocapture.ts PageviewNav): popstate is also a forward fragment navigation, so
  // only the Navigation API's navigationType names it; without it, 'unknown'.
  function navFromNavigationType(type) {
    if (type === 'traverse') return 'pop';
    if (type === 'push' || type === 'replace') return type;
    return 'unknown';
  }

  function loadTypeOf() {
    try {
      var type = window.performance.getEntriesByType('navigation')[0].type;
      return inList(['navigate', 'reload', 'back_forward', 'prerender'], type) ? type : 'unknown';
    } catch (e) {
      return 'unknown';
    }
  }

  var RAGE_MS = 1000;
  var RAGE_RADIUS_PX = 30;
  var RAGE_MIN_CLICKS = 3;
  var DEAD_WAIT_MS = 2500;
  var BUTTON_INPUT_TYPES = ['submit', 'button', 'image', 'reset'];

  function isButtonLikeInput(el) {
    return tagNameOf(el) === 'input' && inList(BUTTON_INPUT_TYPES, String(el.getAttribute('type') || 'text').toLowerCase());
  }

  // Fast clicks are normal here (a caret, a stepper, a toggle), or the page opted out.
  function rageExcluded(el) {
    if (closestMatching(el, 'textarea, select, [data-sq-no-rage]')) return true;
    var editable = closestMatching(el, '[contenteditable]');
    if (editable && editable.getAttribute('contenteditable') !== 'false') return true;
    var input = closestMatching(el, 'input');
    return !!input && !isButtonLikeInput(input);
  }

  // The effect happens outside the page, or the control changes state with no DOM mutation.
  function deadExcluded(matched, target) {
    if (closestMatching(target, 'label')) return true;
    if (tagNameOf(matched) === 'input' && !isButtonLikeInput(matched)) return true;
    if (tagNameOf(matched) !== 'a') return false;
    if (matched.hasAttribute('download')) return true;
    if (String(matched.getAttribute('target') || '').toLowerCase() === '_blank') return true;
    return /^(mailto|tel|sms):/i.test(String(matched.getAttribute('href') || '').replace(/^\s+/, ''));
  }

  // sequential.autocapture.ts STATE_ATTRIBUTES: a changed state attribute on the clicked element is a response.
  var STATE_ATTRIBUTES = ['aria-checked', 'aria-pressed', 'aria-expanded', 'aria-selected', 'open', 'checked', 'value'];

  function stateChanged(r) {
    if (r.type !== 'attributes' || !r.attributeName || !inList(STATE_ATTRIBUTES, r.attributeName)) return false;
    return r.target.getAttribute(r.attributeName) !== r.oldValue;
  }

  // The main button and no modifier key: anything else opens a menu, a tab or a selection. Not
  // isPrimary: Chromium sends `click` as a PointerEvent with isPrimary=false; only pointer events
  // check it (isPlainPointer).
  function isPlainClick(ev) {
    return ev.button === 0 && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey;
  }

  function isPlainPointer(ev) {
    return isPlainClick(ev) && ev.isPrimary !== false;
  }

  function startAutocapture(attachUrl) {
    if (autocaptureStarted || !redactor) return;
    autocaptureStarted = true;

    function capturePageview(url, nav) {
      var href = url || String(window.location.href);
      var pathname;
      try {
        pathname = url ? new URL(url, href).pathname : String(window.location.pathname);
      } catch (e) {
        pathname = String(window.location.pathname);
      }
      var referrer = document.referrer || undefined;
      captureInternal('$pageview', {
        $current_url: safeUrl(href, redactor),
        $pathname: safeUrl(pathname, redactor),
        $referrer: referrer !== undefined ? safeUrl(referrer, redactor) : undefined,
        $nav: nav,
        $load_type: nav === 'load' ? loadTypeOf() : undefined
      });
    }

    // One page key (pathname + search of the RAW URL, + the fragment only for a #/ or #!/ hash
    // route) for every trigger, as in
    // sequential.autocapture.ts pageKey: a router's same-URL replaceState is not a pageview.
    var lastPageKey = null;
    var lastNavigationType;
    var navigationApi = false;

    function checkPage(nav) {
      try {
        lastNavigationType = undefined;
        var key = pageKey(String(window.location.href));
        if (key === lastPageKey) return;
        lastPageKey = key;
        capturePageview(undefined, nav);
      } catch (e) {}
    }

    function onPopState() {
      checkPage(navigationApi ? navFromNavigationType(lastNavigationType) : 'unknown');
    }

    // $click's props; $rageclick and $deadclick send the same, so the detector groups all three.
    function elementProps(matched) {
      var masked = isMasked(matched);
      var raw = masked ? undefined : rawClickText(matched);
      var identity = DETECT_IDENTITY && raw !== undefined && (inAccountUi(matched) || namesPerson(raw));
      var noIds = closestMatching(matched, '[data-sq-private]') || (DETECT_IDENTITY && namesPerson(stableSelector(matched)));
      var selector = stableSelector(matched, noIds);
      return {
        $el_tag_name: tagNameOf(matched),
        $el_selector: cap(selector, EL_SELECTOR_MAX),
        $el_id: matched.id && !noIds ? cap(String(matched.id), EL_ID_MAX) : undefined,
        $el_data: masked || identity ? undefined : dataAttrs(matched, redactor),
        $el_text: raw !== undefined && !identity ? redactor.boundedRedact(raw, CLICK_TEXT_MAX) : undefined
      };
    }

    function onClick(ev) {
      try {
        var target = ev && ev.target;
        if (!target || target.nodeType !== 1) return;
        var matched = closestMatching(target, INTERACTIVE_SELECTOR);
        if (!matched) return;
        captureInternal('$click', elementProps(matched));
        if (isPlainClick(ev) && !deadExcluded(matched, target)) openDead(matched);
      } catch (e) {}
    }

    // ── rage and dead clicks: as in sequential.autocapture.ts (BE spec 2026-10-08, BE #432) ──
    // One MutationObserver, only while a burst or a dead window is open. No MutationObserver:
    // neither signal runs, because "no effect" cannot be told from "an effect we cannot see".
    var Observer = window.MutationObserver;
    var rage = null;
    var dead = null;
    var observer = null;

    function syncObserver() {
      try {
        if ((rage || dead) && !observer && Observer) {
          observer = new Observer(onMutations);
          observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
        } else if (!rage && !dead && observer) {
          observer.disconnect();
          observer = null;
        }
      } catch (e) {}
    }

    function hasSelection() {
      try {
        var sel = window.getSelection ? window.getSelection() : null;
        return !!sel && String(sel) !== '';
      } catch (e) {
        return false;
      }
    }

    // For rage, the clicked element's own attributes and a focus on it are not a response (own).
    function effect(own) {
      if (dead) {
        clearTimeout(dead.timer);
        dead = null;
      }
      if (rage && !own) rage.responded = true;
      syncObserver();
    }

    function onMutations(records) {
      var own = true;
      for (var i = 0; i < records.length; i++) {
        if (records[i].type !== 'attributes' || !rage || records[i].target !== rage.el || stateChanged(records[i])) own = false;
      }
      effect(own);
    }

    function onPointerDown(ev) {
      try {
        var target = ev && ev.target;
        if (!Observer || !target || target.nodeType !== 1 || !isPlainPointer(ev) || rageExcluded(target)) return;
        var t = Date.now();
        var dx = rage ? ev.clientX - rage.x : 0;
        var dy = rage ? ev.clientY - rage.y : 0;
        if (rage && t - rage.last <= RAGE_MS && Math.sqrt(dx * dx + dy * dy) <= RAGE_RADIUS_PX) {
          clearTimeout(rage.timer);
          rage.times.push(t);
          rage.last = t;
          rage.timer = setTimeout(endRage, RAGE_MS);
        } else {
          if (rage) endRage();
          rage = {
            first: t,
            last: t,
            x: ev.clientX,
            y: ev.clientY,
            times: [t],
            el: closestMatching(target, INTERACTIVE_SELECTOR) || target,
            href: String(window.location.href),
            responded: false,
            timer: setTimeout(endRage, RAGE_MS)
          };
        }
        syncObserver();
      } catch (e) {}
    }

    // The burst ended (1 s with no click near it): one $rageclick, dated at its first click.
    function endRage() {
      try {
        var r = rage;
        if (!r) return;
        clearTimeout(r.timer);
        rage = null;
        syncObserver();
        // Rage: RAGE_MIN_CLICKS of the burst's clicks fall within one RAGE_MS span.
        var fast = false;
        for (var i = RAGE_MIN_CLICKS - 1; i < r.times.length; i++) {
          if (r.times[i] - r.times[i - RAGE_MIN_CLICKS + 1] <= RAGE_MS) fast = true;
        }
        if (!fast || r.responded || String(window.location.href) !== r.href || hasSelection()) return;
        var props = elementProps(r.el);
        props.$click_count = r.times.length;
        captureInternal('$rageclick', props, r.first);
      } catch (e) {}
    }

    // A disabled control sends no click, only pointer events: its dead window opens here.
    function onPointerUp(ev) {
      try {
        var target = ev && ev.target;
        if (!target || target.nodeType !== 1 || !isPlainPointer(ev)) return;
        var disabled = closestMatching(target, ':disabled');
        if (disabled) openDead(closestMatching(target, INTERACTIVE_SELECTOR) || disabled);
      } catch (e) {}
    }

    function openDead(el) {
      if (!Observer || document.visibilityState === 'hidden') return;
      // A new click means the person did something: the old window ends with no event.
      if (dead) clearTimeout(dead.timer);
      dead = { at: Date.now(), el: el, href: String(window.location.href), timer: setTimeout(endDead, DEAD_WAIT_MS) };
      syncObserver();
    }

    function endDead() {
      try {
        var d = dead;
        dead = null;
        syncObserver();
        if (!d || String(window.location.href) !== d.href) return;
        var props = elementProps(d.el);
        props.$wait_ms = DEAD_WAIT_MS;
        captureInternal('$deadclick', props, d.at);
      } catch (e) {}
    }

    function onFocusIn(ev) {
      try {
        var el = dead ? dead.el : rage ? rage.el : null;
        var node = ev && ev.target;
        if (!el || !node) return;
        // Chromium focuses the button or link it clicks: only focus moving AWAY is an effect.
        if (!(el === node || el.contains(node) || (node.contains && node.contains(el)))) effect(false);
      } catch (e) {}
    }

    function onSelectionChange() {
      // A click on text fires selectionchange with an EMPTY selection: that is not an effect.
      if ((dead || rage) && hasSelection()) effect(false);
    }

    function onScroll() {
      if (dead || rage) effect(false);
    }

    // The page goes away: an open dead window ends with no event (leaving IS an effect), but an
    // open rage burst is sent now (its 1 s timer would never fire). sendOnUnload calls this
    // BEFORE it drains the queue, so the burst rides in the same beacon, whatever the order of
    // the listeners.
    function onLeave() {
      try {
        if (dead) clearTimeout(dead.timer);
        dead = null;
        endRage();
      } catch (e) {}
    }
    flushOpenSignals = onLeave;

    function onSubmit(ev) {
      try {
        var target = ev && ev.target;
        if (!target || tagNameOf(target) !== 'form') return;

        captureInternal('$form_submit', {
          $form_selector: cap(stableSelector(target), EL_SELECTOR_MAX),
          form: target.id ? cap(String(target.id), EL_ID_MAX) : undefined
        });
      } catch (e) {}
    }

    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('selectionchange', onSelectionChange, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('popstate', onPopState);
    try {
      var navigation = window.navigation;
      if (navigation && typeof navigation.addEventListener === 'function') {
        navigation.addEventListener('navigate', function (ev) {
          lastNavigationType = ev.navigationType;
        });
        navigationApi = true;
      }
    } catch (e) {}

    try {
      var history = window.history;
      var originalPush = history.pushState;
      var originalReplace = history.replaceState;
      if (typeof originalPush === 'function') {
        history.pushState = function () {
          var result = originalPush.apply(history, arguments);
          checkPage('push');
          return result;
        };
      }
      if (typeof originalReplace === 'function') {
        history.replaceState = function () {
          var result = originalReplace.apply(history, arguments);
          checkPage('replace');
          return result;
        };
      }
    } catch (e) {}

    lastPageKey = pageKey(attachUrl || String(window.location.href));
    capturePageview(attachUrl, 'load');
  }

  // ─── the recorder (§5.6, S6) ──────────────────────────────────────────────

  function bootRecorder(config) {
    try {
      // C1: an opted-out visitor is never recorded. recorder-boot.js reads __sq_opt as well; this skips loading it.
      if (optedOut || DISABLED) return;
      var replay = config && config.replay;
      // S6: no replay block, not enabled, or no key: load nothing.
      if (!replay || !replay.enabled || !replay.key) return;
      // The recorder tag is on the page as well: do not load it twice.
      if (window.__lxReplayStarted) return;
      // Publish before the tag goes in: the recorder reads the id once, as it boots.
      publishReplaySessionId(session.id);
      var script = document.createElement('script');
      script.src = API + '/rec/recorder.js/' + encodeURIComponent(replay.key);
      script.async = true;
      var mount = document.head || document.documentElement;
      if (mount) mount.appendChild(script);
    } catch (e) {}
  }

  // ─── the unload path (§5.5) ───────────────────────────────────────────────

  function sendOnUnload() {
    try {
      flushOpenSignals();
      var envelope = drain();
      if (!envelope) return;
      var nav = window.navigator;
      if (nav && nav.sendBeacon) {
        var accepted = false;
        try {
          accepted = nav.sendBeacon(envelope.url, envelope.body);
        } catch (e) {
          accepted = false;
        }

        // A refused beacon falls back to fetch keepalive; it is never dropped.
        if (accepted) return;
      }
      try {
        window.fetch(envelope.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: envelope.body,
          keepalive: true
        })['catch'](noop);
      } catch (e) {}
    } catch (e) {}
  }

  // ─── boot ─────────────────────────────────────────────────────────────────

  function loadConfig() {
    try {
      if (!canSend()) return Promise.reject(new Error('fetch unavailable'));
      return window
        .fetch(API + '/i/v1/config/' + encodeURIComponent(KEY), { method: 'GET' })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('config ' + (res ? res.status : 'unavailable'));
          return res.json();
        });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  var api = {
    capture: capture,
    identify: identify,
    account: account,
    register: register,
    unregister: unregister,
    reset: reset,
    optOut: optOut,
    optIn: optIn,
    captureException: captureException,
    flush: flush
  };

  // Replay the stub queue in order; an unknown method or a throwing call is skipped.
  var pending = null;
  try {
    var stub = window.sequential;
    if (stub) {
      if (stub._q && stub._q.length) pending = stub._q;
      else if (Object.prototype.toString.call(stub) === '[object Array]' && stub.length) {
        pending = stub;
      }
    }
  } catch (e) {}

  window.sequential = api;

  if (pending) {
    for (var q = 0; q < pending.length; q++) {
      try {
        var call = pending[q];
        var method = call && call[0];
        var fn = method && Object.prototype.hasOwnProperty.call(api, method) ? api[method] : null;
        if (typeof fn === 'function') fn.apply(api, call[1] || []);
      } catch (e) {}
    }
  }

  // The queue has run: a visitor who is not opted out gets the ids stored.
  if (!optedOut && !DISABLED) startStorage();

  // Runs once, and again from optIn(). An opted-out visitor sends NO config request (C1).
  // S17: autocapture waits for the config, because the redaction rules ride on it.
  var bootStarted = false;

  function bootSequence() {
    if (bootStarted || DISABLED || optedOut) return;
    bootStarted = true;

    var attachUrl = null;
    try {
      attachUrl = String(window.location.href);
    } catch (e) {}

    try {
      loadConfig().then(
        function (config) {
          try {
            // Opted out while the request was in flight.
            if (optedOut) return;
            contextOn = true;
            syncContextCookie();
            if (config && config.redaction) installRedactor(config.redaction);

            if (AUTOCAPTURE_ENABLED) startAutocapture(attachUrl);
            bootRecorder(config);
          } catch (e) {}
        },
        function () {
          // Config failed: autocapture and replay stay off for this page (fail closed).
        }
      );
    } catch (e) {}
  }

  if (!DISABLED) {
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') sendOnUnload();
      });
      window.addEventListener('pagehide', sendOnUnload);
    } catch (e) {}

    bootSequence();
  }
})();
