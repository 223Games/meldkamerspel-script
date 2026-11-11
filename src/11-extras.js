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

  let coverageLayer = null;
  async function updateCoverageMap() {
    const L = unsafeWindow.L;
    const map = unsafeWindow.map;
    if (!setting('coverageMap') || !L || !map?.addLayer) {
      if (coverageLayer && map?.removeLayer) map.removeLayer(coverageLayer);
      coverageLayer = null;
      return;
    }
    const [buildings, vehicles] = await Promise.all([fetchJson('/api/buildings'), fetchJson('/api/vehicles')]);
    if (!coverageLayer) coverageLayer = L.layerGroup().addTo(map);
    coverageLayer.clearLayers();
    buildings
      .filter((b) => b.building_type === 0)
      .forEach((b) => {
        const engines = vehicles.filter((v) => v.building_id === b.id && isFireEngine(v.vehicle_type));
        const free = engines.filter((v) => FREE_FMS.has(v.fms_real)).length;
        const color = free === 0 ? '#d32f2f' : free < engines.length ? '#f9a825' : '#2e7d32';
        L.circleMarker([b.latitude, b.longitude], { radius: 9, color, weight: 3, fillOpacity: 0.15, interactive: true })
          .bindTooltip(`${b.caption.trim()}: ${free}/${engines.length} TS vrij`)
          .addTo(coverageLayer);
      });
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

