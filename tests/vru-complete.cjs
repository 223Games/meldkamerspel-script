// VRU completeness: specials/trailers/regional status and achievements (v7.16.0)
const { JSDOM } = require('jsdom');
const path = require('path');
const code = require('fs').readFileSync(path.join(__dirname, '..', 'meldkamerspel.user.js'), 'utf8');
const body = code.replace(/\n\s*boot\(\);\s*\n\}\)\(\);\s*$/, '\nwindow.__mks = { vruExtrasStatus, recordAchievements };\n})();');
if (body === code) throw new Error('footer not found');
const w = new JSDOM('<div id="mission_list"></div>', { url: 'https://www.meldkamerspel.com/', runScripts: 'outside-only' }).window;
Object.assign(w, { GM_getValue: (k, d) => d, GM_setValue: () => {}, GM_registerMenuCommand: () => {}, GM_xmlhttpRequest: () => {}, unsafeWindow: w });
w.eval('const GM_getValue=window.GM_getValue,GM_setValue=window.GM_setValue,GM_registerMenuCommand=window.GM_registerMenuCommand,GM_xmlhttpRequest=window.GM_xmlhttpRequest,unsafeWindow=window;' + body);

const st = (id, c) => ({ id, caption: `BRW 09-${c} Post`, level: 3 });
const stations = [st(1, '06'), st(2, '07')];
const veh = (id, type, b) => ({ id, vehicle_type: type, building_id: b });
const items = w.__mks.vruExtrasStatus(stations, [veh(1, 153, 1), veh(2, 154, 1), veh(3, 5, 2), veh(4, 24, 2)]);
const get = (k) => items.find((i) => i.key === k);
const checks = {
  rietDoneAt06: get('riet@06').missing === 0 && get('ria@06').missing === 0,
  rietUnbuiltPostOpen: get('riet@37').missing === 1 && get('riet@37').unbuilt === true,
  abDoneAt07: get('ab@07').missing === 0 && get('ab@44').unbuilt === true,
  regionalAgsNeedsTwo: get('ags@regio').missing === 1, // one AGS owned, West + Oost wanted
  regionalHovdOpen: get('hovd@regio').missing === 2,
  achievementsKept: (() => {
    w.__mks.recordAchievements(['x@1']);
    const first = JSON.parse(w.localStorage.getItem('mks_vru_achieved_v1'))['x@1'];
    w.__mks.recordAchievements(['x@1', 'y@2']);
    const d = JSON.parse(w.localStorage.getItem('mks_vru_achieved_v1'));
    return d['x@1'] === first && !!d['y@2'];
  })(),
};
console.log(checks);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
