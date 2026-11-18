// Development plan learns from what you miss: rietkap/veetakel extensions and an own academy (v7.4.0)
const { JSDOM } = require('jsdom');
const path = require('path');

const code = require('fs').readFileSync(path.join(__dirname, '..', 'meldkamerspel.user.js'), 'utf8');
const expose = 'window.__mks = { buildDevelopmentPlan, recordNotOwned, notOwnedStats };\n})();';
const body = code.replace(/\n\s*boot\(\);\s*\n\}\)\(\);\s*$/, `\n${expose}`);
if (body === code) throw new Error('footer not found');

const dom = new JSDOM('<div id="mission_list"></div>', { url: 'https://www.meldkamerspel.com/', runScripts: 'outside-only' });
const w = dom.window;
Object.assign(w, { GM_getValue: (k, d) => d, GM_setValue: () => {}, GM_registerMenuCommand: () => {}, GM_xmlhttpRequest: () => {}, unsafeWindow: w });
w.eval('const GM_getValue=window.GM_getValue,GM_setValue=window.GM_setValue,GM_registerMenuCommand=window.GM_registerMenuCommand,GM_xmlhttpRequest=window.GM_xmlhttpRequest,unsafeWindow=window;' + body);
const m = w.__mks;

// 5 missions asked for a rietkap vehicle (missing text), 2 for a "Voorlichter"; one repeat must not double count
for (let i = 1; i <= 5; i++) m.recordNotOwned(String(i), ['1× DB-RI of RIA']);
m.recordNotOwned('1', ['1× DB-RI of RIA']);
m.recordNotOwned('6', ['1× Voorlichter']);
m.recordNotOwned('7', ['1× Voorlichter (40%)']);
const stats = m.notOwnedStats();

const station = { id: 1, caption: 'BRW 09-51 Driebergen-Rijsenburg', building_type: 0, level: 3, extensions: [], small_building: false, hiring_phase: 0 };
const staff = Array.from({ length: 20 }, () => ({ keys: [] }));
const data = {
  typeInfo: { 56: { name: 'DA-VL Voorlichter', education: 'Voorlichter', minStations: 0 } },
  vehicles: [],
  stationRows: [{ station, own: [], staff, crewNeeded: 6 }],
  specialtyRows: [
    { key: 'hazmat_vehicles', label: 'AGS', typeId: 24, unlocked: [{}, {}, {}], owned: false, trained: false, info: { name: 'DA-AGS', education: 'Adviseur Gevaarlijke Stoffen' } },
  ],
  extensionStats: {}, // prerequisites count found nothing: the old code then never advised rietkap
  academy: { typeId: 3, name: 'Brandweeracademie', owned: false },
};
const plan = m.buildDevelopmentPlan(data, [station], 15);
const ext = plan.steps.find((s) => s.kind === 'extension' && s.ext.key === 'thatched_fire');
const academy = plan.steps.find((s) => s.kind === 'academy');
const noteText = plan.notes.join('\n');

const checks = {
  countsMissionsOnce: stats['DB-RI of RIA'] === 5 && stats.Voorlichter === 2,
  rietkapAdvised: !!ext && ext.missed === 5 && ext.s.station.id === 1,
  academyAdvised: !!academy && academy.trainings[0].label === 'AGS',
  otherMissesListed: /Voorlichter 2× → DA-VL Voorlichter, opleiding <i>Voorlichter<\/i>/.test(noteText),
};
console.log(checks);
if (!Object.values(checks).every(Boolean)) {
  console.log(plan.steps.map((s) => s.kind + ' ' + (s.ext?.key || s.label || '')), noteText);
  process.exit(1);
}
