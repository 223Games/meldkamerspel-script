// Smoke test: boots the built script in jsdom on a fake main page and checks it starts without errors
const { JSDOM } = require('jsdom');
const dom = new JSDOM(`<meta name="csrf-token" content="x"><div id="mission_list"></div>`, { url: 'https://www.meldkamerspel.com/', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window;
const errors = [];
w.console.error = (...a) => errors.push(a.join(' '));
w.fetch = async () => ({ ok: true, json: async () => [], text: async () => '<html></html>' });
const menu = [];
Object.assign(w, { GM_getValue: (k, d) => d, GM_setValue: () => {}, GM_registerMenuCommand: (l) => menu.push(l), GM_xmlhttpRequest: () => {}, unsafeWindow: w, missionMarkerAddSingle() {}, missionDelete() {}, radioMessage() {} });
const code = require('fs').readFileSync(require('path').join(__dirname, '..', 'meldkamerspel.user.js'), 'utf8');
w.eval(`const GM_getValue=window.GM_getValue,GM_setValue=window.GM_setValue,GM_registerMenuCommand=window.GM_registerMenuCommand,GM_xmlhttpRequest=window.GM_xmlhttpRequest,unsafeWindow=window;` + code);
const iframe = w.document.createElement('iframe'); iframe.className = 'lightbox_iframe'; w.document.body.append(iframe);
setTimeout(() => {
  console.log('menu:', menu);
  console.log('iframe watched:', iframe.dataset.mksWatched === '1');
  console.log('VRU button:', !![...w.document.querySelectorAll('button')].find((b) => /VRU/.test(b.textContent)));
  console.log('errors:', errors.length ? errors : 'none');
  const ok = !errors.length && iframe.dataset.mksWatched === '1' && menu.length > 1;
  process.exit(ok ? 0 : 1);
}, 300);
