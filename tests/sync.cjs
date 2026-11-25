// Sync between devices through a (fake) GitHub gist (v7.6.0): logs merge by mission id,
// mission memory adds up per device and never double counts after repeated syncs.
const { JSDOM } = require('jsdom');
const path = require('path');

const code = require('fs').readFileSync(path.join(__dirname, '..', 'meldkamerspel.user.js'), 'utf8');
const expose = 'window.__mks = { syncNow, memoryTypesMerged, shortageStats, notOwnedStats };\n})();';
const body = code.replace(/\n\s*boot\(\);\s*\n\}\)\(\);\s*$/, `\n${expose}`);
if (body === code) throw new Error('footer not found');

// Fake GitHub gist API, shared by both devices
const gists = {};
let created = 0;
function fakeGithub({ method, url, data, onload }) {
  const id = url.split('/gists/')[1];
  const respond = (status, obj) => setTimeout(() => onload({ status, responseText: JSON.stringify(obj) }), 0);
  if (method === 'POST') {
    const newId = `g${++created}`;
    gists[newId] = JSON.parse(data).files;
    return respond(201, { id: newId });
  }
  if (!gists[id]) return respond(404, {});
  if (method === 'GET') return respond(200, { files: gists[id] });
  if (method === 'PATCH') {
    Object.assign(gists[id], JSON.parse(data).files);
    return respond(200, {});
  }
}

function device(name, gistId) {
  const dom = new JSDOM('<div id="mission_list"></div>', { url: 'https://www.meldkamerspel.com/', runScripts: 'outside-only' });
  const w = dom.window;
  const gm = { syncToken: 'token', syncGistId: gistId, syncDevice: name };
  Object.assign(w, {
    GM_getValue: (k, d) => (k in gm ? gm[k] : d),
    GM_setValue: (k, v) => (gm[k] = v),
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: fakeGithub,
    unsafeWindow: w,
  });
  w.eval('const GM_getValue=window.GM_getValue,GM_setValue=window.GM_setValue,GM_registerMenuCommand=window.GM_registerMenuCommand,GM_xmlhttpRequest=window.GM_xmlhttpRequest,unsafeWindow=window;' + body);
  return { w, gm, m: w.__mks };
}

(async () => {
  const now = Date.now();
  const a = device('mac', '');
  a.w.localStorage.setItem('mks_mem_types_v1', JSON.stringify({ 114: { name: 'Brandend dak', n: 2, usedSum: { firetrucks: 4 }, required: { platform_trucks: 1 }, requiredMax: { platform_trucks: 1 } } }));
  a.w.localStorage.setItem('mks_shortage_v1', JSON.stringify({ 900: { ts: now, cats: { firetrucks: 1 } } }));
  await a.m.syncNow(); // creates the gist
  const gistId = a.gm.syncGistId;

  const b = device('mobiel', gistId);
  b.w.localStorage.setItem('mks_mem_types_v1', JSON.stringify({ 114: { name: 'Brandend dak', n: 1, usedSum: { firetrucks: 2 }, required: { platform_trucks: 1 }, requiredMax: { platform_trucks: 2 } } }));
  b.w.localStorage.setItem('mks_shortage_v1', JSON.stringify({ 900: { ts: now - 1000, cats: { firetrucks: 2 } }, 901: { ts: now, cats: { water_tankers: 1 } } }));
  b.w.localStorage.setItem('mks_not_owned_v1', JSON.stringify({ 902: { ts: now, names: { 'DB-RI of RIA': 1 } } }));
  await b.m.syncNow();
  await a.m.syncNow();
  await a.m.syncNow(); // repeated syncs must not add anything
  await b.m.syncNow();

  const memA = a.m.memoryTypesMerged()[114];
  const memB = b.m.memoryTypesMerged()[114];
  const ownA = JSON.parse(a.w.localStorage.getItem('mks_mem_types_v1'))[114];
  const checks = {
    gistCreatedOnce: created === 1 && !!gistId,
    memoryAddsUpOnce: memA.n === 3 && memB.n === 3 && memA.usedSum.firetrucks === 6 && memA.requiredMax.platform_trucks === 2,
    ownMemoryStaysOwn: ownA.n === 2,
    shortagesMergedById: a.m.shortageStats().firetrucks?.missions === 1 && a.m.shortageStats().firetrucks.vehicles === 2 && a.m.shortageStats().water_tankers?.missions === 1,
    notOwnedShared: a.m.notOwnedStats()['DB-RI of RIA'] === 1,
    twoDevices: Object.keys(JSON.parse(gists[gistId]['meldkamerspel-sync.json'].content).devices).length === 2,
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
