
  /* ------------------------------------------------------------------ */
  /* Specialists: discover, register and give each a home station        */
  /* ------------------------------------------------------------------ */

  const SPECIALIST_REGISTER_KEY = 'mks_specialists_v1';

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
   * 1. fixed by the VRU reference (extension vehicles: rietkap 09-51, veetakels 09-62);
   * 2. otherwise the own station closest to where you missed it (average of those missions),
   *    preferring stations that already have people with the needed education;
   * 3. no locations yet: the station with trained people, else none.
   */
  function specialistHome({ name, at = [], education }, stations, stationRows) {
    const fixed = PLAN_EXTENSIONS.find((ext) => ext.match.test(name));
    if (fixed) {
      const station = stations.find((b) => new RegExp(`09-${fixed.station}\\b`).test(b.caption));
      return { station, code: fixed.station, why: `VRU-indeling (uitbreiding ${fixed.name})`, extension: fixed };
    }
    const trainedAt = (st) => {
      if (!education) return 0;
      const row = stationRows?.find((r) => r.station.id === st.id);
      return row?.perEducation?.[education] || 0;
    };
    if (at.length) {
      const centre = {
        latitude: at.reduce((n, p) => n + p.lat, 0) / at.length,
        longitude: at.reduce((n, p) => n + p.lng, 0) / at.length,
      };
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

    list.forEach((sp) => {
      const typeId = sp.shop?.typeId;
      sp.ownedAt = typeId != null ? vehicles.filter((v) => v.vehicle_type === typeId).map((v) => stations.find((s) => s.id === v.building_id)).filter(Boolean) : [];
      sp.home = specialistHome(sp, stations, data.stationRows);
      sp.allowed = !sp.shop?.minStations || sp.shop.minStations <= stations.length;
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
        const short = (caption) => escapeHtml(caption.trim().replace(`${CONFIG.vru.prefix} `, ''));
        wrap.innerHTML = '';
        list.forEach((sp) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;gap:6px;margin-bottom:6px';
          const owned = sp.ownedAt.length;
          // Action = missed and not owned (or not at its home); option = could unlock missions
          const needsAction = sp.missions > 0 && !owned;
          row.dataset.mksSpecialist = needsAction ? 'act' : owned ? 'ok' : 'opt';
          const facts = [];
          if (sp.missions) facts.push(`<b>${sp.missions}× gemist</b> (14 d)`);
          if (sp.unlocked) facts.push(`${sp.unlocked} meldingstype(s)`);
          if (sp.shop) facts.push(`winkel: ${escapeHtml(sp.shop.name)}${sp.shop.price ? ` (${formatCredits(sp.shop.price)})` : ''}`);
          if (sp.education) facts.push(`opleiding <i>${escapeHtml(sp.education)}</i>`);
          if (!sp.allowed) facts.push(`pas vanaf ${sp.shop.minStations} posten`);
          if (sp.home.extension) facts.push(`eerst uitbreiding ${escapeHtml(sp.home.extension.name)} (${formatCredits(sp.home.extension.price)})`);
          const home = sp.home.station
            ? `🏠 <b>${short(sp.home.station.caption)}</b> <small class="text-muted">(${escapeHtml(sp.home.why)})</small>`
            : `🏠 <small class="text-muted">${escapeHtml(sp.home.why)}${sp.home.code ? ` · 09-${sp.home.code} nog niet gebouwd` : ''}</small>`;
          const have = owned
            ? `✅ ${owned}× in bezit: ${sp.ownedAt.map((s) => short(s.caption)).join(', ')}`
            : needsAction
              ? '❌ niet in je korps'
              : '➖ nog niet in bezit';
          row.innerHTML = `<span>${needsAction ? '🔴' : owned ? '🟢' : '⚪'} <b>${escapeHtml(sp.name)}</b>${
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
        const foot = document.createElement('small');
        foot.className = 'text-muted';
        foot.textContent =
          'Gemist = een melding vroeg erom terwijl je er geen had (alarmeerhulp, 14 dagen). Thuiskazerne: VRU-indeling waar bekend, anders de post het dichtst bij waar je hem miste.';
        wrap.append(foot);
      } catch (e) {
        console.error('[MKS→HA] Specialists failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Specialisten mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();
    return wrap;
  }
