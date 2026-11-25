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
    { typeId: 26, key: 'thatched_fire', name: 'Rietkapbrandbestrijding', price: 150000, days: 5, vehicle: 'DB-RI of RIA', stations: ['06', '37', '58', '61'], match: /riet|thatch|\bDB-RI\b|\bRIA\b/i },
    { typeId: 27, key: 'livestock_fire', name: 'Veetakels', price: 150000, days: 5, vehicle: 'DB-VI', stations: ['21', '23', '29'], match: /veetakel|livestock|\bDB-VI\b/i },
  ];

  // Own fire academy: train specialists yourself instead of waiting for the team academy
  const ACADEMY_PRICE = 500000;

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
    const pendingTraining = specialtyRows.filter((sp) => sp.unlocked.length && !sp.owned && sp.info?.education && !sp.trained);

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
        const value = 6 + stats.count * 2.5 * Math.min(1.5, stats.avgCredits / 1500) + Math.min(40, missed * 4);
        candidates.push({ kind: 'extension', ext, stats, missed, s: station, cost, value });
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
              e.type_id === 15
                ? ': pas aanzetten als je een natuurbrandvoertuig (DA-LA-NB, VW-NB of NBH) hebt'
                : PLAN_EXTENSIONS.some((x) => x.typeId === e.type_id)
                  ? ' — <b>bewust?</b> Een uitgezette uitbreiding doet niet mee; aanzetten via het gebouw → uitbreidingen'
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
        data.extensionStats = await loadExtensionMissionStats(stationCount).catch(() => ({}));
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
        const short = (caption) => escapeHtml(caption.trim().replace(`${CONFIG.vru.prefix} `, ''));

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
            if (step.stats.count)
              why.push(
                `+${step.stats.count} meldingstypes, gem. ${formatCredits(step.stats.avgCredits)} cr (${escapeHtml(
                  step.stats.names.slice(0, 3).join(', ')
                )}…)`
              );
            detail = `${why.join(' · ')} · 👷 ${escapeHtml(step.personnel.text)}`;
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

