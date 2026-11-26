// Crew planner: trained people on the right vehicle, or moved to the post that has it (v7.9.0)
const { JSDOM } = require('jsdom');
const path = require('path');
const code = require('fs').readFileSync(path.join(__dirname, '..', 'meldkamerspel.user.js'), 'utf8');
const expose = 'window.__mks = { planSpecialistCrew, findIdleTrained };\n})();';
const body = code.replace(/\n\s*boot\(\);\s*\n\}\)\(\);\s*$/, `\n${expose}`);
if (body === code) throw new Error('footer not found');
const w = new JSDOM('<div id="mission_list"></div>', { url: 'https://www.meldkamerspel.com/', runScripts: 'outside-only' }).window;
Object.assign(w, { GM_getValue: (k, d) => d, GM_setValue: () => {}, GM_registerMenuCommand: () => {}, GM_xmlhttpRequest: () => {}, unsafeWindow: w });
w.eval('const GM_getValue=window.GM_getValue,GM_setValue=window.GM_setValue,GM_registerMenuCommand=window.GM_registerMenuCommand,GM_xmlhttpRequest=window.GM_xmlhttpRequest,unsafeWindow=window;' + body);

const KEY = 'riet';
const person = (id, keys, extra = {}) => ({ id, name: `P${id}`, keys, boundVehicleId: null, boundRequiresKey: null, ...extra });
const filler = (n, from) => Array.from({ length: n }, (_, i) => person(from + i, []));
const A = { id: 1, caption: 'BRW 09-06 Werkhoven' }; // has the DB-RI, nobody trained
const B = { id: 2, caption: 'BRW 09-12 Elders' }; // two trained, no DB-RI
const C = { id: 3, caption: 'BRW 09-13 Klein' }; // one trained but only 10 staff: cannot spare
const dbri = { id: 100, caption: 'BRW 09-0671 DB-RI', vehicle_type: 153 };
const trainedB = [person(10, [KEY]), person(11, [KEY], { boundVehicleId: 50, boundRequiresKey: null })]; // 11 sits on a TS
const trainedC = person(20, [KEY]);
const mk = (stationRows, qualifiedAtA = [], boundHere = [], free = []) => ({
  stationRows,
  specialistVehicles: [{ vehicle: dbri, station: A, key: KEY, need: 2, full: 4, qualified: qualifiedAtA, boundHere, free, misbound: [] }],
});
const rows = (a, b, c) => [
  { station: A, staff: a, transferable: Math.max(0, a.length - 10) },
  { station: B, staff: b, transferable: Math.max(0, b.length - 10) },
  { station: C, staff: c, transferable: Math.max(0, c.length - 10) },
];

// 1. trained people at the post but free → bind
const freeHere = [person(1, [KEY]), person(2, [KEY])];
const p1 = w.__mks.planSpecialistCrew(mk(rows([...freeHere, ...filler(10, 100)], [...filler(12, 200)], [trainedC, ...filler(9, 300)]), freeHere, [], freeHere), 5);
// 2. trained at the post, bound to another vehicle → rebind
const onTs = [person(3, [KEY], { boundVehicleId: 50, boundRequiresKey: null }), person(4, [KEY], { boundVehicleId: 51, boundRequiresKey: null })];
const p2 = w.__mks.planSpecialistCrew(mk(rows([...onTs, ...filler(10, 100)], filler(12, 200), filler(10, 300)), onTs, [], []), 5);
// 3. nobody here; two trained at B (one bound to a TS) and one at C that cannot be spared → transfer 2 from B
const p3 = w.__mks.planSpecialistCrew(mk(rows(filler(10, 100), [...trainedB, ...filler(10, 200)], [trainedC, ...filler(9, 300)])), 5);
// 4. no transfers left this week → no transfer step
const p4 = w.__mks.planSpecialistCrew(mk(rows(filler(10, 100), [...trainedB, ...filler(10, 200)], filler(10, 300))), 0);
// 5. donor would drop below 10 staff → no transfer
const p5 = w.__mks.planSpecialistCrew(mk(rows(filler(10, 100), [...trainedB, ...filler(8, 200)], filler(10, 300))), 5);

// Idle trained people: posts with trained, unbound people but no car for that education (v7.15.0)
const stA = { id: 1, caption: 'BRW 09-01 A' }, stB = { id: 2, caption: 'BRW 09-02 B' }, stC = { id: 3, caption: 'BRW 09-03 C' };
const ppl = [person(1, ['ags'], { buildingId: 1 }), person(2, ['ags'], { buildingId: 1 }), person(3, ['ags'], { buildingId: 2 }), person(4, ['ags'], { buildingId: 3, boundVehicleId: 9 }), person(5, ['ags'], { buildingId: 3 })];
const idle = w.__mks.findIdleTrained({
  stations: [stA, stB, stC], people: ppl,
  vehicles: [{ id: 9, vehicle_type: 24, building_id: 3 }],
  typeInfo: { 24: { name: 'AGS', education: 'Adviseur Gevaarlijke Stoffen' }, 17: { name: 'TS', education: null } },
  keyOf: (e) => (e ? 'ags' : null),
})[0];

const checks = {
  idleTrainedPerPost: idle?.posts.map((x) => `${x.station.id}:${x.idle}`).join() === '1:2,2:1' && idle.owned === 1, // C has the car: not idle

  bindsFreeTrained: p1.length === 1 && p1[0].type === 'bind' && p1[0].people.length === 2,
  rebindsFromOtherVehicle: p2.length === 1 && p2[0].type === 'rebind' && p2[0].people.map((p) => p.id).join() === '3,4',
  transfersFromPostThatCanSpare: p3.length === 1 && p3[0].type === 'transfer' && p3[0].from.id === 2 && p3[0].people.length === 2 && p3[0].station.id === 1,
  boundTrainedPersonMayMove: p3[0]?.people.some((p) => p.id === 11 && p.boundVehicleId === 50),
  noTransfersLeft: p4.length === 0,
  donorKeepsMinimumStaff: p5.length === 0 || p5[0].people.length === 0 || p5[0].people.length < 2,
};
console.log(checks);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
