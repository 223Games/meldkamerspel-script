  /* ------------------------------------------------------------------ */
  /* Mission windows (lightbox iframes on the main page)                 */
  /* ------------------------------------------------------------------ */

  /* ---------- Worklist: alarm, then open the next mission from YOUR priority list ---------- */

  const WORKLIST_NEXT = 'mks_worklist_next';
  const WORKLIST_DONE = 'mks_worklist_done';
  const sessionRead = (key, fallback) => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || 'null') ?? fallback;
    } catch (e) {
      return fallback;
    }
  };
  const sessionWrite = (key, value) => {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* best-effort */
    }
  };

  /** Next mission from the priority list, skipping this one and what the worklist alarmed in the last 10 min. */
  async function worklistNext(currentId) {
    const credits = await loadMissionCredits();
    const done = sessionRead(WORKLIST_DONE, {});
    return rankOwnMissions(credits).find((m) => m.id !== currentId && !(Date.now() - (done[m.id] || 0) < 10 * 60e3)) || null;
  }

  /**
   * Adds "▶ Alarmeren → <next>" next to the game's "Alarmeren en volgende". It uses the game's own
   * alarm-and-next submit; when the new window loads, it is redirected to the mission from your list.
   */
  async function addWorklistButton(doc) {
    const gameNext = doc.querySelector('#mission-form .alert_next');
    const currentId = (doc.location.pathname.match(/\/missions\/(\d+)/) || [])[1];
    if (!gameNext || !currentId || doc.getElementById('mks_worklist_btn')) return;
    const next = await worklistNext(currentId);
    if (!next) return;
    const btn = doc.createElement('a');
    btn.id = 'mks_worklist_btn';
    btn.href = '#';
    btn.className = 'btn btn-primary';
    btn.style.marginLeft = '4px';
    btn.title = 'Alarmeren en daarna de volgende melding uit je eigen prioriteitenlijst openen';
    btn.textContent = `▶ Alarmeren → ${next.caption}`;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const done = sessionRead(WORKLIST_DONE, {});
      done[currentId] = Date.now();
      sessionWrite(WORKLIST_DONE, done);
      sessionWrite(WORKLIST_NEXT, { id: next.id, ts: Date.now() });
      gameNext.click(); // the game's own alarm + next: same submit, same checks
    });
    gameNext.after(btn);
  }

  /** On a new mission window: if the worklist asked for another mission, go there instead. */
  function followWorklist(doc) {
    const want = sessionRead(WORKLIST_NEXT, null);
    if (!want) return false;
    sessionWrite(WORKLIST_NEXT, null);
    if (Date.now() - want.ts > 20e3) return false; // stale: the alarm round-trip takes a few seconds
    const currentId = (doc.location.pathname.match(/\/missions\/(\d+)/) || [])[1];
    if (currentId === want.id) return false;
    doc.location.href = `/missions/${want.id}`;
    return true;
  }

  function tryDispatchAssistant(doc) {
    const isMissionPage = /^\/missions\/\d+/.test(doc.location?.pathname || '') && !!doc.getElementById('mission-form');
    // After "▶ Alarmeren → …" the game opens ITS next mission (or another page): load the one from your list
    if (!(isMainPage && doc === document) && followWorklist(doc)) return; // only inside the lightbox, never the main page
    if (!isMissionPage || doc.documentElement.dataset.mksAssist) return; // not a mission, or already running
    doc.documentElement.dataset.mksAssist = '1';
    initDispatchAssistant(doc);
    if (setting('worklist')) addWorklistButton(doc).catch((e) => console.error('[MKS→HA] Worklist failed', e));
  }

  function watchMissionWindows() {
    const attach = (iframe) => {
      if (iframe.dataset.mksWatched) return;
      iframe.dataset.mksWatched = '1';
      // "load" fires on every navigation inside the frame (e.g. "Alarmeren en volgende")
      iframe.addEventListener('load', () => {
        try {
          initPage(iframe.contentDocument);
        } catch (e) {
          console.error('[MKS→HA] Cannot access lightbox window', e);
        }
      });
      if (iframe.contentDocument?.readyState === 'complete') initPage(iframe.contentDocument);
    };

    document.querySelectorAll('iframe.lightbox_iframe').forEach(attach);
    onBodyChange(() => document.querySelectorAll('iframe.lightbox_iframe').forEach(attach));
    log('Watching lightbox windows');
  }

