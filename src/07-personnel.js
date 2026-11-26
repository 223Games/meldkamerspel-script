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

  /**
   * Personnel parts of the VRU panel (the former separate 👷 panel): manual transfers and staff per post.
   * Specialist binding/moves live in "Herverdelen", training in "Opleidingen", so nothing is shown twice.
   * Returns a loader: [[title, element], …]; `refresh` re-renders the whole VRU panel after an action.
   */
  function personnelSections(refresh) {
    const el = (html) => {
      const div = document.createElement('div');
      div.innerHTML = html;
      return div;
    };
    const short = shortPost;
    const actionButton = (label, onClick, cls = 'btn-success', confirmText = null) =>
      makeActionButton(label, onClick, {
        cls,
        confirmText,
        onDone: () => {
          invalidatePersonnel(); // data changed: next render must refetch
          setTimeout(refresh, 900);
        },
      });
    const row = makeRow;

    return async () => {
      const data = await analysePersonnel();
      const transfer = await loadTransferInfo(data.stations[0].id);
      const overview = renderOverview(data, transfer);
      const stations = renderStations(data);
      stations.prepend(overview);
      return [
        [`🔁 Personeel zelf verplaatsen (nog ${transfer.remaining} deze week)`, renderTransfers(data, transfer)],
        ['🏠 Personeel per post', stations],
      ];
    };

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

    /* ---- Personnel transfers: manual (suggestions are in "Herverdelen") ---- */
    function renderTransfers(data, transfer) {
      const wrap = el('');
      const untrainedFree = (row) => row.staff.filter((p) => !p.keys.length && !p.boundVehicleId);
      const movable = (row, includeTrained) =>
        Math.max(0, Math.min(row.staff.length - MIN_STATION_PERSONNEL, (includeTrained ? row.staff.filter((p) => !p.boundVehicleId) : untrainedFree(row)).length));

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

