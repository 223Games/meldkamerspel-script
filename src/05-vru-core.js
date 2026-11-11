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

