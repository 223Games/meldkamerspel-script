// Development plan learns from what you miss: rietkap/veetakel extensions and an own academy (v7.4.0)
const { JSDOM } = require('jsdom');
const path = require('path');

const code = require('fs').readFileSync(path.join(__dirname, '..', 'meldkamerspel.user.js'), 'utf8');
const expose = 'window.__mks = { buildDevelopmentPlan, recordNotOwned, notOwnedStats, collectSpecialists, findStuckVehicles };\n})();';
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
// Voorlichter missed twice near Amersfoort
m.recordNotOwned('6', ['1× Voorlichter'], { lat: 52.156, lng: 5.387 });
m.recordNotOwned('7', ['1× Voorlichter (40%)'], { lat: 52.16, lng: 5.39 });
// Not in the VRU reference: home learned from where it was missed
m.recordNotOwned('8', ['1× Hoogwerker Zwaar'], { lat: 52.15, lng: 5.38 });
const stats = m.notOwnedStats();

const station = { id: 1, caption: 'BRW 09-51 Driebergen-Rijsenburg', building_type: 0, level: 3, extensions: [], small_building: false, hiring_phase: 0 };
const staff = Array.from({ length: 20 }, () => ({ keys: [] }));
const data = {
  typeInfo: {
    56: { name: 'DA-VL Voorlichter', education: 'Voorlichter', minStations: 0 },
    153: { name: 'DB-RI Dienstbus – Rietdakbrandbestrijding', education: 'Specialist Rietdakbrandbestrijder', minCrew: 2, maxCrew: 4 },
  },
  people: staff,
  keyOf: (name) => ({ 'Specialist Rietdakbrandbestrijder': 'riet' })[name] || null,
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
// Same plan once somebody is trained for rietkap: no training warning, extension is ready to go
const trainedData = { ...data, people: [{ keys: ['riet'] }, ...staff] };
const trainedPlan = m.buildDevelopmentPlan(trainedData, [station], 15);
const trainedExt = trainedPlan.steps.find((s) => s.kind === 'extension' && s.ext.key === 'thatched_fire');
// Rietkap built but switched off + nobody trained: the note says train first, not just "bewust?"
const offStation = { ...station, extensions: [{ type_id: 26, caption: 'Rietkapbrandbestrijding', available: true, enabled: false }] };
const offNotes = m.buildDevelopmentPlan(data, [offStation], 15).notes.join('\n');
const offNotesTrained = m.buildDevelopmentPlan(trainedData, [offStation], 15).notes.join('\n');
const noteText = plan.notes.join('\n');

// Specialists: register + home station
const amersfoort = { id: 2, caption: 'BRW 09-01 Amersfoort Centrum', building_type: 0, latitude: 52.155, longitude: 5.388 };
const driebergen = { ...station, latitude: 52.05, longitude: 5.28 };
const werkhoven = { id: 3, caption: 'BRW 09-06 Werkhoven', building_type: 0, latitude: 52.02, longitude: 5.24 };
const specialists = m.collectSpecialists(data, [driebergen, amersfoort, werkhoven], [{ id: 9, vehicle_type: 24, building_id: 2 }]);
const byName = Object.fromEntries(specialists.map((x) => [x.name, x]));
const register = JSON.parse(w.localStorage.getItem('mks_specialists_v1') || '{}');

// Stuck vehicles: seen on scene 13 days ago at another mission, now on scene again → not "329 hours"
const now = Date.now();
w.localStorage.setItem('mks_extras_status_since_v1', JSON.stringify({ 7: { fms: 4, target: 111, ts: now - 329 * 3600e3, seen: now - 329 * 3600e3 } }));
const stuckNow = m.findStuckVehicles([{ id: 7, fms_real: 4, target_id: 222, caption: 'BRW 09-5034 TS' }]);

const checks = {
  noFalseStuckAlarm: stuckNow.length === 0,
  // Brandbase: rietkap on 09-06/37/58/61 → the built one (Werkhoven), not 09-51
  rietkapHomeWerkhoven: byName['DB-RI of RIA']?.home.station?.id === 3 && !!byName['DB-RI of RIA'].home.extension,
  // Voorlichter is a head-office specialist → own post closest to the VRU head office (Driebergen here)
  voorlichterHomeHq: byName.Voorlichter?.home.station?.id === 1 && byName.Voorlichter.shop?.typeId === 56,
  learnedHomeNearestMisses: byName['Hoogwerker Zwaar']?.home.station?.id === 2,
  catalogSpecialistListed: byName.AGS?.ownedAt.length === 1 && byName.AGS.source === 'unlocked',
  registered: !!register.Voorlichter?.firstSeen && /Driebergen/.test(register.Voorlichter.home) && byName.Voorlichter.isNew,
  countsMissionsOnce: stats['DB-RI of RIA'] === 5 && stats.Voorlichter === 2,
  rietkapAdvised: !!ext && ext.missed === 5 && ext.s.station.id === 1,
  academyAdvised: !!academy && academy.trainings[0].label === 'AGS',
  rietkapNeedsTraining: !!ext && ext.personnel.ok === false && /niemand opgeleid als Specialist Rietdakbrandbestrijder/.test(ext.personnel.text) && plan.training.some((t) => t.education === 'Specialist Rietdakbrandbestrijder'),
  rietkapReadyWhenTrained: !!trainedExt && trainedExt.personnel.ok === true && !trainedPlan.training.some((t) => t.education === 'Specialist Rietdakbrandbestrijder'),
  disabledNoteSaysTrainFirst: /niemand opgeleid als Specialist Rietdakbrandbestrijder/.test(offNotes) && !/bewust/.test(offNotes) && /bewust/.test(offNotesTrained),
  otherMissesListed: /Voorlichter 2× → DA-VL Voorlichter, opleiding <i>Voorlichter<\/i>/.test(noteText),
};
console.log(checks);
if (!Object.values(checks).every(Boolean)) {
  console.log(plan.steps.map((s) => s.kind + ' ' + (s.ext?.key || s.label || '')), noteText);
  process.exit(1);
}
