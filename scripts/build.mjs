#!/usr/bin/env node
// Builds dist/ from src/sequential.js, the file the script tag loads (cdn.usesequential.com/sdk/sequential/v1/), with no
// change to its code: it is one function expression called once, `(function (injectedTag) { … })();`. The package
// keeps the function and calls it from init() with a tag-shaped object made of the options, so every check on the
// options is the tag's own code. Writes dist/index.mjs (import), dist/index.cjs (require) and their .d.ts files.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A path string, not new URL(…): under a test DOM (jsdom), URL is not Node's.
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..') + '/';
const OPEN = '(function (injectedTag) {';
const CLOSE = '})();';

/** The SDK function expression: the source without its doc comment and its final call. Throws when the shape changed.
 *  @param {string} source the text of src/sequential.js @returns {string} */
export function sdkFunction(source) {
  const start = source.indexOf(OPEN);
  const end = source.trimEnd().lastIndexOf(CLOSE);
  if (start === -1 || end === -1 || source.trimEnd().length !== end + CLOSE.length)
    throw new Error(`src/sequential.js must be one ${OPEN} … ${CLOSE} expression`);
  if (source.indexOf(OPEN, start + 1) !== -1) throw new Error(`src/sequential.js has ${OPEN} twice`);
  return source.slice(start, end + 1) + ')';
}

/** The package's own code, ES5 like the SDK. `boot` is the SDK function.
 *  @param {string} version package.json's version @returns {string} */
function wrapper(version) {
  return `
var VERSION = '${version}';
var running = null;

function logLine(level, message) {
  try {
    if (window.console && window.console[level]) window.console[level]('[sequential] ' + message);
  } catch (e) {}
}

// Server rendering (no window), or init() without its key and api: every method is present and does nothing.
function inert() {
  function none() {}
  return {
    capture: none,
    identify: none,
    account: none,
    register: none,
    unregister: none,
    reset: none,
    optOut: none,
    optIn: none,
    captureException: none,
    flush: function () {
      return Promise.resolve();
    }
  };
}

function init(options) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return inert();
  if (running) {
    logLine('warn', 'init() ran before on this page; the first instance is used and these options are not read.');
    return running;
  }
  var current = window.sequential;
  if (current && typeof current.flush === 'function' && !current._q) {
    logLine('warn', 'the script tag already loaded the SDK on this page; init() uses it and does not read its options.');
    running = current;
    return running;
  }
  var o = options && typeof options === 'object' ? options : {};
  var own = function (name) {
    return Object.prototype.hasOwnProperty.call(o, name) ? o[name] : undefined;
  };
  var key = own('key');
  var api = own('api');
  if (typeof key !== 'string' || !key || typeof api !== 'string' || !api) {
    logLine('error', 'init() needs key (the sq_sequential_ key from Setup) and api (the ingest host); no events will be sent.');
    return inert();
  }
  var values = { 'data-key': key, 'data-api': api };
  if (typeof own('release') === 'string') values['data-release'] = own('release');
  if (typeof own('contextCookieDomain') === 'string') values['data-context-cookie-domain'] = own('contextCookieDomain');
  if (own('optOut') === true) values['data-opt-out'] = '';
  if (own('autocapture') === false) values['data-autocapture'] = 'false';
  if (own('identityText') === false) values['data-identity-text'] = 'off';
  boot({
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null;
    },
    hasAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(values, name);
    }
  });
  running = window.sequential;
  return running;
}
`;
}

const TYPES = readFileSync(`${PKG}src/index.d.ts`, 'utf8');

/** @param {string} source the text of src/sequential.js @param {string} version package.json's version
 *  @returns {{ mjs: string, cjs: string, dts: string }} */
export function buildPackage(source, version) {
  const banner =
    `/* @usesequential/browser ${version}: the Sequential browser SDK. MIT. https://www.usesequential.com/docs/browser-npm\n` +
    ' * `boot` below is sequential.js, the file the script tag loads, unchanged. */\n';
  const body = `var boot = ${sdkFunction(source)};\n${wrapper(version)}`;
  return {
    mjs: `${banner}${body}\nexport { init, VERSION };\n`,
    cjs: `${banner}'use strict';\n${body}\nexports.init = init;\nexports.VERSION = VERSION;\n`,
    dts: TYPES,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(`${PKG}package.json`, 'utf8'));
  const out = buildPackage(readFileSync(`${PKG}src/sequential.js`, 'utf8'), version);
  rmSync(`${PKG}dist`, { recursive: true, force: true });
  mkdirSync(`${PKG}dist`);
  writeFileSync(`${PKG}dist/index.mjs`, out.mjs);
  writeFileSync(`${PKG}dist/index.cjs`, out.cjs);
  writeFileSync(`${PKG}dist/index.d.mts`, out.dts);
  writeFileSync(`${PKG}dist/index.d.cts`, out.dts);
  console.log(`built @usesequential/browser ${version} in dist/`);
}
