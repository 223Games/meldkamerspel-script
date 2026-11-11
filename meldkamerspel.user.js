// ==UserScript==
// @name         Meldkamerspel → Home Assistant + Alarmeerhulp + VRU
// @namespace    https://223studio.nl/
// @version      7.2.1
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
    if (isMainPage) registerSettingsMenu();
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

  function tryDispatchAssistant(doc) {
    const isMissionPage = /^\/missions\/\d+/.test(doc.location?.pathname || '') && !!doc.getElementById('mission-form');
    if (!isMissionPage || doc.documentElement.dataset.mksAssist) return; // not a mission, or already running
    doc.documentElement.dataset.mksAssist = '1';
    initDispatchAssistant(doc);
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
    const categoryOf = (row) => {
      const caption = (row.querySelector('small.vehicle_caption, small')?.textContent || '').replace(/[()]/g, '').trim();
      return Object.keys(DISPATCH_CATEGORIES).find((k) => DISPATCH_CATEGORIES[k].caption.test(caption)) || null;
    };
    const backLink = (row) =>
      row.querySelector('a[href*="backalarm"]') ||
      [...row.querySelectorAll('a, button')].find((el) => /retour\s*post|terug/i.test(el.textContent) && el.getAttribute('href'));

    // First-arriving vehicles fill what is still missing; the rest is surplus
    const stillNeeded = { ...missing };
    const surplus = [];
    rows
      .sort((a, b) => arrival(a) - arrival(b))
      .forEach((row) => {
        const key = categoryOf(row);
        if (!key && Object.keys(missing).length) return; // unrecognised vehicle while something is missing: keep
        if (key && stillNeeded[key] > 0) {
          stillNeeded[key] -= 1; // a teammate's vehicle arriving first also fills the gap
          return;
        }
        if (!isOwn(row)) return;
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
    firetrucks: { label: 'TS', caption: /^TST?(-NB)?\s*\d/i, missing: /Tankautospuit/i },
    platform_trucks: { label: 'AL/HW', caption: /^(AL|HW)$/i, missing: /Redvoertuig|Autoladder|Hoogwerker/i },
    mobile_command_vehicles: { label: 'HOvD', caption: /^DA-HOD$/i, missing: /Hoofd\s*Officier\s*van\s*Dienst|HOVD/i },
    hazmat_vehicles: { label: 'AGS', caption: /^DA-AGS$/i, missing: /Adviseurs?\s*Gevaarlijke\s*Stoffen/i },
    elw3: { label: 'CO', caption: /^CO$/i, missing: /Commandowagen|Commandovoertuig/i },
    gwmess: { label: 'VEB', caption: /^DB-VEB$/i, missing: /Verkenningseenhe/i },
    mobile_air_vehicles: { label: 'AB', caption: /^AB$/i, missing: /Adembescherming/i },
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
        const { needed, notOwned, info, enRoute } = await calculateNeeded(typeId);
        const { selected, short } = selectVehicles(needed);
        if (Object.keys(short).length && (await loadMoreVehicles())) {
          // Far-away vehicles were not in the list yet: try again for what is still short
          const retry = selectVehicles({ ...short });
          Object.keys(short).forEach((k) => delete short[k]);
          Object.assign(short, retry.short);
          Object.entries(retry.selected).forEach(([k, n]) => (selected[k] = (selected[k] || 0) + n));
        }
        if (short.water_tankers) logWaterDebug();
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

    function captionOfAssignedRow(row) {
      return (row.querySelector('small.vehicle_caption')?.textContent || '').replace(/[()]/g, '').trim();
    }

    function countByCategory(captions) {
      const counts = {};
      captions.forEach((caption) => {
        for (const [key, cat] of Object.entries(CATEGORIES)) {
          if (cat.caption.test(caption)) {
            counts[key] = (counts[key] || 0) + 1;
            break;
          }
        }
      });
      return counts;
    }

    function parseMissingText() {
      const el = doc.querySelector('#missing_text [data-requirement-type="vehicles"]');
      return el ? parseMissingVehicles(el.textContent) : null;
    }

    async function calculateNeeded(typeId) {
      const driving = countByCategory(
        [...doc.querySelectorAll('#mission_vehicle_driving tbody tr')].map(captionOfAssignedRow),
      );
      const atMission = countByCategory(
        [...doc.querySelectorAll('#mission_vehicle_at_mission tbody tr')].map(captionOfAssignedRow),
      );

      const needed = {};
      const notOwned = [];
      const info = [];
      const enRoute = {}; // "missing" per the game, but already driving there

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
        log('Using missing text', missingText, 'driving', driving);
      } else {
        // New mission: use the mission type requirements
        const types = await loadMissionTypes();
        const type = types[typeId];
        if (!type) throw new Error(`meldingstype ${typeId} onbekend`);

        for (const [key, count] of Object.entries(type.r)) {
          if (NON_VEHICLE_KEYS.test(key)) continue;
          const chance = type.c[key];
          if (chance !== undefined && chance < CONFIG.minChance) continue;

          if (!CATEGORIES[key]) {
            notOwned.push(`${count}× ${key}${chance !== undefined ? ` (${chance}%)` : ''}`);
            continue;
          }
          needed[key] = Math.max(0, count - (driving[key] || 0) - (atMission[key] || 0));
        }
        log('Using requirements for type', typeId, type, '→', needed);
      }

      return { needed, notOwned, info, enRoute };
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

    function selectVehicles(needed) {
      const rows = [...doc.querySelectorAll('#vehicle_show_table_body_all tr.vehicle_select_table_tr')].sort(
        (a, b) => parseFloat(a.dataset.distance || 999) - parseFloat(b.dataset.distance || 999),
      );

      const selected = {};
      const short = {};

      for (const [key, count] of Object.entries(needed)) {
        let remaining = count;
        for (const row of rows) {
          if (remaining <= 0) break;
          const checkbox = row.querySelector('.vehicle_checkbox');
          if (!checkbox || checkbox.checked) continue;
          if (!rowMatchesCategory(key, row)) continue;

          checkbox.click(); // click (not .checked) so the game updates its own counters
          remaining--;
          selected[key] = (selected[key] || 0) + 1;
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
      const assignedTypeIds = [...doc.querySelectorAll('#mission_vehicle_driving tbody tr, #mission_vehicle_at_mission tbody tr')]
        .map((row) => row.querySelector('a[vehicle_type_id]')?.getAttribute('vehicle_type_id'))
        .filter(Boolean);

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
        const present = barHas('at_mission') + barHas('driving');
        let selectedWater = checkedBoxes().reduce((s, c) => s + num(c.getAttribute('wasser_amount')), 0);
        const missing = waterNeeded - present - selectedWater;
        if (missing > 0) selectedWater += topUp('wasser_amount', missing);
        const total = present + selectedWater;
        const ok = total >= waterNeeded;
        lines.push({
          ok,
          text: `<b>Water:</b> ${fmtNum(total)}/${fmtNum(waterNeeded)} l ${ok ? '✓' : '— niet genoeg beschikbaar'}`,
        });
      }

      // Pump capacity
      const types = await loadMissionTypes();
      const pumpNeeded = num(types[typeId]?.r?.min_pump_speed);
      if (pumpNeeded > 0) {
        const present = assignedTypeIds.reduce((s, t) => s + (capacity[t]?.pump || 0), 0);
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
      const assigned = [...doc.querySelectorAll('#mission_vehicle_driving tbody tr, #mission_vehicle_at_mission tbody tr')].map(captionOfAssignedRow);
      const selectedCaptions = [...doc.querySelectorAll('#mission-form .vehicle_checkbox:checked')].map(
        (c) => c.closest('tr')?.getAttribute('vehicle_type') || ''
      );
      const used = countByCategory([...assigned, ...selectedCaptions]);
      const atMission = countByCategory([...doc.querySelectorAll('#mission_vehicle_at_mission tbody tr')].map(captionOfAssignedRow));
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
    const pane = doc.getElementById('all') || doc.body;
    const num = (s) => parseInt(String(s).replace(/\./g, ''), 10) || 0;
    return [...pane.querySelectorAll('.task_panel.hidden-xs')].map((p) => {
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
        done: progress ? num(progress[1]) : 0,
        total: progress ? num(progress[2]) : 1,
        reward,
        claimable,
        form,
      };
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
        body.append(
          section('🎯 Prioriteiten, teamhulp & vergeten voertuigen', await renderPriorities(), true),
          section('📋 Taken', renderTasks(tasks), false),
          section('👥 Werving', renderHiring(fireStations), false),
          section('🧭 Ontwikkelplan (incl. personeel)', await renderPlan(balance), true),
          section('🔀 Herverdelen: voertuigen & personeel', await renderRedistribution(), true),
          section('📚 Inzetgeheugen per melding', await renderMissionMemory(), false),
          section('🗺️ VRU-voortgang', renderProgress(fireStations, buildings, vehicles), false),
          section('📈 Rapport', await renderReport(balance, fireStations.length), false),
          section('⚙️ Instellingen', renderSettings(), false),
        );
        updateBadge();
      } catch (e) {
        console.error('[MKS→HA] Panel failed', e);
        body.innerHTML = `<div class="alert alert-danger">Laden mislukt: ${escapeHtml(e.message)}</div>`;
      }
    }

    function section(title, content, isOpen) {
      const details = document.createElement('details');
      details.open = isOpen;
      details.style.marginBottom = '8px';
      details.innerHTML = `<summary style="cursor:pointer;font-weight:bold;margin-bottom:4px">${title}</summary>`;
      details.append(content);
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
              `<div style="margin-bottom:2px">${complete ? '✅' : '🟡'} 09-${s.code} ${escapeHtml(VRU_STATIONS[s.code][0])} <small class="text-muted">${
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

  /** Builds the complete picture; pure data, no UI. */
  // Panels ask for this several times at once (plan, redistribution, personnel): share one result for 15 s
  let personnelCache = null;
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

    return { stations, stationRows, people, vehicles, typeInfo, specialistVehicles, specialtyRows, stationCount, keyOf };
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
    const short = (caption) => escapeHtml(caption.trim().replace(`${CONFIG.vru.prefix} `, ''));
    const actionButton = (label, onClick, cls = 'btn-success', confirmText = null) => {
      const a = document.createElement('a');
      a.href = '#';
      a.className = `btn btn-xs ${cls}`;
      a.style.marginLeft = '6px';
      a.textContent = label;
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        if (a.dataset.busy) return;
        if (confirmText && !window.confirm(confirmText)) return;
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
          if (ok !== false) {
            invalidatePersonnel(); // data changed: next render must refetch
            setTimeout(render, 900);
          }
        } catch (err) {
          console.error('[MKS→HA]', err);
          a.textContent = 'Mislukt';
          a.title = err.message;
          a.className = 'btn btn-xs btn-danger';
        }
      });
      return a;
    };
    const row = (html, ...buttons) => {
      const r = el(`<span>${html}</span>`);
      r.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:5px';
      const right = document.createElement('span');
      right.style.whiteSpace = 'nowrap';
      buttons.filter(Boolean).forEach((b) => right.append(b));
      r.append(right);
      return r;
    };

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

        // Nobody here: transfer from another station
        const donors = data.stationRows
          .filter((r) => r.station.id !== s.station.id && r.transferable > 0)
          .map((r) => ({ r, people: r.staff.filter((p) => s.key && p.keys.includes(s.key) && !p.boundVehicleId) }))
          .filter((d) => d.people.length)
          .sort((a, b) => b.people.length - a.people.length);
        if (donors.length && transfer.remaining > 0) {
          const d = donors[0];
          const pick = d.people.slice(0, Math.min(missing, d.r.transferable, transfer.remaining));
          wrap.append(
            row(
              `❌ ${base}<small>Geen opgeleid personeel op deze post. ${pick.length}× ${escapeHtml(
                s.info.education
              )} beschikbaar in ${short(d.r.station.caption)}.</small>`,
              actionButton(
                `Verplaats ${pick.length}`,
                () => transferPersonnel(s.station.id, pick.map((p) => p.id)),
                'btn-warning',
                `${pick.map((p) => p.name).join(', ')} van ${d.r.station.caption.trim()} naar ${s.station.caption.trim()} verplaatsen?\n\nDit kan NIET ongedaan worden en kost ${pick.length} van je ${transfer.remaining} verplaatsingen deze week.`
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

      // Training options
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
  const PLAN_EXTENSIONS = [
    { typeId: 26, key: 'thatched_fire', name: 'Rietkapbrandbestrijding', price: 150000, days: 5, vehicle: 'DB-RI of RIA', station: '51' },
    { typeId: 27, key: 'livestock_fire', name: 'Veetakels', price: 150000, days: 5, vehicle: 'DB-VI', station: '62' },
  ];

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
        const stats = data.extensionStats?.[ext.key];
        if (!stats?.count || ext.planned) return;
        if (buildings.some((b) => (b.extensions || []).some((e) => e.type_id === ext.typeId))) return; // already built/being built
        const station =
          sim.find((s) => s.code === ext.station) || [...sim].sort((a, b) => a.used - b.used)[0];
        if (!station) return;
        const cost = ext.price + DEFAULT_VEHICLE_PRICE; // + its vehicle
        const value = 6 + stats.count * 2.5 * Math.min(1.5, stats.avgCredits / 1500);
        candidates.push({ kind: 'extension', ext, stats, s: station, cost, value });
      });

      // 4. New stations (coverage), best-ranked first
      unbuilt.forEach((u, i) => {
        if (u.planned) return;
        candidates.push({ kind: 'station', u, cost: stationBuildPrice(stationsInPlan), value: Math.max(4, 14 - i * 2) });
      });

      if (!candidates.length) break;
      const pick = candidates.sort((a, b) => b.value / b.cost - a.value / a.cost)[0];

      // Apply to the simulation
      if (pick.kind === 'extension') {
        pick.ext.planned = true;
        steps.push({ ...pick, personnel: { ok: true, text: `daarna ${pick.ext.vehicle} kopen (eigen parkeerplek)` } });
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
      .map((sp) => ({ sp, education: sp.info.education, need: Math.max(1, sp.info.minCrew || 0), full: sp.info.maxCrew }));

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
              e.type_id === 15 ? ': pas aanzetten als je een natuurbrandvoertuig (DA-LA-NB, VW-NB of NBH) hebt' : ''
            }`
          );
      })
    );
    // Worthwhile extensions that did not make it into the top of the plan: still show them
    PLAN_EXTENSIONS.forEach((ext) => {
      const stats = data.extensionStats?.[ext.key];
      if (ext.planned || !stats?.count) return;
      if (buildings.some((b) => (b.extensions || []).some((e) => e.type_id === ext.typeId))) return;
      const station = sim.find((x) => x.code === ext.station);
      notes.push(
        `🧩 Later: <b>${escapeHtml(ext.name)}</b> (${formatCredits(ext.price)} + ${escapeHtml(ext.vehicle)}) op ${
          station ? escapeHtml(station.station.caption.trim().replace(`${CONFIG.vru.prefix} `, '')) : `09-${ext.station}`
        } → +${stats.count} meldingstypes, gem. ${formatCredits(stats.avgCredits)} cr`
      );
    });
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
        data.extensionStats = await loadExtensionMissionStats(stationCount).catch(() => ({}));
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
        const short = (caption) => escapeHtml(caption.trim().replace(`${CONFIG.vru.prefix} `, ''));

        let cumulative = 0;
        let affordable = 0;
        const list = document.createElement('div');
        steps.forEach((step, i) => {
          cumulative += step.cost;
          const canNow = cumulative <= balance;
          if (canNow) affordable = i + 1;

          let title;
          let detail;
          const buttons = [];
          if (step.kind === 'extension') {
            title = `🧩 <b>${short(step.s.station.caption)}</b>: uitbreiding <b>${escapeHtml(step.ext.name)}</b> (${step.ext.days} dagen)`;
            detail = `+${step.stats.count} meldingstypes, gem. ${formatCredits(step.stats.avgCredits)} cr (${escapeHtml(
              step.stats.names.slice(0, 3).join(', ')
            )}…) · 👷 ${escapeHtml(step.personnel.text)}`;
            buttons.push(linkButton('Gebouw', open(`/buildings/${step.s.station.id}`)));
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
          row.innerHTML = `<span>${i + 1}. ${title}<br><small class="text-muted">${formatCredits(step.cost)} · totaal ${formatCredits(cumulative)}${
            canNow ? ' · <span class="text-success">kan nu</span>' : ''
          }</small><br><small>${detail}</small></span>`;
          const right = document.createElement('span');
          right.style.whiteSpace = 'nowrap';
          buttons.forEach((b) => right.append(b));
          row.append(right);
          list.append(row);
        });

        const intro = document.createElement('div');
        intro.innerHTML = `<small class="text-muted">Saldo ${formatCredits(balance)} · ${
          affordable ? `stap 1–${affordable} kun je nu doen` : 'spaar voor stap 1'
        } · volgorde = meeste waarde per credit, rekening houdend met plekken, levels en personeel<br>Nieuwe post nu: ${formatCredits(
          stationBuildPrice(stationCount, true)
        )} (klein) / ${formatCredits(stationBuildPrice(stationCount, false))} (normaal) · elke post maakt de volgende duurder</small>${
          notes.length ? `<br><small>${notes.join('<br>')}</small>` : ''
        }`;
        intro.style.marginBottom = '6px';
        wrap.append(intro, list);

        if (training.length) {
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
    const stats = memRead(MEMORY_KEYS.types, {})[typeId] || null;
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

  // Extra AAOs for mobile, on top of "1. TS" … "12. Groot + HOvD". Keys = AAO form fields.
  const EXTRA_AAOS = [
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
        const memory = memRead(MEMORY_KEYS.types, {});

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
        const short = (caption) => escapeHtml(caption.trim().replace(`${CONFIG.vru.prefix} `, ''));
        wrap.innerHTML = '';

        const button = (label, onClick, cls, confirmText) => {
          const a = document.createElement('a');
          a.href = '#';
          a.className = `btn btn-xs ${cls}`;
          a.style.marginLeft = '4px';
          a.textContent = label;
          a.addEventListener('click', async (e) => {
            e.preventDefault();
            if (a.dataset.busy || (confirmText && !window.confirm(confirmText))) return;
            a.dataset.busy = '1';
            a.textContent = '…';
            try {
              await onClick();
              a.textContent = '✓';
              a.className = 'btn btn-xs btn-default';
            } catch (err) {
              console.error('[MKS→HA]', err);
              a.textContent = 'Mislukt';
              a.title = err.message;
              a.className = 'btn btn-xs btn-danger';
            }
          });
          return a;
        };
        const line = (html, ...buttons) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;gap:6px;margin-bottom:6px';
          row.innerHTML = `<span>${html}</span>`;
          const right = document.createElement('span');
          right.style.whiteSpace = 'nowrap';
          buttons.forEach((b) => right.append(b));
          row.append(right);
          wrap.append(row);
        };
        const heading = (text) => {
          const h = document.createElement('div');
          h.style.cssText = 'font-weight:bold;margin:6px 0 3px';
          h.textContent = text;
          wrap.append(h);
        };

        if (!moves.length && !renames.length && !stuck.length && !transfers.length) {
          wrap.innerHTML = '<em>Alles staat op de juiste post en het personeel is in balans. ✅</em>';
          return;
        }

        if (moves.length || renames.length || stuck.length) heading('🚒 Voertuigen die hier officieel niet horen');
        renames.forEach((r) =>
          line(
            `✏️ <b>${short(r.vehicle.caption)}</b> <small class="text-muted">· ${short(r.station.caption)}</small><br><small>Hoort hier wel, maar onder het officiële nummer → <b>${short(r.to)}</b></small>`,
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

  /** Missions in one of the game's sidebar lists, read from the page itself. */
  function readMissionList(selector) {
    return [...document.querySelectorAll(`${selector} .missionSideBarEntry`)]
      .filter((e) => !e.classList.contains('mission_deleted') && e.style.display !== 'none')
      .map((entry) => {
        const id = entry.getAttribute('mission_id');
        const panel = entry.querySelector(`#mission_panel_${id}`);
        const missingText = (entry.querySelector(`#mission_missing_${id}`)?.textContent || '').trim();
        return {
          id,
          caption: (entry.querySelector(`#mission_caption_${id}`)?.firstChild?.textContent || 'Melding').trim().replace(/,$/, ''),
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

        // Own missions: almost done first, then not dispatched yet by credits, then the rest
        const own = readMissionList('#mission_list');
        const score = (m) => {
          const missing = missingCount(m);
          if (missing === 1) return 3e6 + (credits[m.typeId] || 0);
          if (m.state === 'red') return 2e6 + (credits[m.typeId] || 0);
          if (missing > 1) return 1e6 + (credits[m.typeId] || 0) / missing;
          return credits[m.typeId] || 0;
        };
        const ranked = own.filter((m) => m.state !== 'green' || missingCount(m)).sort((a, b) => score(b) - score(a));
        wrap.append(heading(`🎯 Jouw meldingen (${ranked.length} vragen actie)`));
        if (!ranked.length) wrap.append(Object.assign(document.createElement('em'), { textContent: 'Alles loopt. 👍' }));
        ranked.slice(0, 12).forEach((m) => {
          const missing = missingCount(m);
          wrap.append(row(m, missing === 1 ? '<span class="label label-success">bijna klaar</span>' : missing ? `${missing} missen` : m.state === 'red' ? 'nog niet gealarmeerd' : ''));
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

  /** Tracks since when each vehicle has its current status (per browser). */
  function trackVehicleStatus(vehicles) {
    const since = extrasRead('status_since_v1', {});
    const next = {};
    vehicles.forEach((v) => {
      const prev = since[v.id];
      next[v.id] = prev && prev.fms === v.fms_real ? prev : { fms: v.fms_real, ts: Date.now() };
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
    entries.push({ ts: Date.now(), typeId: typeId || null });
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
    return wrap;
  }

  boot();
})();
