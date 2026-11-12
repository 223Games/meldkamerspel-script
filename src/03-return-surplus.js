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
        const key = assignedRowCategory(row);
        if (!key && Object.keys(missing).length) return; // unrecognised vehicle while something is missing: keep
        if (key && stillNeeded[key] > 0) {
          stillNeeded[key] -= 1; // a teammate's vehicle arriving first also fills the gap
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

