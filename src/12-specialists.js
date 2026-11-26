
  /* ------------------------------------------------------------------ */
  /* Specialists: discover, register and give each a home station        */
  /* ------------------------------------------------------------------ */

  const SPECIALIST_REGISTER_KEY = 'mks_specialists_v1';

  // VRU head office (Archimedeslaan, Utrecht): AGS, HOvD and the communication adviser are based here, not at a post
  const VRU_HQ = { latitude: 52.0866, longitude: 5.1683 };

  /**
   * Where the real VRU keeps each specialist (Brandbase regio 09, Nov 2026). `posts` = station codes,
   * `hq` = head office (the game needs a fire station: the own post closest to it).
   */
  const VRU_SPECIALIST_HOMES = [
    { match: /riet|thatch|\bDB-RI\b|\bRIA\b/i, posts: ['06', '37', '58', '61'], real: 'Rietdak Brandbestrijdingsteamvoertuig' },
    { match: /veetakel|livestock|\bDB-VI\b/i, posts: ['21', '23', '29'], real: 'Veetakel Installatie' },
    { typeIds: [31], match: /commando|\bCO\b/i, posts: ['01', '18'], real: 'Commandovoertuig Multi CoPI' },
    { typeIds: [5], match: /adembescherming|\bAB\b/i, posts: ['07', '44', '64'], real: 'Adembeschermingshaakarmbak' },
    { typeIds: [24], match: /gevaarlijke\s*stoffen|\bAGS\b/i, hq: true, real: 'AGS West/Oost (hoofdkantoor)' },
    { typeIds: [19], match: /hoofd\s*officier|\bHOvD\b/i, hq: true, real: 'HOvD West/Oost (hoofdkantoor)' },
    { typeIds: [56], match: /voorlicht|communicatie|\bVL\b/i, hq: true, real: 'Communicatieadviseur CoPI (hoofdkantoor)' },
    { typeIds: [68], match: /schuim/i, posts: ['18'], real: 'Schuimblusvoertuig' },
    // "brush" = the game's key for nature fire vehicles (TST-NB / NBV)
    { typeIds: [12, 14, 15], match: /brush|natuurbrand|\bNBV?\b/i, posts: ['01', '03', '07', '10', '22', '30', '31', '32', '33', '35', '50', '51', '52', '53', '54', '55', '64', '66'], real: 'Natuurbrandbestrijdingsvoertuig (NBV)' },
    // Brandbase regio 09 (Nov 2026): Brandweervaartuig middel/klein (BRV) at Bunschoten, Vinkeveen, Breukelen, Vianen; no blusrobot in the VRU
    { match: /blusboot|brandweervaartuig|\bBRV\b|fire_boat/i, posts: ['04', '14', '36', '57'], real: 'Brandweervaartuig (BRV)' },
    // Droneteams / TDV are regional (09-80), not at a post: the game needs a fire station
    { match: /drone|\bTDV\b|verkenningsteam/i, hq: true, real: 'Droneteam / TDV (regionaal)' },
    { typeIds: [33], match: /waterongeval|duik/i, posts: ['01', '04', '13', '39', '44', '59'], real: 'Waterongevallen' },
  ];

  const vruHomeOf = (name, typeId) =>
    VRU_SPECIALIST_HOMES.find((h) => (typeId != null && h.typeIds?.includes(typeId)) || h.match.test(name)) || null;

  const readSpecialistRegister = () => {
    try {
      return JSON.parse(localStorage.getItem(SPECIALIST_REGISTER_KEY) || '{}');
    } catch (e) {
      return {};
    }
  };

  /** Shop vehicle whose name shares a word (≥ 3 letters) with `name`: "DB-RI of RIA" → the rietkap vehicle. */
  function shopMatch(name, typeInfo) {
    const words = name.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 3 && !['van', 'een', 'het', 'met'].includes(w));
    const hit = Object.entries(typeInfo || {}).find(([, t]) => words.some((w) => t.name?.toLowerCase().includes(w)));
    return hit ? { typeId: Number(hit[0]), ...hit[1] } : null;
  }

  /**
   * Home station for a specialist:
   * 1. the real VRU posts (Brandbase): a built one, closest to where you missed it; head-office
   *    specialists → your post closest to the head office; VRU posts not built yet → temporary home;
   * 2. otherwise the own station closest to where you missed it (average of those missions),
   *    preferring stations that already have people with the needed education;
   * 3. no locations yet: the station with trained people, else none.
   */
  function specialistHome({ name, at = [], education, shop }, stations, stationRows) {
    const centre = at.length
      ? { latitude: at.reduce((n, p) => n + p.lat, 0) / at.length, longitude: at.reduce((n, p) => n + p.lng, 0) / at.length }
      : null;
    const extension = PLAN_EXTENSIONS.find((ext) => ext.match.test(name)) || null;
    const vru = vruHomeOf(name, shop?.typeId);
    const short = (st) => st.caption.trim().replace(`${CONFIG.vru.prefix} `, '');
    if (vru?.hq) {
      const best = stations.map((st) => ({ st, km: distanceKm(VRU_HQ, st) })).sort((a, b) => a.km - b.km)[0];
      if (best)
        return { station: best.st, vru: true, extension, why: `VRU: ${vru.real}; jouw post het dichtst bij het hoofdkantoor (${best.km.toFixed(1)} km)` };
    }
    if (vru?.posts) {
      const all = vru.posts.map((c) => `09-${c}`).join(', ');
      const built = vru.posts.map((c) => stations.find((b) => new RegExp(`09-${c}\\b`).test(b.caption))).filter(Boolean);
      if (built.length) {
        // Several VRU posts built: the one closest to where you missed it
        const pick = centre ? built.sort((a, b) => distanceKm(centre, a) - distanceKm(centre, b))[0] : built[0];
        return {
          station: pick,
          vru: true,
          extension,
          why: `VRU: ${vru.real} op ${all}${built.length > 1 ? `; ${short(pick)} ligt het dichtst bij je gemiste meldingen` : ''}`,
        };
      }
      // None of its VRU posts built yet: temporary home closest to where you missed it
      const temp = centre && stations.map((st) => ({ st, km: distanceKm(centre, st) })).sort((a, b) => a.km - b.km)[0];
      return {
        station: temp?.st || null,
        vru: false,
        extension,
        posts: vru.posts,
        why: `VRU: ${vru.real} op ${all} (nog niet gebouwd)${temp ? `; tijdelijk ${short(temp.st)}, ${temp.km.toFixed(1)} km van je gemiste meldingen` : ''}`,
      };
    }
    const trainedAt = (st) => {
      if (!education) return 0;
      const row = stationRows?.find((r) => r.station.id === st.id);
      return row?.perEducation?.[education] || 0;
    };
    if (centre) {
      const ranked = stations
        .map((st) => ({ st, km: distanceKm(centre, st), trained: trainedAt(st) }))
        // A station with trained people within 5 km extra beats the closest one without
        .sort((a, b) => a.km - (a.trained ? 5 : 0) - (b.km - (b.trained ? 5 : 0)));
      const best = ranked[0];
      if (best)
        return {
          station: best.st,
          why: `dichtst bij je ${at.length} gemiste melding(en), ${best.km.toFixed(1)} km${best.trained ? `, ${best.trained} opgeleid` : ''}`,
        };
    }
    const trained = stations.map((st) => ({ st, n: trainedAt(st) })).filter((x) => x.n).sort((a, b) => b.n - a.n)[0];
    return trained ? { station: trained.st, why: `${trained.n} opgeleid` } : { station: null, why: 'nog geen locaties: speel even door' };
  }

  /** People trained in a long education name ("Specialist Rietdakbrandbestrijder"); null when the vehicle needs none. */
  function trainedCount(data, education) {
    if (!education) return null;
    const key = data.keyOf ? data.keyOf(education) : null;
    return key ? (data.people || []).filter((p) => p.keys.includes(key)).length : 0; // key unknown = nobody has it yet
  }

  /**
   * All specialists worth knowing about:
   * - missed: asked for in your missions while you had none (14 days, with locations);
   * - unlocked: specialist vehicles the game lets you buy that unlock fire missions (catalog).
   * Every kind is registered (first/last seen, advised home) so new ones stand out.
   */
  function collectSpecialists(data, buildings, vehicles) {
    const stations = buildings.filter((b) => b.building_type === 0);
    const register = readSpecialistRegister();
    const now = Date.now();
    const list = [];

    Object.entries(notOwnedDetails()).forEach(([name, d]) => {
      const shop = shopMatch(name, data.typeInfo);
      list.push({ name, missions: d.missions, at: d.at, shop, education: shop?.education || null, source: 'missed' });
    });
    (data.specialtyRows || [])
      .filter((sp) => sp.unlocked?.length && sp.info?.name)
      .forEach((sp) => {
        const dupe = list.find((x) => x.shop?.typeId === sp.typeId);
        if (dupe) {
          dupe.unlocked = sp.unlocked.length;
          return;
        }
        list.push({
          name: sp.label,
          missions: 0,
          at: [],
          shop: { typeId: sp.typeId, ...sp.info },
          education: sp.info.education || null,
          unlocked: sp.unlocked.length,
          source: 'unlocked',
        });
      });

    // Specialist vehicles you already own that need an education (e.g. DB-RI): untrained crew = a vehicle that stays home
    (data.specialistVehicles || []).forEach(({ vehicle, info }) => {
      if (list.some((x) => x.shop?.typeId === vehicle.vehicle_type)) return;
      list.push({ name: info.name, missions: 0, at: [], shop: { typeId: vehicle.vehicle_type, ...info }, education: info.education, source: 'owned' });
    });

    // Basic vehicles every post has in the VRU layout (OvD, TS, AL, HV…) are not specialists,
    // unless the VRU keeps them at specific posts (AB, NB, waterongevallen…)
    const baseTypes = new Set(Object.values(VRU_STATIONS).flatMap(([, vehiclesRef]) => vehiclesRef.map(([, t]) => t)));
    for (let i = list.length - 1; i >= 0; i--) {
      const typeId = list[i].shop?.typeId;
      if (typeId != null && baseTypes.has(typeId) && !vruHomeOf(list[i].name, typeId)) list.splice(i, 1);
    }

    list.forEach((sp) => {
      const vru = vruHomeOf(sp.name, sp.shop?.typeId);
      if (vru && /brush/i.test(sp.name)) sp.name = 'NB (natuurbrandvoertuig, spelcode "brush")';
      const typeId = sp.shop?.typeId ?? vru?.typeIds?.[0];
      const typeIds = sp.shop?.typeId != null ? [sp.shop.typeId] : vru?.typeIds || [];
      sp.ownedAt = vehicles.filter((v) => typeIds.includes(v.vehicle_type)).map((v) => stations.find((s) => s.id === v.building_id)).filter(Boolean);
      sp.home = specialistHome(sp, stations, data.stationRows);
      sp.allowed = !sp.shop?.minStations || sp.shop.minStations <= stations.length;
      sp.trained = trainedCount(data, sp.education);
      const reg = register[sp.name] || { firstSeen: now };
      sp.isNew = now - reg.firstSeen < 3 * 86400e3;
      register[sp.name] = { ...reg, lastSeen: now, typeId: typeId ?? null, home: sp.home.station?.caption?.trim() || reg.home || null };
    });
    try {
      localStorage.setItem(SPECIALIST_REGISTER_KEY, JSON.stringify(register));
    } catch (e) {
      /* best-effort */
    }
    // Most missed first, then most missions unlocked
    return list.sort((a, b) => b.missions - a.missions || (b.unlocked || 0) - (a.unlocked || 0));
  }

  /** Every education the vehicle shop asks for: which vehicles need it, how many you own, how many people are trained. */
  /**
   * Trained people without a car on their post. The car goes where the real VRU keeps it (Brandbase) first;
   * only without a VRU place do we fall back to the post with the most idle trained people.
   */
  function renderIdleTrained(data) {
    const wrap = document.createElement('div');
    if (!data.idleTrained?.length) return wrap;
    wrap.innerHTML = '<div style="margin-top:8px"><b>🎓 Opgeleid personeel zonder auto op de post</b></div>';
    data.idleTrained.forEach(({ education, types, owned, posts }) => {
      const idleAt = (st) => posts.find((x) => x.station.id === st.id)?.idle || 0;
      const eduKey = data.keyOf ? data.keyOf(education) : null;
      const trainedAt = (st) => (eduKey ? data.people.filter((p) => p.buildingId === st.id && p.keys.includes(eduKey)).length : 0);
      // Real VRU place per vehicle type; "open" = no such car there yet
      const placed = types
        .map((t) => ({ t, home: specialistHome({ name: t.name, education, shop: { typeId: t.typeId } }, data.stations, data.stationRows) }))
        .filter((x) => x.home.station && x.home.vru)
        .map((x) => ({ ...x, has: data.vehicles.some((v) => v.vehicle_type === x.t.typeId && v.building_id === x.home.station.id) }));
      const open = placed.find((x) => !x.has);
      let target;
      let advice;
      if (open) {
        target = open.home.station;
        const here = trainedAt(target);
        advice = `📍 VRU-plek: <b>${shortPost(target.caption)}</b> (${escapeHtml(open.home.why)}). ${
          here ? `${here} opgeleid op die post.` : 'Daar is nog niemand opgeleid: verplaats of train eerst.'
        }`;
      } else if (placed.length) {
        advice = `✅ Staat al op de VRU-plek (${placed.map((x) => shortPost(x.home.station.caption)).join(', ')}). Deze extra opgeleiden wachten op een tweede auto.`;
      } else {
        target = posts[0].station;
        advice = `Geen VRU-plek bekend: een (extra) auto op ${shortPost(target.caption)} is meteen bemand.`;
      }
      const abbr = [...new Set(types.map((t) => t.name.split(/\s+/)[0]))];
      const typeText = abbr.slice(0, 4).join(' / ') + (abbr.length > 4 ? ` +${abbr.length - 4}` : '');
      const list = posts.map((x) => `${shortPost(x.station.caption)} (${x.idle})`).join(', ');
      const row = document.createElement('div');
      row.setAttribute('data-mks-specialist', target ? 'opt' : 'ok');
      row.style.cssText = 'display:flex;justify-content:space-between;gap:6px;margin:3px 0';
      row.innerHTML = `<span>${target ? '🟡' : '🟢'} <b>${escapeHtml(education)}</b> <small class="text-muted">· ${escapeHtml(typeText)} · ${
        owned ? `${owned}× in bezit` : 'nog geen auto'
      }</small><br><small>Opgeleid zonder auto: ${list}</small><br><small>${advice}</small></span>`;
      if (target) {
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'btn btn-xs btn-default';
        a.textContent = 'Winkel';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          openLightbox(`/buildings/${target.id}/vehicles/new`);
        });
        row.append(a);
      }
      wrap.append(row);
    });
    return wrap;
  }

  function renderEducationCatalog(data, vehicles) {
    const byEdu = {};
    Object.entries(data.typeInfo || {}).forEach(([typeId, info]) => {
      if (!info.education) return;
      (byEdu[info.education] ||= []).push({ typeId: Number(typeId), name: info.name });
    });
    const rows = Object.entries(byEdu)
      .map(([education, types]) => ({
        education,
        types,
        trained: trainedCount(data, education),
        owned: vehicles.filter((v) => types.some((t) => t.typeId === v.vehicle_type)).length,
      }))
      .sort((a, b) => b.owned - a.owned || b.trained - a.trained || a.education.localeCompare(b.education));
    const details = document.createElement('details');
    details.style.marginTop = '6px';
    details.innerHTML = `<summary><b>🎓 Alle opleidingen in het spel (${rows.length})</b> <small class="text-muted">· ${rows.filter((r) => r.trained).length} heb je opgeleid personeel voor</small></summary>${rows
      .map(
        (r) =>
          `<div><small>${r.trained ? '🟢' : r.owned ? '🔴' : '⚪'} <b>${escapeHtml(r.education)}</b> · ${r.trained} opgeleid · ${r.owned}× voertuig in bezit<br><span class="text-muted">${r.types
            .slice(0, 4)
            .map((t) => escapeHtml(t.name.split(' ')[0]))
            .join(', ')}${r.types.length > 4 ? '…' : ''}</span></small></div>`
      )
      .join('')}`;
    return details;
  }

  async function renderSpecialists() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<em>Specialisten zoeken…</em>';
    (async () => {
      try {
        const [data, buildings, vehicles] = await Promise.all([analysePersonnel(), fetchJson('/api/buildings'), fetchJson('/api/vehicles')]);
        const list = collectSpecialists(data, buildings, vehicles);
        if (!list.length) {
          wrap.innerHTML =
            '<small class="text-muted">Nog niets ontdekt. Open meldingen zoals altijd: wat er gevraagd wordt en je niet hebt, komt hier vanzelf te staan.</small>';
          return;
        }
        const short = shortPost;
        wrap.innerHTML = '';
        list.forEach((sp) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;gap:6px;margin-bottom:6px';
          const owned = sp.ownedAt.length;
          // Action = missed and not owned (or not at its home); option = could unlock missions
          const untrained = sp.education && !sp.trained; // nobody can crew it
          const needsAction = (sp.missions > 0 && !owned) || (owned && untrained) || (sp.missions > 0 && untrained);
          row.dataset.mksSpecialist = needsAction ? 'act' : owned ? 'ok' : 'opt';
          const facts = [];
          if (sp.missions) facts.push(`<b>${sp.missions}× gemist</b> (14 d)`);
          if (sp.unlocked) facts.push(`${sp.unlocked} meldingstype(s)`);
          if (sp.shop && !owned) facts.push(`winkel: ${escapeHtml(sp.shop.name)}${sp.shop.price ? ` (${formatCredits(sp.shop.price)})` : ''}`);
          if (sp.education)
            facts.push(
              `opleiding <i>${escapeHtml(sp.education)}</i>: ${
                sp.trained ? `<b>${sp.trained}</b> opgeleid` : '<b class="text-danger">niemand opgeleid</b> — zie Opleidingen'
              }`
            );
          if (!sp.allowed) facts.push(`pas vanaf ${sp.shop.minStations} posten`);
          if (sp.home.extension) facts.push(`eerst uitbreiding ${escapeHtml(sp.home.extension.name)} (${formatCredits(sp.home.extension.price)})`);
          const home = sp.home.station
            ? `🏠 <b>${short(sp.home.station.caption)}</b> <small class="text-muted">(${escapeHtml(sp.home.why)})</small>`
            : `🏠 <small class="text-muted">${escapeHtml(sp.home.why)}</small>`;
          const have = owned
            ? `✅ ${owned}× in bezit: ${sp.ownedAt.map((s) => short(s.caption)).join(', ')}`
            : needsAction
              ? '❌ niet in je korps'
              : '➖ nog niet in bezit';
          const idle = owned && untrained ? ' <span class="label label-danger" title="Zonder opgeleid personeel rijdt hij niet uit">staat stil</span>' : '';
          row.innerHTML = `<span>${needsAction ? '🔴' : owned ? '🟢' : '⚪'} <b>${escapeHtml(sp.name)}</b>${idle}${
            sp.isNew ? ' <span class="label label-info">nieuw</span>' : ''
          }<br><small>${have} · ${facts.join(' · ')}</small><br><small>${home}</small></span>`;
          const right = document.createElement('span');
          right.style.whiteSpace = 'nowrap';
          if (sp.home.station) {
            const a = document.createElement('a');
            a.href = '#';
            a.className = 'btn btn-xs btn-default';
            a.textContent = sp.home.extension ? 'Gebouw' : 'Winkel';
            const url = sp.home.extension ? `/buildings/${sp.home.station.id}` : `/buildings/${sp.home.station.id}/vehicles/new`;
            a.addEventListener('click', (e) => {
              e.preventDefault();
              if (typeof unsafeWindow.lightboxOpen === 'function') unsafeWindow.lightboxOpen(url);
              else window.open(url, '_blank');
            });
            right.append(a);
          }
          row.append(right);
          wrap.append(row);
        });
        wrap.append(renderIdleTrained(data));
        wrap.append(renderEducationCatalog(data, vehicles));
        const foot = document.createElement('small');
        foot.className = 'text-muted';
        foot.textContent =
          'Gemist = een melding vroeg erom terwijl je er geen had (alarmeerhulp, 14 dagen). Thuiskazerne: echte VRU-indeling (Brandbase regio 09), anders de post het dichtst bij waar je hem miste.';
        wrap.append(foot);
      } catch (e) {
        console.error('[MKS→HA] Specialists failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Specialisten mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();
    return wrap;
  }
