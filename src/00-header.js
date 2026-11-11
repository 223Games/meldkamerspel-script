// ==UserScript==
// @name         Meldkamerspel → Home Assistant + Alarmeerhulp + VRU
// @namespace    https://223studio.nl/
// @version      7.1.0
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

    // On/off switches, stored per browser (Tampermonkey menu)
    const TOGGLES = [
      ['dispatchAssist', 'Alarmeerhulp'],
      ['queueBusyVehicles', 'Dooralarmeren bij tekort'],
      ['autoReturnSurplus', 'Overbodige voertuigen terugsturen'],
      ['sendCompleted', 'HA: melding afgerond'],
      ['sendMissing', 'HA: missende voertuigen'],
      ['debug', 'Debug-log in console'],
    ];
    TOGGLES.forEach(([key, label]) =>
      GM_registerMenuCommand(`${CONFIG[key] ? '✅' : '⬜'} ${label}`, () => {
        GM_setValue(`opt_${key}`, !CONFIG[key]);
        window.alert(`${label} ${CONFIG[key] ? 'uit' : 'aan'}gezet. Herlaad de pagina.`);
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

