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

