// Renders the VRU panel against a fake game (missions, shared missions, API data, Leaflet map)
// and checks the new sections: priorities, team radar, stuck vehicles, coverage map, report, settings.
const { JSDOM } = require('jsdom');
const path = require('path');

const entry = (list, id, type, state, lat, missing = '') => `
  <div class="missionSideBarEntry" mission_id="${id}" mission_type_id="${type}" latitude="${lat}" longitude="5.4">
    <div id="mission_panel_${id}" class="mission_panel_${state}"><span id="mission_caption_${id}">Melding ${id},</span>
    <div id="mission_missing_${id}">${missing}</div></div></div>`;
const html = `<meta name="csrf-token" content="x">
  <div id="mission_list">${entry('own', 1, 10, 'yellow', 52.1, 'Missende voertuigen: 1 Tankautospuit')}${entry('own', 2, 11, 'red', 52.2)}${entry('own', 3, 10, 'green', 52.1)}</div>
  <div id="mission_list_alliance">${entry('al', 9, 11, 'red', 52.11)}${entry('al', 8, 10, 'red', 54.9)}</div>`;

const dom = new JSDOM(html, { url: 'https://www.meldkamerspel.com/', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window;
const errors = [];
w.console.error = (...a) => errors.push(a.map(String).join(' '));
const now = Date.now();
const api = {
  '/api/buildings': [{ id: 100, building_type: 0, caption: 'BRW 09-01 Test', latitude: 52.1, longitude: 5.4, level: 1, personal_count: 4, hiring_phase: 0, extensions: [] }],
  '/api/vehicles': [
    { id: 1, building_id: 100, vehicle_type: 17, fms_real: 2, caption: 'BRW 09-0131 TS' },
    { id: 2, building_id: 100, vehicle_type: 17, fms_real: 6, caption: 'BRW 09-0132 TS' },
  ],
  '/api/credits': { credits_user_current: 5000, credits_user_total: 100000 },
  '/einsaetze.json': [{ id: 10, name: 'Brand A', average_credits: 1200, requirements: {}, prerequisites: {} }, { id: 11, name: 'Brand B', average_credits: 3000, requirements: {}, prerequisites: {} }],
};
const fetched = [];
w.fetch = async (url) => {
  fetched.push(url);
  const key = Object.keys(api).find((k) => url.startsWith(k));
  return { ok: true, json: async () => (key ? api[key] : []), text: async () => '<html><body></body></html>' };
};
// Stuck tracking: pretend vehicle 2 has been out of service for an hour
w.localStorage.setItem('mks_extras_status_since_v1', JSON.stringify({ 2: { fms: 6, ts: now - 3600e3 } }));
w.localStorage.setItem('mks_extras_completed_v1', JSON.stringify([{ ts: now - 1000, typeId: '11' }]));

const markers = [];
w.L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }), circleMarker: (ll, o) => ({ bindTooltip(t) { markers.push({ ll, o, t }); return this; }, addTo() { return this; } }) };
w.map = { addLayer() {}, removeLayer() {} };
const settings = {};
Object.assign(w, {
  GM_getValue: (k, d) => (k in settings ? settings[k] : d), GM_setValue: (k, v) => (settings[k] = v), GM_registerMenuCommand: () => {}, GM_xmlhttpRequest: () => {},
  unsafeWindow: w, missionMarkerAddSingle() {}, missionDelete() {}, radioMessage() {}, lightboxOpen() {},
});
w.eval('const GM_getValue=window.GM_getValue,GM_setValue=window.GM_setValue,GM_registerMenuCommand=window.GM_registerMenuCommand,GM_xmlhttpRequest=window.GM_xmlhttpRequest,unsafeWindow=window;' +
  require('fs').readFileSync(path.join(__dirname, '..', 'meldkamerspel.user.js'), 'utf8'));

[...w.document.querySelectorAll('button')].find((b) => /VRU/.test(b.textContent)).click();
setTimeout(() => {
  const text = w.document.body.textContent;
  const checks = {
    priorities: /Jouw meldingen \(2 vragen actie\)/.test(text),
    almostDoneFirst: /bijna klaar/.test(text),
    teamRadar: /Teamhulp dichtbij \(1, ≤15 km\)/.test(text),
    stuck: /buiten dienst/.test(text),
    report: /Vandaag/.test(text) && /Brand B 1×/.test(text),
    settings: w.document.querySelectorAll('[id^="mks-set-"]').length > 5,
    coverageMap: markers.length === 1 && /1\/2 TS vrij/.test(markers[0].t),
  };
  const ownErrors = errors.filter((e) => /Priorities|Report|Extras|Panel failed/.test(e));
  console.log(checks, ownErrors.length ? ownErrors : 'no errors in new sections');
  process.exit(Object.values(checks).every(Boolean) && !ownErrors.length ? 0 : 1);
}, 9500);
