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
        missions.set(id, { caption: caption || 'Melding', state, missing }); // existing state: no event
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
      missions.set(m.id, { caption: m.caption, state, missing });
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

