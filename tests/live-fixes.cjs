// Checks the fixes from the live test (v7.2.1):
// - coverage map on Apple MapKit (the game's default map provider), not only Leaflet
// - "Retour post": arrival order from registerVehicleTimer(), only own vehicles, return=mission_js
const { JSDOM } = require('jsdom');
const path = require('path');

const code = require('fs').readFileSync(path.join(__dirname, '..', 'meldkamerspel.user.js'), 'utf8');
const expose = 'window.__mks = { updateCoverageMap, returnSurplusVehicles, initDispatchAssistant };\n})();';
const body = code.replace(/\n\s*boot\(\);\s*\n\}\)\(\);\s*$/, `\n${expose}`);
if (body === code) throw new Error('footer not found');

// One driving row as the game renders it (inspected live, Nov 2026)
const row = (vehicleId, caption, typeCaption, userId, arrivalMs) => `
  <tr id="vehicle_row_${vehicleId}"><td><a href="/vehicles/${vehicleId}">${caption}</a>
    <small class="vehicle_caption">(${typeCaption})</small><small class="visible-xs">(<a href="/profile/${userId}">speler</a>)</small></td>
    <td><a href="/profile/${userId}">speler</a>
    <a class="btn btn-xs btn-default btn-backalarm-ajax" vehicle_id="${vehicleId}" href="/vehicles/${vehicleId}/backalarm?return=mission&amp;ifs=at_fi">Retour post</a></td>
    <td><script>registerVehicleTimer(${vehicleId}, 1, ${arrivalMs})</script></td></tr>`;
// A vehicle queued for this mission (busy elsewhere), as rendered live: plain <small>, no timer,
// first backalarm link is "Direct naar deze inzet vertrekken"
const queuedRow = (vehicleId, typeId, caption) => `
  <tr><td><span class="building_list_fms building_list_fms_4">2</span></td>
    <td><a href="/vehicles/${vehicleId}" vehicle_type_id="${typeId}">${caption}</a> <small> (TS 6/7) </small><small class="visible-xs">(<a href="/profile/1">speler</a>)</small></td>
    <td><a href="/profile/1">speler</a>
    <a href="/vehicles/${vehicleId}/backalarm?ifs=at_fi&amp;next_mission=1&amp;return=mission">Direct naar deze inzet vertrekken</a>
    <a href="/vehicles/${vehicleId}/backalarm?only_mission_id=77&amp;return=mission">Retour post</a></td></tr>`;
const queuedMissionHtml = `<html><body><h1 id="missionH1">Brand bij afvalverwerker</h1>
  <div id="missing_text"><div data-requirement-type="vehicles">Missende voertuigen: 2 Tankautospuiten</div></div>
  <table id="mission_vehicle_at_mission"><tbody><tr><td><small class="vehicle_caption">(DA-OVD)</small></td></tr></tbody></table>
  <table id="mission_vehicle_driving"><tbody>${queuedRow(21, 17, 'BRW 09-1831 TS')}${queuedRow(22, 17, 'BRW 09-2031 TS')}</tbody></table>
</body></html>`;
const missionHtml = `<html><body><h1 id="missionH1">Brand in woning</h1>
  <div id="missing_text"><div data-requirement-type="vehicles">Missende voertuigen: 1 Tankautospuit</div></div>
  <table id="mission_vehicle_at_mission"><tbody><tr><td>OvD</td></tr></tbody></table>
  <table id="mission_vehicle_driving"><tbody>
    ${row(11, 'BRW 09-0131 TS', 'TS 6/7', 1, 5000)}
    ${row(12, 'BRW 09-0231 TS', 'TS 6/7', 1, 2000)}
    ${row(13, 'Team TS', 'TS 6/7', 99, 9000)}
  </tbody></table></body></html>`;

const dom = new JSDOM('<meta name="csrf-token" content="x"><div id="mission_list"></div>', {
  url: 'https://www.meldkamerspel.com/', pretendToBeVisual: true, runScripts: 'outside-only',
});
const w = dom.window;
const errors = [];
w.console.error = (...a) => errors.push(a.map(String).join(' '));
const requested = [];
w.fetch = async (url) => {
  requested.push(String(url));
  if (String(url).startsWith('/api/buildings')) return { ok: true, json: async () => [{ id: 100, building_type: 0, caption: 'BRW 09-01 Test', latitude: 52.1, longitude: 5.4 }] };
  if (String(url).startsWith('/api/vehicles')) return { ok: true, json: async () => [{ id: 1, building_id: 100, vehicle_type: 17, fms_real: 2 }, { id: 2, building_id: 100, vehicle_type: 17, fms_real: 3 }] };
  if (String(url).startsWith('/missions/77')) return { ok: true, json: async () => ({}), text: async () => queuedMissionHtml };
  return { ok: true, json: async () => ({}), text: async () => missionHtml };
};

// Minimal MapKit: the shape the game exposes as window.mapkit / window.map
const added = { overlays: [], annotations: [] };
w.mapkit = {
  Coordinate: function (lat, lng) { Object.assign(this, { latitude: lat, longitude: lng }); },
  CircleOverlay: function (c, r, o) { Object.assign(this, { c, r, o }); },
  Style: function (o) { Object.assign(this, o); },
  Annotation: function (c, factory, o) { Object.assign(this, { c, el: factory(), o }); },
};
w.map = {
  addOverlays: (a) => added.overlays.push(...a), removeOverlays: (a) => (added.overlays = added.overlays.filter((x) => !a.includes(x))),
  addAnnotations: (a) => added.annotations.push(...a), removeAnnotations: (a) => (added.annotations = added.annotations.filter((x) => !a.includes(x))),
};
w.DOMPoint = function (x, y) { Object.assign(this, { x, y }); };
w.user_id = 1;
Object.assign(w, { GM_getValue: (k, d) => d, GM_setValue: () => {}, GM_registerMenuCommand: () => {}, GM_xmlhttpRequest: () => {}, unsafeWindow: w });
w.eval('const GM_getValue=window.GM_getValue,GM_setValue=window.GM_setValue,GM_registerMenuCommand=window.GM_registerMenuCommand,GM_xmlhttpRequest=window.GM_xmlhttpRequest,unsafeWindow=window;' + body);

(async () => {
  await w.__mks.updateCoverageMap();
  await w.__mks.updateCoverageMap(); // second run must replace, not stack
  await w.__mks.returnSurplusVehicles(5);
  const backCalls = requested.filter((u) => u.includes('backalarm'));
  await w.__mks.returnSurplusVehicles(77); // only queued vehicles driving: they must never be touched
  const queuedBackCalls = requested.filter((u) => u.includes('backalarm')).length - backCalls.length;

  // Mission window: game misses 2 TS, but 2 TS are already queued for it → select nothing
  const win = new JSDOM(`<a id="mission_help" href="/einsaetze/1"></a>${queuedMissionHtml.replace(/<\/?(html|body)>/g, '')}
    <form id="mission-form"><table><tbody id="vehicle_show_table_body_all">
      <tr class="vehicle_select_table_tr" vehicle_type="TS 6/7" data-distance="1"><td><input type="checkbox" class="vehicle_checkbox" vehicle_type_id="17" value="31"></td></tr>
      <tr class="vehicle_select_table_tr" vehicle_type="TS 6/7" data-distance="2"><td><input type="checkbox" class="vehicle_checkbox" vehicle_type_id="17" value="32"></td></tr>
    </tbody></table></form>`, { url: 'https://www.meldkamerspel.com/missions/77' }).window.document;
  w.localStorage.setItem('mks_ha_mission_types_v1', JSON.stringify({ ts: Date.now(), data: { 1: { r: { firetrucks: 3 }, c: {} } } }));
  w.__mks.initDispatchAssistant(win);
  await new Promise((r) => setTimeout(r, 1500));
  const selectedTs = win.querySelectorAll('.vehicle_checkbox:checked').length;
  const panelText = win.querySelector('.alert')?.textContent || '';
  const checks = {
    mapkitRing: added.overlays.length === 1 && added.overlays[0].o.style.strokeColor === '#f9a825',
    mapkitBadge: added.annotations.length === 1 && added.annotations[0].el.textContent === '1/2',
    // TS 12 arrives first and fills the missing TS; TS 11 is surplus; team TS 13 is never touched
    returnsOnlyLaterOwnTs: backCalls.length === 1 && backCalls[0].startsWith('/vehicles/11/'),
    usesMissionJs: backCalls.every((u) => u.includes('return=mission_js')),
    queuedNeverReturned: queuedBackCalls === 0,
    queuedCountedInWindow: selectedTs === 0 && /In wachtrij hierheen/.test(panelText) && /2× TS/.test(panelText),
  };
  console.log(checks, errors.length ? errors : 'no errors');
  if (!checks.queuedCountedInWindow) console.log('selected', selectedTs, 'panel:', panelText);
  process.exit(Object.values(checks).every(Boolean) && !errors.length ? 0 : 1);
})();
