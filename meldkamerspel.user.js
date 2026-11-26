// ==UserScript==
// @name         Meldkamerspel → Home Assistant + Alarmeerhulp + VRU
// @namespace    https://223studio.nl/
// @version      7.15.3
// @description  HA lamp feedback, dispatch assistant and VRU (Veiligheidsregio Utrecht) naming for stations and vehicles
// @match        https://www.meldkamerspel.com/*
// @match        https://meldkamerspel.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      homeassistant.local
// @connect      *
// @updateURL    https://raw.githubusercontent.com/223Games/meldkamerspel-script/main/meldkamerspel.user.js
// @downloadURL  https://raw.githubusercontent.com/223Games/meldkamerspel-script/main/meldkamerspel.user.js
// @supportURL   https://github.com/223Games/meldkamerspel-script
// @run-at       document-idle
// ==/UserScript==

/*
 * How the game works (inspected live):
 * - New/updated missions arrive via push in missionMarkerAddSingle(mission)
 *   mission.vehicle_state: 0 = red (unattended), 1 = yellow (en route), 2 = green (on scene)
 * - A completed mission triggers missionDelete(missionId); the element is NOT removed,
 *   it only gets the class "mission_deleted".
 * - Vehicle status updates arrive in radioMessage(msg) with msg.type === 'vehicle_fms'
 *   msg.fms_real === 5 means "spraakaanvraag" (request to speak).
 * - Mission window: /missions/<id>. Mission type via #mission_help href (/einsaetze/<type>).
 *   Requirements per type in /einsaetze.json. Available vehicles in #vehicle_show_table_body_all,
 *   already assigned in #mission_vehicle_driving and #mission_vehicle_at_mission.
 *   After the first dispatch, #missing_text lists what is still missing (on scene only).
 */

(function () {
  'use strict';

  const CONFIG = {
    // --- Home Assistant ---
    // Personal values live in Tampermonkey storage (menu: "Home Assistant instellen"), not in this file,
    // so the script can be hosted online for automatic updates
    haUrl: GM_getValue('haUrl', 'http://homeassistant.local:8123'),
    webhookId: GM_getValue('webhookId', ''),
    sendCompleted: GM_getValue('opt_sendCompleted', true), // mission completed
    sendMissing: GM_getValue('opt_sendMissing', true), // "Missende voertuigen" appears on a mission
    sendStateChanges: false, // mission turned red / yellow / green
    sendSpeakRequests: false, // vehicle in status 5 (spraakaanvraag)

    // --- Dispatch assistant ---
    dispatchAssist: GM_getValue('opt_dispatchAssist', true), // pre-select vehicles in the mission window (you still press Alarmeren)
    minChance: 50, // include requirements that are only needed with this % chance or higher
    focusAlertNext: true, // put keyboard focus on "Alarmeren en volgende" (press Enter to dispatch)
    queueBusyVehicles: GM_getValue('opt_queueBusyVehicles', true), // nothing free? queue a vehicle that is on scene elsewhere (Dooralarmeren)
    missionTypesCacheHours: 24,
    autoReturnSurplus: GM_getValue('opt_autoReturnSurplus', true), // mission running with nothing missing? send own vehicles still driving there back to station

    // --- VRU stations & vehicles ---
    vru: {
      enabled: true,
      prefix: 'BRW', // all stations and vehicles start with this
      defaultBuildingType: 17, // 17 = Brandweer, Kazerne (klein), 0 = Kazerne
      startVehicleTypeId: 17, // 17 = TS 6/7 (1 = TS 8/9, 9 = TS 4/5)
      autoHireDays: 3, // start recruitment after building (0 = off)
      panel: true, // 🚒 VRU panel on the main page (tasks, hiring, expansion, advice, progress)
      personnelPanel: true, // 👷 personnel panel (specialists, binding, transfers, training advice)
    },

    debug: GM_getValue('opt_debug', false), // true = log every step to the browser console (F12)
  };

  const log = (...args) => CONFIG.debug && console.log('[MKS→HA]', ...args);

  /** On/off switches (Tampermonkey storage, per browser). `needsReload`: only read when the page starts. */
  const SETTINGS = [
    { key: 'dispatchAssist', label: 'Alarmeerhulp in meldingsvenster', def: true, needsReload: true },
    { key: 'eventPriority', label: 'Evenementmeldingen bovenaan de prioriteiten en werklijst', def: true },
    { key: 'worklist', label: 'Werklijst: "Alarmeren → volgende uit mijn lijst"', def: false },
    { key: 'queueBusyVehicles', label: 'Dooralarmeren bij tekort', def: true, needsReload: true },
    { key: 'autoReturnSurplus', label: 'Overbodige voertuigen terugsturen', def: true, needsReload: true },
    { key: 'coverageMap', label: 'Dekkingskaart (vrije TS per post)', def: true },
    { key: 'stuckWarnings', label: 'Waarschuwing vergeten voertuigen', def: true },
    { key: 'autoClaimTasks', label: 'Taken automatisch claimen', def: false },
    { key: 'autoHire', label: 'Werving automatisch verlengen bij tekort', def: false },
    { key: 'sendCompleted', label: 'HA: melding afgerond', def: true, needsReload: true },
    { key: 'sendMissing', label: 'HA: missende voertuigen', def: true, needsReload: true },
    { key: 'debug', label: 'Debug-log in console', def: false, needsReload: true },
  ];
  const setting = (key) => GM_getValue(`opt_${key}`, SETTINGS.find((s) => s.key === key)?.def ?? false);

  const isMainPage = !!document.getElementById('mission_list');

  /** Tampermonkey menu: set the personal Home Assistant values once (stored per browser). */
  function registerSettingsMenu() {
    GM_registerMenuCommand('Home Assistant instellen', () => {
      const url = window.prompt('Home Assistant-adres', CONFIG.haUrl);
      if (url === null) return;
      const id = window.prompt('Webhook ID (uit je HA-automation)', CONFIG.webhookId);
      if (id === null) return;
      GM_setValue('haUrl', url.trim().replace(/\/$/, ''));
      GM_setValue('webhookId', id.trim());
      window.alert('Opgeslagen. Herlaad de pagina.');
    });

    // On/off switches, stored per browser (also in the VRU panel under ⚙️ Instellingen)
    SETTINGS.forEach(({ key, label }) =>
      GM_registerMenuCommand(`${setting(key) ? '✅' : '⬜'} ${label}`, () => {
        GM_setValue(`opt_${key}`, !setting(key));
        window.alert(`${label} ${setting(key) ? 'aan' : 'uit'}gezet. Herlaad de pagina.`);
      })
    );
  }

  /**
   * One shared, throttled watcher for DOM changes on the main page. The game updates the
   * mission list constantly; callbacks run at most once per animation frame, and only when nodes were added.
   */
  const bodyChangeCallbacks = [];
  let bodyChangeScheduled = false;
  function onBodyChange(callback) {
    bodyChangeCallbacks.push(callback);
    if (bodyChangeCallbacks.length > 1) return;
    new MutationObserver((records) => {
      if (bodyChangeScheduled || !records.some((r) => r.addedNodes.length)) return;
      bodyChangeScheduled = true;
      requestAnimationFrame(() => {
        bodyChangeScheduled = false;
        bodyChangeCallbacks.forEach((cb) => {
          try {
            cb();
          } catch (e) {
            console.error('[MKS→HA] DOM watcher', e);
          }
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Started at the bottom of the script, after all constants are defined
  function boot() {
    if (isMainPage) {
      registerSettingsMenu();
      registerSyncMenu();
      startSync();
      refreshEventTypes().catch(() => {});
    }
    if (isMainPage) {
      initHomeAssistantBridge();
      watchMissionWindows();
      if (CONFIG.vru.enabled) {
        watchBuildForm();
        pollPendingHire();
        if (CONFIG.vru.panel) initPanel();
        if (CONFIG.vru.personnelPanel) initPersonnelPanel();
      }
      startExtras();
    }
    // Page opened directly (or Tampermonkey injected into the frame)
    initPage(document);
  }

  /** Runs every feature that applies to a (frame) document, once per document. */
  function initPage(doc) {
    if (!doc?.documentElement || doc.documentElement.dataset.mksInit) return;
    doc.documentElement.dataset.mksInit = '1';
    const run = (fn) =>
      Promise.resolve()
        .then(() => fn(doc))
        .catch((e) => console.error('[MKS→HA]', fn.name, e));

    if (CONFIG.dispatchAssist) run(tryDispatchAssistant);
    if (CONFIG.vru.enabled) {
      run(enhanceVehicleShop);
      run(enhanceBuildingPage);
      run(processPendingRename);
    }
  }

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
    // Only next to the form's "Alarmeren en volgende": the fixed bar at the bottom keeps the game's own buttons
    const gameNexts = [...doc.querySelectorAll('.alert_next')].slice(0, 1);
    const currentId = (doc.location.pathname.match(/\/missions\/(\d+)/) || [])[1];
    if (!gameNexts.length || !currentId || doc.documentElement.dataset.mksWorklist) return;
    doc.documentElement.dataset.mksWorklist = '1';
    const next = await worklistNext(currentId);
    if (!next) return;
    gameNexts.forEach((gameNext) => {
      const btn = doc.createElement('a');
      btn.id = 'mks_worklist_btn';
      btn.href = '#';
      btn.className = `btn btn-primary${gameNext.classList.contains('btn-xs') ? ' btn-xs' : gameNext.classList.contains('btn-sm') ? ' btn-sm' : ''}`;
      btn.style.marginLeft = '4px';
      btn.title = `Alarmeren en daarna de volgende melding uit je eigen prioriteitenlijst openen: ${next.caption}`;
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
    });
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

  /* ------------------------------------------------------------------ */
  /* Home Assistant bridge (main page)                                   */
  /* ------------------------------------------------------------------ */

  function initHomeAssistantBridge() {
    const w = unsafeWindow;
    const STATES = ['red', 'yellow', 'green'];
    const missions = new Map(); // id -> { caption, state }

    function sendEvent(event, data = {}) {
      if (!CONFIG.webhookId) return log('No webhook ID set: Home Assistant events are off');
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${CONFIG.haUrl}/api/webhook/${CONFIG.webhookId}`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({
          event,
          ...data,
          open_missions: missions.size,
          timestamp: new Date().toISOString(),
        }),
        onload: (res) => log(`Sent "${event}"`, res.status),
        onerror: (err) => console.error('[MKS→HA] Webhook failed', err),
      });
    }

    function wrap(fnName, before) {
      const original = w[fnName];
      if (typeof original !== 'function') {
        console.warn(`[MKS→HA] ${fnName} not found, game code may have changed`);
        return;
      }
      w[fnName] = function (...args) {
        try {
          before(...args);
        } catch (e) {
          console.error(`[MKS→HA] Error in ${fnName} hook`, e);
        }
        return original.apply(this, args);
      };
    }

    // Register own missions already on screen (alliance lists are skipped)
    document
      .querySelectorAll(
        '#mission_list .missionSideBarEntry, #mission_list_krankentransporte .missionSideBarEntry, #mission_list_sicherheitswache .missionSideBarEntry',
      )
      .forEach((entry) => {
        if (entry.classList.contains('mission_deleted')) return;
        const id = parseInt(entry.getAttribute('mission_id'), 10);
        const caption = entry
          .querySelector(`#mission_caption_${id}`)
          ?.firstChild?.textContent?.trim()
          .replace(/,$/, '');
        const panel = entry.querySelector(`#mission_panel_${id}`);
        const state = STATES.find((s) => panel?.classList.contains(`mission_panel_${s}`)) || 'red';
        const missing = !!entry.querySelector(`#mission_missing_${id}`)?.textContent.trim();
        const typeId = entry.getAttribute('mission_type_id');
        missions.set(id, { caption: caption || 'Melding', state, missing, typeId }); // existing state: no event
        if (CONFIG.autoReturnSurplus && state === 'green') scheduleSurplusCheck(id, 5000 + missions.size * 1500);
      });

    const toPlainText = (value) => {
      const div = document.createElement('div');
      div.innerHTML = typeof value === 'string' ? value : JSON.stringify(value);
      return div.textContent.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    };

    // New or updated mission from push
    wrap('missionMarkerAddSingle', (m) => {
      if (!m || m.user_id != w.user_id) return; // own missions only

      const state = STATES[m.vehicle_state] || 'red';
      const missing = !!m.missing_text;
      const known = missions.get(m.id);
      missions.set(m.id, { caption: m.caption, state, missing, typeId: m.mtid != null ? String(m.mtid) : known?.typeId });
      if (CONFIG.autoReturnSurplus && state === 'green') scheduleSurplusCheck(m.id);

      // "Missende voertuigen" just appeared
      if (missing && !known?.missing) {
        const text = toPlainText(m.missing_text);
        log('Missing vehicles', m.id, m.caption, text);
        if (m.mtid != null) {
          rememberMissionSnapshot(m.id, { typeId: String(m.mtid), name: m.caption, used: {}, required: parseMissingVehicles(text).missing });
        }
        if (CONFIG.sendMissing) sendEvent('mission_missing', { mission_id: m.id, caption: m.caption, missing: text });
      }

      if (!known) {
        log('New mission', m.id, m.caption);
        if (CONFIG.sendStateChanges) sendEvent('mission_new', { mission_id: m.id, caption: m.caption, state });
      } else if (known.state !== state) {
        log('Mission state', m.id, known.state, '→', state);
        if (CONFIG.sendStateChanges) sendEvent('mission_state', { mission_id: m.id, caption: m.caption, state });
      }
    });

    // Mission completed
    wrap('missionDelete', (id) => {
      id = parseInt(id, 10);
      finalizeMissionMemory(id);
      const done = missions.get(id);
      if (done) recordCompletion(done.typeId);
      const known = missions.get(id);
      if (!known) return; // alliance or unknown mission

      missions.delete(id);
      log('Mission completed', id, known.caption);
      if (CONFIG.sendCompleted) sendEvent('mission_completed', { mission_id: id, caption: known.caption });
    });

    // Vehicle status (FMS)
    wrap('radioMessage', (msg) => {
      if (!msg || msg.type !== 'vehicle_fms' || msg.user_id != w.user_id) return;
      if (msg.fms_real === 5) {
        log('Speak request', msg.caption);
        if (CONFIG.sendSpeakRequests) {
          sendEvent('vehicle_speak_request', { vehicle_id: msg.id, vehicle: msg.caption, mission_id: msg.mission_id });
        }
      }
    });

    log(`HA bridge active — tracking ${missions.size} own missions`);
  }

  /* ------------------------------------------------------------------ */
  /* Return surplus vehicles                                             */
  /* ------------------------------------------------------------------ */

  const surplusTimers = new Map();

  /** Debounced: the mission marker updates several times while vehicles arrive. */
  function scheduleSurplusCheck(missionId, delay = 4000) {
    clearTimeout(surplusTimers.get(missionId));
    surplusTimers.set(
      missionId,
      setTimeout(() => {
        surplusTimers.delete(missionId);
        returnSurplusVehicles(missionId).catch((e) => console.error('[MKS→HA] Return surplus failed', e));
      }, delay)
    );
  }

  /**
   * Own vehicles still DRIVING to a mission that won't need them, sent back with the game's "Retour post" link.
   * Only decided once vehicles are on scene, because only then does the game show what is really missing:
   * - nothing missing → every vehicle still driving is surplus;
   * - "Missende voertuigen: 1 OvD" → keep the first-arriving OvD, everything else driving is surplus.
   * Vehicles on scene are never touched. Unknown missing items or missing water/pump: do nothing (safe side).
   */
  async function returnSurplusVehicles(missionId) {
    const doc = await fetchDoc(`/missions/${missionId}`);
    if (!doc.querySelector('#mission_vehicle_at_mission tbody tr')) return; // nobody on scene: game hasn't decided yet
    const rows = [...doc.querySelectorAll('#mission_vehicle_driving tbody tr')];
    if (!rows.length) return;

    const requirementEls = [...doc.querySelectorAll('#missing_text [data-requirement-type]')];
    if (requirementEls.some((el) => el.getAttribute('data-requirement-type') !== 'vehicles')) {
      return log('Surplus check: water/pump/other still missing, leaving vehicles', missionId);
    }
    const vehicleMissing = requirementEls.find((el) => el.getAttribute('data-requirement-type') === 'vehicles');
    const { missing, unknown } = vehicleMissing ? parseMissingVehicles(vehicleMissing.textContent) : { missing: {}, unknown: [] };
    if (unknown.length) return log('Surplus check: unknown missing items, leaving vehicles', missionId, unknown);

    // Arrival time: the row holds no countdown text, only registerVehicleTimer(vehicleId, startMs, arrivalMs)
    const arrival = (row) => {
      const timer = row.textContent.match(/registerVehicleTimer\(\s*\d+\s*,\s*\d+\s*,\s*(\d+)\s*\)/);
      if (timer) return +timer[1];
      const m = row.textContent.match(/(\d+):(\d{2}):(\d{2})/);
      return m ? Date.now() + (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 : Infinity;
    };
    // Shared missions list other players' vehicles too: only ever touch our own
    const ownUserId = String(unsafeWindow.user_id || '');
    const isOwn = (row) => {
      const profile = row.querySelector('a[href^="/profile/"]')?.getAttribute('href');
      return !profile || !ownUserId || profile === `/profile/${ownUserId}`;
    };
    // Only the real "Retour post" link: queued rows start with "Direct naar deze inzet vertrekken" (also backalarm),
    // which would pull the vehicle away from the mission it is busy with
    const backLink = (row) =>
      [...row.querySelectorAll('a[href*="backalarm"]')].find(
        (a) => /retour\s*post/i.test(a.textContent) && !/next_mission=/.test(a.getAttribute('href'))
      ) || null;

    // First-arriving vehicles fill what is still missing; the rest is surplus
    const stillNeeded = { ...missing };
    const surplus = [];
    rows
      .sort((a, b) => arrival(a) - arrival(b))
      .forEach((row) => {
        const keys = assignedRowCategories(row);
        if (!keys.length && Object.keys(missing).length) return; // unrecognised vehicle while something is missing: keep
        // Fills every gap it counts for (a TST-NB covers a missing NB and a missing TS); also teammates' vehicles
        const fills = keys.filter((k) => stillNeeded[k] > 0);
        if (fills.length) {
          fills.forEach((k) => (stillNeeded[k] -= 1));
          return;
        }
        if (!isOwn(row)) return;
        if (isQueuedRow(row)) return; // queued vehicle (busy elsewhere): never touched, the player decides
        const link = backLink(row);
        if (link) surplus.push({ row, link });
      });
    if (!surplus.length) return;

    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const returned = [];
    for (const { row, link } of surplus) {
      const method = (link.getAttribute('data-method') || 'get').toUpperCase();
      // Same call as the game's own button: return=mission_js answers with a small script instead of the whole page
      const res = await fetch(link.getAttribute('href').replace('return=mission&', 'return=mission_js&'), {
        method,
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrf, 'X-Requested-With': 'XMLHttpRequest' },
      });
      const caption = row.querySelector('a[href^="/vehicles/"]')?.textContent.trim() || 'voertuig';
      if (res.ok) returned.push(caption);
      else console.warn('[MKS→HA] Back to station failed', caption, res.status, link.getAttribute('href'));
    }
    if (!returned.length) return;
    const title = (doc.getElementById('missionH1')?.textContent || `melding ${missionId}`).replace(/\s+/g, ' ').trim();
    const reason = Object.keys(missing).length ? 'niet nodig volgens missende voertuigen' : 'melding is al compleet';
    log(`Returned ${returned.length} surplus vehicles from`, missionId, returned);
    showToast(`↩️ Terug naar post (${escapeHtml(title)}, ${reason}): ${returned.map(escapeHtml).join(', ')}`);
  }

  /** Small notice in the bottom-right corner of the main page. */
  function showToast(html) {
    const box = document.createElement('div');
    box.className = 'alert alert-info';
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;max-width:380px;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    box.innerHTML = html;
    box.addEventListener('click', () => box.remove());
    document.body.append(box);
    setTimeout(() => box.remove(), 12000);
  }

  /* ------------------------------------------------------------------ */
  /* Dispatch assistant (mission window)                                 */
  /* ------------------------------------------------------------------ */

  /* ---------- Shortage log: which vehicle kinds you keep running out of ---------- */

  const SHORTAGE_KEY = 'mks_shortage_v1';
  const SHORTAGE_DAYS = 7;
  // Dispatch category -> VRU vehicle labels that solve it
  const SHORTAGE_LABELS = {
    firetrucks: ['TS', 'TST'],
    platform_trucks: ['AL'],
    battalion_chief_vehicles: ['OvD'],
    heavy_rescue_vehicles: ['HV'],
    water_tankers: ['WT', 'SW'],
    mobile_air_vehicles: ['AB'],
  };

  const readShortages = () => {
    try {
      return JSON.parse(localStorage.getItem(SHORTAGE_KEY) || '{}');
    } catch (e) {
      return {};
    }
  };

  /**
   * Remembers per mission what had to be dispatched further or was not available at all.
   * Once per mission (highest count wins), so reopening a window doesn't count twice.
   */
  function recordShortage(missionId, short, queued) {
    if (!missionId) return;
    const cats = {};
    [short, queued].forEach((obj) => Object.entries(obj || {}).forEach(([k, n]) => (cats[k] = (cats[k] || 0) + n)));
    if (!Object.keys(cats).length) return;
    const entries = readShortages();
    const prev = entries[missionId]?.cats || {};
    Object.entries(prev).forEach(([k, n]) => (cats[k] = Math.max(cats[k] || 0, n)));
    entries[missionId] = { ts: entries[missionId]?.ts || Date.now(), cats };
    Object.keys(entries).forEach((id) => {
      if (Date.now() - entries[id].ts > SHORTAGE_DAYS * 86400e3) delete entries[id];
    });
    try {
      localStorage.setItem(SHORTAGE_KEY, JSON.stringify(entries));
    } catch (e) {
      /* best-effort */
    }
  }

  /** Last 7 days per category: in how many missions you were short, and how many vehicles in total. */
  function shortageStats() {
    const stats = {};
    Object.values(readShortages()).forEach(({ ts, cats }) => {
      if (Date.now() - ts > SHORTAGE_DAYS * 86400e3) return;
      Object.entries(cats).forEach(([k, n]) => {
        stats[k] = stats[k] || { missions: 0, vehicles: 0 };
        stats[k].missions += 1;
        stats[k].vehicles += n;
      });
    });
    return stats;
  }

  /* ---------- Not-owned log: vehicles missions asked for that you don't have at all ---------- */

  const NOT_OWNED_KEY = 'mks_not_owned_v1';
  const NOT_OWNED_DAYS = 14;

  /** "1× DB-RI of RIA (40%)" → "DB-RI of RIA" */
  const notOwnedName = (item) => String(item).replace(/^\d+\s*×\s*/, '').replace(/\s*\(\d+%\)\s*$/, '').trim();

  /**
   * Per mission (once, highest count wins): names from "Missende voertuigen" or requirement keys you don't own.
   * `at` = mission location {lat, lng}: used to advise the home station closest to where you miss it.
   */
  function recordNotOwned(missionId, items, at = null) {
    if (!missionId || !items?.length) return;
    let entries;
    try {
      entries = JSON.parse(localStorage.getItem(NOT_OWNED_KEY) || '{}');
    } catch (e) {
      entries = {};
    }
    const names = { ...(entries[missionId]?.names || {}) };
    items.forEach((item) => {
      const count = parseInt(String(item).match(/^(\d+)/)?.[1] || '1', 10);
      const name = notOwnedName(item);
      if (name) names[name] = Math.max(names[name] || 0, count);
    });
    entries[missionId] = { ts: entries[missionId]?.ts || Date.now(), names, at: at || entries[missionId]?.at || null };
    Object.keys(entries).forEach((id) => {
      if (Date.now() - entries[id].ts > NOT_OWNED_DAYS * 86400e3) delete entries[id];
    });
    try {
      localStorage.setItem(NOT_OWNED_KEY, JSON.stringify(entries));
    } catch (e) {
      /* best-effort */
    }
  }

  /** Last 14 days per name: missions and where they were ({ name: { missions, at: [{lat, lng}] } }). */
  function notOwnedDetails() {
    let entries;
    try {
      entries = JSON.parse(localStorage.getItem(NOT_OWNED_KEY) || '{}');
    } catch (e) {
      return {};
    }
    const out = {};
    Object.values(entries).forEach(({ ts, names, at }) => {
      if (Date.now() - ts > NOT_OWNED_DAYS * 86400e3) return;
      Object.keys(names || {}).forEach((name) => {
        out[name] = out[name] || { missions: 0, at: [] };
        out[name].missions += 1;
        if (at) out[name].at.push(at);
      });
    });
    return out;
  }

  /** Last 14 days: per name, in how many missions it was asked for while you had none. */
  function notOwnedStats() {
    let entries;
    try {
      entries = JSON.parse(localStorage.getItem(NOT_OWNED_KEY) || '{}');
    } catch (e) {
      return {};
    }
    const stats = {};
    Object.values(entries).forEach(({ ts, names }) => {
      if (Date.now() - ts > NOT_OWNED_DAYS * 86400e3) return;
      Object.keys(names || {}).forEach((name) => (stats[name] = (stats[name] || 0) + 1));
    });
    return stats;
  }

  /** Extra plan weight per VRU label for kinds you were short of (capped so it can't drown out the rest). */
  function shortageWeights() {
    const weights = {};
    Object.entries(shortageStats()).forEach(([cat, st]) =>
      (SHORTAGE_LABELS[cat] || []).forEach((label) => (weights[label] = Math.min(40, st.missions * 1.5)))
    );
    return weights;
  }

  // Requirement key (einsaetze.json) -> how to recognise it
  // caption: vehicle type caption in the vehicle tables, missing: name in "Missende voertuigen"
  const DISPATCH_CATEGORIES = {
    // Nature fire vehicle (game key contains "brush"): TST-NB / NBV, type ids 12, 14, 15.
    // First, so "Tankautospuit natuurbrand…" in a missing text isn't read as a plain TS.
    // A TST-NB also counts as TS: assigned vehicles are counted for every category they match.
    brush_trucks: { label: 'NB', caption: /(^|-)NBV?\b/i, typeIds: ['12', '14', '15'], missing: /natuurbrand|\bNBV?\b/i },
    firetrucks: { label: 'TS', caption: /^TST?(-NB)?\s*\d/i, missing: /Tankautospuit/i },
    platform_trucks: { label: 'AL/HW', caption: /^(AL|HW)$/i, missing: /Redvoertuig|Autoladder|Hoogwerker/i },
    mobile_command_vehicles: { label: 'HOvD', caption: /^DA-HOD$/i, missing: /Hoofd\s*Officier\s*van\s*Dienst|HOVD/i },
    hazmat_vehicles: { label: 'AGS', caption: /^DA-AGS$/i, missing: /Adviseurs?\s*Gevaarlijke\s*Stoffen/i },
    elw3: { label: 'CO', caption: /^CO$/i, missing: /Commandowagen|Commandovoertuig/i },
    gwmess: { label: 'VEB', caption: /^DB-VEB$/i, missing: /Verkenningseenhe/i },
    // Matched on type id too (5 = AB): the row's type text is not always the bare "AB"
    mobile_air_vehicles: { label: 'AB', caption: /(^|\s)AB$/i, typeIds: ['5'], missing: /Adembescherming/i },
    // Specialist: the DB-RI (153) tows the RIA trailer (154). The trailer is a separate row, ticked together with its tractor.
    thatched_firefighting: { label: 'DB-RI', caption: /^DB-RI$/i, typeIds: ['153'], missing: /Riet/i, withTypeIds: ['154'], extension: true },
    livestock_hoist: { label: 'DB-VI', caption: /^DB-VI$/i, typeIds: ['155'], missing: /Vee(redd|hef)|Dierhef/i, extension: true },
    // Blusrobot (added Nov 2026): BMH-BRB (159) hook-lift, towed by the DB-BRB crew bus (157). Every mission asking for it also needs police + ambulance buildings.
    fire_extinguisher_robot: { label: 'BMH-BRB', caption: /^(BMH-BRB|DB-BRB)$/i, typeIds: ['159'], missing: /Blusrobot/i, withTypeIds: ['157'], extension: true },
    // Blusboot (berth = building type 28). Vehicle type ids unknown until a berth is built: matched on name.
    fire_boat: { label: 'Blusboot', caption: /^(BRV|BB)\b|blusboot|brandweerboot|vaartuig/i, missing: /Blusboot|Brandweerboot|Brandweervaartuig/i, extension: true },
    battalion_chief_vehicles: {
      label: 'OvD-B',
      caption: /OVD/i,
      missing: /Officier\s*van\s*Dienst\s*-\s*Brandweer/i,
    },
    heavy_rescue_vehicles: { label: 'HV', caption: /^HV$/i, missing: /Hulpverlening/i },
    // "Slangenwagen, watertankwagen of gelijkwaardige haakarmbak": SL and WT both count
    // Matched on type id too (10 = SL, 34 = WT): the caption in the vehicle list can differ
    water_tankers: {
      label: 'WT/SL',
      caption: /^(WT|SL|SW)\b|water\s*tank|slang/i,
      typeIds: ['10', '34'],
      missing: /Watertank|Slangenwagen/i,
    },
  };

  /** Does this vehicle row (available / dispatch-further list) belong to the category? */
  function rowMatchesCategory(key, row) {
    const cat = DISPATCH_CATEGORIES[key];
    const typeId = row.querySelector('.vehicle_checkbox')?.getAttribute('vehicle_type_id');
    return cat.caption.test(row.getAttribute('vehicle_type') || '') || (!!cat.typeIds && cat.typeIds.includes(typeId));
  }

  /**
   * Type caption ("TS 6/7", "WT") of a row in "Voertuigen zijn onderweg" / "ter plaatse".
   * Normal rows use <small class="vehicle_caption">, but rows of vehicles queued for this mission
   * (busy elsewhere, coming next) have a plain <small> — without this they were not counted at all.
   */
  function assignedRowCaption(row) {
    const small =
      row.querySelector('small.vehicle_caption') ||
      [...row.querySelectorAll('small')].find((s) => !s.classList.contains('visible-xs') && /\(/.test(s.textContent));
    return (small?.textContent || '').replace(/[()]/g, '').trim();
  }

  /** All dispatch categories an assigned vehicle row counts for (a TST-NB is TS and NB). */
  function assignedRowCategories(row) {
    const caption = assignedRowCaption(row);
    const typeId = row.querySelector('a[vehicle_type_id]')?.getAttribute('vehicle_type_id');
    return Object.keys(DISPATCH_CATEGORIES).filter(
      (k) => DISPATCH_CATEGORIES[k].caption.test(caption) || !!DISPATCH_CATEGORIES[k].typeIds?.includes(typeId)
    );
  }


  /** Requirement keys as the game names them → our category ("…brush…" = nature fire vehicle). */
  const canonicalRequirementKey = (key) => (/brush/i.test(key) ? 'brush_trucks' : key);

  /** Water/pump per vehicle id, read from its vehicle page (stable per vehicle, so cached for the session). */
  const vehicleCapacityCache = new Map();

  /** Row in "onderweg" of a vehicle queued for this mission: no drive timer, still busy at its current mission. */
  const isQueuedRow = (row) => !/registerVehicleTimer/.test(row.textContent) && !!row.querySelector('a[href*="next_mission="]');

  /** Parses a "Missende voertuigen: 1 Tankautospuit, 2 …" text into counts per category. */
  function parseMissingVehicles(rawText) {
    const text = String(rawText || '').replace(/\u00a0/g, ' ').replace(/^.*?:/, '');
    const missing = {};
    const unknown = [];
    // Split only on commas followed by a count: names can contain commas themselves
    // ("1 Slangenwagen, watertankwagen of gelijkwaardige haakarmbak")
    text.split(/,\s*(?=\d+\s)/).forEach((part) => {
      const m = part.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) return;
      const [, count, name] = m;
      const key = Object.keys(DISPATCH_CATEGORIES).find((k) => DISPATCH_CATEGORIES[k].missing.test(name));
      if (key) missing[key] = (missing[key] || 0) + parseInt(count, 10);
      else unknown.push(`${count}× ${name.trim()}`);
    });
    return { missing, unknown };
  }

  function initDispatchAssistant(doc) {
    const CATEGORIES = DISPATCH_CATEGORIES;

    // Requirements that are amounts or conditions, not vehicles
    const NON_VEHICLE_KEYS = /^(water_needed|foam_needed|min_pump_speed|personnel_educations|oneof_)/;

    const panel = createPanel();
    run();

    async function run() {
      panel.setText('Alarmeerhulp: bezig…');
      try {
        const typeId = getMissionTypeId();
        const { needed, notOwned, info, enRoute, missed } = await calculateNeeded(typeId);
        // Feeds the development plan: what you keep missing because you don't have it at all
        const missionId = (doc.location?.pathname || '').match(/\/missions\/(\d+)/)?.[1];
        const entry = missionId && document.getElementById(`mission_${missionId}`);
        const lat = parseFloat(entry?.getAttribute('latitude'));
        const lng = parseFloat(entry?.getAttribute('longitude'));
        const { selected, short } = selectVehicles(needed);
        if (Object.keys(short).length && (await loadMoreVehicles())) {
          // Far-away vehicles were not in the list yet: try again for what is still short
          const retry = selectVehicles({ ...short });
          Object.keys(short).forEach((k) => delete short[k]);
          Object.assign(short, retry.short);
          Object.entries(retry.selected).forEach(([k, n]) => (selected[k] = (selected[k] || 0) + n));
        }
        if (short.water_tankers) logWaterDebug();
        // Extension vehicles (DB-RI, blusrobot…) still short after everything: the plan reads this as "missed"
        Object.entries(short).forEach(([k, n]) => {
          if (CATEGORIES[k].extension) missed.push(`${n}× ${CATEGORIES[k].label}`);
        });
        recordNotOwned(missionId, missed, Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null);
        const queued =
          CONFIG.queueBusyVehicles && Object.keys(short).length ? await queueBusyVehicles(short) : {};
        const resources = await selectForResources(typeId);
        recordShortage((doc.location?.pathname || '').match(/\/missions\/(\d+)/)?.[1], short, queued);

        renderResult(selected, short, notOwned, info, queued, resources, enRoute);
        await renderMemoryHint(typeId);
        if (CONFIG.focusAlertNext) doc.getElementById('alert_next_btn')?.focus();
      } catch (e) {
        console.error('[MKS→HA] Dispatch assistant failed', e);
        panel.setText(`Alarmeerhulp: fout — ${e.message}`, 'danger');
      }
    }

    function getMissionTypeId() {
      const href = doc.getElementById('mission_help')?.getAttribute('href') || '';
      const match = href.match(/\/einsaetze\/(\d+)/);
      if (!match) throw new Error('meldingstype niet gevonden');
      return match[1];
    }

    async function loadMissionTypes() {
      const cacheKey = 'mks_ha_mission_types_v1';
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (cached && Date.now() - cached.ts < CONFIG.missionTypesCacheHours * 3600e3) return cached.data;
      } catch (e) {
        /* ignore broken cache */
      }

      const types = await loadMissionCatalog();
      const data = {};
      types.forEach((t) => {
        data[t.id] = { r: t.requirements || {}, c: t.chances || {} };
      });
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
      } catch (e) {
        /* storage full — fine, just no cache */
      }
      return data;
    }

    /** Counts assigned vehicle rows (driving, queued, on scene) per category. */
    function countRows(rows) {
      const counts = {};
      rows.forEach((row) => assignedRowCategories(row).forEach((key) => (counts[key] = (counts[key] || 0) + 1)));
      return counts;
    }

    function countByCategory(captions) {
      const counts = {};
      captions.forEach((caption) => {
        for (const [key, cat] of Object.entries(CATEGORIES)) {
          if (cat.caption.test(caption)) counts[key] = (counts[key] || 0) + 1;
        }
      });
      return counts;
    }

    function parseMissingText() {
      const el = doc.querySelector('#missing_text [data-requirement-type="vehicles"]');
      return el ? parseMissingVehicles(el.textContent) : null;
    }

    async function calculateNeeded(typeId) {
      // "driving" includes vehicles queued for this mission: they come for sure, just later
      const drivingRows = [...doc.querySelectorAll('#mission_vehicle_driving tbody tr')];
      const driving = countRows(drivingRows);
      const atMission = countRows([...doc.querySelectorAll('#mission_vehicle_at_mission tbody tr')]);

      const needed = {};
      const notOwned = [];
      const missed = []; // asked for, but you don't have that kind at all
      const info = [];
      const enRoute = {}; // "missing" per the game, but already driving or queued there
      const queuedHere = countRows(drivingRows.filter(isQueuedRow));
      if (Object.keys(queuedHere).length)
        info.push(
          `<b>In wachtrij hierheen</b> (meegeteld): ${Object.entries(queuedHere)
            .map(([k, n]) => `${n}× ${CATEGORIES[k].label}`)
            .join(', ')}`
        );

      // Other requirement types (water, personnel, …) shown by the game
      doc.querySelectorAll('#missing_text [data-requirement-type]').forEach((el) => {
        if (el.getAttribute('data-requirement-type') !== 'vehicles')
          info.push(el.textContent.replace(/\s+/g, ' ').trim());
      });

      const missingText = parseMissingText();
      if (missingText) {
        // Game already knows what's missing on scene; subtract what is still driving
        for (const [key, count] of Object.entries(missingText.missing)) {
          needed[key] = Math.max(0, count - (driving[key] || 0));
          const covered = Math.min(count, driving[key] || 0);
          if (covered) enRoute[key] = covered;
        }
        notOwned.push(...missingText.unknown);
        missed.push(...missingText.unknown);
        log('Using missing text', missingText, 'driving', driving);
      } else {
        // New mission: use the mission type requirements
        const types = await loadMissionTypes();
        const type = types[typeId];
        if (!type) throw new Error(`meldingstype ${typeId} onbekend`);

        for (const [rawKey, count] of Object.entries(type.r)) {
          if (NON_VEHICLE_KEYS.test(rawKey)) continue;
          const key = canonicalRequirementKey(rawKey);
          const chance = type.c[rawKey];
          if (chance !== undefined && chance < CONFIG.minChance) continue;

          if (!CATEGORIES[key]) {
            notOwned.push(`${count}× ${key}${chance !== undefined ? ` (${chance}%)` : ''}`);
            if (chance === undefined) missed.push(`${count}× ${key}`); // only certain requirements count as a miss
            continue;
          }
          needed[key] = Math.max(0, count - (driving[key] || 0) - (atMission[key] || 0));
        }
        log('Using requirements for type', typeId, type, '→', needed);
      }

      return { needed, notOwned, info, enRoute, missed };
    }

    /**
     * The game does not always load every vehicle into the mission window.
     * Clicks its own "load more/missing vehicles" button if present and waits for new rows.
     */
    async function loadMoreVehicles() {
      const button = [...doc.querySelectorAll('.missing_vehicles_load, #mission-form a.btn, #mission-form button')].find(
        (el) =>
          el.offsetParent !== null &&
          (el.classList.contains('missing_vehicles_load') || /(meer|ontbrekende|alle)\s+voertuigen|voertuigen\s+laden|laad\s+(meer|alle)/i.test(el.textContent))
      );
      if (!button) return false;
      const countRows = () => doc.querySelectorAll('#vehicle_show_table_body_all tr.vehicle_select_table_tr').length;
      const before = countRows();
      log('Loading more vehicles via', button.textContent.trim());
      button.click();
      for (let i = 0; i < 30 && countRows() === before; i++) await new Promise((r) => setTimeout(r, 200));
      return countRows() > before;
    }

    /** Console info to diagnose a WT/SL that is not picked up. */
    function logWaterDebug() {
      const rows = [...doc.querySelectorAll('#vehicle_show_table_body_all tr.vehicle_select_table_tr')];
      console.info(
        '[MKS→HA] WT/SL niet gevonden. Beschikbare voertuigtypes in dit venster:',
        [...new Set(rows.map((r) => `${r.getAttribute('vehicle_type')} (id ${r.querySelector('.vehicle_checkbox')?.getAttribute('vehicle_type_id')})`))].join(', ')
      );
    }

    /** Ticks the trailer row(s) that belong to a just-selected tractor (same building), e.g. RIA behind the DB-RI. */
    function tickTowedRows(key, row) {
      const withTypes = CATEGORIES[key].withTypeIds;
      if (!withTypes) return;
      doc.querySelectorAll('#vehicle_show_table_body_all tr.vehicle_select_table_tr').forEach((other) => {
        const box = other.querySelector('.vehicle_checkbox');
        if (!box || box.checked || box.disabled) return;
        if (!withTypes.includes(box.getAttribute('vehicle_type_id'))) return;
        if (other.getAttribute('building') !== row.getAttribute('building')) return;
        box.click();
      });
    }

    function selectVehicles(needed) {
      const rows = [...doc.querySelectorAll('#vehicle_show_table_body_all tr.vehicle_select_table_tr')].sort(
        (a, b) => parseFloat(a.dataset.distance || 999) - parseFloat(b.dataset.distance || 999),
      );

      const selected = {};
      const short = {};
      // A vehicle can count for several requirements (TST-NB = NB and TS): credit it to all of them
      const credit = {};
      // Most specific first: the NB requirement picks a TST-NB, which then also covers a TS
      const order = Object.entries(needed).sort(([a], [b]) => (a === 'brush_trucks' ? -1 : b === 'brush_trucks' ? 1 : 0));

      for (const [key, count] of order) {
        let remaining = count - (credit[key] || 0);
        for (const row of rows) {
          if (remaining <= 0) break;
          const checkbox = row.querySelector('.vehicle_checkbox');
          if (!checkbox || checkbox.checked) continue;
          if (!rowMatchesCategory(key, row)) continue;

          checkbox.click(); // click (not .checked) so the game updates its own counters
          tickTowedRows(key, row);
          remaining--;
          selected[key] = (selected[key] || 0) + 1;
          Object.keys(needed).forEach((other) => {
            if (other !== key && rowMatchesCategory(other, row)) credit[other] = (credit[other] || 0) + 1;
          });
        }
        if (remaining > 0) short[key] = remaining;
      }
      return { selected, short };
    }

    /** Loads the game's "Dooralarmeren" tab (busy vehicles) and returns its rows. */
    async function loadOccupiedTab() {
      const pane = doc.getElementById('occupied');
      if (!pane) return [];
      if (!pane.querySelector('table')) {
        const link = doc.querySelector('a[tabload="occupied"]');
        const activeTab = doc.querySelector('.nav-tabs li.active > a');
        link?.click(); // let the game load the tab its own way
        for (let i = 0; i < 25 && !pane.querySelector('table'); i++) await new Promise((r) => setTimeout(r, 200));
        if (activeTab && activeTab !== link) activeTab.click(); // back to the tab the user was on
      }
      return [...pane.querySelectorAll('tr.vehicle_select_table_tr')];
    }

    /**
     * For categories nothing is free for: select vehicles that are ON SCENE elsewhere (status 4)
     * and have no follow-up mission yet. Vehicles still driving (status 3) are left alone.
     * Mutates `short`, returns what was queued per category.
     */
    async function queueBusyVehicles(short) {
      const rows = (await loadOccupiedTab()).sort(
        (a, b) => parseFloat(a.dataset.distance || 999) - parseFloat(b.dataset.distance || 999)
      );
      if (!rows.length) return {};

      const vehicles = await fetchJson('/api/vehicles');
      const alreadyQueued = new Set(vehicles.filter((v) => v.queued_mission_id).map((v) => String(v.id)));

      // Planned events (e.g. "Open dag") last for hours: don't queue behind those
      let plannedEventIds = new Set();
      try {
        plannedEventIds = new Set(
          [...window.top.document.querySelectorAll('#mission_list_sicherheitswache .missionSideBarEntry')].map((e) =>
            e.getAttribute('mission_id')
          )
        );
      } catch (e) {
        /* main page not reachable — no filter */
      }
      const currentMissionId = (row) => row.querySelector('small a[href^="/missions/"]')?.getAttribute('href').split('/')[2];

      const queued = {};
      for (const [key, count] of Object.entries(short)) {
        let remaining = count;
        for (const row of rows) {
          if (remaining <= 0) break;
          const checkbox = row.querySelector('.vehicle_checkbox');
          if (!checkbox || checkbox.checked) continue;
          if (checkbox.getAttribute('fms') !== '4') continue; // only vehicles on scene
          if (alreadyQueued.has(checkbox.value)) continue; // max 1 follow-up mission
          if (plannedEventIds.has(currentMissionId(row))) continue; // stuck at a planned event
          if (!rowMatchesCategory(key, row)) continue;

          checkbox.click();
          remaining--;
          queued[key] = (queued[key] || 0) + 1;
        }
        if (remaining > 0) short[key] = remaining;
        else delete short[key];
      }
      return queued;
    }

    /**
     * Tops up water (liters) and pump capacity when the selected vehicles don't cover them.
     * Water: the game's own mission bars hold what is needed / on scene / driving.
     * Pump: min_pump_speed from the mission type vs. the pump capacity of all assigned vehicles.
     * Returns lines for the result panel.
     */
    async function selectForResources(typeId) {
      const lines = [];
      const num = (v) => parseInt(v || '0', 10) || 0;
      const fmtNum = (n) => n.toLocaleString('nl-NL');
      const availableRows = () =>
        [...doc.querySelectorAll('#vehicle_show_table_body_all tr.vehicle_select_table_tr')].sort(
          (a, b) => parseFloat(a.dataset.distance || 999) - parseFloat(b.dataset.distance || 999)
        );
      const checkedBoxes = () => [...doc.querySelectorAll('#mission-form .vehicle_checkbox:checked')];

      // Per vehicle type: water and pump capacity, learned from the vehicle list on this page
      const capacity = {};
      doc.querySelectorAll('.vehicle_checkbox').forEach((c) => {
        capacity[c.getAttribute('vehicle_type_id')] = {
          water: num(c.getAttribute('wasser_amount')),
          pump: num(c.getAttribute('water_damage_pump_value')),
        };
      });
      const assignedRows = [...doc.querySelectorAll('#mission_vehicle_driving tbody tr, #mission_vehicle_at_mission tbody tr')];
      /**
       * Water/pump of an assigned vehicle. From the free-vehicle list when that type is in it; otherwise
       * (all of that type busy) from the vehicle's own page — before, such vehicles counted as 0.
       */
      const capacityOf = (row) => {
        const typeId = row.querySelector('a[vehicle_type_id]')?.getAttribute('vehicle_type_id');
        if (typeId && typeId in capacity) return Promise.resolve(capacity[typeId]);
        const id = row.querySelector('a[href^="/vehicles/"]')?.getAttribute('href').split('/')[2];
        if (!id) return Promise.resolve({ water: 0, pump: 0 });
        if (!vehicleCapacityCache.has(id)) {
          vehicleCapacityCache.set(
            id,
            fetchDoc(`/vehicles/${id}`)
              .then((page) => {
                const text = page.body.textContent.replace(/\s+/g, ' ');
                const value = (re) => num((text.match(re)?.[1] || '').replace(/\./g, ''));
                return { water: value(/\bWater\s+([\d.]+)\s*l\b/), pump: value(/Pomp\s*Capaciteit\s+([\d.]+)/i) };
              })
              .catch(() => ({ water: 0, pump: 0 }))
          );
        }
        return vehicleCapacityCache.get(id);
      };

      /** Selects the nearest free vehicles that add `attr` until `missing` is covered. */
      const topUp = (attr, missing) => {
        let added = 0;
        for (const row of availableRows()) {
          if (missing - added <= 0) break;
          const checkbox = row.querySelector('.vehicle_checkbox');
          const value = num(checkbox?.getAttribute(attr));
          if (!checkbox || checkbox.checked || !value) continue;
          checkbox.click();
          added += value;
        }
        return added;
      };

      // Water
      const needBar = doc.querySelector('[data-need_water]');
      const waterNeeded = num(needBar?.dataset.need_water);
      if (waterNeeded > 0) {
        const barHas = (kind) => num(doc.querySelector(`[class*="mission_water_bar_${kind}_"]`)?.dataset.waterHas);
        // The game's bars leave out vehicles queued for this mission (live check, Nov 2026): add their water
        const queuedRows = assignedRows.filter((row) => row.closest('#mission_vehicle_driving') && isQueuedRow(row));
        const queuedWater = (await Promise.all(queuedRows.map(capacityOf))).reduce((s, c) => s + (c.water || 0), 0);
        const present = barHas('at_mission') + barHas('driving') + queuedWater;
        let selectedWater = checkedBoxes().reduce((s, c) => s + num(c.getAttribute('wasser_amount')), 0);
        const missing = waterNeeded - present - selectedWater;
        if (missing > 0) selectedWater += topUp('wasser_amount', missing);
        const total = present + selectedWater;
        const ok = total >= waterNeeded;
        lines.push({
          ok,
          text: `<b>Water:</b> ${fmtNum(total)}/${fmtNum(waterNeeded)} l${
            queuedWater ? ` (incl. ${fmtNum(queuedWater)} l in wachtrij)` : ''
          } ${ok ? '✓' : '— niet genoeg beschikbaar'}`,
        });
      }

      // Pump capacity
      const types = await loadMissionTypes();
      const pumpNeeded = num(types[typeId]?.r?.min_pump_speed);
      if (pumpNeeded > 0) {
        const present = (await Promise.all(assignedRows.map(capacityOf))).reduce((s, c) => s + (c.pump || 0), 0);
        let selectedPump = checkedBoxes().reduce((s, c) => s + num(c.getAttribute('water_damage_pump_value')), 0);
        const missing = pumpNeeded - present - selectedPump;
        if (missing > 0) selectedPump += topUp('water_damage_pump_value', missing);
        const total = present + selectedPump;
        const ok = total >= pumpNeeded;
        lines.push({
          ok,
          text: `<b>Pompcapaciteit:</b> ${fmtNum(total)}/${fmtNum(pumpNeeded)} l/min ${ok ? '✓' : '— niet genoeg beschikbaar'}`,
        });
      }
      return lines;
    }

    function renderResult(selected, short, notOwned, info, queued = {}, resources = [], enRoute = {}) {
      const fmt = (obj) =>
        Object.entries(obj)
          .map(([k, n]) => `${n}× ${CATEGORIES[k].label}`)
          .join(', ');

      const lines = [];
      lines.push(
        Object.keys(selected).length
          ? `<b>Geselecteerd:</b> ${fmt(selected)}`
          : '<b>Niets extra nodig</b> volgens de eisen',
      );
      if (Object.keys(enRoute).length)
        lines.push(`<b>Al onderweg</b> (telt pas als "aanwezig" bij aankomst): ${fmt(enRoute)}`);
      if (Object.keys(short).length) lines.push(`<b>Niet beschikbaar:</b> ${fmt(short)}`);
      if (Object.keys(queued).length) lines.push(`<b>Dooralarmeren</b> (na huidige inzet): ${fmt(queued)}`);
      resources.forEach((r) => lines.push(r.text));
      if (notOwned.length) lines.push(`<b>Niet in je korps:</b> ${notOwned.join(', ')} — overweeg vrijgeven in team`);
      if (info.length) lines.push(info.join('<br>'));

      const level = Object.keys(short).length || notOwned.length || resources.some((r) => !r.ok) ? 'warning' : 'success';
      panel.setHtml(lines.join('<br>'), level);
    }

    /** Counts per category: assigned (driving + on scene), selected, and what the game says is missing. */
    function snapshotWindow(typeId) {
      const assigned = countRows([...doc.querySelectorAll('#mission_vehicle_driving tbody tr, #mission_vehicle_at_mission tbody tr')]);
      const selectedCaptions = [...doc.querySelectorAll('#mission-form .vehicle_checkbox:checked')].map(
        (c) => c.closest('tr')?.getAttribute('vehicle_type') || ''
      );
      const used = countByCategory(selectedCaptions);
      Object.entries(assigned).forEach(([k, n]) => (used[k] = (used[k] || 0) + n));
      const atMission = countRows([...doc.querySelectorAll('#mission_vehicle_at_mission tbody tr')]);
      const missing = parseMissingText()?.missing || {};
      // What the game required in total = on scene + still missing (only for categories it reports missing)
      const required = Object.fromEntries(Object.entries(missing).map(([k, n]) => [k, n + (atMission[k] || 0)]));
      const name = (doc.getElementById('missionH1')?.textContent || '').replace(/\s+/g, ' ').trim();
      return { typeId, name, used, required };
    }

    /** AAO buttons in this window, with their vehicle counts (attributes = AAO field names). */
    function readAaoButtons() {
      const aaos = [...doc.querySelectorAll('a.aao_btn')].map((btn) => {
        const counts = {};
        Object.entries(AAO_KEY_BY_CATEGORY).forEach(([cat, key]) => (counts[cat] = parseInt(btn.getAttribute(key) || '0', 10) || 0));
        return { id: btn.getAttribute('aao_id') || btn.id, caption: btn.textContent.replace(/\s+/g, ' ').trim(), counts, btn };
      });
      if (aaos.length) memWrite('mks_mem_aaos_win_v1', { ts: Date.now(), data: aaos.map(({ btn, ...a }) => a) });
      return aaos;
    }

    async function renderMemoryHint(typeId) {
      const missionId = (doc.location?.pathname || '').match(/\/missions\/(\d+)/)?.[1];
      if (!missionId) return;
      rememberMissionSnapshot(missionId, snapshotWindow(typeId));
      if (!doc.body.dataset.mksMemSubmit) {
        // Also remember what the player finally sent
        doc.body.dataset.mksMemSubmit = '1';
        doc.getElementById('mission-form')?.addEventListener('submit', () => rememberMissionSnapshot(missionId, snapshotWindow(typeId)), true);
      }

      const est = estimateMinimum(typeId, await loadMissionTypes());
      const aaos = readAaoButtons();
      const best = aaos.length ? pickAao(est.min, aaos) : null;
      aaos.forEach((a) => (a.btn.style.boxShadow = ''));
      if (best) {
        best.a.btn.style.boxShadow = '0 0 0 3px #f0ad4e';
        best.a.btn.title = 'Inzetvoorstel volgens het inzetgeheugen';
      }

      const seen = est.stats?.n || 0;
      const parts = [`<b>📚 Minimaal:</b> ${formatNeeds(est.min)}`];
      if (est.sometimes.length) parts.push(`soms: ${est.sometimes.map((x) => `${CATEGORY_LABELS[x.k]} ${x.chance}%`).join(', ')}`);
      if (est.learned.length) parts.push(`<span class="text-warning">geleerd: +${escapeHtml(est.learned.join(', '))}</span>`);
      if (est.usual && seen) parts.push(`meestal gestuurd: ${formatNeeds(est.usual)}`);
      parts.push(seen ? `${seen}× afgerond` : 'nog niet eerder afgerond');
      if (best) parts.push(`👉 <b>${escapeHtml(best.a.caption)}</b>${best.missing ? ' (dekt niet alles)' : ''}`);
      panel.appendHtml(parts.join(' · '));
    }

    function createPanel() {
      const box = doc.createElement('div');
      box.className = 'alert alert-info';
      box.style.cssText = 'margin:6px 0;padding:6px 10px;font-size:13px;';

      const content = doc.createElement('span');
      const retry = doc.createElement('a');
      retry.href = '#';
      retry.textContent = ' ↻ opnieuw';
      retry.style.marginLeft = '8px';
      retry.addEventListener('click', (e) => {
        e.preventDefault();
        run();
      });

      box.append(content, retry);
      const form = doc.getElementById('mission-form');
      form.parentNode.insertBefore(box, form);

      return {
        setText(text, level = 'info') {
          box.className = `alert alert-${level}`;
          content.textContent = text;
        },
        setHtml(html, level = 'info') {
          box.className = `alert alert-${level}`;
          content.innerHTML = html;
        },
        appendHtml(html) {
          content.insertAdjacentHTML('beforeend', `<br>${html}`);
        },
      };
    }
  }

  /* ------------------------------------------------------------------ */
  /* VRU reference (Veiligheidsregio Utrecht, source: Brandbase)         */
  /* ------------------------------------------------------------------ */

  // station code -> [place, [[callsign suffix, game vehicle type id], ...]]
  // Hook-lift containers replaced by full vehicles (numbering kept); xx01 = OvD (own convention)
  const VRU_STATIONS = {
    '01': [
      'Amersfoort (Centrum)',
      [
        ['0101', 3],
        ['0111', 33],
        ['0131', 17],
        ['0132', 17],
        ['0133', 17],
        ['0144', 14],
        ['0152', 2],
      ],
    ],
    '02': [
      'Amersfoort (Noord)',
      [
        ['0201', 3],
        ['0231', 17],
        ['0271', 4],
      ],
    ],
    '03': [
      'Baarn',
      [
        ['0301', 3],
        ['0331', 17],
        ['0344', 14],
        ['0374', 4],
      ],
    ],
    '04': [
      'Bunschoten',
      [
        ['0401', 3],
        ['0411', 33],
        ['0431', 17],
        ['0432', 17],
      ],
    ],
    '05': [
      'Bunnik',
      [
        ['0501', 3],
        ['0531', 17],
        ['0571', 4],
      ],
    ],
    '06': [
      'Werkhoven',
      [
        ['0601', 3],
        ['0631', 17],
      ],
    ],
    '07': [
      'Bilthoven',
      [
        ['0701', 3],
        ['0731', 17],
        ['0744', 14],
        ['0762', 10],
        ['0774', 4],
      ],
    ],
    '08': [
      'De Bilt',
      [
        ['0801', 3],
        ['0831', 17],
      ],
    ],
    '09': ['Groenekan', [['0931', 17]]],
    10: [
      'Maartensdijk',
      [
        ['1001', 3],
        ['1034', 17],
        ['1044', 14],
      ],
    ],
    11: [
      'Westbroek-Tienhoven',
      [
        ['1101', 3],
        ['1131', 17],
      ],
    ],
    12: [
      'Abcoude',
      [
        ['1201', 3],
        ['1231', 17],
      ],
    ],
    13: [
      'Mijdrecht',
      [
        ['1301', 3],
        ['1311', 33],
        ['1331', 17],
        ['1332', 17],
        ['1352', 2],
      ],
    ],
    14: [
      'Vinkeveen',
      [
        ['1401', 3],
        ['1431', 17],
      ],
    ],
    15: [
      'Wilnis',
      [
        ['1501', 3],
        ['1531', 17],
        ['1571', 4],
      ],
    ],
    16: [
      'Eemnes',
      [
        ['1601', 3],
        ['1631', 17],
        ['1632', 17],
      ],
    ],
    17: [
      'Houten-Oost',
      [
        ['1701', 3],
        ['1731', 17],
      ],
    ],
    18: [
      'Houten-West',
      [
        ['1801', 3],
        ['1831', 17],
        ['1832', 17],
        ['1863', 68],
      ],
    ],
    19: [
      'Schalkwijk',
      [
        ['1901', 3],
        ['1931', 17],
      ],
    ],
    20: [
      'IJsselstein',
      [
        ['2001', 3],
        ['2031', 17],
        ['2032', 17],
        ['2052', 2],
      ],
    ],
    21: [
      'Achterveld',
      [
        ['2101', 3],
        ['2131', 17],
      ],
    ],
    22: [
      'Leusden',
      [
        ['2201', 3],
        ['2231', 17],
        ['2244', 14],
        ['2265', 34],
      ],
    ],
    23: [
      'Benschop',
      [
        ['2301', 3],
        ['2331', 17],
      ],
    ],
    24: [
      'Lopik',
      [
        ['2401', 3],
        ['2431', 17],
        ['2432', 17],
      ],
    ],
    25: [
      'Linschoten',
      [
        ['2501', 3],
        ['2531', 17],
        ['2571', 4],
      ],
    ],
    26: [
      'Montfoort',
      [
        ['2601', 3],
        ['2631', 17],
      ],
    ],
    27: [
      'Nieuwegein Noord',
      [
        ['2701', 3],
        ['2731', 17],
        ['2732', 17],
        ['2771', 4],
      ],
    ],
    28: [
      'Nieuwegein Zuid',
      [
        ['2801', 3],
        ['2831', 17],
      ],
    ],
    29: [
      'Oudewater',
      [
        ['2901', 3],
        ['2931', 17],
        ['2932', 17],
      ],
    ],
    30: [
      'Renswoude',
      [
        ['3001', 3],
        ['3034', 17],
        ['3044', 14],
      ],
    ],
    31: [
      'Rhenen-Elst',
      [
        ['3101', 3],
        ['3134', 17],
        ['3144', 14],
      ],
    ],
    32: [
      'Rhenen-Achterberg',
      [
        ['3201', 3],
        ['3231', 17],
        ['3241', 7],
        ['3244', 14],
      ],
    ],
    33: [
      'Soest Hoofdpost',
      [
        ['3301', 3],
        ['3334', 17],
        ['3344', 14],
        ['3352', 2],
      ],
    ],
    34: ['Soest Nevenpost', [['3431', 17]]],
    35: [
      'Soesterberg',
      [
        ['3501', 3],
        ['3534', 17],
        ['3544', 14],
      ],
    ],
    36: [
      'Breukelen',
      [
        ['3601', 3],
        ['3631', 17],
        ['3632', 17],
        ['3671', 4],
      ],
    ],
    37: [
      'Kockengen',
      [
        ['3701', 3],
        ['3731', 17],
      ],
    ],
    38: [
      'Loenen a.d. Vecht',
      [
        ['3801', 3],
        ['3831', 17],
      ],
    ],
    39: [
      'Maarssen',
      [
        ['3901', 3],
        ['3911', 33],
        ['3931', 17],
        ['3932', 17],
        ['3952', 2],
      ],
    ],
    41: [
      'Nieuwer Ter Aa',
      [
        ['4101', 3],
        ['4131', 17],
      ],
    ],
    42: [
      'Nigtevecht',
      [
        ['4201', 3],
        ['4231', 17],
      ],
    ],
    43: [
      'Utrecht (De Meern)',
      [
        ['4301', 3],
        ['4331', 17],
      ],
    ],
    44: [
      'Utrecht (Leidsche Rijn)',
      [
        ['4401', 3],
        ['4411', 33],
        ['4431', 17],
        ['4452', 2],
        ['4483', 5],
      ],
    ],
    45: ['Utrecht (Schepenbuurt)', [['4531', 17]]],
    46: ['Utrecht (Tolsteeg)', [['4631', 17]]],
    47: [
      'Utrecht (Vleuten)',
      [
        ['4701', 3],
        ['4731', 17],
      ],
    ],
    48: [
      'Utrecht (Voordorp)',
      [
        ['4831', 17],
        ['4852', 2],
      ],
    ],
    49: [
      'Utrecht (Zuilen)',
      [
        ['4901', 3],
        ['4931', 17],
      ],
    ],
    50: [
      'Amerongen',
      [
        ['5001', 3],
        ['5034', 17],
        ['5044', 14],
        ['5071', 4],
      ],
    ],
    51: [
      'Driebergen-Rijsenburg',
      [
        ['5101', 3],
        ['5131', 17],
        ['5144', 14],
        ['5169', 34],
      ],
    ],
    52: [
      'Doorn',
      [
        ['5201', 3],
        ['5234', 17],
        ['5244', 14],
        ['5252', 2],
      ],
    ],
    53: [
      'Leersum',
      [
        ['5301', 3],
        ['5334', 17],
        ['5344', 14],
      ],
    ],
    54: [
      'Maarn-Maarsbergen',
      [
        ['5401', 3],
        ['5431', 17],
        ['5434', 17],
        ['5444', 14],
        ['5474', 4],
      ],
    ],
    55: [
      'Veenendaal',
      [
        ['5501', 3],
        ['5531', 17],
        ['5532', 17],
        ['5541', 14],
        ['5552', 2],
        ['5571', 4],
      ],
    ],
    56: [
      'Hagestein',
      [
        ['5601', 3],
        ['5631', 17],
      ],
    ],
    57: ['Vianen', [['5731', 17]]],
    58: [
      'Cothen-Langbroek',
      [
        ['5831', 17],
        ['5832', 17],
      ],
    ],
    59: [
      'Wijk bij Duurstede',
      [
        ['5901', 3],
        ['5911', 33],
        ['5931', 17],
      ],
    ],
    60: [
      'Harmelen',
      [
        ['6001', 3],
        ['6031', 17],
      ],
    ],
    61: [
      'Kamerik',
      [
        ['6101', 3],
        ['6131', 17],
      ],
    ],
    62: [
      'Woerden',
      [
        ['6201', 3],
        ['6231', 17],
        ['6232', 17],
        ['6252', 2],
      ],
    ],
    63: [
      'Zegveld',
      [
        ['6301', 3],
        ['6331', 17],
      ],
    ],
    64: [
      'Woudenberg',
      [
        ['6401', 3],
        ['6431', 17],
        ['6434', 17],
        ['6444', 14],
      ],
    ],
    65: [
      'Den Dolder',
      [
        ['6501', 3],
        ['6531', 17],
      ],
    ],
    66: [
      'Zeist',
      [
        ['6601', 3],
        ['6631', 17],
        ['6634', 17],
        ['6644', 14],
        ['6652', 2],
      ],
    ],
    67: [
      'Ameide-Tienhoven',
      [
        ['6701', 3],
        ['6731', 17],
      ],
    ],
    68: [
      'Leerdam',
      [
        ['6801', 3],
        ['6831', 17],
        ['6852', 2],
      ],
    ],
    69: [
      'Lexmond',
      [
        ['6901', 3],
        ['6931', 17],
      ],
    ],
    70: [
      'Meerkerk',
      [
        ['7001', 3],
        ['7031', 17],
        ['7071', 4],
      ],
    ],
    71: [
      'Schoonrewoerd',
      [
        ['7101', 3],
        ['7131', 17],
        ['7169', 34],
      ],
    ],
  };

  // Game vehicle type id -> short label used in vehicle names, and a group for "same kind" matching
  const VEHICLE_LABELS = {
    1: 'TS',
    9: 'TS',
    17: 'TS',
    0: 'TS',
    6: 'TST',
    7: 'TST',
    8: 'TST',
    12: 'NB',
    14: 'NB',
    15: 'NB',
    2: 'AL',
    18: 'AL',
    3: 'OvD',
    4: 'HV',
    5: 'AB',
    10: 'SW',
    19: 'HOvD',
    24: 'AGS',
    31: 'CO',
    11: 'VEB',
    56: 'VL',
    33: 'WO',
    34: 'WT',
    68: 'SB',
  };
  const labelOf = (typeId) => VEHICLE_LABELS[typeId] || null;

  const stationName = (code) => `${CONFIG.vru.prefix} 09-${code} ${VRU_STATIONS[code][0]}`;
  const vehicleName = (suffix, typeId) => `${CONFIG.vru.prefix} 09-${suffix} ${labelOf(typeId) || ''}`.trim();
  const stationCodeFromName = (name) => (name || '').match(/09-(\d{2})(?!\d)/)?.[1] || null;

  const storage = {
    get(key) {
      try {
        return JSON.parse(localStorage.getItem(`mks_vru_${key}`) || 'null');
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null) localStorage.removeItem(`mks_vru_${key}`);
        else localStorage.setItem(`mks_vru_${key}`, JSON.stringify(value));
      } catch (e) {
        /* ignore */
      }
    },
  };

  // no-store: the game's API responses are cached for 60 s otherwise
  // einsaetze.json is large: fetch it once per page load and share it (callers cache what they derive)
  let missionCatalogPromise = null;
  const loadMissionCatalog = () =>
    (missionCatalogPromise ||= fetch('/einsaetze.json', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        setTimeout(() => (missionCatalogPromise = null), 10 * 60e3); // free the memory after a while
        return data;
      })
      .catch((e) => {
        missionCatalogPromise = null; // allow a retry
        throw e;
      }));

  // Panels ask for /api/buildings and /api/vehicles many times at once: share one response for 3 s.
  // Pass { fresh: true } right after an action (move, buy, build) to see its result.
  const jsonCache = new Map();
  const fetchJson = (url, { fresh = false } = {}) => {
    const hit = jsonCache.get(url);
    if (!fresh && hit && Date.now() - hit.ts < 3000) return hit.promise;
    const promise = fetch(url, { credentials: 'include', cache: 'no-store' })
      .then((r) => r.json())
      .catch((e) => {
        jsonCache.delete(url);
        throw e;
      });
    jsonCache.set(url, { ts: Date.now(), promise });
    return promise;
  };
  const FIRE_ACADEMY_TYPE = 4; // building_type of 'Brandweer, Academie'

  /** Post name for panels ("09-06 Werkhoven"), HTML-safe. */
  const shortPost = (caption) => escapeHtml(caption.trim().replace(`${CONFIG.vru.prefix} `, ''));

  /**
   * Small action link shared by all panels: "…" while busy, "✓" when done, "Mislukt" on an error or a `false` result.
   * The click handler may return 'cancel' to reset the button; onDone runs after a successful action.
   */
  function makeActionButton(label, onClick, { cls = 'btn-success', confirmText = null, onDone = null } = {}) {
    const a = document.createElement('a');
    a.href = '#';
    a.className = `btn btn-xs ${cls || 'btn-success'}`;
    a.style.marginLeft = '5px';
    a.textContent = label;
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      if (a.dataset.busy || (confirmText && !window.confirm(confirmText))) return;
      a.dataset.busy = '1';
      a.textContent = '…';
      try {
        const ok = await onClick();
        if (ok === 'cancel') {
          a.textContent = label;
          delete a.dataset.busy;
          return;
        }
        a.textContent = ok === false ? 'Mislukt' : '✓';
        a.className = `btn btn-xs ${ok === false ? 'btn-danger' : 'btn-default'}`;
        if (ok !== false && onDone) onDone();
      } catch (err) {
        console.error('[MKS→HA]', err);
        a.textContent = 'Mislukt';
        a.title = err.message;
        a.className = 'btn btn-xs btn-danger';
      }
    });
    return a;
  }

  /** Panel row: text on the left, buttons on the right. */
  function makeRow(html, ...buttons) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:6px';
    row.innerHTML = `<span>${html}</span>`;
    const right = document.createElement('span');
    right.style.whiteSpace = 'nowrap';
    buttons.filter(Boolean).forEach((b) => right.append(b));
    row.append(right);
    return row;
  }

  const fetchDoc = async (url) =>
    new DOMParser().parseFromString(await fetch(url, { credentials: 'include' }).then((r) => r.text()), 'text/html');

  /* ---------- Build form: VRU station picker + TS + remember for hiring ---------- */

  function watchBuildForm() {
    const check = () => {
      const form = document.getElementById('new_building');
      if (form && !form.dataset.mksVru) {
        form.dataset.mksVru = '1';
        enhanceBuildForm(form);
      }
    };
    check();
    onBodyChange(check);
  }

  async function enhanceBuildForm(form) {
    const nameInput = form.querySelector('#building_name');
    const typeSelect = form.querySelector('#building_building_type');
    const addressInput = form.querySelector('#building_address');
    if (!nameInput || !typeSelect) return;

    const fire = (el) => el.dispatchEvent(new Event('change', { bubbles: true }));

    // Default start vehicle: TS for both station sizes
    ['#building_start_vehicle_feuerwache', '#building_start_vehicle_feuerwache_kleinwache'].forEach((sel) => {
      const select = form.querySelector(sel);
      if (select && !select.value) {
        select.value = String(CONFIG.vru.startVehicleTypeId);
        fire(select);
      }
    });

    // Stations not built yet
    const [buildings, vehicles] = await Promise.all([fetchJson('/api/buildings'), fetchJson('/api/vehicles')]);
    const builtCodes = new Set(buildings.map((b) => stationCodeFromName(b.caption)).filter(Boolean));
    const openCodes = Object.keys(VRU_STATIONS)
      .map((c) => String(c).padStart(2, '0'))
      .filter((c) => !builtCodes.has(c))
      .sort();

    // Picker UI
    const box = document.createElement('div');
    box.className = 'form-group';
    box.style.cssText = 'background:#fff3cd;padding:6px 8px;border-radius:4px;';
    box.innerHTML = `
      <label style="margin-bottom:4px">VRU-post (${openCodes.length} nog te bouwen)</label>
      <select class="form-control input-sm"><option value="">— kies een post —</option>${openCodes
        .map((c) => `<option value="${c}">09-${c} ${VRU_STATIONS[c][0]}</option>`)
        .join('')}</select>
      <small class="mks-vru-hint" style="display:block;margin-top:3px;color:#7a5d00"></small>`;
    nameInput.closest('.form-group, div')?.before(box);

    const picker = box.querySelector('select');
    const hint = box.querySelector('.mks-vru-hint');
    let autoFilledName = '';
    let userChose = false; // picked by hand or from the panel: no address suggestions

    const applyStation = (code, reason) => {
      picker.value = code;
      if (!code) return;
      // Only overwrite a name the user hasn't typed themselves
      if (!nameInput.value || nameInput.value === autoFilledName) {
        autoFilledName = stationName(code);
        nameInput.value = autoFilledName;
      }
      if (!typeSelect.value) {
        typeSelect.value = String(CONFIG.vru.defaultBuildingType);
        fire(typeSelect);
      }
      const vehicles = VRU_STATIONS[code][1].map(([s, t]) => `${s} ${labelOf(t)}`).join(', ');
      hint.textContent = `${reason ? reason + ' — ' : ''}Voertuigen volgens VRU: ${vehicles}`;
    };

    picker.addEventListener('change', () => {
      userChose = true;
      applyStation(picker.value, '');
    });

    // Advice: best next station
    const advice = rankUnbuiltStations(buildings, vehicles)[0];
    if (advice) {
      const brings = advice.specialists.length ? advice.specialists.map(([, t]) => labelOf(t)).join(', ') : 'alleen TS';
      const line = document.createElement('small');
      line.style.cssText = 'display:block;margin-top:3px';
      line.innerHTML = `⭐ Advies: <b>09-${advice.code} ${VRU_STATIONS[advice.code][0]}</b> (brengt ${brings}) <a href="#">kiezen</a>`;
      line.querySelector('a').addEventListener('click', (e) => {
        e.preventDefault();
        userChose = true;
        applyStation(advice.code, 'Advies');
      });
      hint.before(line);
    }

    // Station picked in the VRU panel
    const preselect = storage.get('preselect_station');
    if (preselect && openCodes.includes(preselect)) {
      storage.set('preselect_station', null);
      userChose = true;
      applyStation(preselect, 'Gekozen in het VRU-paneel');
    }

    // Suggest a station from the address of the chosen map location
    const placeKey = (place) =>
      place
        .replace(/\s*\(.*\)/, '')
        .replace(/\s+(Hoofdpost|Nevenpost|Noord|Zuid)$/, '')
        .split('-')[0]
        .trim()
        .toLowerCase();
    let lastAddress = '';
    const addressPoll = setInterval(() => {
      if (!form.isConnected) return clearInterval(addressPoll); // build window closed
      const address = (addressInput?.value || '').toLowerCase();
      if (!address || address === lastAddress) return;
      lastAddress = address;
      const match = openCodes.find((c) => new RegExp(`\\b${placeKey(VRU_STATIONS[c][0])}\\b`).test(address));
      if (match && !userChose && (!picker.value || nameInput.value === autoFilledName))
        applyStation(match, 'Voorgesteld op basis van adres');
    }, 800);

    // Remember what is being built, so we can start hiring once it exists
    form.addEventListener(
      'submit',
      () => {
        const name = nameInput.value.trim();
        const isFireStation = ['0', '17'].includes(typeSelect.value); // Kazerne / Kazerne (klein)
        if (!name || !isFireStation || !CONFIG.vru.autoHireDays) return;
        storage.set('pending_hire', { name, ts: Date.now() });
        log('Pending hire for', name);
        pollPendingHire();
      },
      true,
    );
  }

  /* ---------- Hiring: start N days of recruitment for a newly built station ---------- */

  let hirePolling = false;
  async function pollPendingHire() {
    if (hirePolling) return;
    hirePolling = true;
    try {
      for (let i = 0; i < 30; i++) {
        if (await processPendingHire()) break;
        await new Promise((r) => setTimeout(r, 4000));
      }
    } finally {
      hirePolling = false;
    }
  }

  async function processPendingHire() {
    const pending = storage.get('pending_hire');
    if (!pending) return true;
    if (Date.now() - pending.ts > 10 * 60e3) {
      storage.set('pending_hire', null); // too old, give up
      return true;
    }
    const buildings = await fetchJson('/api/buildings', { fresh: true });
    const building = buildings.find((b) => (b.caption || '').trim() === pending.name);
    if (!building) return false;

    storage.set('pending_hire', null);
    if (building.hiring_phase > 0) return true; // already hiring
    const res = await fetch(`/buildings/${building.id}/hire_do/${CONFIG.vru.autoHireDays}`, { credentials: 'include' });
    log(`Hiring ${CONFIG.vru.autoHireDays} days for ${building.caption}`, res.status);
    return true;
  }

  /* ---------- Vehicle shop: VRU vehicles + specialists, with personnel ---------- */

  // Call-sign endings for specialists, following the VRU's own numbering (09-9129 AGS, 09-9191 HOvD, 09-9297 CO, …)
  const SPECIALIST_SUFFIX = { 24: '29', 19: '91', 31: '97', 5: '87', 11: '89', 56: '95' };

  async function enhanceVehicleShop(doc) {
    const buildingId = doc.location.pathname.match(/^\/buildings\/(\d+)\/vehicles\/new/)?.[1];
    if (!buildingId) return;

    const [buildings, vehicles] = await Promise.all([fetchJson('/api/buildings'), fetchJson('/api/vehicles')]);
    const building = buildings.find((b) => String(b.id) === buildingId);
    const code = stationCodeFromName(building?.caption);
    if (!code || !VRU_STATIONS[code]) return;

    const box = doc.createElement('div');
    box.className = 'alert alert-warning';
    box.style.cssText = 'padding:6px 10px;';
    box.innerHTML = `<b>VRU 09-${code} ${VRU_STATIONS[code][0]}</b> <em>— personeel en specialisten ophalen…</em>`;
    (doc.querySelector('.nav-tabs') || doc.body.firstElementChild).before(box);

    const own = vehicles.filter((v) => String(v.building_id) === buildingId);
    const ownCaptions = own.map((v) => v.caption || '');
    const stationCount = buildings.filter((b) => b.building_type === 0).length;

    const [typeInfo, staff, missions] = await Promise.all([
      loadVehicleTypeInfo(buildingId),
      loadStationPersonnel(building, vehicles),
      loadSpecialistMissions(),
    ]);
    const eduKeys = staff.some((p) => p.keys.length) ? await loadEducationKeys([building]) : storage.get('education_keys_v1')?.data || {};

    const crewNeeded = own.reduce((n, v) => n + (v.max_personnel_override || typeInfo[v.vehicle_type]?.maxCrew || 0), 0);
    const slots = building.level + 1;
    const freeSlots = Math.max(0, slots - own.length);

    /** Personnel line for a vehicle type at this station. */
    const personnelInfo = (typeId) => {
      const info = typeInfo[typeId] || {};
      const crew = info.maxCrew || 0;
      const after = crewNeeded + crew;
      const parts = [`bemanning ${crew}`];
      let ok = staff.length >= after;
      if (info.education) {
        const key = eduKeys[info.education];
        const trained = key ? staff.filter((p) => p.keys.includes(key)) : [];
        const free = trained.filter((p) => !p.boundVehicleId).length;
        const need = Math.max(1, info.minCrew || 0);
        parts.push(`${escapeHtml(info.education)}: ${trained.length} opgeleid (${free} vrij, min. ${need})`);
        if (free < need) ok = false;
      }
      parts.push(`personeel ${staff.length}/${after}`);
      return { ok, text: parts.join(' · ') };
    };

    const buyButton = (typeId, name) => {
      const buyLink = doc.querySelector(`a[href*="/vehicle/${buildingId}/${typeId}/credits"]`);
      if (!buyLink) return '<span class="label label-default">niet mogelijk hier</span>';
      if (!freeSlots) return '<span class="label label-default" title="Eerst een level omhoog">geen plek</span>';
      return `<a href="#" class="btn btn-xs btn-success mks-vru-buy" data-href="${buyLink.getAttribute('href')}" data-type="${typeId}" data-name="${escapeHtml(name)}">Kopen</a>`;
    };

    const row = (name, typeId, present) => {
      const p = present ? null : personnelInfo(typeId);
      const action = present ? '<span class="label label-success">aanwezig</span>' : buyButton(typeId, name);
      const price = typeInfo[typeId]?.price ? ` <small class="text-muted">${formatCredits(typeInfo[typeId].price)}</small>` : '';
      return `<tr><td>${escapeHtml(name)}${present ? '' : price}${
        p ? `<br><small style="color:${p.ok ? 'inherit' : '#a94442'}">${p.ok ? '👷' : '⚠️'} ${p.text}</small>` : ''
      }</td><td style="white-space:nowrap">${action}</td></tr>`;
    };

    // 1. VRU vehicles of this station
    const vruRows = VRU_STATIONS[code][1].map(([suffix, typeId]) =>
      row(vehicleName(suffix, typeId), typeId, ownCaptions.some((c) => c.includes(`09-${suffix}`)))
    );

    // 2. Specialists you're allowed to buy that unlock missions, where this station can crew them
    const specialistRows = SPECIALTIES.filter((sp) => sp.key !== 'battalion_chief_vehicles')
      .map((sp) => {
        const typeId = sp.typeIds[0];
        const info = typeInfo[typeId];
        if (!info) return null;
        const unlocked = (missions[sp.key] || []).filter((m) => m.stations <= stationCount);
        const allowed = !info.minStations || info.minStations <= stationCount;
        const ownedHere = own.some((v) => v.vehicle_type === typeId);
        const ownedAnywhere = vehicles.some((v) => v.vehicle_type === typeId);
        if (!allowed || !unlocked.length) return null;
        if (info.education) {
          const key = eduKeys[info.education];
          if (!key || !staff.some((p) => p.keys.includes(key))) return null; // nobody trained here
        }
        const label = labelOf(typeId) || sp.label;
        const name = `${CONFIG.vru.prefix} 09-${code}${SPECIALIST_SUFFIX[typeId] || '99'} ${label}`;
        const why = `<br><small class="text-muted">${unlocked.length} meldingstype(s) vrijgespeeld${ownedAnywhere && !ownedHere ? ' · je hebt er elders al een' : ''}</small>`;
        return row(name, typeId, ownedHere).replace('</td><td', `${why}</td><td`);
      })
      .filter(Boolean);

    const hiring = building.hiring_phase ? `werving loopt nog ${building.hiring_phase}d` : 'geen werving actief';
    const shortage = staff.length < crewNeeded;
    box.innerHTML = `<b>VRU 09-${code} ${VRU_STATIONS[code][0]}</b> — kopen geeft het voertuig meteen de juiste naam<br>
      <small>👷 Personeel <b>${staff.length}</b> · nodig voor huidige voertuigen ${crewNeeded}${shortage ? ' ⚠️' : ''} · ${hiring} · plekken ${own.length}/${slots}${
        freeSlots ? ` (<b>${freeSlots} vrij</b>)` : ' (vol)'
      }</small>
      <table class="table table-condensed" style="margin:4px 0 0;background:transparent">${vruRows.join('')}</table>
      ${
        specialistRows.length
          ? `<div style="margin-top:6px"><b>Extra specialisten</b> <small class="text-muted">(niet in de VRU-lijst van deze post, wel nuttig voor je meldingen)</small></div>
             <table class="table table-condensed" style="margin:2px 0 0;background:transparent">${specialistRows.join('')}</table>`
          : ''
      }`;

    box.querySelectorAll('.mks-vru-buy').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        storage.set('pending_rename', {
          buildingId,
          typeId: Number(btn.dataset.type),
          name: btn.dataset.name,
          knownIds: own.map((v) => v.id),
          ts: Date.now(),
        });
        doc.location.href = btn.dataset.href; // the game's own buy link
      })
    );
  }

  /* ---------- Renaming ---------- */

  async function renameVehicle(vehicleId, caption) {
    const doc = await fetchDoc(`/vehicles/${vehicleId}/edit`);
    const form = doc.querySelector(`form[action="/vehicles/${vehicleId}"]`);
    if (!form) throw new Error('edit form not found');
    form.querySelector('[name="vehicle[caption]"]').value = caption;
    const res = await fetch(form.getAttribute('action'), {
      method: 'POST',
      body: new FormData(form),
      credentials: 'include',
    });
    log(`Renamed ${vehicleId} → ${caption}`, res.status);
    return res.ok;
  }

  let renamePolling = false;
  async function processPendingRename() {
    if (renamePolling) return;
    renamePolling = true;
    try {
      // The bought vehicle may take a moment to show up in the API
      for (let i = 0; i < 6; i++) {
        const pending = storage.get('pending_rename');
        if (!pending) return;
        if (Date.now() - pending.ts > 10 * 60e3) return storage.set('pending_rename', null);

        const vehicles = await fetchJson('/api/vehicles', { fresh: true });
        const bought = vehicles.find(
          (v) =>
            String(v.building_id) === pending.buildingId &&
            v.vehicle_type === pending.typeId &&
            !pending.knownIds.includes(v.id)
        );
        if (bought) {
          storage.set('pending_rename', null);
          await renameVehicle(bought.id, pending.name);
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    } finally {
      renamePolling = false;
    }
  }

  /* ---------- Building page: rename existing vehicles to VRU names ---------- */

  async function enhanceBuildingPage(doc) {
    const buildingId = doc.location.pathname.match(/^\/buildings\/(\d+)\/?$/)?.[1];
    if (!buildingId) return;

    const [buildings, vehicles] = await Promise.all([fetchJson('/api/buildings'), fetchJson('/api/vehicles')]);
    const building = buildings.find((b) => String(b.id) === buildingId);
    const code = stationCodeFromName(building?.caption);
    if (!code || !VRU_STATIONS[code]) return;

    const own = vehicles.filter((v) => String(v.building_id) === buildingId);
    const used = new Set(own.map((v) => (v.caption || '').match(/09-(\d{4})/)?.[1]).filter(Boolean));

    // Vehicles without a VRU number get the first free callsign of the same kind
    const plan = [];
    own
      .filter((v) => !/09-\d{4}/.test(v.caption || ''))
      .forEach((v) => {
        const free = VRU_STATIONS[code][1].find(
          ([suffix, typeId]) => !used.has(suffix) && labelOf(typeId) === labelOf(v.vehicle_type),
        );
        if (!free) return;
        used.add(free[0]);
        plan.push({ id: v.id, from: v.caption, to: vehicleName(free[0], v.vehicle_type) });
      });

    if (!plan.length) return;

    const box = doc.createElement('div');
    box.className = 'alert alert-warning';
    box.style.cssText = 'padding:6px 10px;';
    box.innerHTML = `<b>VRU-namen</b>: ${plan.map((p) => `${p.from} → ${p.to}`).join(', ')}
      <a href="#" class="btn btn-xs btn-success" style="margin-left:8px">Toepassen</a>`;
    (doc.querySelector('.nav-tabs') || doc.body.firstElementChild).before(box);

    box.querySelector('a').addEventListener('click', async (e) => {
      e.preventDefault();
      e.target.textContent = 'Bezig…';
      for (const p of plan) await renameVehicle(p.id, p.to);
      box.className = 'alert alert-success';
      box.textContent = `${plan.length} voertuig(en) hernoemd. Herlaad de pagina om de nieuwe namen te zien.`;
    });
  }

  /* ------------------------------------------------------------------ */
  /* VRU panel (main page): tasks, hiring, expansion, advice, progress   */
  /* ------------------------------------------------------------------ */

  // Approximate credit prices per vehicle type (measured in the shop, Oct 2026)
  const VEHICLE_PRICES = {
    0: 5000, 1: 5000, 6: 5000, 7: 5000, 8: 5000, 9: 5000, 12: 5000, 14: 5000, 15: 5000, 17: 5000,
    2: 10000, 18: 10000, 3: 10000, 33: 10000, 4: 12180, 5: 11680, 10: 17300, 34: 17000,
  };
  const DEFAULT_VEHICLE_PRICE = 15000; // types not measured (SB, CO, …)
  /**
   * Price of the NEXT fire station, given how many you already have (blog.meldkamerspel.com/kostenoverzicht/brandweerkosten):
   * from 23 stations on: 100.000 + 200.000 × log2(stations − 22); before that a flat 100.000.
   * A small station ("Kazerne (klein)") costs half.
   */
  const stationBuildPrice = (existingStations, small = CONFIG.vru.defaultBuildingType === 17) => {
    const normal = existingStations < 23 ? 100000 : 100000 + 200000 * Math.log2(existingStations - 22);
    return Math.round(small ? normal / 2 : normal);
  };
  const countFireStations = (buildings) => buildings.filter((b) => b.building_type === 0).length;
  const LEVEL_STEP_PRICES = [10000, 50000, 100000, 100000, 100000]; // level n -> n+1

  // How often a vehicle kind is needed in your fire missions (share of mission types)
  const NEED_WEIGHT = { AL: 34, OvD: 17, HV: 12, WT: 7, TS: 3, NB: 3, TST: 3, WO: 2, SB: 1, AB: 1, SW: 1 };

  // Hand-picked build order: fills the biggest gaps around your current coverage first
  const BUILD_PRIORITY = [
    '66', '51', '48', '27', '18', '55', '39', '44', '20', '62', '13', '50', '36', '64',
    '35', '65', '10', '09', '17', '43', '47', '49', '45', '46', '28', '25', '29', '59',
  ];

  const formatCredits = (n) => `${Math.round(n).toLocaleString('nl-NL')}`;
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** Counts owned vehicles per label (TS, AL, OvD, …). */
  function countLabels(vehicles) {
    const counts = {};
    vehicles.forEach((v) => {
      const label = labelOf(v.vehicle_type);
      if (label) counts[label] = (counts[label] || 0) + 1;
    });
    return counts;
  }

  /** Ranks stations that are not built yet. */
  function rankUnbuiltStations(buildings, vehicles) {
    const built = new Set(buildings.map((b) => stationCodeFromName(b.caption)).filter(Boolean));
    const owned = countLabels(vehicles);
    const nextStationPrice = stationBuildPrice(countFireStations(buildings));
    const all = Object.keys(VRU_STATIONS).map((c) => String(c).padStart(2, '0'));

    return all
      .filter((c) => !built.has(c))
      .map((code) => {
        const vehiclesRef = VRU_STATIONS[code][1];
        // Specialists = everything except the first fire engine (that one comes free with the station)
        const specialists = vehiclesRef.filter(([, t]) => labelOf(t) !== 'TS');
        const score = specialists.reduce((s, [, t]) => s + (NEED_WEIGHT[labelOf(t)] || 1) / (1 + (owned[labelOf(t)] || 0)), 0);
        const priority = BUILD_PRIORITY.indexOf(code);
        const firstSpecialist = specialists[0];
        const cost =
          nextStationPrice + (firstSpecialist ? LEVEL_STEP_PRICES[0] + (VEHICLE_PRICES[firstSpecialist[1]] || DEFAULT_VEHICLE_PRICE) : 0);
        return { code, name: VRU_STATIONS[code][0], specialists, score, priority, cost };
      })
      .sort((a, b) => {
        // Hand-picked order first, then by how much the station adds
        const pa = a.priority === -1 ? 999 : a.priority;
        const pb = b.priority === -1 ? 999 : b.priority;
        return pa - pb || b.score - a.score;
      });
  }

  /** What a built station still misses compared to the VRU reference. */
  function stationStatus(building, vehicles) {
    const code = stationCodeFromName(building.caption);
    const ref = code && VRU_STATIONS[code] ? VRU_STATIONS[code][1] : [];
    const own = vehicles.filter((v) => v.building_id === building.id);
    const ownNumbers = new Set(own.map((v) => (v.caption || '').match(/09-(\d{4})/)?.[1]).filter(Boolean));
    const missing = ref.filter(([suffix]) => !ownNumbers.has(suffix));
    const slots = building.level + 1;
    const free = Math.max(0, slots - own.length);
    const levelsNeeded = Math.max(0, own.length + missing.length - slots);
    let levelCost = 0;
    for (let l = building.level; l < building.level + levelsNeeded; l++) levelCost += LEVEL_STEP_PRICES[Math.min(l, 4)];
    const vehicleCost = missing.reduce((s, [, t]) => s + (VEHICLE_PRICES[t] || DEFAULT_VEHICLE_PRICE), 0);
    return { code, ref, own, missing, slots, free, levelsNeeded, cost: levelCost + vehicleCost };
  }

  async function loadTasks() {
    const doc = await fetchDoc('/tasks/index');
    const num = (s) => parseInt(String(s).replace(/\./g, ''), 10) || 0;
    const seen = new Set();
    // "Alle taken" does not hold the event tabs (Sinterklaas…): read every tab and drop repeats
    return [...doc.querySelectorAll('#all .task_panel.hidden-xs, #event .task_panel.hidden-xs, #autumn .task_panel.hidden-xs')]
      .map((p) => {
        const endsAt = Number(p.querySelector('script')?.textContent.match(/registerTaskTimer\("[^"]*",\s*"[^"]*",\s*(\d+)/)?.[1]) || null;
        p.querySelectorAll('script').forEach((s) => s.remove());
        const heading = p.querySelector('.panel-heading');
        const category = heading?.querySelector('b')?.textContent.replace(/[[\]]/g, '').trim() || '';
        const title = (heading?.textContent || '')
          .replace(/\[[^\]]*\]/, '')
          .replace(/Meer taken volgen/, '')
          .replace(/\s+/g, ' ')
          .trim();
        const body = (p.querySelector('.task_body')?.textContent || '').replace(/\s+/g, ' ');
        const progress = body.match(/([\d.]+)\s*\/\s*([\d.]+)/);
        const reward = (body.match(/[\d.]+ Credits|\d+ coins?/gi) || []).join(' + ');
        const form = p.querySelector('form[action*="claim_reward"]');
        const claimable = !!form?.querySelector('input[type=submit]:not([disabled])');
        return {
          category,
          title,
          endsAt,
          done: progress ? num(progress[1]) : 0,
          total: progress ? num(progress[2]) : 1,
          reward,
          claimable,
          form,
        };
      })
      .filter((t) => {
        const key = `${t.title}|${t.total}|${t.endsAt}`;
        return seen.has(key) ? false : (seen.add(key), true);
      });
  }

  async function claimTask(form) {
    const res = await fetch(form.getAttribute('action'), { method: 'POST', body: new FormData(form), credentials: 'include' });
    log('Claimed task', res.status);
    return res.ok;
  }

  function initPanel() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-danger btn-sm';
    button.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;box-shadow:0 2px 6px rgba(0,0,0,.3);';
    button.innerHTML = '🚒 VRU <span class="badge" style="display:none"></span>';
    const badge = button.querySelector('.badge');

    const panel = document.createElement('div');
    panel.className = 'panel panel-default';
    panel.style.cssText =
      'position:fixed;left:12px;bottom:52px;z-index:9999;width:500px;max-width:calc(100vw - 24px);max-height:75vh;overflow:auto;display:none;box-shadow:0 4px 16px rgba(0,0,0,.35);font-size:13px;';
    panel.innerHTML = `
      <div class="panel-heading" style="display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:1">
        <b>🚒 VRU-paneel</b>
        <span>
          <a href="#" class="mks-refresh" title="Vernieuwen">↻</a>
          <a href="#" class="mks-close" title="Sluiten" style="margin-left:10px">✕</a>
        </span>
      </div>
      <div class="panel-body" style="padding:8px 10px"></div>`;
    const body = panel.querySelector('.panel-body');

    document.body.append(panel, button);

    const open = () => panel.style.display !== 'none';
    button.addEventListener('click', () => {
      panel.style.display = open() ? 'none' : 'block';
      if (open()) render();
    });
    panel.querySelector('.mks-close').addEventListener('click', (e) => {
      e.preventDefault();
      panel.style.display = 'none';
    });
    panel.querySelector('.mks-refresh').addEventListener('click', (e) => {
      e.preventDefault();
      invalidatePersonnel();
      render();
    });

    // Badge: claimable tasks + stations without recruitment
    async function updateBadge() {
      try {
        const [tasks, buildings] = await Promise.all([loadTasks(), fetchJson('/api/buildings')]);
        const claimable = tasks.filter((t) => t.claimable).length;
        const notHiring = buildings.filter((b) => b.building_type === 0 && !b.hiring_phase).length;
        const total = claimable + notHiring;
        badge.textContent = total;
        badge.style.display = total ? 'inline-block' : 'none';
        button.title = `${claimable} taak/taken te claimen, ${notHiring} post(en) zonder werving`;
      } catch (e) {
        console.error('[MKS→HA] Badge update failed', e);
      }
    }
    updateBadge();
    setInterval(updateBadge, 5 * 60e3);

    async function render() {
      body.innerHTML = '<em>Laden…</em>';
      try {
        const [buildings, vehicles, credits, tasks] = await Promise.all([
          fetchJson('/api/buildings'),
          fetchJson('/api/vehicles'),
          fetchJson('/api/credits'),
          loadTasks(),
        ]);
        const fireStations = buildings
          .filter((b) => b.building_type === 0)
          .sort((a, b) => a.caption.trim().localeCompare(b.caption.trim()));
        const balance = credits.credits_user_current;

        body.innerHTML = '';
        // All sections start collapsed; the counters show what is waiting inside (they follow the async content)
        const buttons = (c, test) => [...c.querySelectorAll('a.btn')].filter((a) => test(a.textContent.trim()));
        body.append(
          section('🎯 Prioriteiten, teamhulp & vergeten voertuigen', await renderPriorities(), (c) => ({
            act: buttons(c, (t) => t === 'Open' || t === 'Voertuig').length,
          })),
          section('📋 Taken', renderTasks(tasks), (c) => ({ act: buttons(c, (t) => t === 'Claim').length })),
          section('👥 Werving', renderHiring(fireStations), (c) => ({ act: buttons(c, (t) => /^\d+ dagen werven$/.test(t)).length })),
          section('🧭 Ontwikkelplan (incl. personeel)', await renderPlan(balance), (c) => ({
            act: c.querySelectorAll('[data-mks-step="now"]').length,
            opt: c.querySelectorAll('[data-mks-step="later"]').length,
          })),
          section('🧑‍🚒 Specialisten: ontdekt & thuiskazerne', await renderSpecialists(), (c) => ({
            act: c.querySelectorAll('[data-mks-specialist="act"]').length,
            opt: c.querySelectorAll('[data-mks-specialist="opt"]').length,
          })),
          section('🎓 Opleidingen: wachtrij voor de academie', await renderTraining(), (c) => ({
            act: c.querySelectorAll('[data-mks-training="act"]').length,
            opt: c.querySelectorAll('[data-mks-training="opt"]').length,
          })),
          section('🔀 Herverdelen: voertuigen & personeel', await renderRedistribution(), (c) => ({
            act: buttons(c, (t) => /^(Hernoem|Verplaats|Koppel)/.test(t)).length,
          })),
          section('📚 Inzetgeheugen per melding', await renderMissionMemory()),
          section('🗺️ VRU-voortgang', renderProgress(fireStations, buildings, vehicles), (c) => ({
            opt: c.querySelectorAll('[data-mks-incomplete]').length,
          })),
          section('📈 Rapport', await renderReport(balance, fireStations.length)),
          section('⚙️ Instellingen', renderSettings()),
        );
        updateBadge();
      } catch (e) {
        console.error('[MKS→HA] Panel failed', e);
        body.innerHTML = `<div class="alert alert-danger">Laden mislukt: ${escapeHtml(e.message)}</div>`;
      }
    }

    /**
     * Collapsible section, always collapsed at first. `count(content)` returns { act, opt }:
     * act = things to do now (red badge), opt = possible next steps (grey badge).
     * Recounted whenever the content changes (async loading, a button turning into ✓).
     */
    function section(title, content, count) {
      const details = document.createElement('details');
      details.style.marginBottom = '8px';
      details.innerHTML = `<summary style="cursor:pointer;font-weight:bold;margin-bottom:4px">${title}
        <span class="badge mks-act" style="display:none;background:#d9534f;margin-left:4px" title="Acties: nu te doen"></span>
        <span class="badge mks-opt" style="display:none;margin-left:4px" title="Opties: mogelijke volgende stappen"></span></summary>`;
      details.append(content);
      if (count) {
        const act = details.querySelector('.mks-act');
        const opt = details.querySelector('.mks-opt');
        const show = (badge, n) => {
          badge.textContent = n;
          badge.style.display = n > 0 ? 'inline-block' : 'none';
        };
        let scheduled = false;
        const update = () => {
          scheduled = false;
          try {
            const r = count(content) || {};
            show(act, r.act || 0);
            show(opt, r.opt || 0);
          } catch (e) {
            console.error('[MKS→HA] Section count failed', title, e);
          }
        };
        update();
        new MutationObserver(() => {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(update);
        }).observe(content, { childList: true, subtree: true, characterData: true });
      }
      return details;
    }

    function el(html) {
      const div = document.createElement('div');
      div.innerHTML = html;
      return div;
    }

    function actionButton(label, onClick, cls = 'btn-success') {
      const a = document.createElement('a');
      a.href = '#';
      a.className = `btn btn-xs ${cls}`;
      a.textContent = label;
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        if (a.dataset.busy) return;
        a.dataset.busy = '1';
        a.textContent = '…';
        try {
          const ok = await onClick();
          a.textContent = ok === false ? 'Mislukt' : '✓';
          a.className = `btn btn-xs ${ok === false ? 'btn-danger' : 'btn-default'}`;
        } catch (err) {
          console.error(err);
          a.textContent = 'Mislukt';
          a.className = 'btn btn-xs btn-danger';
        }
      });
      return a;
    }

    /* ---- Tasks ---- */
    function renderTasks(tasks) {
      const open = tasks
        .filter((t) => t.claimable || t.done < t.total)
        .sort((a, b) => Number(b.claimable) - Number(a.claimable) || b.done / b.total - a.done / a.total);
      const wrap = el('');
      const claimable = open.filter((t) => t.claimable);
      if (claimable.length > 1) {
        const all = actionButton(`Alles claimen (${claimable.length})`, async () => {
          for (const t of claimable) await claimTask(t.form);
          setTimeout(render, 500);
        });
        all.style.marginBottom = '6px';
        wrap.append(all);
      }
      if (!open.length) wrap.append(el('<em>Geen openstaande taken.</em>'));
      open.slice(0, 15).forEach((t) => {
        const pct = Math.min(100, Math.round((t.done / t.total) * 100));
        const row = el(`
          <div style="display:flex;justify-content:space-between;gap:6px">
            <span>${t.category ? `<small class="text-muted">[${escapeHtml(t.category)}]</small> ` : ''}${escapeHtml(t.title)}</span>
            <span style="white-space:nowrap"><b>${formatCredits(t.done)}/${formatCredits(t.total)}</b></span>
          </div>
          <div class="progress" style="height:6px;margin:2px 0 1px"><div class="progress-bar ${t.claimable ? 'progress-bar-success' : ''}" style="width:${pct}%"></div></div>
          <small class="text-muted">${escapeHtml(t.reward)}</small>`);
        row.style.marginBottom = '6px';
        // Event counter check: how many of this event's missions the script saw finishing vs. what the game counted
        if (/evenementopdrachten/.test(t.title) && t.endsAt) {
          const mine = extrasRead('completed_v1', []).filter((e) => e.ev && Math.abs(e.ev - t.endsAt) < 36e5);
          if (mine.length) {
            const since = new Date(Math.min(...mine.map((e) => e.ts))).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
            row.append(el(`<small class="text-muted">🔎 Script zag ${mine.length} van deze evenementmeldingen verdwijnen sinds ${since} (afgerond of verlopen); het spel telt ${formatCredits(t.done)}.</small>`));
          }
        }
        if (t.claimable) {
          const btn = actionButton('Claim', async () => {
            const ok = await claimTask(t.form);
            setTimeout(updateBadge, 500);
            return ok;
          });
          btn.style.marginLeft = '6px';
          row.querySelector('small').after(btn);
        }
        wrap.append(row);
      });
      if (open.length > 15) wrap.append(el(`<small class="text-muted">+ ${open.length - 15} meer op de takenpagina</small>`));
      return wrap;
    }

    /* ---- Hiring ---- */
    function renderHiring(stations) {
      const wrap = el('');
      const notHiring = stations.filter((b) => !b.hiring_phase);
      const hiring = stations.filter((b) => b.hiring_phase);
      const hire = (b) => () =>
        fetch(`/buildings/${b.id}/hire_do/${CONFIG.vru.autoHireDays || 3}`, { credentials: 'include' }).then((r) => r.ok);

      if (notHiring.length > 1) {
        const all = actionButton(`Alle ${notHiring.length} posten ${CONFIG.vru.autoHireDays || 3} dagen laten werven`, async () => {
          for (const b of notHiring) await hire(b)();
          setTimeout(render, 500);
        });
        all.style.marginBottom = '6px';
        wrap.append(all);
      }
      notHiring.forEach((b) => {
        const row = el(`<span>${escapeHtml(b.caption.trim())} <small class="text-muted">(${b.personal_count} personeel)</small></span>`);
        row.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:3px';
        row.append(actionButton(`${CONFIG.vru.autoHireDays || 3} dagen werven`, hire(b)));
        wrap.append(row);
      });
      if (hiring.length)
        wrap.append(
          el(
            `<small class="text-muted">Werft al: ${hiring
              .map((b) => `${escapeHtml(b.caption.trim().replace(`${CONFIG.vru.prefix} `, ''))} (${b.hiring_phase}d)`)
              .join(', ')}</small>`
          )
        );
      if (!stations.length) wrap.append(el('<em>Geen brandweerposten.</em>'));
      return wrap;
    }

    /* ---- Progress ---- */
    function renderProgress(stations, buildings, vehicles) {
      const wrap = el('');
      const total = Object.keys(VRU_STATIONS).length;
      const statuses = stations.map((b) => ({ b, s: stationStatus(b, vehicles) })).filter((x) => x.s.code);
      const builtCodes = new Set(statuses.map((x) => x.s.code));
      const unbuilt = rankUnbuiltStations(buildings, vehicles);
      const refVehicles = Object.values(VRU_STATIONS).reduce((n, [, v]) => n + v.length, 0);
      const vruVehicles = statuses.reduce((n, x) => n + (x.s.ref.length - x.s.missing.length), 0);
      const finishBuilt = statuses.reduce((n, x) => n + x.s.cost, 0);
      const existingStations = countFireStations(buildings);
      const finishUnbuilt = unbuilt.reduce((n, s, i) => {
        const vehiclesCost = VRU_STATIONS[s.code][1]
          .slice(1)
          .reduce((c, [, t]) => c + (VEHICLE_PRICES[t] || DEFAULT_VEHICLE_PRICE), 0);
        const levels = VRU_STATIONS[s.code][1].length - 1;
        let levelCost = 0;
        for (let l = 0; l < levels; l++) levelCost += LEVEL_STEP_PRICES[Math.min(l, 4)];
        return n + stationBuildPrice(existingStations + i) + vehiclesCost + levelCost; // every station raises the next price
      }, 0);

      wrap.append(
        el(`<div><b>${builtCodes.size}/${total}</b> posten · <b>${vruVehicles}/${refVehicles}</b> VRU-voertuigen</div>
            <div class="progress" style="height:8px;margin:3px 0"><div class="progress-bar progress-bar-danger" style="width:${Math.round(
              (builtCodes.size / total) * 100
            )}%"></div></div>
            <small class="text-muted">Afmaken ≈ ${formatCredits(finishBuilt)} (bestaande posten) + ${formatCredits(finishUnbuilt)} (nieuwe posten)</small>`)
      );

      const list = el('');
      list.style.marginTop = '6px';
      statuses
        .sort((a, b) => a.s.code.localeCompare(b.s.code))
        .forEach(({ b, s }) => {
          const complete = !s.missing.length;
          list.append(
            el(
              `<div style="margin-bottom:2px"${complete ? '' : ' data-mks-incomplete="1"'}>${complete ? '✅' : '🟡'} 09-${s.code} ${escapeHtml(VRU_STATIONS[s.code][0])} <small class="text-muted">${
                s.ref.length - s.missing.length
              }/${s.ref.length}${complete ? '' : ` · mist ${s.missing.map(([n, t]) => `${n} ${labelOf(t)}`).join(', ')}`}</small></div>`
            )
          );
        });
      if (unbuilt.length)
        list.append(
          el(
            `<div style="margin-top:4px"><small class="text-muted">Nog te bouwen (${unbuilt.length}): ${unbuilt
              .map((s) => `09-${s.code} ${escapeHtml(s.name)}`)
              .join(', ')}</small></div>`
          )
        );
      wrap.append(list);
      return wrap;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Personnel panel: specialists, binding, transfers, training advice   */
  /* ------------------------------------------------------------------ */

  // Mission requirement key -> specialist vehicle (verified via the game's mission help pages)
  const SPECIALTIES = [
    { key: 'battalion_chief_vehicles', label: 'OvD-B', typeIds: [3] },
    { key: 'mobile_command_vehicles', label: 'HOvD', typeIds: [19] },
    { key: 'hazmat_vehicles', label: 'AGS', typeIds: [24] },
    { key: 'elw3', label: 'Commandowagen (CO)', typeIds: [31] },
    { key: 'gwmess', label: 'Verkenningseenheid (DB-VEB)', typeIds: [11] },
    { key: 'mobile_air_vehicles', label: 'Adembescherming (AB)', typeIds: [5] },
    { key: 'spokesman', label: 'Voorlichter (DA-VL)', typeIds: [56] },
  ];
  const MIN_STATION_PERSONNEL = 10; // the game keeps at least this many at the source station

  const cacheGet = (key, maxAgeMs) => {
    const c = storage.get(key);
    return c && Date.now() - c.ts < maxAgeMs ? c.data : null;
  };
  const cacheSet = (key, data) => storage.set(key, { ts: Date.now(), data });

  /** Vehicle type info from the game's own shop: education, unlock threshold, crew. Cached 24 h. */
  async function loadVehicleTypeInfo(fireStationId) {
    const cached = cacheGet('vehicle_types_v1', 24 * 3600e3);
    if (cached) return cached;
    const doc = await fetchDoc(`/buildings/${fireStationId}/vehicles/new`);
    doc.querySelectorAll('script, style').forEach((s) => s.remove());
    const info = {};
    doc.querySelectorAll(`a[href*="/vehicle/${fireStationId}/"][href*="/credits"]`).forEach((a) => {
      const typeId = Number(a.getAttribute('href').match(/vehicle\/\d+\/(\d+)\//)[1]);
      let el = a;
      while (el.parentElement && el.parentElement.querySelectorAll('a[href*="/credits"]').length === 1) el = el.parentElement;
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      info[typeId] = {
        name: text.split(/ (?:\d+ in Bezit )?(?:Max\.|Min\.)/)[0].slice(0, 60),
        education: text.match(/speciale opleiding op een school\. \(([^)]+)\)/)?.[1] || null,
        minStations: Number(text.match(/Benodigd vanaf (\d+) brandweerposten/)?.[1] || 0),
        minCrew: Number(text.match(/Min\. (\d+) personen/)?.[1] || 0),
        maxCrew: Number(text.match(/Max\. (\d+) personen/)?.[1] || 0),
        price: Number((a.textContent.match(/[\d.]+/)?.[0] || '0').replace(/\./g, '')),
      };
    });
    cacheSet('vehicle_types_v1', info);
    return info;
  }

  /** Fire-only missions per specialist key: {key: [{stations, credits, name}]}. Cached 24 h. */
  async function loadSpecialistMissions() {
    const cached = cacheGet('specialist_missions_v1', 24 * 3600e3);
    if (cached) return cached;
    const types = await loadMissionCatalog();
    const result = {};
    types.forEach((t) => {
      const pre = t.prerequisites || {};
      const fireOnly =
        pre.fire_stations && !pre.main_building && Object.keys(pre).every((k) => ['main_building', 'fire_stations'].includes(k));
      if (!fireOnly || pre.fire_stations >= 100) return; // skip milestone missions
      SPECIALTIES.forEach((s) => {
        if (!t.requirements?.[s.key]) return;
        (result[s.key] = result[s.key] || []).push({ stations: pre.fire_stations, credits: t.average_credits || 0, name: t.name });
      });
    });
    cacheSet('specialist_missions_v1', result);
    return result;
  }

  /** All personnel of one station, plus long education name -> key mapping. */
  async function loadStationPersonnel(building, vehicles) {
    const doc = await fetchDoc(`/buildings/${building.id}/personals`);
    const own = vehicles.filter((v) => v.building_id === building.id);
    const people = [...doc.querySelectorAll('table tbody tr')].map((row) => {
      // "Gebonden aan" is plain text (the vehicle caption), sometimes a link
      const boundCell = row.children[3];
      const boundHref = boundCell?.querySelector('a[href^="/vehicles/"]')?.getAttribute('href');
      const boundText = boundCell?.textContent.trim();
      const boundVehicleId = boundHref
        ? Number(boundHref.split('/')[2])
        : boundText
          ? own.find((v) => v.caption.trim() === boundText)?.id ?? -1 // -1: bound, vehicle unknown
          : null;
      let keys = [];
      try {
        keys = JSON.parse(row.getAttribute('data-filterable-by') || '[]');
      } catch (e) {
        /* no keys */
      }
      return {
        id: row.querySelector('input.personal-delete-checkbox')?.value,
        name: row.children[1]?.textContent.trim(),
        education: row.children[2]?.textContent.trim(),
        keys,
        boundVehicleId,
        status: row.children[4]?.textContent.replace(/\s+/g, ' ').trim(),
        buildingId: building.id,
      };
    });
    return people;
  }

  /** Long education names ("Adviseur Gevaarlijke Stoffen") -> key ("gw_gefahrgut"), from the transfer lists. */
  async function loadEducationKeys(buildingsWithEducated) {
    const cached = cacheGet('education_keys_v1', 24 * 3600e3) || {};
    for (const b of buildingsWithEducated) {
      const doc = await fetchDoc(`/buildings/${b.id}/schooling_personal_select`);
      doc.querySelectorAll('.schooling_select_available_with_education').forEach((a) => {
        const key = a.getAttribute('onclick')?.match(/"([^"]+)"\)/)?.[1] || a.getAttribute('onclick')?.match(/&quot;([^&]+)&quot;/)?.[1];
        if (key) cached[a.textContent.trim()] = key;
      });
    }
    cacheSet('education_keys_v1', cached);
    return cached;
  }

  /** Remaining transfers this week, the adopt form token and the "buy more" hint. */
  async function loadTransferInfo(targetBuildingId) {
    const html = await fetch(`/buildings/${targetBuildingId}/hire`, { credentials: 'include', cache: 'no-store' }).then((r) => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const form = doc.querySelector(`form[action="/buildings/${targetBuildingId}/adopt"]`);
    const hireTrained = doc.querySelector('form[action="/hire_with_education"]');
    return {
      remaining: Number(html.match(/free_space_for_personnel_selection\(\)\s*\{\s*return (\d+)/)?.[1] ?? 0),
      token: form?.querySelector('input[name="authenticity_token"]')?.value,
      commit: form?.querySelector('input[name="commit"]')?.value || '',
      hireTrainedPrice:
        [...(hireTrained?.querySelectorAll('input[type=submit], button') || [])]
          .map((b) => b.value || b.textContent)
          .join(' ')
          .match(/Direct iemand aannemen \((\d+) Coins\)/)?.[1] || null,
    };
  }

  /** Moves personnel to `targetBuildingId` with the game's own "Personeel overnemen" form. Irreversible. */
  async function transferPersonnel(targetBuildingId, personIds) {
    const info = await loadTransferInfo(targetBuildingId);
    if (!info.token) throw new Error('transfer form not found');
    if (info.remaining < personIds.length) throw new Error(`nog maar ${info.remaining} verplaatsingen deze week`);
    const body = new FormData();
    body.append('utf8', '✓');
    body.append('authenticity_token', info.token);
    personIds.forEach((id) => body.append('personal_ids[]', id));
    body.append('commit', info.commit);
    const res = await fetch(`/buildings/${targetBuildingId}/adopt`, { method: 'POST', body, credentials: 'include' });
    log(`Transferred ${personIds.length} to ${targetBuildingId}`, res.status);
    return res.ok;
  }

  /**
   * Binding via the game's "Voertuig toewijzen" link, which TOGGLES. To stay safe we first read
   * the vehicle's assignment page and only click when the current state differs from what we want.
   */
  async function setBinding(vehicleId, personId, shouldBeBound) {
    const doc = await fetchDoc(`/vehicles/${vehicleId}/zuweisung`);
    const link = doc.querySelector(`#personal_${personId} a[href$="/zuweisungDo/${personId}"]`);
    if (!link) throw new Error('persoon niet gevonden op dit voertuig');
    const isBound = link.classList.contains('btn-assigned');
    if (isBound === shouldBeBound) return true; // already as wanted
    // The game posts this link via AJAX with the CSRF token; a plain GET is silently ignored
    const res = await fetch(link.getAttribute('href'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || '',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    log(`${shouldBeBound ? 'Bound' : 'Unbound'} ${personId} ${shouldBeBound ? '→' : '←'} ${vehicleId}`, res.status);
    return res.ok;
  }
  const bindPerson = (vehicleId, personId) => setBinding(vehicleId, personId, true);
  const unbindPerson = (vehicleId, personId) => setBinding(vehicleId, personId, false);

  /**
   * Crew plan for specialist vehicles: trained people on the right vehicle, or moved to a post that has it.
   * Steps (in order, per vehicle): bind free trained people here; re-bind trained people who sit on another
   * vehicle at this post; otherwise transfer trained people from a post that can spare them (they keep ≥10 staff).
   * Pure data: nothing is executed here.
   */
  function planSpecialistCrew(data, transfersLeft) {
    const steps = [];
    const used = new Set(); // person ids already planned for another vehicle
    const spare = new Map(data.stationRows.map((r) => [r.station.id, r.transferable]));
    let transfersRemaining = transfersLeft;
    const reusable = (p, key) => !used.has(p.id) && (!p.boundVehicleId || (p.boundVehicleId > 0 && p.boundRequiresKey !== key));

    [...data.specialistVehicles]
      .sort((a, b) => a.need - b.need)
      .forEach((s) => {
        if (!s.key) return; // education key unknown: nobody has it yet
        let have = s.boundHere.length;
        // 1. free trained people at this post
        const free = s.free.filter((p) => !used.has(p.id)).slice(0, Math.max(0, s.full - have));
        if (free.length) {
          free.forEach((p) => used.add(p.id));
          steps.push({ type: 'bind', vehicle: s.vehicle, station: s.station, people: free });
          have += free.length;
        }
        // 2. trained people at this post bound to a vehicle that does not need them
        if (have < s.need) {
          const mis = s.qualified.filter((p) => reusable(p, s.key) && p.boundVehicleId > 0).slice(0, s.need - have);
          if (mis.length) {
            mis.forEach((p) => used.add(p.id));
            steps.push({ type: 'rebind', vehicle: s.vehicle, station: s.station, people: mis });
            have += mis.length;
          }
        }
        // 3. other posts: trained people not needed there, donor keeps its minimum staff
        if (have < s.need && transfersRemaining > 0) {
          const donors = data.stationRows
            .filter((r) => r.station.id !== s.station.id && spare.get(r.station.id) > 0)
            .map((r) => ({ r, people: r.staff.filter((p) => p.keys.includes(s.key) && reusable(p, s.key)) }))
            .filter((d) => d.people.length)
            .sort((a, b) => b.people.length - a.people.length);
          for (const d of donors) {
            const n = Math.min(s.need - have, d.people.length, spare.get(d.r.station.id), transfersRemaining);
            if (n <= 0) continue;
            const pick = d.people.slice(0, n);
            pick.forEach((p) => used.add(p.id));
            spare.set(d.r.station.id, spare.get(d.r.station.id) - n);
            transfersRemaining -= n;
            steps.push({ type: 'transfer', vehicle: s.vehicle, station: s.station, from: d.r.station, people: pick });
            have += n;
            if (have >= s.need) break;
          }
        }
      });
    return steps;
  }

  /** Runs one crew step with the game's own forms. Bound people are un-bound first; after a transfer they are bound on arrival. */
  async function executeCrewStep(step) {
    const unbindOthers = async () => {
      for (const p of step.people) if (p.boundVehicleId > 0 && p.boundVehicleId !== step.vehicle.id) await unbindPerson(p.boundVehicleId, p.id);
    };
    if (step.type === 'bind') {
      for (const p of step.people) await bindPerson(step.vehicle.id, p.id);
      return true;
    }
    if (step.type === 'rebind') {
      await unbindOthers();
      for (const p of step.people) await bindPerson(step.vehicle.id, p.id);
      return true;
    }
    await unbindOthers(); // a bound person cannot be moved
    const ok = await transferPersonnel(step.station.id, step.people.map((p) => p.id));
    if (ok) {
      try {
        for (const p of step.people) await bindPerson(step.vehicle.id, p.id); // best-effort: they may need a moment to show up
      } catch (e) {
        log('Bind after transfer failed (do it by hand)', e.message);
      }
    }
    return ok;
  }

  /** Builds the complete picture; pure data, no UI. */
  // Panels ask for this several times at once (plan, redistribution, personnel): share one result for 15 s
  let personnelCache = null;
  /**
   * Trained people at a post without a vehicle that needs their education (the car stands elsewhere or is not bought yet).
   * Per education: the posts with the most idle people first, so a new car there is crewed from day one.
   */
  function findIdleTrained({ stations, people, vehicles, typeInfo, keyOf }) {
    const byEducation = {};
    Object.entries(typeInfo).forEach(([typeId, info]) => {
      if (info.education) (byEducation[info.education] ||= []).push({ typeId: Number(typeId), name: info.name });
    });
    return Object.entries(byEducation)
      .map(([education, types]) => {
        const key = keyOf(education);
        if (!key) return null;
        const typeIds = types.map((t) => t.typeId);
        const owned = vehicles.filter((v) => typeIds.includes(v.vehicle_type) && stations.some((s) => s.id === v.building_id));
        const posts = stations
          .map((station) => {
            const idle = people.filter((p) => p.buildingId === station.id && p.keys.includes(key) && !p.boundVehicleId);
            const hasCar = owned.some((v) => v.building_id === station.id);
            return { station, idle: idle.length, hasCar };
          })
          .filter((x) => x.idle && !x.hasCar)
          .sort((a, b) => b.idle - a.idle);
        return posts.length ? { education, types, owned: owned.length, posts } : null;
      })
      .filter(Boolean);
  }

  function analysePersonnel() {
    if (personnelCache && Date.now() - personnelCache.ts < 15e3) return personnelCache.promise;
    const promise = analysePersonnelUncached().catch((e) => {
      personnelCache = null;
      throw e;
    });
    personnelCache = { ts: Date.now(), promise };
    return promise;
  }
  const invalidatePersonnel = () => (personnelCache = null);

  async function analysePersonnelUncached() {
    const [buildings, vehicles] = await Promise.all([fetchJson('/api/buildings'), fetchJson('/api/vehicles')]);
    const stations = buildings
      .filter((b) => b.building_type === 0)
      .sort((a, b) => a.caption.trim().localeCompare(b.caption.trim()));
    if (!stations.length) throw new Error('geen brandweerposten');

    const [typeInfo, missions, peoplePerStation] = await Promise.all([
      loadVehicleTypeInfo(stations[0].id),
      loadSpecialistMissions(),
      Promise.all(stations.map((st) => loadStationPersonnel(st, vehicles))),
    ]);
    const people = peoplePerStation.flat();
    const educated = stations.filter((s, i) => peoplePerStation[i].some((p) => p.keys.length));
    const eduKeys = await loadEducationKeys(educated);
    const keyOf = (longName) => (longName ? eduKeys[longName] || null : null);

    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
    const requiredKeyOfVehicle = (v) => keyOf(typeInfo[v.vehicle_type]?.education);
    // What a bound person is bound to (null = free / unknown vehicle): lets the crew planner see who can be re-used
    people.forEach((p) => {
      const bound = p.boundVehicleId > 0 ? vehicleById.get(p.boundVehicleId) : null;
      p.boundRequiresKey = bound ? requiredKeyOfVehicle(bound) : null;
    });

    // Per station
    const stationRows = stations.map((s, i) => {
      const own = vehicles.filter((v) => v.building_id === s.id);
      const crewNeeded = own.reduce((n, v) => n + (v.max_personnel_override || typeInfo[v.vehicle_type]?.maxCrew || 0), 0);
      const staff = peoplePerStation[i];
      const perEducation = {};
      staff.forEach((p) => p.education && (perEducation[p.education] = (perEducation[p.education] || 0) + 1));
      return { station: s, staff, own, crewNeeded, perEducation, transferable: Math.max(0, staff.length - MIN_STATION_PERSONNEL) };
    });

    // Specialist vehicles you own that need an education
    const specialistVehicles = vehicles
      .filter((v) => typeInfo[v.vehicle_type]?.education && stations.some((s) => s.id === v.building_id))
      .map((v) => {
        const info = typeInfo[v.vehicle_type];
        const key = requiredKeyOfVehicle(v);
        const station = stations.find((s) => s.id === v.building_id);
        const staff = people.filter((p) => p.buildingId === v.building_id);
        const qualified = key ? staff.filter((p) => p.keys.includes(key)) : [];
        const boundHere = qualified.filter((p) => p.boundVehicleId === v.id);
        const free = qualified.filter((p) => !p.boundVehicleId);
        // Qualified people bound to a vehicle that doesn't need their education
        const misbound = qualified.filter((p) => {
          if (!p.boundVehicleId || p.boundVehicleId === v.id || p.boundVehicleId < 0) return false;
          const other = vehicleById.get(p.boundVehicleId);
          return !other || requiredKeyOfVehicle(other) !== key;
        });
        const need = Math.max(1, info.minCrew || 0);
        const full = v.max_personnel_override || info.maxCrew || need;
        const allBound = staff.filter((p) => p.boundVehicleId === v.id);
        return { vehicle: v, station, info, key, qualified, boundHere, free, misbound, need, full, overBound: Math.max(0, allBound.length - full) };
      });

    // Specialist demand: missions unlocked by your station count vs. what you own / have trained
    const stationCount = stations.length;
    const specialtyRows = SPECIALTIES.map((s) => {
      const list = missions[s.key] || [];
      const unlocked = list.filter((m) => m.stations <= stationCount);
      const next = list.filter((m) => m.stations > stationCount).sort((a, b) => a.stations - b.stations);
      const typeId = s.typeIds[0];
      const info = typeInfo[typeId] || {};
      const owned = vehicles.filter((v) => s.typeIds.includes(v.vehicle_type)).length;
      const key = keyOf(info.education);
      const trained = info.education ? people.filter((p) => key && p.keys.includes(key)).length : null;
      return { ...s, typeId, info, unlocked, next, owned, key, trained };
    });

    const idleTrained = findIdleTrained({ stations, people, vehicles, typeInfo, keyOf });

    return { stations, stationRows, people, vehicles, typeInfo, specialistVehicles, specialtyRows, idleTrained, stationCount, keyOf, hasAcademy: buildings.some((b) => b.building_type === FIRE_ACADEMY_TYPE) };
  }

  function initPersonnelPanel() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary btn-sm';
    button.style.cssText = 'position:fixed;left:100px;bottom:12px;z-index:9999;box-shadow:0 2px 6px rgba(0,0,0,.3);';
    button.innerHTML = '👷 Personeel <span class="badge" style="display:none"></span>';
    const badge = button.querySelector('.badge');

    const panel = document.createElement('div');
    panel.className = 'panel panel-default';
    panel.style.cssText =
      'position:fixed;left:12px;bottom:52px;z-index:10000;width:480px;max-width:calc(100vw - 24px);max-height:75vh;overflow:auto;display:none;box-shadow:0 4px 16px rgba(0,0,0,.35);font-size:13px;';
    panel.innerHTML = `
      <div class="panel-heading" style="display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:1">
        <b>👷 Personeel & opleidingen</b>
        <span><a href="#" class="mks-refresh" title="Vernieuwen">↻</a><a href="#" class="mks-close" title="Sluiten" style="margin-left:10px">✕</a></span>
      </div>
      <div class="panel-body" style="padding:8px 10px"></div>`;
    const body = panel.querySelector('.panel-body');
    document.body.append(panel, button);

    const isOpen = () => panel.style.display !== 'none';
    button.addEventListener('click', () => {
      panel.style.display = isOpen() ? 'none' : 'block';
      if (isOpen()) render();
    });
    panel.querySelector('.mks-close').addEventListener('click', (e) => {
      e.preventDefault();
      panel.style.display = 'none';
    });
    panel.querySelector('.mks-refresh').addEventListener('click', (e) => {
      e.preventDefault();
      invalidatePersonnel();
      render();
    });

    const el = (html) => {
      const div = document.createElement('div');
      div.innerHTML = html;
      return div;
    };
    const section = (title, content, open) => {
      const d = document.createElement('details');
      d.open = open;
      d.style.marginBottom = '8px';
      d.innerHTML = `<summary style="cursor:pointer;font-weight:bold;margin-bottom:4px">${title}</summary>`;
      d.append(content);
      return d;
    };
    const short = shortPost;
    const actionButton = (label, onClick, cls = 'btn-success', confirmText = null) =>
      makeActionButton(label, onClick, {
        cls,
        confirmText,
        onDone: () => {
          invalidatePersonnel(); // data changed: next render must refetch
          setTimeout(render, 900);
        },
      });
    const row = makeRow;

    async function updateBadge() {
      try {
        const data = await analysePersonnel();
        const problems = data.specialistVehicles.filter((s) => s.boundHere.length < s.need || s.overBound).length;
        const missingSpecialists = data.specialtyRows.filter((s) => s.unlocked.length && !s.owned).length;
        const total = problems + missingSpecialists;
        badge.textContent = total;
        badge.style.display = total ? 'inline-block' : 'none';
      } catch (e) {
        console.error('[MKS→HA] Personnel badge failed', e);
      }
    }
    setTimeout(updateBadge, 4000);
    setInterval(updateBadge, 15 * 60e3);

    async function render() {
      body.innerHTML = '<em>Personeel ophalen… (alle posten)</em>';
      try {
        const data = await analysePersonnel();
        const transfer = await loadTransferInfo(data.stations[0].id);
        body.innerHTML = '';
        body.append(
          section('📊 Overzicht', renderOverview(data, transfer), true),
          section(`🔁 Personeel verplaatsen (nog ${transfer.remaining} deze week)`, renderTransfers(data, transfer), true),
          section('🚒 Specialistische voertuigen', renderSpecialistVehicles(data, transfer), true),
          section('🎓 Specialisaties, opleiden & nieuwe meldingen', renderSpecialties(data, transfer), true),
          section('🏠 Personeel per post', renderStations(data), false)
        );
        updateBadge();
      } catch (e) {
        console.error('[MKS→HA] Personnel panel failed', e);
        body.innerHTML = `<div class="alert alert-danger">Laden mislukt: ${escapeHtml(e.message)}</div>`;
      }
    }

    /* ---- Overview ---- */
    function renderOverview(data, transfer) {
      const perEducation = {};
      data.people.forEach((p) => p.education && (perEducation[p.education] = (perEducation[p.education] || 0) + 1));
      const totalCrew = data.stationRows.reduce((n, s) => n + s.crewNeeded, 0);
      return el(`
        <div><b>${data.people.length}</b> personeel op <b>${data.stationCount}</b> posten · nodig voor volle bezetting: ${totalCrew}</div>
        <div>Opgeleid: ${
          Object.keys(perEducation).length
            ? Object.entries(perEducation)
                .map(([e, n]) => `<b>${escapeHtml(e)}</b> ${n}`)
                .join(' · ')
            : '<em>niemand</em>'
        }</div>
        <small class="text-muted">Verplaatsingen deze week: <b>${transfer.remaining}</b> · een post houdt minimaal ${MIN_STATION_PERSONNEL} personeel · verplaatsen is niet terug te draaien</small>`);
    }

    /* ---- Personnel transfers: suggestions + manual ---- */
    function renderTransfers(data, transfer) {
      const wrap = el('');
      const untrainedFree = (row) => row.staff.filter((p) => !p.keys.length && !p.boundVehicleId);
      const movable = (row, includeTrained) =>
        Math.max(0, Math.min(row.staff.length - MIN_STATION_PERSONNEL, (includeTrained ? row.staff.filter((p) => !p.boundVehicleId) : untrainedFree(row)).length));

      // Suggestions (surplus -> shortage, nearest first)
      const { transfers } = planRedistribution(data);
      const suggestions = transfers.filter((t) => t.from && t.people.length);
      const shortages = transfers.filter((t) => !t.from);
      if (!suggestions.length && !shortages.length) wrap.append(el('<small class="text-muted">Geen tekorten: alle posten hebben genoeg personeel voor hun voertuigen.</small>'));
      suggestions.forEach((t) =>
        wrap.append(
          row(
            `➡️ <b>${t.people.length}</b> van <b>${short(t.from.caption)}</b> naar <b>${short(t.to.caption)}</b><br><small class="text-muted">${escapeHtml(
              t.people.map((p) => p.name).join(', ')
            )} · zonder opleiding, niet gekoppeld</small>`,
            actionButton(
              'Verplaats',
              () => transferPersonnel(t.to.id, t.people.map((p) => p.id)),
              'btn-warning',
              `${t.people.length} personeel van ${t.from.caption.trim()} naar ${t.to.caption.trim()} verplaatsen?\n\nDit kan NIET ongedaan worden.`
            )
          )
        )
      );
      shortages.forEach((t) => wrap.append(el(`<div style="margin-bottom:4px">⚠️ <b>${short(t.to.caption)}</b> <small>nog ${t.missing} tekort, niemand over: start werving</small></div>`)));

      // Manual transfer
      const options = data.stationRows
        .map((r) => `<option value="${r.station.id}">${short(r.station.caption)} (${r.staff.length}, nodig ${r.crewNeeded})</option>`)
        .join('');
      const manual = el(`
        <div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(128,128,128,.3)">
          <b>Zelf verplaatsen</b>
          <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:4px">
            <select class="form-control input-sm mks-from" style="width:auto;max-width:100%">${options}</select>
            <span>→</span>
            <select class="form-control input-sm mks-to" style="width:auto;max-width:100%">${options}</select>
            <input type="number" min="1" value="1" class="form-control input-sm mks-count" style="width:64px">
            <label style="font-weight:normal;margin:0"><input type="checkbox" class="mks-trained"> ook opgeleiden</label>
          </div>
          <small class="mks-hint text-muted"></small>
        </div>`);
      const from = manual.querySelector('.mks-from');
      const to = manual.querySelector('.mks-to');
      const count = manual.querySelector('.mks-count');
      const trained = manual.querySelector('.mks-trained');
      const hint = manual.querySelector('.mks-hint');
      if (data.stationRows[1]) to.value = String(data.stationRows[1].station.id);

      const update = () => {
        const r = data.stationRows.find((x) => String(x.station.id) === from.value);
        const max = Math.min(movable(r, trained.checked), transfer.remaining);
        count.max = String(Math.max(1, max));
        hint.textContent =
          from.value === to.value
            ? 'Kies twee verschillende posten.'
            : `Max. ${max} te verplaatsen (post houdt min. ${MIN_STATION_PERSONNEL}, ${trained.checked ? 'niet gekoppeld' : 'zonder opleiding, niet gekoppeld'}, ${transfer.remaining} verplaatsingen over)`;
        go.style.display = max > 0 && from.value !== to.value ? '' : 'none';
      };
      const go = actionButton(
        'Verplaats',
        async () => {
          const r = data.stationRows.find((x) => String(x.station.id) === from.value);
          const pool = trained.checked ? r.staff.filter((p) => !p.boundVehicleId) : untrainedFree(r);
          // Untrained first, so trained people only move when really needed
          pool.sort((a, b) => a.keys.length - b.keys.length);
          const n = Math.min(Number(count.value) || 0, movable(r, trained.checked), transfer.remaining);
          if (n <= 0) throw new Error('niets te verplaatsen');
          const target = data.stationRows.find((x) => String(x.station.id) === to.value);
          if (!window.confirm(`${n} personeel van ${r.station.caption.trim()} naar ${target.station.caption.trim()} verplaatsen?\n\nDit kan NIET ongedaan worden.`)) return 'cancel';
          return transferPersonnel(Number(to.value), pool.slice(0, n).map((p) => p.id));
        },
        'btn-warning'
      );
      manual.firstElementChild.append(go);
      [from, to, trained].forEach((x) => x.addEventListener('change', update));
      update();
      wrap.append(manual);
      return wrap;
    }

    /* ---- Specialist vehicles ---- */
    function renderSpecialistVehicles(data, transfer) {
      const wrap = el('');
      if (!data.specialistVehicles.length) {
        wrap.append(el('<em>Je hebt nog geen voertuigen die een opleiding vereisen.</em>'));
        return wrap;
      }
      const crewPlan = planSpecialistCrew(data, transfer.remaining);
      data.specialistVehicles.forEach((s) => {
        const v = s.vehicle;
        const base = `<b>${short(v.caption)}</b> <small class="text-muted">· ${short(s.station.caption)} · vereist ${escapeHtml(
          s.info.education
        )}</small><br>`;

        // Too many bound (more than the vehicle can carry)
        if (s.overBound) {
          // Unbind the untrained ones first, then surplus trained ones
          const boundToVehicle = data.people.filter((p) => p.boundVehicleId === v.id);
          const extra = [...boundToVehicle.filter((p) => !p.keys.includes(s.key)), ...boundToVehicle.filter((p) => p.keys.includes(s.key))].slice(0, s.overBound);
          wrap.append(
            row(
              `⚠️ ${base}<small>${s.overBound} persoon/personen te veel gekoppeld (max ${s.full}). Ontkoppelen maakt ze vrij voor andere voertuigen.</small>`,
              actionButton(`Ontkoppel ${extra.length}`, async () => {
                for (const p of extra) await unbindPerson(v.id, p.id);
              })
            )
          );
        }

        if (s.boundHere.length >= s.need) {
          if (!s.overBound) wrap.append(row(`✅ ${base}<small>${s.boundHere.length}/${s.full} opgeleid en gekoppeld</small>`));
          return;
        }
        const missing = s.need - s.boundHere.length;

        // Free qualified people at this station: bind them
        if (s.free.length) {
          const pick = s.free.slice(0, Math.min(s.full - s.boundHere.length, s.free.length));
          wrap.append(
            row(
              `🟡 ${base}<small>${s.free.length} opgeleid maar niet gekoppeld: een TS kan ze meenemen. Koppelen reserveert ze.</small>`,
              actionButton(`Koppel ${pick.map((p) => p.name).join(', ')}`, async () => {
                for (const p of pick) await bindPerson(v.id, p.id);
              })
            )
          );
          return;
        }

        // Qualified people bound to a vehicle that doesn't need them: rebind
        if (s.misbound.length) {
          const pick = s.misbound.slice(0, missing);
          const from = pick.map((p) => `${p.name} (nu op ${short(data.vehicles.find((x) => x.id === p.boundVehicleId)?.caption || '?')})`).join(', ');
          wrap.append(
            row(
              `🟠 ${base}<small>Opgeleid personeel zit op een ander voertuig: ${from}</small>`,
              actionButton('Herkoppel', async () => {
                for (const p of pick) {
                  if (p.boundVehicleId > 0) await unbindPerson(p.boundVehicleId, p.id);
                  await bindPerson(v.id, p.id);
                }
              })
            )
          );
          return;
        }

        // Nobody here: move trained people from a post that can spare them (un-binds them first when needed)
        const move = crewPlan.find((x) => x.type === 'transfer' && x.vehicle.id === v.id);
        if (move) {
          const pick = move.people;
          wrap.append(
            row(
              `❌ ${base}<small>Geen opgeleid personeel op deze post. ${pick.length}× ${escapeHtml(
                s.info.education
              )} beschikbaar in ${short(move.from.caption)}; ze worden daarna meteen op dit voertuig gekoppeld.</small>`,
              actionButton(
                `Verplaats ${pick.length}`,
                () => executeCrewStep(move),
                'btn-warning',
                `${pick.map((p) => p.name).join(', ')} van ${move.from.caption.trim()} naar ${s.station.caption.trim()} verplaatsen en op ${v.caption.trim()} koppelen?\n\nDit kan NIET ongedaan worden en kost ${pick.length} van je ${transfer.remaining} verplaatsingen deze week.`
              )
            )
          );
          return;
        }
        wrap.append(
          row(`❌ ${base}<small>Niemand met deze opleiding beschikbaar: zie "Opleiden" hieronder.</small>`)
        );
      });
      return wrap;
    }

    /* ---- Specialties, training and new missions ---- */
    function renderSpecialties(data, transfer) {
      const wrap = el('');
      const fmtCredits = (list) => (list.length ? Math.round(list.reduce((n, m) => n + m.credits, 0) / list.length).toLocaleString('nl-NL') : '0');

      data.specialtyRows.forEach((s) => {
        const info = s.info || {};
        const unlockedVehicle = !info.minStations || info.minStations <= data.stationCount;
        const nextMission = s.next[0];
        let status;
        let advice = '';

        if (!s.unlocked.length && !nextMission) return; // not used by fire missions

        if (s.owned) status = '✅';
        else if (s.unlocked.length) status = '❌';
        else status = '⏳';

        const missionLine = s.unlocked.length
          ? `${s.unlocked.length} meldingstype(s) vrijgespeeld (gem. ${fmtCredits(s.unlocked)} cr), bijv. ${escapeHtml(s.unlocked[0].name)}`
          : `nog geen meldingen`;
        const nextLine = nextMission
          ? ` · bij <b>${nextMission.stations}</b> posten: ${escapeHtml(nextMission.name)}`
          : '';

        if (!s.owned && s.unlocked.length) {
          if (!unlockedVehicle) advice = `Voertuig te koop vanaf ${info.minStations} posten.`;
          else if (info.education && !s.trained)
            advice = `Eerst opleiden: <b>${escapeHtml(info.education)}</b> (min. ${Math.max(1, info.minCrew || 0)}, vol ${info.maxCrew || '?'}).`;
          else if (info.education) {
            // Best station: most free qualified people, then a free parking slot
            const best = data.stationRows
              .map((r) => ({
                r,
                qualified: r.staff.filter((p) => s.key && p.keys.includes(s.key) && !p.boundVehicleId).length,
                freeSlot: r.station.level + 1 - r.own.length > 0,
              }))
              .filter((x) => x.qualified)
              .sort((a, b) => Number(b.freeSlot) - Number(a.freeSlot) || b.qualified - a.qualified || a.r.station.level - b.r.station.level)[0];
            advice = best
              ? `Koop een ${escapeHtml(info.name.split(' ')[0])} bij <b>${short(best.r.station.caption)}</b> (${best.qualified}× opgeleid${
                  best.freeSlot ? ', plek vrij' : ', eerst level omhoog of personeel verplaatsen naar een post met plek'
                }).`
              : `Je ${s.trained} opgeleide mensen zijn allemaal gekoppeld.`;
          } else advice = `Geen opleiding nodig: koop een ${escapeHtml(info.name?.split(' ')[0] || s.label)} (≈ ${(info.price || 0).toLocaleString('nl-NL')}).`;
        }

        wrap.append(
          el(`<div style="margin-bottom:6px">${status} <b>${escapeHtml(s.label)}</b> <small class="text-muted">· in bezit ${s.owned}${
            info.education ? ` · opgeleid ${s.trained ?? 0}` : ''
          }</small><br><small>${missionLine}${nextLine}</small>${advice ? `<br><small>👉 ${advice}</small>` : ''}</div>`)
        );
      });

      // Training options: with an academy the queue in the VRU panel says what to train next
      if (data.hasAcademy) {
        wrap.append(el('<small class="text-muted">🎓 Wat je hierna moet opleiden staat in het VRU-paneel, sectie Opleidingen.</small>'));
        return wrap;
      }
      wrap.append(
        el(`<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(128,128,128,.3)">
          <b>Opleiden kan via:</b>
          <ul style="margin:3px 0 0 16px;padding:0">
            <li>de <a href="/schoolings" class="lightbox-open">team-academie</a>: vraag in de teamchat om de cursus te openen</li>
            <li>direct opgeleid personeel aannemen op het wervingsscherm van een post${
              transfer.hireTrainedPrice ? ` (${transfer.hireTrainedPrice} coins per persoon)` : ''
            }</li>
            <li>een eigen Brandweer-academie (≈ 500.000 credits)</li>
          </ul></div>`)
      );
      return wrap;
    }

    /* ---- Per station ---- */
    function renderStations(data) {
      const wrap = el('');
      data.stationRows.forEach((r) => {
        const shortage = r.staff.length < r.crewNeeded;
        const edu = Object.entries(r.perEducation)
          .map(([e, n]) => `${escapeHtml(e)} ${n}`)
          .join(', ');
        wrap.append(
          el(
            `<div style="margin-bottom:3px">${shortage ? '⚠️' : '•'} <b>${short(r.station.caption)}</b> <small class="text-muted">${r.staff.length} personeel · nodig ${
              r.crewNeeded
            }${edu ? ` · ${edu}` : ''}${r.transferable ? ` · ${r.transferable} verplaatsbaar` : ''}</small></div>`
          )
        );
      });
      return wrap;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Development plan: upgrades, purchases, new stations + personnel     */
  /* ------------------------------------------------------------------ */

  // Price of one level step (measured on the expand pages, Nov 2026)
  const levelStepPrice = (level) => (level === 0 ? 10000 : level === 1 ? 50000 : 100000);
  const maxLevel = (building) => (building.small_building ? 5 : 23);
  // How valuable a vehicle kind is: share of your fire missions that need it (SW serves as water tanker)
  const PLAN_WEIGHT = { ...NEED_WEIGHT, SW: NEED_WEIGHT.WT };

  /**
   * Station extensions worth it for a fire-only player (the others only unlock missions that
   * also need police/ambulance buildings). Missions are counted live from einsaetze.json.
   */
  // `match`: recognises the extension's vehicle in "Missende voertuigen" texts / requirement keys you missed
  const PLAN_EXTENSIONS = [
    // Real VRU posts (Brandbase regio 09, Nov 2026): Rietdak Brandbestrijdingsteamvoertuig / Veetakel Installatie
    { typeId: 26, key: 'thatched_fire', name: 'Rietkapbrandbestrijding', price: 150000, days: 5, vehicle: 'DB-RI of RIA', vehicleTypeId: 153, stations: ['06', '37', '58', '61'], match: /riet|thatch|\bDB-RI\b|\bRIA\b/i },
    { typeId: 27, key: 'livestock_fire', name: 'Veetakels', price: 150000, days: 5, vehicle: 'DB-VI', vehicleTypeId: 155, stations: ['21', '23', '29'], match: /veetakel|livestock|\bDB-VI\b/i },
    // Added Nov 2026. All 484 missions asking for the robot also need police + ambulance buildings, so for a fire-only
    // player it counts 0 mission types and never enters the plan; it only does once you actually miss one. Not in the real VRU (Brandbase).
    { typeId: 28, key: 'fire_extinguisher_robot', name: 'Blusrobot', price: 100000, days: 5, vehicle: 'DB-BRB + BMH-BRB', vehicleTypeId: 157, stations: [], match: /blusrobot|\bBRB\b|extinguisher_robot/i },
  ];

  // Own fire academy: train specialists yourself instead of waiting for the team academy
  const ACADEMY_PRICE = 500000;
  // Extensions whose missions pay less than this on average do not repay extension + vehicle + training: rank them low
  const LOW_YIELD_CREDITS = 3000;

  /** Building type id of the fire academy, read from the build menu (cached 7 days). */
  async function loadAcademyType() {
    const cached = memRead('mks_academy_type_v1', null);
    if (cached && Date.now() - cached.ts < 7 * 86400e3) return cached.data;
    const doc = await fetchDoc('/buildings/new');
    const option = [...doc.querySelectorAll('select[name="building[building_type]"] option')].find((o) =>
      /academie|school|opleiding/i.test(o.textContent)
    );
    const data = option ? { typeId: Number(option.value), name: option.textContent.trim() } : null;
    memWrite('mks_academy_type_v1', { ts: Date.now(), data });
    return data;
  }

  /** Missions (last 14 days) that asked for something matching `re` while you had none. */
  const missesMatching = (stats, re) =>
    Object.entries(stats).reduce((n, [name, missions]) => (re.test(name) ? Math.max(n, missions) : n), 0);

  /** Mission types an extension unlocks (only fire prerequisites, within your station count), cached 24 h. */
  async function loadExtensionMissionStats(stationCount) {
    const cached = memRead('mks_plan_ext_v1', null);
    if (cached && cached.stations === stationCount && Date.now() - cached.ts < 24 * 3600e3) return cached.data;
    const types = await loadMissionCatalog();
    const data = {};
    PLAN_EXTENSIONS.concat([{ key: 'brush_extension' }]).forEach(({ key }) => {
      const list = types.filter((t) => {
        const p = t.prerequisites || {};
        return p[key] === 1 && (p.fire_stations || 0) <= stationCount && Object.keys(p).every((k) => [key, 'fire_stations', 'main_building'].includes(k));
      });
      data[key] = {
        count: list.length,
        avgCredits: list.length ? Math.round(list.reduce((n, t) => n + (t.average_credits || 0), 0) / list.length) : 0,
        names: list.map((t) => t.name),
      };
    });
    memWrite('mks_plan_ext_v1', { ts: Date.now(), stations: stationCount, data });
    return data;
  }

  /** Is anyone trained for the vehicle an extension brings? Without them it never leaves the station. */
  function extensionEducation(data, ext) {
    const education = data.typeInfo?.[ext.vehicleTypeId]?.education;
    if (!education) return null;
    const key = data.keyOf ? data.keyOf(education) : null;
    return { education, trained: key ? (data.people || []).filter((p) => p.keys.includes(key)).length : 0 };
  }

  /** Educations (e.g. for DB-RI, DB-VI) nobody has yet, for extensions you have missions for. Shared by the plan and the training queue. */
  function untrainedExtensionNeeds(data, notOwned) {
    return PLAN_EXTENSIONS.map((ext) => ({ ext, edu: extensionEducation(data, ext), stats: data.extensionStats?.[ext.key] }))
      .filter((x) => x.edu && !x.edu.trained && ((x.stats?.count || 0) || missesMatching(notOwned, x.ext.match)))
      .map((x) => ({
        name: x.ext.name,
        education: x.edu.education,
        minCrew: data.typeInfo[x.ext.vehicleTypeId].minCrew,
        maxCrew: data.typeInfo[x.ext.vehicleTypeId].maxCrew,
        count: x.stats?.count || 1,
        missed: missesMatching(notOwned, x.ext.match) || 0,
      }));
  }

  /**
   * Greedy plan: repeatedly takes the step with the most value per credit, while simulating
   * levels, parking slots, crew and personnel so later steps stay realistic.
   */
  function buildDevelopmentPlan(data, buildings, maxSteps = 15) {
    const { typeInfo, stationRows, specialtyRows } = data;
    const crewOf = (typeId) => typeInfo[typeId]?.maxCrew || 3;
    const priceOf = (typeId) => typeInfo[typeId]?.price || VEHICLE_PRICES[typeId] || DEFAULT_VEHICLE_PRICE;

    // Kinds you keep running short of weigh heavier (learned in the mission window)
    const boost = shortageWeights();
    const weightOf = (label) => (PLAN_WEIGHT[label] || 1) + (boost[label] || 0);

    // Simulation state per built station
    const owned = countLabels(data.vehicles);
    const sim = stationRows.map((r) => {
      const status = stationStatus(r.station, data.vehicles);
      const queue = [...status.missing].sort(
        (a, b) => weightOf(labelOf(b[1])) - weightOf(labelOf(a[1]))
      );
      return {
        station: r.station,
        code: status.code,
        level: r.station.level,
        used: r.own.length,
        staff: r.staff.length,
        crewNeeded: r.crewNeeded,
        hiring: r.station.hiring_phase,
        queue,
        free: (r.staff.length || 0) - Math.max(MIN_STATION_PERSONNEL, r.crewNeeded), // spare people
      };
    });

    /** Personnel advice when a station needs `crew` more people. Reserves donors in the simulation. */
    const personnelFor = (s, crew) => {
      const shortage = s.crewNeeded + crew - s.staff;
      if (shortage <= 0) return { ok: true, text: `personeel ok (${s.staff}/${s.crewNeeded + crew})` };
      // Take spare people from the stations with the most surplus until the shortage is covered
      const fromDonors = [];
      let remaining = shortage;
      sim
        .filter((d) => d !== s && d.free > 0)
        .sort((a, b) => b.free - a.free)
        .forEach((d) => {
          if (remaining <= 0) return;
          const take = Math.min(d.free, remaining);
          d.free -= take;
          remaining -= take;
          fromDonors.push(`${take} van ${d.station.caption.trim().replace(`${CONFIG.vru.prefix} `, '')}`);
        });
      const hire = s.hiring ? `werving loopt nog ${s.hiring}d` : 'start 3 dagen werving';
      return {
        ok: false,
        shortage,
        text: `${shortage} personeel tekort (${s.staff}/${s.crewNeeded + crew}): ${hire}${fromDonors.length ? ` of verplaats ${fromDonors.join(' + ')}` : ''}`,
      };
    };

    const notOwned = notOwnedStats();
    const academy = data.academy || null; // { typeId, name, owned }

    const educationOf = (ext) => extensionEducation(data, ext);
    const extensionTraining = untrainedExtensionNeeds(data, notOwned).map((x) => ({
      label: x.name,
      info: { education: x.education, minCrew: x.minCrew, maxCrew: x.maxCrew },
      unlocked: new Array(x.count).fill(0),
      extension: true,
    }));
    const pendingTraining = specialtyRows
      .filter((sp) => sp.unlocked.length && !sp.owned && sp.info?.education && !sp.trained)
      .concat(extensionTraining);

    const steps = [];
    const plannedSpecialties = new Set();
    const unbuilt = rankUnbuiltStations(buildings, data.vehicles).slice(0, 6);
    let stationsInPlan = countFireStations(buildings); // grows with every planned station: next one costs more

    for (let n = 0; n < maxSteps; n++) {
      const candidates = [];

      // 1. Next VRU vehicle per built station (buy in free slot, or level up first)
      sim.forEach((s) => {
        const next = s.queue[0];
        if (!next) return;
        const [suffix, typeId] = next;
        const needsLevel = s.used >= s.level + 1;
        if (needsLevel && s.level >= maxLevel(s.station)) return;
        const cost = (needsLevel ? levelStepPrice(s.level) : 0) + priceOf(typeId);
        const label = labelOf(typeId);
        const value = weightOf(label) / Math.sqrt(1 + (owned[label] || 0));
        candidates.push({ kind: 'vehicle', s, suffix, typeId, label, needsLevel, cost, value, short: !!boost[label] });
      });

      // 2. Specialist vehicles that unlock missions (AGS, AB, …), only where trained people are
      specialtyRows
        .filter((sp) => sp.unlocked.length && !sp.owned && !plannedSpecialties.has(sp.key) && sp.info?.name)
        .forEach((sp) => {
          const needsEducation = !!sp.info.education;
          if (needsEducation && !sp.trained) return; // training first: listed separately
          const best = sim
            .map((s) => {
              const row = stationRows.find((r) => r.station.id === s.station.id);
              const qualified = needsEducation ? row.staff.filter((p) => sp.key && p.keys.includes(sp.key) && !p.boundVehicleId).length : 99;
              return { s, qualified, freeSlot: s.used < s.level + 1 };
            })
            .filter((x) => x.qualified > 0 && (x.freeSlot || x.s.level < maxLevel(x.s.station)))
            .sort((a, b) => Number(b.freeSlot) - Number(a.freeSlot) || b.qualified - a.qualified || a.s.level - b.s.level)[0];
          if (!best) return;
          const needsLevel = !best.freeSlot;
          const cost = (needsLevel ? levelStepPrice(best.s.level) : 0) + priceOf(sp.typeId);
          const value = 6 + sp.unlocked.length * 2.5; // each unlocked mission type adds value
          candidates.push({ kind: 'specialist', s: best.s, sp, typeId: sp.typeId, label: sp.label, needsLevel, cost, value, qualified: best.qualified });
        });

      // 3. Station extensions that unlock new missions (own parking slot: no level needed)
      PLAN_EXTENSIONS.forEach((ext) => {
        const stats = data.extensionStats?.[ext.key] || { count: 0, avgCredits: 0, names: [] };
        const missed = missesMatching(notOwned, ext.match);
        if ((!stats.count && !missed) || ext.planned) return;
        if (buildings.some((b) => (b.extensions || []).some((e) => e.type_id === ext.typeId))) return; // already built/being built
        // A built VRU post of this extension; none built yet → least used station (note says where it belongs)
        const station =
          ext.stations.map((c) => sim.find((s) => s.code === c)).find(Boolean) || [...sim].sort((a, b) => a.used - b.used)[0];
        if (!station) return;
        const cost = ext.price + DEFAULT_VEHICLE_PRICE; // + its vehicle
        // Missions you actually get but can't finish weigh most: each one is lost credits
        const lowYield = stats.avgCredits > 0 && stats.avgCredits < LOW_YIELD_CREDITS;
        const value = lowYield
          ? 3 + stats.count * 0.5 + Math.min(10, missed * 1.5)
          : 6 + stats.count * 2.5 * Math.min(1.5, stats.avgCredits / 1500) + Math.min(40, missed * 4);
        const edu = educationOf(ext);
        // Nobody trained yet: the vehicle would stand idle, so train first (academy/training list) and rank it lower
        candidates.push({ kind: 'extension', ext, stats, missed, s: station, cost, value: edu && !edu.trained ? value * 0.5 : value, edu, lowYield });
      });

      // 3b. Own academy: when specialists wait for training (each one unlocks missions)
      if (academy && !academy.owned && !academy.planned && pendingTraining.length) {
        const unlocks = pendingTraining.reduce((n, sp) => n + sp.unlocked.length, 0);
        candidates.push({ kind: 'academy', cost: ACADEMY_PRICE, value: 6 + unlocks * 2.5, trainings: pendingTraining });
      }

      // 4. New stations (coverage), best-ranked first
      unbuilt.forEach((u, i) => {
        if (u.planned) return;
        candidates.push({ kind: 'station', u, cost: stationBuildPrice(stationsInPlan), value: Math.max(4, 14 - i * 2) });
      });

      if (!candidates.length) break;
      const pick = candidates.sort((a, b) => b.value / b.cost - a.value / a.cost)[0];

      // Apply to the simulation
      if (pick.kind === 'academy') {
        academy.planned = true;
        steps.push({ ...pick, personnel: { ok: true, text: 'daarna zelf opleiden; cursisten komen van je eigen posten' } });
        continue;
      }
      if (pick.kind === 'extension') {
        pick.ext.planned = true;
        const untrained = pick.edu && !pick.edu.trained;
        steps.push({
          ...pick,
          personnel: untrained
            ? { ok: false, text: `niemand opgeleid als ${pick.edu.education}: eerst opleiden, anders rijdt de ${pick.ext.vehicle} niet uit` }
            : { ok: true, text: `daarna ${pick.ext.vehicle} kopen (eigen parkeerplek)` },
        });
        continue;
      }
      if (pick.kind === 'station') {
        pick.u.planned = true;
        stationsInPlan += 1;
        steps.push({ ...pick, personnel: { ok: true, text: 'nieuwe post start met ±10 personeel; 3 dagen werving gaat automatisch' } });
        continue;
      }
      const s = pick.s;
      const fromLevel = s.level;
      if (pick.needsLevel) s.level += 1;
      s.used += 1;
      const crew = crewOf(pick.typeId);
      const personnel = personnelFor(s, crew);
      s.crewNeeded += crew;
      owned[pick.label] = (owned[pick.label] || 0) + 1;
      if (pick.kind === 'vehicle') s.queue.shift();
      if (pick.kind === 'specialist') {
        plannedSpecialties.add(pick.sp.key);
        personnel.text += ` · koppel ${pick.qualified > 1 ? 'je opgeleide mensen' : 'je opgeleide persoon'} via 👷`;
      }
      steps.push({ ...pick, fromLevel, personnel });
    }

    // Training needed before some specialists can be bought
    const training = specialtyRows
      .filter((sp) => sp.unlocked.length && !sp.owned && sp.info?.education && !sp.trained)
      .map((sp) => ({ sp, education: sp.info.education, need: Math.max(1, sp.info.minCrew || 0), full: sp.info.maxCrew }))
      .concat(extensionTraining.map((sp) => ({ sp, education: sp.info.education, need: Math.max(1, sp.info.minCrew || 0), full: sp.info.maxCrew })));

    // Extensions that are built but switched off
    const notes = [];
    const shortStats = shortageStats();
    const shortText = Object.entries(shortStats)
      .filter(([cat]) => SHORTAGE_LABELS[cat])
      .sort((a, b) => b[1].missions - a[1].missions)
      .map(([cat, st]) => `${SHORTAGE_LABELS[cat][0]} ${st.missions}×`)
      .join(', ');
    if (shortText) notes.push(`🔥 Te kort gekomen (7 dagen, telt mee in de volgorde): <b>${escapeHtml(shortText)}</b>`);
    Object.entries(shortStats).forEach(([cat, st]) => {
      const labels = SHORTAGE_LABELS[cat];
      if (!labels || st.missions < 3) return;
      const vruSlotLeft = sim.some((x) => x.queue.some(([, t]) => labels.includes(labelOf(t))));
      if (!vruSlotLeft)
        notes.push(
          `⚠️ Alle VRU-plekken voor ${labels[0]} zijn al gevuld en je komt er nog steeds te kort: bouw een nieuwe post (komt met een TS) of koop een extra ${labels[0]} op een post met een vrije plek.`
        );
    });
    buildings.forEach((b) =>
      (b.extensions || []).forEach((e) => {
        if (e.available && !e.enabled)
          notes.push(
            `⏸️ <b>${escapeHtml(e.caption)}</b> op ${escapeHtml(b.caption.trim().replace(`${CONFIG.vru.prefix} `, ''))} staat uit${
              e.type_id === 15
                ? ': pas aanzetten als je een natuurbrandvoertuig (DA-LA-NB, VW-NB of NBH) hebt'
                : PLAN_EXTENSIONS.some((x) => x.typeId === e.type_id)
                  ? (() => {
                      const edu = educationOf(PLAN_EXTENSIONS.find((x) => x.typeId === e.type_id));
                      return edu && !edu.trained
                        ? ` — nog <b>niemand opgeleid als ${escapeHtml(edu.education)}</b>: eerst opleiden, dan pas aanzetten (anders rijdt het voertuig niet uit)`
                        : ' — <b>bewust?</b> Een uitgezette uitbreiding doet niet mee; aanzetten via het gebouw → uitbreidingen';
                    })()
                  : ''
            }`
          );
      })
    );
    // Worthwhile extensions that did not make it into the top of the plan: still show them
    PLAN_EXTENSIONS.forEach((ext) => {
      const stats = data.extensionStats?.[ext.key] || { count: 0, avgCredits: 0 };
      const missed = missesMatching(notOwned, ext.match);
      if (ext.planned || (!stats.count && !missed)) return;
      if (buildings.some((b) => (b.extensions || []).some((e) => e.type_id === ext.typeId))) return;
      const station = ext.stations.map((c) => sim.find((x) => x.code === c)).find(Boolean);
      notes.push(
        `🧩 Later: <b>${escapeHtml(ext.name)}</b> (${formatCredits(ext.price)} + ${escapeHtml(ext.vehicle)}) op ${
          station ? escapeHtml(station.station.caption.trim().replace(`${CONFIG.vru.prefix} `, '')) : ext.stations.map((c) => `09-${c}`).join('/')
        } →${missed ? ` je miste hem ${missed}× (14 d)` : ''}${stats.count ? ` +${stats.count} meldingstypes, gem. ${formatCredits(stats.avgCredits)} cr` : ''}`
      );
    });
    // Everything else you keep missing (not solved by an extension): match it to the vehicle shop
    const otherMisses = Object.entries(notOwned)
      .filter(([name]) => !PLAN_EXTENSIONS.some((ext) => ext.match.test(name)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, missions]) => {
        const words = name.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 3);
        const shop = Object.values(data.typeInfo || {}).find((t) => words.some((w) => t.name?.toLowerCase().includes(w)));
        const how = shop
          ? ` → ${escapeHtml(shop.name)}${shop.education ? `, opleiding <i>${escapeHtml(shop.education)}</i>` : ''}${
              shop.minStations ? `, vanaf ${shop.minStations} posten` : ''
            }`
          : '';
        return `${escapeHtml(name)} ${missions}×${how}`;
      });
    if (otherMisses.length) notes.push(`🚫 Niet in je korps maar wel gevraagd (14 d): ${otherMisses.join(' · ')}`);
    if (academy && !academy.owned && !academy.planned && pendingTraining.length)
      notes.push(
        `🎓 Eigen ${escapeHtml(academy.name)} (≈ ${formatCredits(ACADEMY_PRICE)}): dan train je ${pendingTraining
          .map((sp) => escapeHtml(sp.info.education))
          .join(', ')} zelf, zonder op de team-academie te wachten`
      );
    PLAN_EXTENSIONS.forEach((ext) => delete ext.planned); // module-level list: reset for the next render
    return { steps, training, notes };
  }

  async function renderPlan(balance) {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<em>Plan berekenen (incl. personeel van alle posten)…</em>';

    (async () => {
      try {
        const [data, buildings] = await Promise.all([analysePersonnel(), fetchJson('/api/buildings')]);
        const stationCount = countFireStations(buildings);
        data.extensionStats ||= await loadExtensionMissionStats(stationCount).catch(() => ({}));
        const academyType = await loadAcademyType().catch(() => null);
        data.academy = academyType
          ? { ...academyType, owned: buildings.some((b) => b.building_type === academyType.typeId) }
          : null;
        const { steps, training, notes } = buildDevelopmentPlan(data, buildings);
        wrap.innerHTML = '';

        const open = (url) => () => {
          if (typeof unsafeWindow.lightboxOpen === 'function') unsafeWindow.lightboxOpen(url);
          else window.open(url, '_blank');
        };
        const linkButton = (label, onClick, cls = 'btn-default') => {
          const a = document.createElement('a');
          a.href = '#';
          a.className = `btn btn-xs ${cls}`;
          a.style.marginLeft = '4px';
          a.textContent = label;
          a.addEventListener('click', (e) => {
            e.preventDefault();
            onClick();
          });
          return a;
        };
        const short = shortPost;

        let cumulative = 0;
        // Greedy over the balance: a cheaper later step you can pay now is "kan nu",
        // even when an expensive step (a new station) comes first and needs saving for
        let remaining = balance;
        const nowSteps = [];
        const list = document.createElement('div');
        steps.forEach((step, i) => {
          cumulative += step.cost;
          const canNow = step.cost <= remaining;
          if (canNow) {
            remaining -= step.cost;
            nowSteps.push(i + 1);
          }

          let title;
          let detail;
          const buttons = [];
          if (step.kind === 'extension') {
            title = `🧩 <b>${short(step.s.station.caption)}</b>: uitbreiding <b>${escapeHtml(step.ext.name)}</b> (${step.ext.days} dagen)`;
            const why = [];
            if (step.missed) why.push(`<b>je miste hem ${step.missed}× in 14 dagen</b>`);
            if (step.lowYield) why.push('⚠️ <b>lage opbrengst</b>: verdient zich traag terug, doe dit pas als de rest staat');
            if (step.stats.count)
              why.push(
                `+${step.stats.count} meldingstypes, gem. ${formatCredits(step.stats.avgCredits)} cr (${escapeHtml(
                  step.stats.names.slice(0, 3).join(', ')
                )}…)`
              );
            detail = `${why.join(' · ')} · ${step.personnel.ok ? '👷' : '⚠️'} ${escapeHtml(step.personnel.text)}`;
            buttons.push(linkButton('Gebouw', open(`/buildings/${step.s.station.id}`)));
          } else if (step.kind === 'academy') {
            title = `🎓 Bouw een eigen <b>${escapeHtml(data.academy.name)}</b>`;
            detail = `zelf opleiden: ${step.trainings
              .map((sp) => `${escapeHtml(sp.info.education)} (${escapeHtml(sp.label)}, ${sp.unlocked.length} meldingstypes)`)
              .join(', ')} · 👷 ${escapeHtml(step.personnel.text)}`;
            buttons.push(linkButton('Bouwmenu', () => document.querySelector('a#build_new_building')?.click()));
          } else if (step.kind === 'station') {
            title = `🏗️ Bouw <b>09-${step.u.code} ${escapeHtml(step.u.name)}</b>`;
            detail = `brengt later ${step.u.specialists.length ? step.u.specialists.map(([, t]) => labelOf(t)).join(', ') : 'alleen TS'}`;
            buttons.push(
              linkButton('Bouwmenu', () => {
                storage.set('preselect_station', step.u.code);
                document.querySelector('a#build_new_building')?.click();
              })
            );
          } else {
            const s = step.s;
            const what =
              step.kind === 'specialist'
                ? `<b>${escapeHtml(step.sp.info.name.split(' ')[0])}</b> (${escapeHtml(step.label)}, ${step.qualified}× opgeleid)`
                : `<b>${escapeHtml(vehicleName(step.suffix, step.typeId).replace(`${CONFIG.vru.prefix} `, ''))}</b>${
                    step.short ? ' <span class="label label-danger" title="Hier kwam je de afgelopen 7 dagen vaak te kort">vaak te kort</span>' : ''
                  }`;
            title = `${step.needsLevel ? '⬆️' : '🚒'} <b>${short(s.station.caption)}</b>: ${
              step.needsLevel ? `level ${step.fromLevel}→${step.fromLevel + 1} + ` : ''
            }${what}`;
            detail = `${step.personnel.ok ? '👷 ' : '⚠️ '}${escapeHtml(step.personnel.text)}`;
            if (step.needsLevel) buttons.push(linkButton('Uitbouwen', open(`/buildings/${s.station.id}/expand`)));
            buttons.push(linkButton('Winkel', open(`/buildings/${s.station.id}/vehicles/new`)));
            if (!step.personnel.ok) buttons.push(linkButton('Werving', open(`/buildings/${s.station.id}/hire`), 'btn-warning'));
          }

          const row = document.createElement('div');
          row.style.cssText = `display:flex;justify-content:space-between;gap:6px;margin-bottom:6px;${canNow ? '' : 'opacity:.75'}`;
          row.dataset.mksStep = canNow ? 'now' : 'later'; // counted in the collapsed section header
          row.innerHTML = `<span>${i + 1}. ${title}<br><small class="text-muted">${formatCredits(step.cost)} · totaal ${formatCredits(cumulative)}${
            canNow ? ' · <span class="text-success"><b>kan nu</b></span>' : ''
          }</small><br><small>${detail}</small></span>`;
          const right = document.createElement('span');
          right.style.whiteSpace = 'nowrap';
          buttons.forEach((b) => right.append(b));
          row.append(right);
          list.append(row);
        });

        const intro = document.createElement('div');
        intro.innerHTML = `<small class="text-muted">Saldo ${formatCredits(balance)} · ${
          nowSteps.length
            ? `nu te doen: stap ${nowSteps.join(', ')} (${formatCredits(balance - remaining)})${nowSteps[0] !== 1 ? ' · daarna sparen voor stap 1' : ''}`
            : 'spaar voor stap 1'
        } · volgorde = meeste waarde per credit, rekening houdend met plekken, levels en personeel<br>Nieuwe post nu: ${formatCredits(
          stationBuildPrice(stationCount, true)
        )} (klein) / ${formatCredits(stationBuildPrice(stationCount, false))} (normaal) · elke post maakt de volgende duurder</small>${
          notes.length ? `<br><small>${notes.join('<br>')}</small>` : ''
        }`;
        intro.style.marginBottom = '6px';
        wrap.append(intro, list);

        if (training.length && data.academy?.owned) {
          const t = document.createElement('small');
          t.className = 'text-muted';
          t.textContent = `🎓 ${training.length} opleiding(en) nodig voor deze voertuigen: zie de sectie Opleidingen (wachtrij voor de academie).`;
          wrap.append(t);
        } else if (training.length) {
          const t = document.createElement('div');
          t.style.cssText = 'margin-top:4px;padding-top:6px;border-top:1px solid rgba(128,128,128,.3)';
          t.innerHTML = `<b>🎓 Eerst opleiden</b> (daarna komen deze voertuigen in het plan):<br>${training
            .map(
              (x) =>
                `<small>• <b>${escapeHtml(x.education)}</b> voor ${escapeHtml(x.sp.label)}: min. ${x.need}, vol ${x.full || '?'} · ${x.sp.unlocked.length} meldingstype(s)</small>`
            )
            .join('<br>')}<br><small class="text-muted">Via de team-academie, direct opgeleid aannemen (coins) of een eigen academie — zie 👷 Personeel.</small>`;
          wrap.append(t);
        }
      } catch (e) {
        console.error('[MKS→HA] Plan failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Plan mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();

    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /* Mission memory: learn what each mission type really needed          */
  /* ------------------------------------------------------------------ */

  const MEMORY_KEYS = { open: 'mks_mem_open_v1', types: 'mks_mem_types_v1' };
  const memRead = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
    } catch (e) {
      return fallback;
    }
  };
  const memWrite = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage full: memory is best-effort */
    }
  };

  // Requirement category -> AAO field / button attribute (from the game's AAO form)
  const AAO_KEY_BY_CATEGORY = {
    firetrucks: 'fire',
    platform_trucks: 'dlk',
    battalion_chief_vehicles: 'elw',
    mobile_command_vehicles: 'elw2',
    elw3: 'elw3',
    heavy_rescue_vehicles: 'rw',
    water_tankers: 'gwl2wasser',
    hazmat_vehicles: 'gwgefahrgut',
    gwmess: 'gwmesstechnik',
    mobile_air_vehicles: 'gwa',
  };
  const CATEGORY_LABELS = {
    firetrucks: 'TS',
    platform_trucks: 'AL',
    battalion_chief_vehicles: 'OvD',
    mobile_command_vehicles: 'HOvD',
    elw3: 'CO',
    heavy_rescue_vehicles: 'HV',
    water_tankers: 'WT/SL',
    hazmat_vehicles: 'AGS',
    gwmess: 'VEB',
    mobile_air_vehicles: 'AB',
  };
  const formatNeeds = (needs) =>
    Object.entries(needs)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n}× ${CATEGORY_LABELS[k] || k}`)
      .join(', ') || '—';

  /**
   * Stores what we saw of one open mission. Called on every look at the mission window and when dispatching.
   * used: everything assigned (+ selected) — required: on scene + "missing" per category, i.e. what the game really asked.
   */
  function rememberMissionSnapshot(missionId, snap) {
    const open = memRead(MEMORY_KEYS.open, {});
    const prev = open[missionId] || { used: {}, required: {} };
    const maxMerge = (a, b) => {
      const out = { ...a };
      Object.entries(b || {}).forEach(([k, v]) => (out[k] = Math.max(out[k] || 0, v)));
      return out;
    };
    open[missionId] = {
      typeId: snap.typeId,
      name: snap.name || prev.name,
      used: maxMerge(prev.used, snap.used),
      required: maxMerge(prev.required, snap.required),
      ts: Date.now(),
    };
    // Keep the store small: drop missions older than 3 days
    Object.keys(open).forEach((id) => {
      if (Date.now() - open[id].ts > 3 * 86400e3) delete open[id];
    });
    memWrite(MEMORY_KEYS.open, open);
  }

  /** Mission completed: fold its snapshot into the statistics of its type. */
  function finalizeMissionMemory(missionId) {
    const open = memRead(MEMORY_KEYS.open, {});
    const snap = open[missionId];
    if (!snap) return;
    delete open[missionId];
    memWrite(MEMORY_KEYS.open, open);

    const types = memRead(MEMORY_KEYS.types, {});
    const t = (types[snap.typeId] = types[snap.typeId] || { name: snap.name, n: 0, usedSum: {}, required: {}, requiredMax: {} });
    t.name = snap.name || t.name;
    t.n += 1;
    Object.entries(snap.used).forEach(([k, v]) => (t.usedSum[k] = (t.usedSum[k] || 0) + v));
    Object.entries(snap.required).forEach(([k, v]) => {
      if (v <= 0) return;
      t.required[k] = (t.required[k] || 0) + 1;
      t.requiredMax[k] = Math.max(t.requiredMax[k] || 0, v);
    });
    t.last = Date.now();
    memWrite(MEMORY_KEYS.types, types);
    log('Mission memory', snap.typeId, snap.name, t);
  }

  /**
   * Minimum per category for a mission type: official requirements (chance >= minChance)
   * plus categories the game asked for in at least 30% of your completed missions of this type.
   */
  function estimateMinimum(typeId, requirementsCache) {
    const req = requirementsCache?.[typeId];
    const official = {};
    const sometimes = [];
    if (req) {
      Object.entries(req.r).forEach(([k, v]) => {
        if (!CATEGORY_LABELS[k]) return;
        const chance = req.c[k];
        if (chance !== undefined && chance < CONFIG.minChance) sometimes.push({ k, chance, v });
        else official[k] = v;
      });
    }
    const stats = memoryTypesMerged()[typeId] || null; // all synced devices
    const min = { ...official };
    const learned = [];
    if (stats && stats.n >= 2) {
      Object.entries(stats.required).forEach(([k, times]) => {
        if (!CATEGORY_LABELS[k]) return;
        const rate = times / stats.n;
        const max = stats.requiredMax[k] || 1;
        if (rate >= 0.3 && max > (min[k] || 0)) {
          min[k] = max;
          learned.push(`${CATEGORY_LABELS[k]} (${times}/${stats.n}×)`);
        }
      });
    }
    const usual = stats?.n
      ? Object.fromEntries(Object.entries(stats.usedSum).map(([k, sum]) => [k, Math.round(sum / stats.n)]))
      : null;
    const stillSometimes = sometimes.filter((x) => !((min[x.k] || 0) > (official[x.k] || 0)));
    return { official, min, sometimes: stillSometimes, learned, stats, usual };
  }

  /** Best AAO for a minimum: covers everything with the least extra; else the one covering most. */
  function pickAao(min, aaos) {
    if (!Object.values(min).some((n) => n > 0)) return null;
    const scored = aaos.map((a) => {
      let missing = 0;
      let extra = 0;
      Object.keys(CATEGORY_LABELS).forEach((k) => {
        const have = a.counts[k] || 0;
        const need = min[k] || 0;
        if (have < need) missing += need - have;
        else extra += have - need;
      });
      return { a, missing, extra };
    });
    scored.sort((x, y) => x.missing - y.missing || x.extra - y.extra);
    return scored[0] || null;
  }

  /** AAO definitions: from the last mission window, else the game's AAO edit forms (cached 1 hour). */
  async function loadAaoDefinitions() {
    const fromWindow = memRead('mks_mem_aaos_win_v1', null); // read from the AAO buttons in a mission window
    if (fromWindow?.data?.length) return fromWindow.data;
    const cached = memRead('mks_mem_aaos_v1', null);
    if (cached && Date.now() - cached.ts < 3600e3) return cached.data;
    const list = await fetchDoc('/aaos');
    const ids = [...new Set([...list.querySelectorAll('a[href$="/edit"]')].map((a) => a.getAttribute('href').match(/\/aaos\/(\d+)\/edit/)?.[1]).filter(Boolean))];
    const data = [];
    for (const id of ids) {
      const form = (await fetchDoc(`/aaos/${id}/edit`)).querySelector('form');
      if (!form) continue;
      const value = (name) => Number(form.querySelector(`[name="aao[${name}]"]`)?.value || 0);
      const counts = {};
      Object.entries(AAO_KEY_BY_CATEGORY).forEach(([cat, key]) => (counts[cat] = value(key)));
      data.push({ id, caption: form.querySelector('[name="aao[caption]"]')?.value || `AAO ${id}`, counts });
    }
    memWrite('mks_mem_aaos_v1', { ts: Date.now(), data });
    return data;
  }

  /** Fire-only mission types available with your station count, cached 24 h. */
  async function loadFireMissionTypes() {
    const cached = memRead('mks_mem_firetypes_v1', null);
    if (cached && Date.now() - cached.ts < 24 * 3600e3) return cached.data;
    const types = await loadMissionCatalog();
    const data = types
      .filter((t) => {
        const p = t.prerequisites || {};
        return p.fire_stations && !p.main_building && p.fire_stations < 100 && Object.keys(p).every((k) => ['main_building', 'fire_stations'].includes(k));
      })
      .map((t) => ({ id: String(t.id), name: t.name, stations: t.prerequisites.fire_stations, credits: t.average_credits || 0, r: t.requirements || {}, c: t.chances || {} }));
    memWrite('mks_mem_firetypes_v1', { ts: Date.now(), data });
    return data;
  }

  // Extra AAOs for mobile, on top of "2. 2 TS" … "12. Groot + HOvD". Keys = AAO form fields.
  // "1. TS" is included: it was missing in the live account, so small missions got a bigger proposal.
  const EXTRA_AAOS = [
    { caption: '1. TS', color: '43a047', v: { fire: 1 } },
    { caption: '13. TS + OvD', color: '43a047', v: { fire: 1, elw: 1 } },
    { caption: '14. 3 TS', color: 'e53935', v: { fire: 3 } },
    { caption: '15. Zeer grote brand (4 TS, AL, OvD, WT)', color: 'b71c1c', v: { fire: 4, dlk: 1, elw: 1, gwl2wasser: 1 } },
    { caption: '16. Beknelling (2 TS, HV, OvD)', color: '1e88e5', v: { fire: 2, rw: 1, elw: 1 } },
    { caption: '17. Gevaarlijke stoffen (2 TS, OvD, AGS)', color: 'fdd835', v: { fire: 2, elw: 1, gwgefahrgut: 1 } },
    { caption: '18. GS + meten (2 TS, OvD, AGS, VEB)', color: 'f9a825', v: { fire: 2, elw: 1, gwgefahrgut: 1, gwmesstechnik: 1 } },
    { caption: '19. Rook/AB (2 TS, OvD, AB)', color: '6d4c41', v: { fire: 2, elw: 1, gwa: 1 } },
    { caption: '20. GRIP (4 TS, AL, OvD, HOvD, CO, WT)', color: '4a148c', v: { fire: 4, dlk: 1, elw: 1, elw2: 1, elw3: 1, gwl2wasser: 1 } },
    { caption: '21. Alleen AL/HW', color: '8e24aa', v: { dlk: 1 } },
    { caption: '22. Alleen OvD', color: '757575', v: { elw: 1 } },
    { caption: '23. Alleen WT/SL', color: '00838f', v: { gwl2wasser: 1 } },
    { caption: '24. Grote wateroverlast (2 TS, pomp 6000)', color: '0277bd', v: { fire: 2, water_damage_pump_value: 6000 } },
  ];

  /** Creates one AAO through the game's own "new" form (all defaults kept, only our fields changed). */
  async function createAao(def) {
    const doc = await fetchDoc('/aaos/new');
    const form = [...doc.forms].find((f) => /\/aaos\/?$/.test(f.getAttribute('action') || ''));
    if (!form) throw new Error('AAO-formulier niet gevonden');
    const fd = new FormData(form);
    // Empty number fields make the save fail silently: send 0
    form.querySelectorAll('input[type="number"]').forEach((i) => i.name && fd.set(i.name, i.value || '0'));
    form.querySelectorAll('input[type="checkbox"]').forEach((c) => {
      if (/\[(reset|automatic_text_color)\]/.test(c.name)) fd.set(c.name, '1');
    });
    fd.set('aao[caption]', def.caption);
    const colorField = form.querySelector('[name="aao[color]"]');
    if (colorField) fd.set('aao[color]', def.color); // without '#'
    const unknown = [];
    Object.entries(def.v).forEach(([key, n]) => {
      if (form.querySelector(`[name="aao[${key}]"]`)) fd.set(`aao[${key}]`, String(n));
      else unknown.push(key);
    });
    if (unknown.length) throw new Error(`velden onbekend: ${unknown.join(', ')}`);
    await fetch('/aaos', { method: 'POST', body: fd, credentials: 'include' });
  }

  /** Creates the extra AAOs that don't exist yet. Returns { created, skipped, failed }. */
  async function createExtraAaos(onProgress) {
    const existing = (await fetchDoc('/aaos')).body.textContent.replace(/\s+/g, ' ');
    const result = { created: [], skipped: [], failed: [] };
    for (const def of EXTRA_AAOS) {
      if (existing.includes(def.caption)) {
        result.skipped.push(def.caption);
        continue;
      }
      onProgress?.(def.caption);
      try {
        await createAao(def);
        result.created.push(def.caption);
      } catch (e) {
        result.failed.push(`${def.caption}: ${e.message}`);
      }
    }
    // Verify against the list, the POST itself says nothing useful
    const after = (await fetchDoc('/aaos')).body.textContent.replace(/\s+/g, ' ');
    result.created = result.created.filter((c) => {
      if (after.includes(c)) return true;
      result.failed.push(`${c}: niet opgeslagen`);
      return false;
    });
    localStorage.removeItem('mks_mem_aaos_v1');
    localStorage.removeItem('mks_mem_aaos_win_v1');
    return result;
  }

  /** VRU panel section: proposal per mission type, searchable, exportable for mobile. */
  async function renderMissionMemory() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<em>Meldingstypes en inzetvoorstellen laden…</em>';

    (async () => {
      try {
        const [fireTypes, aaos, buildings] = await Promise.all([loadFireMissionTypes(), loadAaoDefinitions(), fetchJson('/api/buildings')]);
        const stationCount = buildings.filter((b) => b.building_type === 0).length;
        const reqCache = Object.fromEntries(fireTypes.map((t) => [t.id, { r: t.r, c: t.c }]));
        const memory = memoryTypesMerged(); // all synced devices

        const rows = fireTypes
          .filter((t) => t.stations <= stationCount)
          .map((t) => {
            const est = estimateMinimum(t.id, reqCache);
            const best = pickAao(est.min, aaos);
            return { t, est, best, seen: memory[t.id]?.n || 0 };
          })
          .sort((a, b) => b.seen - a.seen || a.t.name.localeCompare(b.t.name));

        const learnedCount = rows.filter((r) => r.est.learned.length).length;
        const seenCount = rows.filter((r) => r.seen).length;
        wrap.innerHTML = `
          <small class="text-muted">${rows.length} meldingstypes · ${seenCount} al gezien en afgerond · ${learnedCount} bijgesteld door wat je zag · minimum = officieel (≥${CONFIG.minChance}% kans) + wat het spel in ≥30% van jouw meldingen extra vroeg</small>
          <div style="display:flex;gap:4px;margin:4px 0">
            <input type="search" class="form-control input-sm mks-mem-search" placeholder="Zoek melding…">
            <a href="#" class="btn btn-xs btn-default mks-mem-export" title="Download een spiekbriefje voor op je mobiel">📱 Spiekbriefje</a>
            <a href="#" class="btn btn-xs btn-success mks-mem-aaos" title="Maakt ${EXTRA_AAOS.length} extra inzetvoorstellen aan (bestaande worden overgeslagen)">➕ Extra AAO's</a>
            <a href="#" class="btn btn-xs btn-default mks-mem-reset" title="Geleerde gegevens wissen">Wis</a>
          </div>
          <div class="mks-mem-list"></div>`;
        const list = wrap.querySelector('.mks-mem-list');

        const rowHtml = (r) => {
          const extra = r.est.sometimes.length ? ` · soms: ${r.est.sometimes.map((s) => `${CATEGORY_LABELS[s.k]} ${s.chance}%`).join(', ')}` : '';
          const learned = r.est.learned.length ? ` · <span class="text-warning">geleerd: +${escapeHtml(r.est.learned.join(', '))}</span>` : '';
          const aao = r.best ? `👉 ${escapeHtml(r.best.a.caption)}${r.best.missing ? ' <span class="text-danger">(dekt niet alles)</span>' : ''}` : '';
          return `<div class="mks-mem-row" data-name="${escapeHtml(r.t.name.toLowerCase())}" style="margin-bottom:4px">
            <b>${escapeHtml(r.t.name)}</b> <small class="text-muted">${r.seen ? `${r.seen}× gezien` : 'nog niet gezien'}</small><br>
            <small>min: <b>${formatNeeds(r.est.min)}</b>${extra}${learned}<br>${aao}</small></div>`;
        };
        list.innerHTML = rows.map(rowHtml).join('');

        wrap.querySelector('.mks-mem-search').addEventListener('input', (e) => {
          const q = e.target.value.trim().toLowerCase();
          list.querySelectorAll('.mks-mem-row').forEach((el) => (el.style.display = !q || el.dataset.name.includes(q) ? '' : 'none'));
        });
        wrap.querySelector('.mks-mem-aaos').addEventListener('click', async (e) => {
          e.preventDefault();
          const btn = e.currentTarget;
          if (btn.dataset.busy) return;
          if (!window.confirm(`Deze inzetvoorstellen aanmaken (bestaande worden overgeslagen)?\n\n${EXTRA_AAOS.map((a) => a.caption).join('\n')}`)) return;
          btn.dataset.busy = '1';
          try {
            const r = await createExtraAaos((caption) => (btn.textContent = `… ${caption.split('.')[0]}`));
            btn.textContent = `✓ ${r.created.length} nieuw`;
            btn.title = [
              r.created.length && `Aangemaakt: ${r.created.join(', ')}`,
              r.skipped.length && `Bestond al: ${r.skipped.join(', ')}`,
              r.failed.length && `Mislukt: ${r.failed.join('; ')}`,
            ]
              .filter(Boolean)
              .join('\n');
            if (r.failed.length) {
              btn.className = 'btn btn-xs btn-danger';
              window.alert(btn.title);
            }
          } catch (err) {
            console.error('[MKS→HA] AAO create failed', err);
            btn.textContent = 'Mislukt';
            btn.title = err.message;
            btn.className = 'btn btn-xs btn-danger';
          }
          delete btn.dataset.busy;
        });
        wrap.querySelector('.mks-mem-reset').addEventListener('click', (e) => {
          e.preventDefault();
          if (!window.confirm('Alle geleerde inzetgegevens wissen?')) return;
          memWrite(MEMORY_KEYS.types, {});
          memWrite(MEMORY_KEYS.open, {});
          e.target.textContent = '✓';
        });
        wrap.querySelector('.mks-mem-export').addEventListener('click', (e) => {
          e.preventDefault();
          const html = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inzetvoorstellen</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--accent:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--muted:#9a9a9a;--line:#333;--accent:#ef5350}}
body{font:15px/1.4 system-ui,sans-serif;margin:0;padding:12px 16px;background:var(--bg);color:var(--fg)}
h1{font-size:18px;margin:0 0 8px}input{width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);margin-bottom:10px}
.r{border-bottom:1px solid var(--line);padding:8px 0}.n{font-weight:600}.m{color:var(--muted);font-size:13px}.a{color:var(--accent);font-size:13px;font-weight:600}
</style></head><body><h1>🚒 Inzetvoorstellen per melding</h1>
<input id="q" type="search" placeholder="Zoek melding…" autofocus>
${rows
  .map(
    (r) =>
      `<div class="r" data-n="${escapeHtml(r.t.name.toLowerCase())}"><div class="n">${escapeHtml(r.t.name)}</div><div>min: ${formatNeeds(r.est.min)}${
        r.est.sometimes.length ? ` <span class="m">· soms ${r.est.sometimes.map((s) => `${CATEGORY_LABELS[s.k]} ${s.chance}%`).join(', ')}</span>` : ''
      }</div>${r.best ? `<div class="a">👉 ${escapeHtml(r.best.a.caption)}</div>` : ''}</div>`
  )
  .join('')}
<p class="m">Gemaakt ${new Date().toLocaleString('nl-NL')} · ${rows.length} meldingstypes</p>
<script>document.getElementById('q').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('.r').forEach(r=>r.style.display=!q||r.dataset.n.includes(q)?'':'none')})<\/script></body></html>`;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
          a.download = 'inzetvoorstellen.html';
          document.body.append(a);
          a.click();
          a.remove();
        });
      } catch (e) {
        console.error('[MKS→HA] Mission memory failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Laden mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();
    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /* Redistribution: vehicles at the wrong station + personnel balance   */
  /* ------------------------------------------------------------------ */

  // Never suggested for moving: hose truck, hook-lift trucks/containers, trailers and deliberate specialists
  const MOVE_EXCLUDED_TYPES = new Set([
    10, 26, 27, 29, 32, 45, 51, 61, 69, 89, 91, 121, 123, 127, 134, 136, 138, 141, 149, // SL + hook-lift
    36, 70, 71, 72, 154, 156, // trailers
    19, 24, 31, 11, 56, // HOvD, AGS, CO, DB-VEB, DA-VL
  ]);
  const SPECIALIST_NAME = /09-\d{2}(29|91|97|87|89|95)\b/; // specialist call signs we hand out ourselves

  /** Vehicle kind used for matching official slots: TS and TST are interchangeable. */
  const kindOf = (typeId) => {
    const label = labelOf(typeId);
    return label === 'TST' ? 'TS' : label;
  };

  const distanceKm = (a, b) => {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.latitude - a.latitude);
    const dLon = rad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
  };

  /** Moves a vehicle with the game's own "Hierheen verplaatsen" link and checks the result. */
  async function moveVehicle(vehicleId, targetBuildingId) {
    await fetch(`/vehicles/${vehicleId}/move/do/${targetBuildingId}`, { credentials: 'include' });
    const moved = (await fetchJson('/api/vehicles', { fresh: true })).find((v) => v.id === vehicleId);
    log(`Moved ${vehicleId} → ${targetBuildingId}`, moved?.building_id === targetBuildingId);
    if (moved?.building_id !== targetBuildingId) throw new Error('verplaatsen niet gelukt (voertuig onderweg of post vol?)');
    return true;
  }

  /** Last two digits the VRU uses for a vehicle type (HV → "71", TS → "31"): most common in the reference. */
  function vruTypeDigits(typeId) {
    const counts = {};
    Object.values(VRU_STATIONS).forEach(([, list]) =>
      list.forEach(([suffix, t]) => {
        if (kindOf(t) === kindOf(typeId)) counts[suffix.slice(-2)] = (counts[suffix.slice(-2)] || 0) + 1;
      })
    );
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '99';
  }

  function planRedistribution(data) {
    const { stationRows, typeInfo, vehicles } = data;
    const crewOf = (typeId) => typeInfo[typeId]?.maxCrew || 3;

    // Simulation state per station: free slots, crew, filled official slots
    const state = new Map(
      stationRows.map((r) => {
        const code = stationCodeFromName(r.station.caption);
        const filled = new Set(r.own.map((v) => (v.caption || '').match(/09-(\d{4})/)?.[1]).filter(Boolean));
        return [
          r.station.id,
          {
            row: r,
            code,
            freeSlots: Math.max(0, r.station.level + 1 - r.own.length),
            crewNeeded: r.crewNeeded,
            staff: r.staff.length,
            open: code && VRU_STATIONS[code] ? VRU_STATIONS[code][1].filter(([suffix]) => !filled.has(suffix)) : [],
          },
        ];
      })
    );

    const moves = [];
    const renames = [];
    const stuck = [];

    stationRows.forEach((r) => {
      const home = state.get(r.station.id);
      if (!home.code || !VRU_STATIONS[home.code]) return;
      const official = VRU_STATIONS[home.code][1];

      r.own.forEach((v) => {
        if (MOVE_EXCLUDED_TYPES.has(v.vehicle_type) || SPECIALIST_NAME.test(v.caption || '')) return;
        // Specialist at one of its real VRU posts (Brandbase), e.g. the DB-RI on 09-06 Werkhoven: belongs here
        const vruHome = vruHomeOf(v.caption || '', v.vehicle_type);
        if (vruHome?.posts?.includes(home.code)) return;
        const number = (v.caption || '').match(/09-(\d{4})/)?.[1];
        const isOfficial = official.some(([suffix, t]) => suffix === number && kindOf(t) === kindOf(v.vehicle_type));
        if (isOfficial) return;

        // 1. An open official slot of this kind at its own station: just rename
        const ownSlot = home.open.find(([, t]) => kindOf(t) === kindOf(v.vehicle_type));
        if (ownSlot) {
          home.open = home.open.filter((s) => s !== ownSlot);
          renames.push({ vehicle: v, station: r.station, to: vehicleName(ownSlot[0], v.vehicle_type) });
          return;
        }

        // 2. Another station that officially has this kind, lacks it, and has room
        const crew = v.max_personnel_override || crewOf(v.vehicle_type);
        const targets = [...state.values()]
          .filter((s) => s !== home && s.open.some(([, t]) => kindOf(t) === kindOf(v.vehicle_type)))
          .map((s) => ({ s, km: distanceKm(r.station, s.row.station) }))
          .sort((a, b) => Number(b.s.freeSlots > 0) - Number(a.s.freeSlots > 0) || a.km - b.km);
        const target = targets.find((t) => t.s.freeSlots > 0);

        if (!target) {
          // Name doesn't follow "BRW 09-xxxx" at all (e.g. "02-6571 HV"): at least give it a VRU-style name here
          if (!number && home.code) {
            const taken = new Set(r.own.map((o) => (o.caption || '').match(/09-(\d{4})/)?.[1]).filter(Boolean));
            const digits = vruTypeDigits(v.vehicle_type);
            let suffix = `${home.code}${digits}`;
            for (let n = 2; taken.has(suffix) && n < 10; n++) suffix = `${home.code}${digits.slice(0, 1)}${n}`;
            if (!taken.has(suffix)) {
              renames.push({ vehicle: v, station: r.station, to: vehicleName(suffix, v.vehicle_type), misnamed: true });
              return;
            }
          }
          stuck.push({ vehicle: v, station: r.station, waiting: targets[0] || null });
          return;
        }
        const slot = target.s.open.find(([, t]) => kindOf(t) === kindOf(v.vehicle_type));
        target.s.open = target.s.open.filter((s) => s !== slot);
        target.s.freeSlots -= 1;
        home.freeSlots += 1;
        home.crewNeeded -= crew;
        target.s.crewNeeded += crew;
        const shortage = target.s.crewNeeded - target.s.staff;
        moves.push({
          vehicle: v,
          from: r.station,
          to: target.s.row.station,
          km: target.km,
          newName: vehicleName(slot[0], v.vehicle_type),
          personnel: shortage > 0 ? `${shortage} personeel tekort op de nieuwe post` : `personeel ok (${target.s.staff}/${target.s.crewNeeded})`,
          personnelOk: shortage <= 0,
        });
      });
    });

    // Personnel: untrained, unbound people from stations with surplus to stations with a shortage
    const transfers = [];
    const donors = [...state.values()]
      .map((s) => ({
        s,
        spare: Math.min(
          s.staff - Math.max(MIN_STATION_PERSONNEL, s.crewNeeded),
          s.row.staff.filter((p) => !p.keys.length && !p.boundVehicleId).length
        ),
        pool: s.row.staff.filter((p) => !p.keys.length && !p.boundVehicleId),
      }))
      .filter((d) => d.spare > 0)
      .sort((a, b) => b.spare - a.spare);
    [...state.values()]
      .filter((s) => s.staff < s.crewNeeded)
      .sort((a, b) => b.crewNeeded - b.staff - (a.crewNeeded - a.staff))
      .forEach((s) => {
        let need = s.crewNeeded - s.staff;
        donors
          .filter((d) => d.spare > 0)
          .sort((a, b) => distanceKm(a.s.row.station, s.row.station) - distanceKm(b.s.row.station, s.row.station))
          .forEach((d) => {
            if (need <= 0) return;
            const take = Math.min(d.spare, need);
            const people = d.pool.splice(0, take);
            d.spare -= take;
            need -= take;
            transfers.push({ from: d.s.row.station, to: s.row.station, people });
          });
        if (need > 0) transfers.push({ from: null, to: s.row.station, people: [], missing: need });
      });

    return { moves, renames, stuck, transfers };
  }

  async function renderRedistribution() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<em>Voertuigen en personeel van alle posten controleren…</em>';

    (async () => {
      try {
        const data = await analysePersonnel();
        const { moves, renames, stuck, transfers } = planRedistribution(data);
        const transferInfo = await loadTransferInfo(data.stations[0].id);
        const short = shortPost;
        wrap.innerHTML = '';

        const button = (label, onClick, cls, confirmText) => makeActionButton(label, onClick, { cls, confirmText });
        const line = (html, ...buttons) => wrap.append(makeRow(html, ...buttons));
        const heading = (text) => {
          const h = document.createElement('div');
          h.style.cssText = 'font-weight:bold;margin:6px 0 3px';
          h.textContent = text;
          wrap.append(h);
        };

        const crew = planSpecialistCrew(data, transferInfo.remaining);
        if (!moves.length && !renames.length && !stuck.length && !transfers.length && !crew.length) {
          wrap.innerHTML = '<em>Alles staat op de juiste post en het personeel is in balans. ✅</em>';
          return;
        }

        if (moves.length || renames.length || stuck.length) heading('🚒 Voertuigen die hier officieel niet horen');
        renames.forEach((r) =>
          line(
            `✏️ <b>${short(r.vehicle.caption)}</b> <small class="text-muted">· ${short(r.station.caption)}</small><br><small>${
              r.misnamed ? 'Naam volgt de VRU-nummering niet; voorstel' : 'Hoort hier wel, maar onder het officiële nummer'
            } → <b>${short(r.to)}</b></small>`,
            button('Hernoem', () => renameVehicle(r.vehicle.id, r.to), 'btn-success')
          )
        );
        moves.forEach((m) =>
          line(
            `🔀 <b>${short(m.vehicle.caption)}</b> <small class="text-muted">· nu ${short(m.from.caption)}</small><br><small>→ <b>${short(m.to.caption)}</b> (${m.km.toFixed(
              1
            )} km), wordt <b>${short(m.newName)}</b> · ${m.personnelOk ? '👷' : '⚠️'} ${escapeHtml(m.personnel)}</small>`,
            button(
              'Verplaats + hernoem',
              async () => {
                await moveVehicle(m.vehicle.id, m.to.id);
                await renameVehicle(m.vehicle.id, m.newName);
              },
              'btn-warning',
              `${m.vehicle.caption.trim()} verplaatsen van ${m.from.caption.trim()} naar ${m.to.caption.trim()} en hernoemen naar ${m.newName}?`
            )
          )
        );
        stuck.forEach((s) =>
          line(
            `⏸️ <b>${short(s.vehicle.caption)}</b> <small class="text-muted">· ${short(s.station.caption)}</small><br><small>${
              s.waiting
                ? `Hoort officieel bij ${short(s.waiting.s.row.station.caption)}, maar daar is geen plek: eerst die post een level omhoog.`
                : 'Geen gebouwde post waar dit voertuig officieel hoort en nog ontbreekt. Laat staan of bouw de juiste post.'
            }</small>`
          )
        );

        if (transfers.length) {
          heading(`👷 Personeel herverdelen (nog ${transferInfo.remaining} verplaatsingen deze week)`);
          transfers.forEach((t) => {
            if (!t.from) {
              line(`⚠️ <b>${short(t.to.caption)}</b><br><small>Nog ${t.missing} personeel tekort, niemand over: start werving.</small>`);
              return;
            }
            line(
              `➡️ <b>${t.people.length}</b> personeel <small class="text-muted">(zonder opleiding)</small> van <b>${short(t.from.caption)}</b> naar <b>${short(t.to.caption)}</b>`,
              button(
                'Verplaats',
                () => transferPersonnel(t.to.id, t.people.map((p) => p.id)),
                'btn-warning',
                `${t.people.length} personeel (${t.people.map((p) => p.name).join(', ')}) van ${t.from.caption.trim()} naar ${t.to.caption.trim()} verplaatsen?\n\nDit kan NIET ongedaan worden.`
              )
            );
          });
        }

        if (crew.length) {
          heading('🎓 Opgeleid personeel op het juiste voertuig');
          const safe = crew.filter((c) => c.type !== 'transfer');
          if (safe.length > 1) {
            line(
              '<small class="text-muted">Alle koppelingen in één keer (verplaatsen blijft per voertuig, met bevestiging)</small>',
              button(`Koppel alles (${safe.length})`, async () => {
                for (const c of safe) await executeCrewStep(c);
              })
            );
          }
          crew.forEach((c) => {
            const who = c.people.map((p) => p.name).join(', ');
            const what = `<b>${short(c.vehicle.caption)}</b> <small class="text-muted">· ${short(c.station.caption)}</small><br><small>${
              c.type === 'transfer'
                ? `${c.people.length}× opgeleid in ${short(c.from.caption)} (${escapeHtml(who)}): hier staat het voertuig. Verplaatsen en daarna koppelen.`
                : c.type === 'rebind'
                  ? `${escapeHtml(who)} zit op een ander voertuig: herkoppelen.`
                  : `${escapeHtml(who)} opgeleid maar niet gekoppeld: vastzetten.`
            }</small>`;
            line(
              `${c.type === 'transfer' ? '➡️' : '🔗'} ${what}`,
              c.type === 'transfer'
                ? button('Verplaats', () => executeCrewStep(c), 'btn-warning', `${who} van ${c.from.caption.trim()} naar ${c.station.caption.trim()} verplaatsen en op ${c.vehicle.caption.trim()} koppelen?\n\nDit kan NIET ongedaan worden.`)
                : button('Koppel', () => executeCrewStep(c))
            );
          });
        }
      } catch (e) {
        console.error('[MKS→HA] Redistribution failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Controle mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();
    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /* Extras: priorities, team radar, stuck vehicles, coverage map,       */
  /* report, auto-claim, auto-hire, settings                             */
  /* ------------------------------------------------------------------ */

  const EXTRAS_KEY = (name) => `mks_extras_${name}`;
  const extrasRead = (name, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(EXTRAS_KEY(name)) || 'null') ?? fallback;
    } catch (e) {
      return fallback;
    }
  };
  const extrasWrite = (name, value) => {
    try {
      localStorage.setItem(EXTRAS_KEY(name), JSON.stringify(value));
    } catch (e) {
      /* best-effort */
    }
  };

  /**
   * Event missions (Sinterklaas, Herfst…) are the mission types with a limited date window in the game's catalog.
   * Map: mission type id -> end of the event (ms). Cached 6 h; refreshed in the background.
   */
  let eventTypeEnds = new Map(Object.entries(extrasRead('event_types_v1', { map: {} }).map));
  async function refreshEventTypes() {
    const cached = extrasRead('event_types_v1', { ts: 0, map: {} });
    if (Date.now() - cached.ts < 6 * 3600e3) return;
    const now = Date.now();
    const map = {};
    (await loadMissionCatalog()).forEach((t) => {
      const start = Date.parse(t.additional?.date_start);
      const end = Date.parse(t.additional?.date_end);
      if (end && start <= now && end >= now) map[String(t.id)] = end;
    });
    extrasWrite('event_types_v1', { ts: now, map });
    eventTypeEnds = new Map(Object.entries(map));
  }

  const FREE_FMS = new Set([1, 2]); // 1 = free on radio, 2 = at station
  const isFireEngine = (typeId) => ['TS', 'TST'].includes(labelOf(typeId));

  const openLightbox = (url) => {
    if (typeof unsafeWindow.lightboxOpen === 'function') unsafeWindow.lightboxOpen(url);
    else window.open(url, '_blank');
  };

  /** Mission type id -> average credits, from the shared mission catalog. */
  async function loadMissionCredits() {
    const cached = extrasRead('credits_v1', null);
    if (cached && Date.now() - cached.ts < 24 * 3600e3) return cached.data;
    const data = {};
    (await loadMissionCatalog()).forEach((t) => (data[t.id] = t.average_credits || 0));
    extrasWrite('credits_v1', { ts: Date.now(), data });
    return data;
  }

  /** The main game page (also when Tampermonkey runs this copy inside a mission window). */
  function mainDocument() {
    if (isMainPage) return document;
    try {
      return window.parent?.document?.getElementById('mission_list') ? window.parent.document : document;
    } catch (e) {
      return document;
    }
  }

  /**
   * Event missions (Sinterklaas, Herfst…): the game does not label them one way, so use several signals:
   * an event list/filter type, an event class or attribute, or a keyword from the settings in the caption.
   */
  function isEventEntry(entry, caption) {
    if (eventTypeEnds.has(String(entry.getAttribute('mission_type_id')))) return true;
    const type = entry.getAttribute('data-mission-type-filter') || '';
    if (type && !['emergency', 'sicherheitswache', 'krankentransporte'].includes(type)) return true;
    if (/event/i.test(entry.parentElement?.id || '') || /event/i.test(entry.className) || entry.hasAttribute('data-event')) return true;
    const words = String(GM_getValue('mks_event_words', 'sinterklaas|pakjes|herfst|halloween|kerst|oud en nieuw|koningsdag')).trim();
    try {
      return !!words && new RegExp(words, 'i').test(caption);
    } catch (e) {
      return false;
    }
  }

  /** Missions in one of the game's sidebar lists, read from the page itself. */
  function readMissionList(selector) {
    return [...mainDocument().querySelectorAll(`${selector} .missionSideBarEntry`)]
      .filter((e) => !e.classList.contains('mission_deleted') && e.style.display !== 'none')
      .map((entry) => {
        const id = entry.getAttribute('mission_id');
        const panel = entry.querySelector(`#mission_panel_${id}`);
        const missingText = (entry.querySelector(`#mission_missing_${id}`)?.textContent || '').trim();
        const caption = (entry.querySelector(`#mission_caption_${id}`)?.firstChild?.textContent || 'Melding').trim().replace(/,$/, '');
        return {
          id,
          caption,
          isEvent: isEventEntry(entry, caption),
          typeId: entry.getAttribute('mission_type_id'),
          lat: parseFloat(entry.getAttribute('latitude')),
          lng: parseFloat(entry.getAttribute('longitude')),
          state: ['red', 'yellow', 'green'].find((s) => panel?.classList.contains(`mission_panel_${s}`)) || 'red',
          missing: missingText ? parseMissingVehicles(missingText) : null,
        };
      });
  }

  const missingCount = (m) => (m.missing ? Object.values(m.missing.missing).reduce((a, b) => a + b, 0) + m.missing.unknown.length : 0);

  /** Nearest own station with a free fire engine, for a coordinate. */
  function nearestFreeEngine(point, stations, vehicles) {
    if (!Number.isFinite(point.lat)) return null;
    const free = new Set(vehicles.filter((v) => FREE_FMS.has(v.fms_real) && isFireEngine(v.vehicle_type)).map((v) => v.building_id));
    return (
      stations
        .filter((s) => free.has(s.id))
        .map((s) => ({ s, km: distanceKm({ latitude: point.lat, longitude: point.lng }, s) }))
        .sort((a, b) => a.km - b.km)[0] || null
    );
  }

  /**
   * Own missions that need you, best first: almost done (1 missing), then not dispatched yet
   * (by credits), then more missing, then the rest. Shared by the priorities list and the worklist.
   */
  function rankOwnMissions(credits) {
    const boost = (m) => (m.isEvent && setting('eventPriority') ? 5e6 : 0); // events expire, so they go first
    const score = (m) => {
      const missing = missingCount(m);
      if (m.isEvent && setting('eventPriority')) return boost(m) + (credits[m.typeId] || 0);
      if (missing === 1) return 3e6 + (credits[m.typeId] || 0);
      if (m.state === 'red') return 2e6 + (credits[m.typeId] || 0);
      if (missing > 1) return 1e6 + (credits[m.typeId] || 0) / missing;
      return credits[m.typeId] || 0;
    };
    return readMissionList('#mission_list')
      .filter((m) => m.state !== 'green' || missingCount(m))
      .sort((a, b) => score(b) - score(a));
  }

  /* ---------- 1 + 2: priorities (own missions) and team radar (shared missions) ---------- */

  async function renderPriorities() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<em>Meldingen beoordelen…</em>';
    (async () => {
      try {
        const [credits, buildings, vehicles] = await Promise.all([loadMissionCredits(), fetchJson('/api/buildings'), fetchJson('/api/vehicles')]);
        const stations = buildings.filter((b) => b.building_type === 0);
        const row = (m, extra) => {
          const engine = nearestFreeEngine(m, stations, vehicles);
          const div = document.createElement('div');
          div.style.cssText = 'display:flex;justify-content:space-between;gap:6px;margin-bottom:4px';
          div.innerHTML = `<span>${{ red: '🔴', yellow: '🟡', green: '🟢' }[m.state]} <b>${escapeHtml(m.caption)}</b>
            <small class="text-muted">· ±${formatCredits(credits[m.typeId] || 0)} cr${engine ? ` · vrije TS ${engine.km.toFixed(1)} km` : ''}${extra ? ` · ${extra}` : ''}</small></span>`;
          const open = document.createElement('a');
          open.href = '#';
          open.className = 'btn btn-xs btn-default';
          open.textContent = 'Open';
          open.addEventListener('click', (e) => {
            e.preventDefault();
            openLightbox(`/missions/${m.id}`);
          });
          div.append(open);
          return div;
        };
        const heading = (text) => {
          const h = document.createElement('div');
          h.style.cssText = 'font-weight:bold;margin:6px 0 3px';
          h.textContent = text;
          return h;
        };
        wrap.innerHTML = '';

        const ranked = rankOwnMissions(credits);
        wrap.append(heading(`🎯 Jouw meldingen (${ranked.length} vragen actie)`));
        if (!ranked.length) wrap.append(Object.assign(document.createElement('em'), { textContent: 'Alles loopt. 👍' }));
        ranked.slice(0, 12).forEach((m) => {
          const missing = missingCount(m);
          wrap.append(row(m, m.isEvent ? '<span class="label label-warning">evenement</span>' + (missing ? ` ${missing} missen` : '') : missing === 1 ? '<span class="label label-success">bijna klaar</span>' : missing ? `${missing} missen` : m.state === 'red' ? 'nog niet gealarmeerd' : ''));
        });

        // Team radar: shared missions near your stations
        const shared = [...readMissionList('#mission_list_alliance'), ...readMissionList('#mission_list_alliance_event')]
          .map((m) => ({ m, engine: nearestFreeEngine(m, stations, vehicles) }))
          .filter((x) => x.engine && x.engine.km <= 15)
          .sort((a, b) => (credits[b.m.typeId] || 0) - (credits[a.m.typeId] || 0));
        wrap.append(heading(`🤝 Teamhulp dichtbij (${shared.length}, ≤15 km)`));
        if (!shared.length) wrap.append(Object.assign(document.createElement('em'), { textContent: 'Geen gedeelde meldingen in de buurt.' }));
        shared.slice(0, 8).forEach((x) => wrap.append(row(x.m, missingCount(x.m) ? `${missingCount(x.m)} missen` : '')));

        // 3: stuck vehicles
        const stuck = findStuckVehicles(vehicles);
        if (stuck.length) {
          wrap.append(heading(`⚠️ Vergeten voertuigen (${stuck.length})`));
          stuck.forEach((s) => {
            const div = document.createElement('div');
            div.style.cssText = 'display:flex;justify-content:space-between;gap:6px;margin-bottom:4px';
            div.innerHTML = `<span><b>${escapeHtml(s.vehicle.caption)}</b> <small class="text-muted">· ${escapeHtml(s.reason)}</small></span>`;
            const open = document.createElement('a');
            open.href = '#';
            open.className = 'btn btn-xs btn-default';
            open.textContent = 'Voertuig';
            open.addEventListener('click', (e) => {
              e.preventDefault();
              openLightbox(`/vehicles/${s.vehicle.id}`);
            });
            div.append(open);
            wrap.append(div);
          });
        }
      } catch (e) {
        console.error('[MKS→HA] Priorities failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Laden mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();
    return wrap;
  }

  /* ---------- 3: vehicles out of service or stuck at a mission ---------- */

  const STUCK_LIMITS = { 6: 30 * 60e3, 4: 3 * 3600e3 }; // status 6 (buiten dienst) > 30 min, status 4 (ter plaatse) > 3 h

  // Longer than this without a look (browser closed, other device): we can't know it stayed put
  const STATUS_GAP_MS = 20 * 60e3;

  /**
   * Tracks since when each vehicle has its current status at its current target (per browser).
   * Restarts when the status or target changes, or after a gap in observation: before, a vehicle seen
   * on scene on day 1 and again on day 13 (at another mission) was reported as "329 hours on scene".
   */
  function trackVehicleStatus(vehicles) {
    const since = extrasRead('status_since_v1', {});
    const now = Date.now();
    const next = {};
    vehicles.forEach((v) => {
      const prev = since[v.id];
      const same =
        prev && prev.fms === v.fms_real && (prev.target ?? null) === (v.target_id ?? null) && now - (prev.seen || prev.ts) < STATUS_GAP_MS;
      next[v.id] = same ? { ...prev, seen: now } : { fms: v.fms_real, target: v.target_id ?? null, ts: now, seen: now };
    });
    extrasWrite('status_since_v1', next);
    return next;
  }

  function findStuckVehicles(vehicles) {
    const since = trackVehicleStatus(vehicles);
    const minutes = (ms) => Math.round(ms / 60e3);
    return vehicles
      .map((v) => {
        const limit = STUCK_LIMITS[v.fms_real];
        const age = Date.now() - (since[v.id]?.ts || Date.now());
        if (!limit || age < limit) return null;
        const reason =
          v.fms_real === 6
            ? `${minutes(age)} min buiten dienst (vaak: te weinig personeel of handmatig uitgezet)`
            : `${Math.round(age / 3600e3)} uur ter plaatse — melding vastgelopen of gepland evenement?`;
        return { vehicle: v, reason };
      })
      .filter(Boolean);
  }

  /* ---------- 4: coverage map ---------- */

  /**
   * The game draws its map with Apple MapKit (default, "map_kit") or Leaflet, per player setting.
   * `map` is the provider's own map object in both cases; xy_map.mapProvider says which one.
   */
  function coverageMapKind() {
    const map = unsafeWindow.map;
    if (unsafeWindow.mapkit && typeof map?.addOverlays === 'function' && typeof map?.addAnnotations === 'function') return 'mapkit';
    if (unsafeWindow.L && typeof map?.addLayer === 'function') return 'leaflet';
    return null;
  }

  let coverage = null; // { kind, layer } (Leaflet) or { kind, overlays, annotations } (MapKit)
  function clearCoverage() {
    const map = unsafeWindow.map;
    if (coverage?.kind === 'leaflet') map?.removeLayer?.(coverage.layer);
    if (coverage?.kind === 'mapkit') {
      map?.removeOverlays?.(coverage.overlays);
      map?.removeAnnotations?.(coverage.annotations);
    }
    coverage = null;
  }

  async function updateCoverageMap() {
    const kind = coverageMapKind();
    if (!setting('coverageMap') || !kind) return clearCoverage();
    const [buildings, vehicles] = await Promise.all([fetchJson('/api/buildings'), fetchJson('/api/vehicles')]);
    const stations = buildings
      .filter((b) => b.building_type === 0)
      .map((b) => {
        const engines = vehicles.filter((v) => v.building_id === b.id && isFireEngine(v.vehicle_type));
        const free = engines.filter((v) => FREE_FMS.has(v.fms_real)).length;
        const color = !engines.length ? '#757575' : free === 0 ? '#d32f2f' : free < engines.length ? '#f9a825' : '#2e7d32';
        return { b, free, total: engines.length, color, tip: `${b.caption.trim()}: ${free}/${engines.length} TS vrij` };
      });
    clearCoverage();
    const map = unsafeWindow.map;

    if (kind === 'leaflet') {
      const L = unsafeWindow.L;
      const layer = L.layerGroup().addTo(map);
      stations.forEach((s) =>
        L.circleMarker([s.b.latitude, s.b.longitude], { radius: 9, color: s.color, weight: 3, fillOpacity: 0.15, interactive: true })
          .bindTooltip(s.tip)
          .addTo(layer)
      );
      coverage = { kind, layer };
      return;
    }

    // MapKit: a ring around the station (drawn below the game's icons) plus a "free/total" badge
    const mk = unsafeWindow.mapkit;
    const overlays = [];
    const annotations = [];
    stations.forEach((s) => {
      const at = new mk.Coordinate(s.b.latitude, s.b.longitude);
      overlays.push(
        new mk.CircleOverlay(at, 900, {
          enabled: false,
          style: new mk.Style({ strokeColor: s.color, lineWidth: 3, fillColor: s.color, fillOpacity: 0.15 }),
        })
      );
      const badge = document.createElement('div');
      badge.textContent = `${s.free}/${s.total}`;
      badge.title = s.tip;
      badge.style.cssText = `font:bold 11px/1 sans-serif;color:#fff;background:${s.color};border-radius:8px;padding:2px 5px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.4)`;
      annotations.push(new mk.Annotation(at, () => badge, { enabled: false, anchorOffset: new DOMPoint(22, -22), displayPriority: 1000 }));
    });
    map.addOverlays(overlays);
    map.addAnnotations(annotations);
    coverage = { kind, overlays, annotations };
  }

  /* ---------- 5: report ---------- */

  function recordCompletion(typeId) {
    const entries = extrasRead('completed_v1', []);
    const ev = eventTypeEnds.get(String(typeId)) || null; // set for event missions: lets the task panel compare with the game's counter
    entries.push({ ts: Date.now(), typeId: typeId || null, ...(ev ? { ev } : {}) });
    extrasWrite('completed_v1', entries.filter((e) => Date.now() - e.ts < 30 * 86400e3));
  }

  /** Credit snapshots every run (max one per 15 min), kept 30 days. */
  async function snapshotCredits() {
    const snaps = extrasRead('credit_snaps_v1', []);
    if (snaps.length && Date.now() - snaps[snaps.length - 1].ts < 15 * 60e3) return snaps;
    const credits = await fetchJson('/api/credits');
    snaps.push({ ts: Date.now(), total: credits.credits_user_total });
    const kept = snaps.filter((s) => Date.now() - s.ts < 30 * 86400e3);
    extrasWrite('credit_snaps_v1', kept);
    return kept;
  }

  async function renderReport(balance, stationCount) {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<em>Rapport maken…</em>';
    (async () => {
      try {
        const [snaps, credits, catalog] = await Promise.all([snapshotCredits(), fetchJson('/api/credits', { fresh: true }), loadMissionCredits()]);
        const startOfDay = new Date().setHours(0, 0, 0, 0);
        const earnedSince = (from) => {
          const first = snaps.find((s) => s.ts >= from);
          return first ? credits.credits_user_total - first.total : null;
        };
        const completed = extrasRead('completed_v1', []);
        const countSince = (from) => completed.filter((e) => e.ts >= from).length;
        const today = earnedSince(startOfDay);
        const week = earnedSince(Date.now() - 7 * 86400e3);
        const trackedDays = snaps.length ? Math.max(1, (Date.now() - snaps[0].ts) / 86400e3) : 0;
        const perDay = week !== null && trackedDays ? week / Math.min(7, trackedDays) : null;
        const nextStation = stationBuildPrice(stationCount, true);

        // Best paying mission types you completed (average credits from the game)
        const byType = {};
        completed.forEach((e) => e.typeId && (byType[e.typeId] = (byType[e.typeId] || 0) + 1));
        const names = Object.fromEntries((await loadMissionCatalog()).map((t) => [String(t.id), t.name]));
        const top = Object.entries(byType)
          .map(([id, n]) => ({ name: names[id] || `type ${id}`, n, total: n * (catalog[id] || 0) }))
          .sort((a, b) => b.total - a.total)
          .slice(0, 5);
        const shortages = Object.entries(shortageStats())
          .map(([cat, st]) => `${SHORTAGE_LABELS[cat]?.[0] || cat} ${st.missions}×`)
          .join(', ');

        const fmt = (n) => (n === null ? '<span class="text-muted">nog geen meting</span>' : formatCredits(n));
        wrap.innerHTML = `
          <table class="table table-condensed" style="margin:0;background:transparent">
            <tr><td>Vandaag</td><td><b>${fmt(today)}</b> cr · ${countSince(startOfDay)} meldingen afgerond</td></tr>
            <tr><td>7 dagen</td><td><b>${fmt(week)}</b> cr · ${countSince(Date.now() - 7 * 86400e3)} meldingen${
          perDay !== null ? ` · ±${formatCredits(perDay)} per dag` : ''
        }</td></tr>
            <tr><td>Volgende post</td><td>${formatCredits(nextStation)} (klein) · saldo ${formatCredits(balance)}${
          perDay > 0 && balance < nextStation ? ` · ±${Math.ceil((nextStation - balance) / perDay)} dag(en) sparen` : ''
        }</td></tr>
            <tr><td>Tekorten (7 d)</td><td>${escapeHtml(shortages || 'geen')}</td></tr>
          </table>
          ${
            top.length
              ? `<small><b>Best betaald (30 d):</b> ${top.map((t) => `${escapeHtml(t.name)} ${t.n}× (±${formatCredits(t.total)})`).join(' · ')}</small>`
              : '<small class="text-muted">Afgeronde meldingen worden vanaf nu bijgehouden.</small>'
          }`;
      } catch (e) {
        console.error('[MKS→HA] Report failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Rapport mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();
    return wrap;
  }

  /* ---------- 6 + 7: automations ---------- */

  async function autoClaimTasks() {
    const claimable = (await loadTasks()).filter((t) => t.claimable);
    for (const task of claimable) await claimTask(task.form);
    if (claimable.length) showToast(`🎁 ${claimable.length} taak/taken automatisch geclaimd: ${claimable.map((t) => escapeHtml(t.title)).join(', ')}`);
  }

  /** Restarts 3 days of recruitment at stations whose recruitment ended while they still lack crew. */
  async function autoHire() {
    const [buildings, vehicles] = await Promise.all([fetchJson('/api/buildings', { fresh: true }), fetchJson('/api/vehicles')]);
    const stations = buildings.filter((b) => b.building_type === 0 && !b.hiring_phase);
    if (!stations.length) return;
    const typeInfo = await loadVehicleTypeInfo(stations[0].id);
    const started = [];
    for (const s of stations) {
      const crewNeeded = vehicles
        .filter((v) => v.building_id === s.id)
        .reduce((n, v) => n + (v.max_personnel_override || typeInfo[v.vehicle_type]?.maxCrew || 0), 0);
      if (s.personal_count >= Math.max(MIN_STATION_PERSONNEL, crewNeeded)) continue;
      const res = await fetch(`/buildings/${s.id}/hire_do/3`, { credentials: 'include' });
      if (res.ok) started.push(`${s.caption.trim().replace(`${CONFIG.vru.prefix} `, '')} (${s.personal_count}/${crewNeeded})`);
    }
    if (started.length) showToast(`👥 Werving gestart (3 dagen): ${started.map(escapeHtml).join(', ')}`);
  }

  /** Background loop on the main page: map, stuck-vehicle warnings, report snapshots, automations. */
  function startExtras() {
    const warned = new Set();
    const tick = async (run) => {
      try {
        await run();
      } catch (e) {
        console.error('[MKS→HA] Extras', e);
      }
    };
    const everyMinute = () =>
      tick(async () => {
        await updateCoverageMap();
        if (setting('stuckWarnings')) {
          const stuck = findStuckVehicles(await fetchJson('/api/vehicles'));
          const fresh = stuck.filter((s) => !warned.has(s.vehicle.id));
          fresh.forEach((s) => warned.add(s.vehicle.id));
          if (fresh.length) showToast(`⚠️ Vergeten voertuig(en): ${fresh.map((s) => `${escapeHtml(s.vehicle.caption)} — ${escapeHtml(s.reason)}`).join('<br>')}`);
        }
      });
    const everyTenMinutes = () =>
      tick(async () => {
        await snapshotCredits();
        if (setting('autoClaimTasks')) await autoClaimTasks();
        if (setting('autoHire')) await autoHire();
      });
    setTimeout(everyMinute, 8000);
    setTimeout(everyTenMinutes, 20000);
    setInterval(everyMinute, 60e3);
    setInterval(everyTenMinutes, 10 * 60e3);
    // Vehicle status changes: refresh the map soon after
    let mapRefresh = null;
    const original = unsafeWindow.radioMessage;
    if (typeof original === 'function') {
      unsafeWindow.radioMessage = function (...args) {
        clearTimeout(mapRefresh);
        mapRefresh = setTimeout(() => tick(updateCoverageMap), 3000);
        return original.apply(this, args);
      };
    }
  }

  /* ---------- Settings section in the VRU panel ---------- */

  function renderSettings() {
    const wrap = document.createElement('div');
    SETTINGS.forEach(({ key, label, needsReload }) => {
      const id = `mks-set-${key}`;
      const row = document.createElement('div');
      row.className = 'checkbox';
      row.style.margin = '2px 0';
      row.innerHTML = `<label for="${id}"><input type="checkbox" id="${id}"${setting(key) ? ' checked' : ''}> ${escapeHtml(label)}${
        needsReload ? ' <small class="text-muted">(na herladen)</small>' : ''
      }</label>`;
      row.querySelector('input').addEventListener('change', (e) => {
        GM_setValue(`opt_${key}`, e.target.checked);
        if (key === 'coverageMap') updateCoverageMap().catch(() => {});
      });
      wrap.append(row);
    });
    const ha = document.createElement('small');
    ha.className = 'text-muted';
    ha.textContent = `Home Assistant: ${CONFIG.webhookId ? 'webhook ingesteld' : 'geen webhook (Tampermonkey-menu → Home Assistant instellen)'}`;
    wrap.append(ha);
    const sync = document.createElement('small');
    sync.className = 'text-muted';
    sync.style.display = 'block';
    sync.textContent = syncStatusText();
    wrap.append(sync);
    return wrap;
  }


  /* ------------------------------------------------------------------ */
  /* Specialists: discover, register and give each a home station        */
  /* ------------------------------------------------------------------ */

  const SPECIALIST_REGISTER_KEY = 'mks_specialists_v1';

  // VRU head office (Archimedeslaan, Utrecht): AGS, HOvD and the communication adviser are based here, not at a post
  const VRU_HQ = { latitude: 52.0866, longitude: 5.1683 };

  /**
   * Where the real VRU keeps each specialist (Brandbase regio 09, Nov 2026). `posts` = station codes,
   * `hq` = head office (the game needs a fire station: the own post closest to it).
   */
  const VRU_SPECIALIST_HOMES = [
    { match: /riet|thatch|\bDB-RI\b|\bRIA\b/i, posts: ['06', '37', '58', '61'], real: 'Rietdak Brandbestrijdingsteamvoertuig' },
    { match: /veetakel|livestock|\bDB-VI\b/i, posts: ['21', '23', '29'], real: 'Veetakel Installatie' },
    { typeIds: [31], match: /commando|\bCO\b/i, posts: ['01', '18'], real: 'Commandovoertuig Multi CoPI' },
    { typeIds: [5], match: /adembescherming|\bAB\b/i, posts: ['07', '44', '64'], real: 'Adembeschermingshaakarmbak' },
    { typeIds: [24], match: /gevaarlijke\s*stoffen|\bAGS\b/i, hq: true, real: 'AGS West/Oost (hoofdkantoor)' },
    { typeIds: [19], match: /hoofd\s*officier|\bHOvD\b/i, hq: true, real: 'HOvD West/Oost (hoofdkantoor)' },
    { typeIds: [56], match: /voorlicht|communicatie|\bVL\b/i, hq: true, real: 'Communicatieadviseur CoPI (hoofdkantoor)' },
    { typeIds: [68], match: /schuim/i, posts: ['18'], real: 'Schuimblusvoertuig' },
    // "brush" = the game's key for nature fire vehicles (TST-NB / NBV)
    { typeIds: [12, 14, 15], match: /brush|natuurbrand|\bNBV?\b/i, posts: ['01', '03', '07', '10', '22', '30', '31', '32', '33', '35', '50', '51', '52', '53', '54', '55', '64', '66'], real: 'Natuurbrandbestrijdingsvoertuig (NBV)' },
    // Brandbase regio 09 (Nov 2026): Brandweervaartuig middel/klein (BRV) at Bunschoten, Vinkeveen, Breukelen, Vianen; no blusrobot in the VRU
    { match: /blusboot|brandweervaartuig|\bBRV\b|fire_boat/i, posts: ['04', '14', '36', '57'], real: 'Brandweervaartuig (BRV)' },
    // Droneteams / TDV are regional (09-80), not at a post: the game needs a fire station
    { match: /drone|\bTDV\b|verkenningsteam/i, hq: true, real: 'Droneteam / TDV (regionaal)' },
    { typeIds: [33], match: /waterongeval|duik/i, posts: ['01', '04', '13', '39', '44', '59'], real: 'Waterongevallen' },
  ];

  const vruHomeOf = (name, typeId) =>
    VRU_SPECIALIST_HOMES.find((h) => (typeId != null && h.typeIds?.includes(typeId)) || h.match.test(name)) || null;

  const readSpecialistRegister = () => {
    try {
      return JSON.parse(localStorage.getItem(SPECIALIST_REGISTER_KEY) || '{}');
    } catch (e) {
      return {};
    }
  };

  /** Shop vehicle whose name shares a word (≥ 3 letters) with `name`: "DB-RI of RIA" → the rietkap vehicle. */
  function shopMatch(name, typeInfo) {
    const words = name.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 3 && !['van', 'een', 'het', 'met'].includes(w));
    const hit = Object.entries(typeInfo || {}).find(([, t]) => words.some((w) => t.name?.toLowerCase().includes(w)));
    return hit ? { typeId: Number(hit[0]), ...hit[1] } : null;
  }

  /**
   * Home station for a specialist:
   * 1. the real VRU posts (Brandbase): a built one, closest to where you missed it; head-office
   *    specialists → your post closest to the head office; VRU posts not built yet → temporary home;
   * 2. otherwise the own station closest to where you missed it (average of those missions),
   *    preferring stations that already have people with the needed education;
   * 3. no locations yet: the station with trained people, else none.
   */
  function specialistHome({ name, at = [], education, shop }, stations, stationRows) {
    const centre = at.length
      ? { latitude: at.reduce((n, p) => n + p.lat, 0) / at.length, longitude: at.reduce((n, p) => n + p.lng, 0) / at.length }
      : null;
    const extension = PLAN_EXTENSIONS.find((ext) => ext.match.test(name)) || null;
    const vru = vruHomeOf(name, shop?.typeId);
    const short = (st) => st.caption.trim().replace(`${CONFIG.vru.prefix} `, '');
    if (vru?.hq) {
      const best = stations.map((st) => ({ st, km: distanceKm(VRU_HQ, st) })).sort((a, b) => a.km - b.km)[0];
      if (best)
        return { station: best.st, vru: true, extension, why: `VRU: ${vru.real}; jouw post het dichtst bij het hoofdkantoor (${best.km.toFixed(1)} km)` };
    }
    if (vru?.posts) {
      const all = vru.posts.map((c) => `09-${c}`).join(', ');
      const built = vru.posts.map((c) => stations.find((b) => new RegExp(`09-${c}\\b`).test(b.caption))).filter(Boolean);
      if (built.length) {
        // Several VRU posts built: the one closest to where you missed it
        const pick = centre ? built.sort((a, b) => distanceKm(centre, a) - distanceKm(centre, b))[0] : built[0];
        return {
          station: pick,
          vru: true,
          extension,
          why: `VRU: ${vru.real} op ${all}${built.length > 1 ? `; ${short(pick)} ligt het dichtst bij je gemiste meldingen` : ''}`,
        };
      }
      // None of its VRU posts built yet: temporary home closest to where you missed it
      const temp = centre && stations.map((st) => ({ st, km: distanceKm(centre, st) })).sort((a, b) => a.km - b.km)[0];
      return {
        station: temp?.st || null,
        vru: false,
        extension,
        posts: vru.posts,
        why: `VRU: ${vru.real} op ${all} (nog niet gebouwd)${temp ? `; tijdelijk ${short(temp.st)}, ${temp.km.toFixed(1)} km van je gemiste meldingen` : ''}`,
      };
    }
    const trainedAt = (st) => {
      if (!education) return 0;
      const row = stationRows?.find((r) => r.station.id === st.id);
      return row?.perEducation?.[education] || 0;
    };
    if (centre) {
      const ranked = stations
        .map((st) => ({ st, km: distanceKm(centre, st), trained: trainedAt(st) }))
        // A station with trained people within 5 km extra beats the closest one without
        .sort((a, b) => a.km - (a.trained ? 5 : 0) - (b.km - (b.trained ? 5 : 0)));
      const best = ranked[0];
      if (best)
        return {
          station: best.st,
          why: `dichtst bij je ${at.length} gemiste melding(en), ${best.km.toFixed(1)} km${best.trained ? `, ${best.trained} opgeleid` : ''}`,
        };
    }
    const trained = stations.map((st) => ({ st, n: trainedAt(st) })).filter((x) => x.n).sort((a, b) => b.n - a.n)[0];
    return trained ? { station: trained.st, why: `${trained.n} opgeleid` } : { station: null, why: 'nog geen locaties: speel even door' };
  }

  /** People trained in a long education name ("Specialist Rietdakbrandbestrijder"); null when the vehicle needs none. */
  function trainedCount(data, education) {
    if (!education) return null;
    const key = data.keyOf ? data.keyOf(education) : null;
    return key ? (data.people || []).filter((p) => p.keys.includes(key)).length : 0; // key unknown = nobody has it yet
  }

  /**
   * All specialists worth knowing about:
   * - missed: asked for in your missions while you had none (14 days, with locations);
   * - unlocked: specialist vehicles the game lets you buy that unlock fire missions (catalog).
   * Every kind is registered (first/last seen, advised home) so new ones stand out.
   */
  function collectSpecialists(data, buildings, vehicles) {
    const stations = buildings.filter((b) => b.building_type === 0);
    const register = readSpecialistRegister();
    const now = Date.now();
    const list = [];

    Object.entries(notOwnedDetails()).forEach(([name, d]) => {
      const shop = shopMatch(name, data.typeInfo);
      list.push({ name, missions: d.missions, at: d.at, shop, education: shop?.education || null, source: 'missed' });
    });
    (data.specialtyRows || [])
      .filter((sp) => sp.unlocked?.length && sp.info?.name)
      .forEach((sp) => {
        const dupe = list.find((x) => x.shop?.typeId === sp.typeId);
        if (dupe) {
          dupe.unlocked = sp.unlocked.length;
          return;
        }
        list.push({
          name: sp.label,
          missions: 0,
          at: [],
          shop: { typeId: sp.typeId, ...sp.info },
          education: sp.info.education || null,
          unlocked: sp.unlocked.length,
          source: 'unlocked',
        });
      });

    // Specialist vehicles you already own that need an education (e.g. DB-RI): untrained crew = a vehicle that stays home
    (data.specialistVehicles || []).forEach(({ vehicle, info }) => {
      if (list.some((x) => x.shop?.typeId === vehicle.vehicle_type)) return;
      list.push({ name: info.name, missions: 0, at: [], shop: { typeId: vehicle.vehicle_type, ...info }, education: info.education, source: 'owned' });
    });

    // Basic vehicles every post has in the VRU layout (OvD, TS, AL, HV…) are not specialists,
    // unless the VRU keeps them at specific posts (AB, NB, waterongevallen…)
    const baseTypes = new Set(Object.values(VRU_STATIONS).flatMap(([, vehiclesRef]) => vehiclesRef.map(([, t]) => t)));
    for (let i = list.length - 1; i >= 0; i--) {
      const typeId = list[i].shop?.typeId;
      if (typeId != null && baseTypes.has(typeId) && !vruHomeOf(list[i].name, typeId)) list.splice(i, 1);
    }

    list.forEach((sp) => {
      const vru = vruHomeOf(sp.name, sp.shop?.typeId);
      if (vru && /brush/i.test(sp.name)) sp.name = 'NB (natuurbrandvoertuig, spelcode "brush")';
      const typeId = sp.shop?.typeId ?? vru?.typeIds?.[0];
      const typeIds = sp.shop?.typeId != null ? [sp.shop.typeId] : vru?.typeIds || [];
      sp.ownedAt = vehicles.filter((v) => typeIds.includes(v.vehicle_type)).map((v) => stations.find((s) => s.id === v.building_id)).filter(Boolean);
      sp.home = specialistHome(sp, stations, data.stationRows);
      sp.allowed = !sp.shop?.minStations || sp.shop.minStations <= stations.length;
      sp.trained = trainedCount(data, sp.education);
      const reg = register[sp.name] || { firstSeen: now };
      sp.isNew = now - reg.firstSeen < 3 * 86400e3;
      register[sp.name] = { ...reg, lastSeen: now, typeId: typeId ?? null, home: sp.home.station?.caption?.trim() || reg.home || null };
    });
    try {
      localStorage.setItem(SPECIALIST_REGISTER_KEY, JSON.stringify(register));
    } catch (e) {
      /* best-effort */
    }
    // Most missed first, then most missions unlocked
    return list.sort((a, b) => b.missions - a.missions || (b.unlocked || 0) - (a.unlocked || 0));
  }

  /** Every education the vehicle shop asks for: which vehicles need it, how many you own, how many people are trained. */
  /**
   * Trained people without a car on their post. The car goes where the real VRU keeps it (Brandbase) first;
   * only without a VRU place do we fall back to the post with the most idle trained people.
   */
  function renderIdleTrained(data) {
    const wrap = document.createElement('div');
    if (!data.idleTrained?.length) return wrap;
    wrap.innerHTML = '<div style="margin-top:8px"><b>🎓 Opgeleid personeel zonder auto op de post</b></div>';
    data.idleTrained.forEach(({ education, types, owned, posts }) => {
      const idleAt = (st) => posts.find((x) => x.station.id === st.id)?.idle || 0;
      const eduKey = data.keyOf ? data.keyOf(education) : null;
      const trainedAt = (st) => (eduKey ? data.people.filter((p) => p.buildingId === st.id && p.keys.includes(eduKey)).length : 0);
      // Real VRU place per vehicle type; "open" = no such car there yet
      const placed = types
        .map((t) => ({ t, home: specialistHome({ name: t.name, education, shop: { typeId: t.typeId } }, data.stations, data.stationRows) }))
        .filter((x) => x.home.station && x.home.vru)
        .map((x) => ({ ...x, has: data.vehicles.some((v) => v.vehicle_type === x.t.typeId && v.building_id === x.home.station.id) }));
      const open = placed.find((x) => !x.has);
      let target;
      let advice;
      if (open) {
        target = open.home.station;
        const here = trainedAt(target);
        advice = `📍 VRU-plek: <b>${shortPost(target.caption)}</b> (${escapeHtml(open.home.why)}). ${
          here ? `${here} opgeleid op die post.` : 'Daar is nog niemand opgeleid: verplaats of train eerst.'
        }`;
      } else if (placed.length) {
        advice = `✅ Staat al op de VRU-plek (${placed.map((x) => shortPost(x.home.station.caption)).join(', ')}). Deze extra opgeleiden wachten op een tweede auto.`;
      } else {
        target = posts[0].station;
        advice = `Geen VRU-plek bekend: een (extra) auto op ${shortPost(target.caption)} is meteen bemand.`;
      }
      const abbr = [...new Set(types.map((t) => t.name.split(/\s+/)[0]))];
      const typeText = abbr.slice(0, 4).join(' / ') + (abbr.length > 4 ? ` +${abbr.length - 4}` : '');
      const list = posts.map((x) => `${shortPost(x.station.caption)} (${x.idle})`).join(', ');
      const row = document.createElement('div');
      row.setAttribute('data-mks-specialist', target ? 'opt' : 'ok');
      row.style.cssText = 'display:flex;justify-content:space-between;gap:6px;margin:3px 0';
      row.innerHTML = `<span>${target ? '🟡' : '🟢'} <b>${escapeHtml(education)}</b> <small class="text-muted">· ${escapeHtml(typeText)} · ${
        owned ? `${owned}× in bezit` : 'nog geen auto'
      }</small><br><small>Opgeleid zonder auto: ${list}</small><br><small>${advice}</small></span>`;
      if (target) {
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'btn btn-xs btn-default';
        a.textContent = 'Winkel';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          openLightbox(`/buildings/${target.id}/vehicles/new`);
        });
        row.append(a);
      }
      wrap.append(row);
    });
    return wrap;
  }

  function renderEducationCatalog(data, vehicles) {
    const byEdu = {};
    Object.entries(data.typeInfo || {}).forEach(([typeId, info]) => {
      if (!info.education) return;
      (byEdu[info.education] ||= []).push({ typeId: Number(typeId), name: info.name });
    });
    const rows = Object.entries(byEdu)
      .map(([education, types]) => ({
        education,
        types,
        trained: trainedCount(data, education),
        owned: vehicles.filter((v) => types.some((t) => t.typeId === v.vehicle_type)).length,
      }))
      .sort((a, b) => b.owned - a.owned || b.trained - a.trained || a.education.localeCompare(b.education));
    const details = document.createElement('details');
    details.style.marginTop = '6px';
    details.innerHTML = `<summary><b>🎓 Alle opleidingen in het spel (${rows.length})</b> <small class="text-muted">· ${rows.filter((r) => r.trained).length} heb je opgeleid personeel voor</small></summary>${rows
      .map(
        (r) =>
          `<div><small>${r.trained ? '🟢' : r.owned ? '🔴' : '⚪'} <b>${escapeHtml(r.education)}</b> · ${r.trained} opgeleid · ${r.owned}× voertuig in bezit<br><span class="text-muted">${r.types
            .slice(0, 4)
            .map((t) => escapeHtml(t.name.split(' ')[0]))
            .join(', ')}${r.types.length > 4 ? '…' : ''}</span></small></div>`
      )
      .join('')}`;
    return details;
  }

  async function renderSpecialists() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<em>Specialisten zoeken…</em>';
    (async () => {
      try {
        const [data, buildings, vehicles] = await Promise.all([analysePersonnel(), fetchJson('/api/buildings'), fetchJson('/api/vehicles')]);
        const list = collectSpecialists(data, buildings, vehicles);
        if (!list.length) {
          wrap.innerHTML =
            '<small class="text-muted">Nog niets ontdekt. Open meldingen zoals altijd: wat er gevraagd wordt en je niet hebt, komt hier vanzelf te staan.</small>';
          return;
        }
        const short = shortPost;
        wrap.innerHTML = '';
        list.forEach((sp) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;gap:6px;margin-bottom:6px';
          const owned = sp.ownedAt.length;
          // Action = missed and not owned (or not at its home); option = could unlock missions
          const untrained = sp.education && !sp.trained; // nobody can crew it
          const needsAction = (sp.missions > 0 && !owned) || (owned && untrained) || (sp.missions > 0 && untrained);
          row.dataset.mksSpecialist = needsAction ? 'act' : owned ? 'ok' : 'opt';
          const facts = [];
          if (sp.missions) facts.push(`<b>${sp.missions}× gemist</b> (14 d)`);
          if (sp.unlocked) facts.push(`${sp.unlocked} meldingstype(s)`);
          if (sp.shop && !owned) facts.push(`winkel: ${escapeHtml(sp.shop.name)}${sp.shop.price ? ` (${formatCredits(sp.shop.price)})` : ''}`);
          if (sp.education)
            facts.push(
              `opleiding <i>${escapeHtml(sp.education)}</i>: ${
                sp.trained ? `<b>${sp.trained}</b> opgeleid` : '<b class="text-danger">niemand opgeleid</b> — zie Opleidingen'
              }`
            );
          if (!sp.allowed) facts.push(`pas vanaf ${sp.shop.minStations} posten`);
          if (sp.home.extension) facts.push(`eerst uitbreiding ${escapeHtml(sp.home.extension.name)} (${formatCredits(sp.home.extension.price)})`);
          const home = sp.home.station
            ? `🏠 <b>${short(sp.home.station.caption)}</b> <small class="text-muted">(${escapeHtml(sp.home.why)})</small>`
            : `🏠 <small class="text-muted">${escapeHtml(sp.home.why)}</small>`;
          const have = owned
            ? `✅ ${owned}× in bezit: ${sp.ownedAt.map((s) => short(s.caption)).join(', ')}`
            : needsAction
              ? '❌ niet in je korps'
              : '➖ nog niet in bezit';
          const idle = owned && untrained ? ' <span class="label label-danger" title="Zonder opgeleid personeel rijdt hij niet uit">staat stil</span>' : '';
          row.innerHTML = `<span>${needsAction ? '🔴' : owned ? '🟢' : '⚪'} <b>${escapeHtml(sp.name)}</b>${idle}${
            sp.isNew ? ' <span class="label label-info">nieuw</span>' : ''
          }<br><small>${have} · ${facts.join(' · ')}</small><br><small>${home}</small></span>`;
          const right = document.createElement('span');
          right.style.whiteSpace = 'nowrap';
          if (sp.home.station) {
            const a = document.createElement('a');
            a.href = '#';
            a.className = 'btn btn-xs btn-default';
            a.textContent = sp.home.extension ? 'Gebouw' : 'Winkel';
            const url = sp.home.extension ? `/buildings/${sp.home.station.id}` : `/buildings/${sp.home.station.id}/vehicles/new`;
            a.addEventListener('click', (e) => {
              e.preventDefault();
              if (typeof unsafeWindow.lightboxOpen === 'function') unsafeWindow.lightboxOpen(url);
              else window.open(url, '_blank');
            });
            right.append(a);
          }
          row.append(right);
          wrap.append(row);
        });
        wrap.append(renderIdleTrained(data));
        wrap.append(renderEducationCatalog(data, vehicles));
        const foot = document.createElement('small');
        foot.className = 'text-muted';
        foot.textContent =
          'Gemist = een melding vroeg erom terwijl je er geen had (alarmeerhulp, 14 dagen). Thuiskazerne: echte VRU-indeling (Brandbase regio 09), anders de post het dichtst bij waar je hem miste.';
        wrap.append(foot);
      } catch (e) {
        console.error('[MKS→HA] Specialists failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Specialisten mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();
    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /* Sync: share what the script learned between devices (GitHub Gist)   */
  /* ------------------------------------------------------------------ */

  // One private gist, one JSON file: { v, devices: { <deviceId>: { name, ts, data: { <key>: value } } } }
  const SYNC_FILE = 'meldkamerspel-sync.json';
  const SYNC_REMOTE_TYPES = 'mks_sync_remote_types_v1'; // mission memory of the OTHER devices
  const SYNC_STATUS = 'mks_sync_status_v1';

  /**
   * Keys and how to merge them. `log` keys are keyed by mission id (or are lists of unique events):
   * merging is idempotent, so remote entries are folded into the local copy. Mission memory holds
   * running totals: it is kept per device and only added up when read (memoryTypesMerged).
   */
  const SYNC_KEYS = {
    mks_shortage_v1: 'byId',
    mks_not_owned_v1: 'byId',
    mks_extras_completed_v1: 'events',
    mks_extras_credit_snaps_v1: 'events',
    mks_specialists_v1: 'register',
    mks_mem_types_v1: 'perDevice',
  };

  const syncConfig = () => ({ token: GM_getValue('syncToken', ''), gistId: GM_getValue('syncGistId', '') });

  function syncDeviceId() {
    let id = GM_getValue('syncDevice', '');
    if (!id) {
      id = `d${Math.random().toString(36).slice(2, 10)}`;
      GM_setValue('syncDevice', id);
    }
    return id;
  }

  const syncDeviceName = () =>
    /iphone|ipad|android/i.test(navigator.userAgent) ? 'mobiel' : /windows/i.test(navigator.userAgent) ? 'Windows' : /mac/i.test(navigator.userAgent) ? 'Mac' : 'browser';

  const lsRead = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
    } catch (e) {
      return fallback;
    }
  };
  const lsWrite = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* best-effort */
    }
  };

  /** GitHub API call through Tampermonkey (no CORS limits); resolves with parsed JSON. */
  function githubApi(method, path, token, body) {
    return new Promise((resolve, reject) =>
      GM_xmlhttpRequest({
        method,
        url: `https://api.github.com${path}`,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(JSON.parse(res.responseText || '{}'));
            } catch (e) {
              reject(e);
            }
          } else reject(new Error(`GitHub ${res.status}`));
        },
        onerror: () => reject(new Error('GitHub niet bereikbaar')),
      })
    );
  }

  /* ---------- merging ---------- */

  /** Logs keyed by mission id: union; same mission on two devices → highest counts, earliest time. */
  function mergeById(a = {}, b = {}) {
    const out = { ...a };
    Object.entries(b).forEach(([id, entry]) => {
      const mine = out[id];
      if (!mine) return (out[id] = entry);
      const pick = (x = {}, y = {}) => {
        const m = { ...x };
        Object.entries(y).forEach(([k, n]) => (m[k] = Math.max(m[k] || 0, n)));
        return m;
      };
      out[id] = {
        ...mine,
        ts: Math.min(mine.ts || Infinity, entry.ts || Infinity),
        ...(mine.cats || entry.cats ? { cats: pick(mine.cats, entry.cats) } : {}),
        ...(mine.names || entry.names ? { names: pick(mine.names, entry.names) } : {}),
        at: mine.at || entry.at || null,
      };
    });
    return out;
  }

  /** Event lists ({ ts, … }): union without exact duplicates, sorted, last 30 days. */
  function mergeEvents(a = [], b = []) {
    const seen = new Set();
    return [...a, ...b]
      .filter((e) => {
        const key = JSON.stringify(e);
        if (seen.has(key)) return false;
        seen.add(key);
        return Date.now() - e.ts < 30 * 86400e3;
      })
      .sort((x, y) => x.ts - y.ts);
  }

  /** Specialist register: earliest first seen, latest last seen (with its home). */
  function mergeRegister(a = {}, b = {}) {
    const out = { ...a };
    Object.entries(b).forEach(([name, r]) => {
      const mine = out[name];
      if (!mine) return (out[name] = r);
      const newer = (r.lastSeen || 0) > (mine.lastSeen || 0) ? r : mine;
      out[name] = { ...newer, firstSeen: Math.min(mine.firstSeen || Infinity, r.firstSeen || Infinity) };
    });
    return out;
  }

  /** Mission memory of several devices added up (counts, sums; max for maxima; latest name/time). */
  function addMemoryTypes(...sets) {
    const out = {};
    sets.forEach((types) =>
      Object.entries(types || {}).forEach(([typeId, t]) => {
        const o = (out[typeId] = out[typeId] || { name: t.name, n: 0, usedSum: {}, required: {}, requiredMax: {} });
        o.name = t.name || o.name;
        o.n += t.n || 0;
        Object.entries(t.usedSum || {}).forEach(([k, v]) => (o.usedSum[k] = (o.usedSum[k] || 0) + v));
        Object.entries(t.required || {}).forEach(([k, v]) => (o.required[k] = (o.required[k] || 0) + v));
        Object.entries(t.requiredMax || {}).forEach(([k, v]) => (o.requiredMax[k] = Math.max(o.requiredMax[k] || 0, v)));
        o.last = Math.max(o.last || 0, t.last || 0);
      })
    );
    return out;
  }

  /** Mission memory to READ: this device plus every other synced device. Writes stay local. */
  function memoryTypesMerged() {
    const remote = lsRead(SYNC_REMOTE_TYPES, {});
    return addMemoryTypes(lsRead('mks_mem_types_v1', {}), ...Object.values(remote));
  }

  /** Folds the other devices' data into this browser; returns the remote mission memory per device. */
  function applyRemote(devices, self) {
    const remoteTypes = {};
    Object.entries(devices || {}).forEach(([id, dev]) => {
      if (id === self) return;
      Object.entries(SYNC_KEYS).forEach(([key, how]) => {
        const value = dev.data?.[key];
        if (value === undefined) return;
        if (how === 'perDevice') remoteTypes[id] = value;
        else if (how === 'byId') lsWrite(key, mergeById(lsRead(key, {}), value));
        else if (how === 'events') lsWrite(key, mergeEvents(lsRead(key, []), value));
        else if (how === 'register') lsWrite(key, mergeRegister(lsRead(key, {}), value));
      });
    });
    lsWrite(SYNC_REMOTE_TYPES, remoteTypes);
  }

  /* ---------- sync run ---------- */

  let syncBusy = false;

  /** Download → merge → upload this device's own data. Quietly does nothing without a token. */
  async function syncNow() {
    const { token, gistId } = syncConfig();
    if (!token || syncBusy) return null;
    syncBusy = true;
    try {
      const self = syncDeviceId();
      let id = gistId;
      let doc = { v: 1, devices: {} };
      if (id) {
        const gist = await githubApi('GET', `/gists/${id}`, token);
        const file = gist.files?.[SYNC_FILE];
        if (file?.content) doc = JSON.parse(file.content);
      }
      applyRemote(doc.devices, self);

      const data = {};
      Object.keys(SYNC_KEYS).forEach((key) => {
        const value = lsRead(key, null);
        if (value !== null) data[key] = value;
      });
      doc.devices = { ...(doc.devices || {}), [self]: { name: syncDeviceName(), ts: Date.now(), data } };
      const body = { files: { [SYNC_FILE]: { content: JSON.stringify(doc) } } };
      if (id) await githubApi('PATCH', `/gists/${id}`, token, body);
      else {
        const created = await githubApi('POST', '/gists', token, { ...body, public: false, description: 'Meldkamerspel-script: gedeelde leerdata' });
        id = created.id;
        GM_setValue('syncGistId', id);
      }
      const status = { ts: Date.now(), ok: true, devices: Object.values(doc.devices).map((d) => `${d.name} (${new Date(d.ts).toLocaleString('nl-NL')})`) };
      lsWrite(SYNC_STATUS, status);
      log('Synced', status);
      return status;
    } catch (e) {
      console.error('[MKS→HA] Sync failed', e);
      lsWrite(SYNC_STATUS, { ts: Date.now(), ok: false, error: e.message });
      return null;
    } finally {
      syncBusy = false;
    }
  }

  /** Tampermonkey menu: token (gist rights only) and, on the 2nd/3rd device, the gist id of the first. */
  function registerSyncMenu() {
    GM_registerMenuCommand('Synchronisatie instellen (leerdata delen)', async () => {
      const token = window.prompt(
        'GitHub-token met alleen "gist"-rechten (github.com → Settings → Developer settings → Personal access tokens).\nLeeg = synchronisatie uit.',
        GM_getValue('syncToken', '')
      );
      if (token === null) return;
      const gistId = window.prompt(
        'Gist-ID. Op je eerste apparaat leeg laten: het script maakt er een. Op je andere apparaten het ID van het eerste apparaat invullen (staat in VRU-paneel → Instellingen).',
        GM_getValue('syncGistId', '')
      );
      if (gistId === null) return;
      GM_setValue('syncToken', token.trim());
      GM_setValue('syncGistId', gistId.trim());
      const status = token.trim() ? await syncNow() : null;
      window.alert(
        !token.trim()
          ? 'Synchronisatie staat uit.'
          : status
            ? `Gesynchroniseerd. Gist-ID: ${GM_getValue('syncGistId', '')}\nApparaten: ${status.devices.join(', ')}`
            : 'Synchroniseren mislukt: controleer token en gist-ID (F12 → console).'
      );
    });
  }

  /** Every 15 minutes and when the page starts (a few seconds in, so the game loads first). */
  function startSync() {
    if (!syncConfig().token) return;
    setTimeout(syncNow, 5000);
    setInterval(syncNow, 15 * 60e3);
  }

  /** One line for the settings section. */
  function syncStatusText() {
    const { token, gistId } = syncConfig();
    if (!token) return 'Synchronisatie: uit (Tampermonkey-menu → Synchronisatie instellen)';
    const s = lsRead(SYNC_STATUS, null);
    const when = s ? new Date(s.ts).toLocaleString('nl-NL') : 'nog niet';
    return s?.ok
      ? `Synchronisatie: ${when} · gist ${gistId} · apparaten: ${s.devices.join(', ')}`
      : `Synchronisatie: ${s ? `mislukt (${s.error})` : 'wacht op eerste run'} · gist ${gistId || '(nog geen)'}`;
  }

  /* ------------------------------------------------------------------ */
  /* Training queue: what to train next, ready for when a classroom frees */
  /* ------------------------------------------------------------------ */

  const NL_MONTHS = { jan: 0, feb: 1, mrt: 2, apr: 3, mei: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11 };

  /** "ma 30 nov 2026 19:33:21 CET" → timestamp (local time of the player's browser); null when unreadable. */
  function parseDutchDate(text) {
    const m = String(text).match(/(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
    if (!m || !(m[2].toLowerCase() in NL_MONTHS)) return null;
    return new Date(Number(m[3]), NL_MONTHS[m[2].toLowerCase()], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0)).getTime();
  }

  /** Academy page → whether a classroom is free, the running lessons and the price of an extra classroom. */
  function parseAcademyDoc(doc) {
    const lessons = doc.querySelector('#schooling')?.textContent.replace(/\s+/g, ' ').trim() || '';
    const running = [...doc.querySelectorAll('#schooling_running a[href]')]
      .filter((a) => /^\/schoolings\/\d+$/.test(a.getAttribute('href')))
      .map((a) => {
        const cells = [...(a.closest('tr')?.children || [])].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
        return { id: Number(a.getAttribute('href').split('/').pop()), education: a.textContent.trim(), freeSeats: Number(cells[2]) || 0 };
      });
    const ext = doc.querySelector('#ausbauten')?.textContent.replace(/\s+/g, ' ') || '';
    const price = ext.match(/Extra klaslokaal.*?(\d{1,3}(?:\.\d{3})+)\s*Credits/i)?.[1];
    // "Adviseur Gevaarlijke Stoffen (6 dagen)": length of each education, shown by the game when a classroom is free
    const days = {};
    doc.querySelectorAll('#schooling select[name="education_select"] option').forEach((o) => {
      const m = o.textContent.match(/^(.*?)\s*\((\d+) dagen\)/);
      if (m) days[m[1].trim()] = Number(m[2]);
    });
    return {
      days,
      free: !/bezet/i.test(lessons) && lessons.length > 0,
      lessonsText: lessons.slice(0, 200),
      running,
      extraClassroomPrice: price ? Number(price.replace(/\./g, '')) : null,
    };
  }

  /** One running lesson: when it ends and how many people take part. */
  function parseSchoolingDoc(doc) {
    const text = doc.body.textContent.replace(/\s+/g, ' ');
    const rows = [...doc.querySelectorAll('table tr')].filter((r) => r.querySelector('td'));
    return {
      endsAt: parseDutchDate(text.match(/loopt tot ([^.]*?CES?T|[^.]*?\d{2}:\d{2}(?::\d{2})?)/i)?.[1] || ''),
      people: rows.length,
      station: rows[0]?.children[3]?.textContent.trim() || '',
    };
  }

  let academyStateCache = null;
  async function loadAcademyState() {
    if (academyStateCache && Date.now() - academyStateCache.ts < 60e3) return academyStateCache.value;
    const buildings = await fetchJson('/api/buildings');
    const academies = [];
    for (const b of buildings.filter((x) => x.building_type === FIRE_ACADEMY_TYPE)) {
      const info = parseAcademyDoc(await fetchDoc(`/buildings/${b.id}`));
      for (const lesson of info.running) Object.assign(lesson, parseSchoolingDoc(await fetchDoc(`/schoolings/${lesson.id}`)));
      academies.push({ id: b.id, caption: b.caption.trim(), ...info });
    }
    const days = Object.assign({}, ...academies.map((a) => a.days));
    const value = { academies, days };
    academyStateCache = { ts: Date.now(), value };
    return value;
  }

  /**
   * Ordered list of educations worth starting, so they can go into a classroom the moment one is free.
   * Priority: vehicle already owned but nobody trained (it stands idle) → missed missions → unlocked mission types.
   * Educations already running are flagged, not repeated.
   */
  function buildTrainingQueue(specialists, academyState, extensionNeeds = []) {
    const running = new Map();
    (academyState?.academies || []).forEach((a) => a.running.forEach((l) => running.set(l.education, { ...l, academy: a })));
    const fromSpecialists = specialists
      .filter((sp) => sp.education && !sp.trained)
      .map((sp) => {
        const lesson = running.get(sp.education);
        const owned = sp.ownedAt.length > 0;
        return {
          education: sp.education,
          vehicle: sp.name,
          owned,
          missions: sp.missions || 0,
          unlocked: sp.unlocked || 0,
          people: Math.max(1, sp.shop?.minCrew || 1),
          station: sp.home.station || sp.ownedAt[0] || null,
          running: lesson || null,
          days: academyState?.days?.[sp.education] || null,
          score: (owned ? 3000 : 0) + (sp.missions || 0) * 100 + (sp.unlocked || 0) * 10,
        };
      })
    // Extension vehicles (DB-VI…) you do not own yet are not in the specialists list but need the same planning
    const known = new Set(fromSpecialists.map((q) => q.education));
    const fromExtensions = extensionNeeds
      .filter((x) => !known.has(x.education))
      .map((x) => ({
        education: x.education,
        vehicle: x.name,
        owned: false,
        missions: x.missed,
        unlocked: x.count,
        people: Math.max(1, x.minCrew || 1),
        station: null,
        running: running.get(x.education) || null,
        days: academyState?.days?.[x.education] || null,
        score: x.missed * 100 + x.count * 10,
      }));
    return [...fromSpecialists, ...fromExtensions].sort((a, b) => !!a.running - !!b.running || b.score - a.score);
  }

  async function renderTraining() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<em>Opleidingen laden…</em>';
    (async () => {
      try {
        const [data, buildings, vehicles, academyState] = await Promise.all([
          analysePersonnel(),
          fetchJson('/api/buildings'),
          fetchJson('/api/vehicles'),
          loadAcademyState(),
        ]);
        data.extensionStats ||= await loadExtensionMissionStats(countFireStations(buildings)).catch(() => ({})); // shared with the plan
        const queue = buildTrainingQueue(collectSpecialists(data, buildings, vehicles), academyState, untrainedExtensionNeeds(data, notOwnedStats()));
        const short = shortPost;
        const open = (url) => (typeof unsafeWindow.lightboxOpen === 'function' ? unsafeWindow.lightboxOpen(url) : window.open(url, '_blank'));
        const when = (ts) => {
          if (!ts) return 'onbekend';
          const left = ts - Date.now();
          const days = Math.floor(left / 864e5);
          const hours = Math.floor((left % 864e5) / 36e5);
          return `${new Date(ts).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (${
            left <= 0 ? 'nu' : days ? `over ${days}d ${hours}u` : `over ${hours}u`
          })`;
        };
        wrap.innerHTML = '';
        const line = (html, attr, ...buttons) => {
          const r = makeRow(html, ...buttons);
          if (attr) r.dataset.mksTraining = attr;
          wrap.append(r);
        };
        const btn = (label, url) => {
          const a = document.createElement('a');
          a.href = '#';
          a.className = 'btn btn-xs btn-default';
          a.textContent = label;
          a.addEventListener('click', (e) => {
            e.preventDefault();
            open(url);
          });
          return a;
        };

        if (!academyState.academies.length) {
          line('🏫 <b>Nog geen academie.</b> <small>Bouw er een (Brandweer, Academie) om zelf specialisten op te leiden; de wachtrij hieronder staat dan klaar.</small>');
        }
        academyState.academies.forEach((a) => {
          const first = a.running.map((l) => l.endsAt).filter(Boolean).sort((x, y) => x - y)[0];
          line(
            `🏫 <b>${short(a.caption)}</b><br><small>${
              a.free
                ? '<b class="text-success">Klaslokaal vrij</b>: start nu de eerstvolgende opleiding uit de wachtrij.'
                : `Alle klaslokalen bezet${first ? `: eerstvolgende vrij ${when(first)}` : ''}.`
            }${a.extraClassroomPrice ? ` Extra klaslokaal: ${formatCredits(a.extraClassroomPrice)}.` : ''}</small>`,
            a.free && queue.some((q) => !q.running) ? 'act' : null,
            btn('Academie', `/buildings/${a.id}`)
          );
          a.running.forEach((l) =>
            line(
              `▶️ <b>${escapeHtml(l.education)}</b> <small class="text-muted">· bezig${l.people ? ` · ${l.people} personen${l.station ? ` van ${escapeHtml(l.station.replace(`${CONFIG.vru.prefix} `, ''))}` : ''}` : ''} · klaar ${when(l.endsAt)}</small>`
            )
          );
        });

        if (!queue.length) {
          wrap.append(Object.assign(document.createElement('small'), { className: 'text-muted', textContent: 'Wachtrij leeg: voor alle bekende specialisten is iemand opgeleid. ✅' }));
          return;
        }
        const h = document.createElement('div');
        h.innerHTML = '<b>Wachtrij: dit opleiden zodra er een klaslokaal vrij is</b>';
        h.style.margin = '8px 0 4px';
        wrap.append(h);
        let n = 0;
        queue.forEach((q) => {
          const why = [
            q.owned ? '<b>voertuig staat al stil</b>' : null,
            q.missions ? `${q.missions}× gemist (14 d)` : null,
            q.unlocked ? `${q.unlocked} meldingstype(s)` : null,
          ].filter(Boolean);
          line(
            `${q.running ? '▶️' : `<b>${++n}.</b>`} <b>${escapeHtml(q.education)}</b> <small class="text-muted">· voor ${escapeHtml(q.vehicle)}</small><br><small>${
              q.running
                ? `loopt al, klaar ${when(q.running.endsAt)}`
                : `${q.days ? `${q.days} dagen · ` : ''}${q.people} personen${q.station ? ` van <b>${short(q.station.caption)}</b>` : ''}${why.length ? ` · ${why.join(' · ')}` : ''}`
            }</small>`,
            q.running ? null : 'opt'
          );
        });
        const foot = document.createElement('small');
        foot.className = 'text-muted';
        foot.textContent =
          'Kies bij het starten personeel van de aangegeven post: de opgeleiden kunnen dan direct op hun voertuig worden gekoppeld (zie Herverdelen). Per opleiding kun je maximaal 10 personen tegelijk laten meedoen; tijdens de opleiding zijn zij niet inzetbaar.';
        wrap.append(foot);
      } catch (e) {
        console.error('[MKS→HA] Training queue failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Opleidingen mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();
    return wrap;
  }
  boot();
})();
