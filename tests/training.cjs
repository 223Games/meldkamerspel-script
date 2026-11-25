// Training queue: academy page parsing + ordered queue (v7.10.0), fixtures taken from the real pages
const { JSDOM } = require('jsdom');
const path = require('path');
const code = require('fs').readFileSync(path.join(__dirname, '..', 'meldkamerspel.user.js'), 'utf8');
const body = code.replace(/\n\s*boot\(\);\s*\n\}\)\(\);\s*$/, '\nwindow.__mks = { parseDutchDate, parseAcademyDoc, parseSchoolingDoc, buildTrainingQueue };\n})();');
if (body === code) throw new Error('footer not found');
const w = new JSDOM('<div id="mission_list"></div>', { url: 'https://www.meldkamerspel.com/', runScripts: 'outside-only' }).window;
Object.assign(w, { GM_getValue: (k, d) => d, GM_setValue: () => {}, GM_registerMenuCommand: () => {}, GM_xmlhttpRequest: () => {}, unsafeWindow: w });
w.eval('const GM_getValue=window.GM_getValue,GM_setValue=window.GM_setValue,GM_registerMenuCommand=window.GM_registerMenuCommand,GM_xmlhttpRequest=window.GM_xmlhttpRequest,unsafeWindow=window;' + body);
const doc = (html) => new JSDOM(html).window.document;
const m = w.__mks;

const busy = doc(`<div id="schooling">Alle klaslokalen zijn bezet.</div>
<div id="schooling_running"><table><tr><th>Opleiding</th><th>Loopt?</th><th>Vrije plaatsen</th><th>Tijd resterend</th></tr>
<tr><td><a href="/schoolings/2957739">Specialist Rietdakbrandbestrijder</a></td><td>Ja</td><td>0</td><td><a href="/schoolings/2957739/education/finish">Direct gereed (6 Coins)</a></td></tr></table></div>
<div id="ausbauten">Extra klaslokaal 7 dagen 400.000 Credits 40 Coins</div>`);
const free = doc(`<div id="schooling"><form><select><option>Specialist Rietdakbrandbestrijder</option></select></form></div><div id="schooling_running"></div><div id="ausbauten"></div>`);
const lesson = doc(`<h2>Specialist Rietdakbrandbestrijder</h2><p>De opleiding loopt tot ma 30 nov 2026 19:33:21 CET. Resterende tijd:</p>
<table><tr><th>Naam</th><th>Opleiding</th><th>Meldkamer</th><th>Gebouw</th></tr>
${['A', 'B', 'C'].map((n) => `<tr><td>${n}</td><td></td><td>223Games</td><td>BRW 09-06 Werkhoven</td></tr>`).join('')}</table>`);

const a = m.parseAcademyDoc(busy);
const l = m.parseSchoolingDoc(lesson);
const expectedEnd = new Date(2026, 10, 30, 19, 33, 21).getTime();

const sp = (name, education, extra = {}) => ({ name, education, trained: 0, ownedAt: [], missions: 0, unlocked: 0, home: { station: { id: 1, caption: 'BRW 09-06 Werkhoven' } }, shop: { minCrew: 2 }, ...extra });
const specialists = [
  sp('Voorlichter', 'Voorlichter', { unlocked: 1 }),
  sp('DB-RI', 'Specialist Rietdakbrandbestrijder', { ownedAt: [{ id: 1 }] }), // already running
  sp('AGS', 'Adviseur Gevaarlijke Stoffen', { missions: 3, unlocked: 2 }),
  sp('DB-VI', 'Veeredder', { ownedAt: [{ id: 2, caption: 'BRW 09-21 X' }] }),
  sp('HOvD', 'Hoofd Officier van Dienst - Brandweer', { trained: 2 }), // nothing to train
];
const queue = m.buildTrainingQueue(specialists, { academies: [{ running: [{ education: 'Specialist Rietdakbrandbestrijder', endsAt: expectedEnd }] }] });

const withExt = m.buildTrainingQueue(specialists, { academies: [] }, [
  { name: 'Veetakels', education: 'Specialist Veetakel', minCrew: 4, maxCrew: 6, count: 6, missed: 2 },
  { name: 'Rietkap', education: 'Adviseur Gevaarlijke Stoffen', minCrew: 2, maxCrew: 4, count: 1, missed: 0 }, // already queued via AGS: no duplicate
]);
const checks = {
  extensionEducationQueued: withExt.some((q) => q.vehicle === 'Veetakels' && q.people === 4) && withExt.filter((q) => q.education === 'Adviseur Gevaarlijke Stoffen').length === 1,
  dutchDate: m.parseDutchDate('ma 30 nov 2026 19:33:21 CET') === expectedEnd,
  busyAcademy: a.free === false && a.running.length === 1 && a.running[0].id === 2957739 && a.running[0].education === 'Specialist Rietdakbrandbestrijder',
  extraClassroomPrice: a.extraClassroomPrice === 400000,
  freeAcademy: m.parseAcademyDoc(free).free === true,
  lessonEndAndPeople: l.endsAt === expectedEnd && l.people === 3 && l.station === 'BRW 09-06 Werkhoven',
  queueOrder: queue.map((q) => q.vehicle).join() === 'DB-VI,AGS,Voorlichter,DB-RI', // idle owned first, running last
  runningFlagged: queue[3].running?.endsAt === expectedEnd,
  trainedSkipped: !queue.some((q) => q.vehicle === 'HOvD'),
};
console.log(checks);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
