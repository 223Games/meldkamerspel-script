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

  /** Dispatch category of an assigned vehicle row (caption first, vehicle type id as fallback). */
  function assignedRowCategory(row) {
    const caption = assignedRowCaption(row);
    const typeId = row.querySelector('a[vehicle_type_id]')?.getAttribute('vehicle_type_id');
    return (
      Object.keys(DISPATCH_CATEGORIES).find(
        (k) => DISPATCH_CATEGORIES[k].caption.test(caption) || !!DISPATCH_CATEGORIES[k].typeIds?.includes(typeId)
      ) || null
    );
  }

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

    /** Counts assigned vehicle rows (driving, queued, on scene) per category. */
    function countRows(rows) {
      const counts = {};
      rows.forEach((row) => {
        const key = assignedRowCategory(row);
        if (key) counts[key] = (counts[key] || 0) + 1;
      });
      return counts;
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
      // "driving" includes vehicles queued for this mission: they come for sure, just later
      const drivingRows = [...doc.querySelectorAll('#mission_vehicle_driving tbody tr')];
      const driving = countRows(drivingRows);
      const atMission = countRows([...doc.querySelectorAll('#mission_vehicle_at_mission tbody tr')]);

      const needed = {};
      const notOwned = [];
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

