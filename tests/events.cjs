// Event missions: detected through the catalog's date windows; tasks read from every tab; counter check (v7.13.0)
const { JSDOM } = require('jsdom');
const path = require('path');
const code = require('fs').readFileSync(path.join(__dirname, '..', 'meldkamerspel.user.js'), 'utf8');
const body = code.replace(/\n\s*boot\(\);\s*\n\}\)\(\);\s*$/, '\nwindow.__mks = { isEventEntry, loadTasks, recordCompletion, refreshEventTypes };\n})();');
if (body === code) throw new Error('footer not found');

const END = Date.UTC(2026, 11, 6, 23, 59, 59);
const tasksHtml = `<div id="all"><div class="task_panel hidden-xs"><div class="panel-heading"><div><b>[Herfst]</b> Beëindig 5 inzetten</div></div><div class="task_body">2.000 Credits<div class="progress"><div>3/5</div></div></div><script>registerTaskTimer("1-all-web", "x", 1796425199999)</script></div></div>
<div id="event"><div class="task_panel hidden-xs"><div class="panel-heading"><div>Maak 25 "Sinterklaas" evenementopdrachten af</div></div><div class="task_body"><script>$(function () { registerTaskTimer("44314-event-web", "task_countdown_44314-event-web", ${END}); });</script>15.000 Credits<div class="progress"><div>20/25</div></div></div></div>
<div class="task_panel hidden-xs"><div class="panel-heading"><div><b>[Herfst]</b> Beëindig 5 inzetten</div></div><div class="task_body">2.000 Credits<div class="progress"><div>3/5</div></div><script>registerTaskTimer("1-event-web", "x", 1796425199999)</script></div></div></div>`;

const w = new JSDOM('<div id="mission_list"></div>', { url: 'https://www.meldkamerspel.com/', runScripts: 'outside-only' }).window;
w.localStorage.setItem('mks_extras_event_types_v1', JSON.stringify({ ts: Date.now(), map: { 160: END } }));
Object.assign(w, {
  GM_getValue: (k, d) => d, GM_setValue: () => {}, GM_registerMenuCommand: () => {}, GM_xmlhttpRequest: () => {}, unsafeWindow: w,
  fetch: async () => ({ ok: true, text: async () => tasksHtml, json: async () => ({}) }),
});
w.eval('const GM_getValue=window.GM_getValue,GM_setValue=window.GM_setValue,GM_registerMenuCommand=window.GM_registerMenuCommand,GM_xmlhttpRequest=window.GM_xmlhttpRequest,unsafeWindow=window;' + body);
const m = w.__mks;

const entry = (type, caption) => {
  const d = new JSDOM(`<div id="mission_list"><div class="missionSideBarEntry" mission_id="1" mission_type_id="${type}" data-mission-type-filter="emergency"></div></div>`).window.document;
  return [d.querySelector('.missionSideBarEntry'), caption];
};

(async () => {
  const tasks = await m.loadTasks();
  m.recordCompletion('160');
  m.recordCompletion('160');
  m.recordCompletion('999');
  const done = JSON.parse(w.localStorage.getItem('mks_extras_completed_v1'));
  const checks = {
    // "Brandende cadeautjes" has no keyword in its name: it is an event only through the catalog window
    cadeautjesIsEvent: m.isEventEntry(...entry('160', 'Brandende cadeautjes')) === true,
    normalMissionIsNot: m.isEventEntry(...entry('486', 'Wateroverlast')) === false,
    readsEventTab: tasks.some((t) => /Sinterklaas/.test(t.title) && t.done === 20 && t.total === 25),
    endTimeRead: tasks.find((t) => /Sinterklaas/.test(t.title))?.endsAt === END,
    noDuplicates: tasks.filter((t) => /Beëindig 5/.test(t.title)).length === 1,
    completionsTaggedWithEvent: done.filter((e) => e.ev === END).length === 2 && done.filter((e) => !e.ev).length === 1,
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
