
  /* ------------------------------------------------------------------ */
  /* Training queue: what to train next, ready for when a classroom frees */
  /* ------------------------------------------------------------------ */

  const NL_MONTHS = { jan: 0, feb: 1, mrt: 2, apr: 3, mei: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11 };

  /** "ma 30 nov 2026 19:33:21 CET" → timestamp (local time of the player's browser); null when unreadable. */
  function parseDutchDate(text) {
    const m = String(text).match(/(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
    if (!m || !(m[2].toLowerCase() in NL_MONTHS)) return null;
    return new Date(Number(m[3]), NL_MONTHS[m[2].toLowerCase()], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0)).getTime();
  }

  /** Academy page → whether a classroom is free, the running lessons and the price of an extra classroom. */
  function parseAcademyDoc(doc) {
    const lessons = doc.querySelector('#schooling')?.textContent.replace(/\s+/g, ' ').trim() || '';
    const running = [...doc.querySelectorAll('#schooling_running a[href]')]
      .filter((a) => /^\/schoolings\/\d+$/.test(a.getAttribute('href')))
      .map((a) => {
        const cells = [...(a.closest('tr')?.children || [])].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
        return { id: Number(a.getAttribute('href').split('/').pop()), education: a.textContent.trim(), freeSeats: Number(cells[2]) || 0 };
      });
    const ext = doc.querySelector('#ausbauten')?.textContent.replace(/\s+/g, ' ') || '';
    const price = ext.match(/Extra klaslokaal.*?(\d{1,3}(?:\.\d{3})+)\s*Credits/i)?.[1];
    // "Adviseur Gevaarlijke Stoffen (6 dagen)": length of each education, shown by the game when a classroom is free
    const days = {};
    doc.querySelectorAll('#schooling select[name="education_select"] option').forEach((o) => {
      const m = o.textContent.match(/^(.*?)\s*\((\d+) dagen\)/);
      if (m) days[m[1].trim()] = Number(m[2]);
    });
    return {
      days,
      free: !/bezet/i.test(lessons) && lessons.length > 0,
      lessonsText: lessons.slice(0, 200),
      running,
      extraClassroomPrice: price ? Number(price.replace(/\./g, '')) : null,
    };
  }

  /** One running lesson: when it ends and how many people take part. */
  function parseSchoolingDoc(doc) {
    const text = doc.body.textContent.replace(/\s+/g, ' ');
    const rows = [...doc.querySelectorAll('table tr')].filter((r) => r.querySelector('td'));
    return {
      endsAt: parseDutchDate(text.match(/loopt tot ([^.]*?CES?T|[^.]*?\d{2}:\d{2}(?::\d{2})?)/i)?.[1] || ''),
      people: rows.length,
      station: rows[0]?.children[3]?.textContent.trim() || '',
    };
  }

  let academyStateCache = null;
  async function loadAcademyState() {
    if (academyStateCache && Date.now() - academyStateCache.ts < 60e3) return academyStateCache.value;
    const buildings = await fetchJson('/api/buildings');
    const academies = [];
    for (const b of buildings.filter((x) => x.building_type === FIRE_ACADEMY_TYPE)) {
      const info = parseAcademyDoc(await fetchDoc(`/buildings/${b.id}`));
      for (const lesson of info.running) Object.assign(lesson, parseSchoolingDoc(await fetchDoc(`/schoolings/${lesson.id}`)));
      academies.push({ id: b.id, caption: b.caption.trim(), ...info });
    }
    const days = Object.assign({}, ...academies.map((a) => a.days));
    const value = { academies, days };
    academyStateCache = { ts: Date.now(), value };
    return value;
  }

  /**
   * Ordered list of educations worth starting, so they can go into a classroom the moment one is free.
   * Priority: vehicle already owned but nobody trained (it stands idle) → missed missions → unlocked mission types.
   * Educations already running are flagged, not repeated.
   */
  function buildTrainingQueue(specialists, academyState, extensionNeeds = []) {
    const running = new Map();
    (academyState?.academies || []).forEach((a) => a.running.forEach((l) => running.set(l.education, { ...l, academy: a })));
    const fromSpecialists = specialists
      .filter((sp) => sp.education && !sp.trained)
      .map((sp) => {
        const lesson = running.get(sp.education);
        const owned = sp.ownedAt.length > 0;
        return {
          education: sp.education,
          vehicle: sp.name,
          owned,
          missions: sp.missions || 0,
          unlocked: sp.unlocked || 0,
          people: Math.max(1, sp.shop?.minCrew || 1),
          station: sp.home.station || sp.ownedAt[0] || null,
          running: lesson || null,
          days: academyState?.days?.[sp.education] || null,
          score: (owned ? 3000 : 0) + (sp.missions || 0) * 100 + (sp.unlocked || 0) * 10,
        };
      })
    // Extension vehicles (DB-VI…) you do not own yet are not in the specialists list but need the same planning
    const known = new Set(fromSpecialists.map((q) => q.education));
    const fromExtensions = extensionNeeds
      .filter((x) => !known.has(x.education))
      .map((x) => ({
        education: x.education,
        vehicle: x.name,
        owned: false,
        missions: x.missed,
        unlocked: x.count,
        people: Math.max(1, x.minCrew || 1),
        station: null,
        running: running.get(x.education) || null,
        days: academyState?.days?.[x.education] || null,
        score: x.missed * 100 + x.count * 10,
      }));
    return [...fromSpecialists, ...fromExtensions].sort((a, b) => !!a.running - !!b.running || b.score - a.score);
  }

  async function renderTraining() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<em>Opleidingen laden…</em>';
    (async () => {
      try {
        const [data, buildings, vehicles, academyState] = await Promise.all([
          analysePersonnel(),
          fetchJson('/api/buildings'),
          fetchJson('/api/vehicles'),
          loadAcademyState(),
        ]);
        data.extensionStats ||= await loadExtensionMissionStats(countFireStations(buildings)).catch(() => ({})); // shared with the plan
        const queue = buildTrainingQueue(collectSpecialists(data, buildings, vehicles), academyState, untrainedExtensionNeeds(data, notOwnedStats()));
        const short = shortPost;
        const open = (url) => (typeof unsafeWindow.lightboxOpen === 'function' ? unsafeWindow.lightboxOpen(url) : window.open(url, '_blank'));
        const when = (ts) => {
          if (!ts) return 'onbekend';
          const left = ts - Date.now();
          const days = Math.floor(left / 864e5);
          const hours = Math.floor((left % 864e5) / 36e5);
          return `${new Date(ts).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (${
            left <= 0 ? 'nu' : days ? `over ${days}d ${hours}u` : `over ${hours}u`
          })`;
        };
        wrap.innerHTML = '';
        const line = (html, attr, ...buttons) => {
          const r = makeRow(html, ...buttons);
          if (attr) r.dataset.mksTraining = attr;
          wrap.append(r);
        };
        const btn = (label, url) => {
          const a = document.createElement('a');
          a.href = '#';
          a.className = 'btn btn-xs btn-default';
          a.textContent = label;
          a.addEventListener('click', (e) => {
            e.preventDefault();
            open(url);
          });
          return a;
        };

        if (!academyState.academies.length) {
          line('🏫 <b>Nog geen academie.</b> <small>Bouw er een (Brandweer, Academie) om zelf specialisten op te leiden; de wachtrij hieronder staat dan klaar.</small>');
        }
        academyState.academies.forEach((a) => {
          const first = a.running.map((l) => l.endsAt).filter(Boolean).sort((x, y) => x - y)[0];
          line(
            `🏫 <b>${short(a.caption)}</b><br><small>${
              a.free
                ? '<b class="text-success">Klaslokaal vrij</b>: start nu de eerstvolgende opleiding uit de wachtrij.'
                : `Alle klaslokalen bezet${first ? `: eerstvolgende vrij ${when(first)}` : ''}.`
            }${a.extraClassroomPrice ? ` Extra klaslokaal: ${formatCredits(a.extraClassroomPrice)}.` : ''}</small>`,
            a.free && queue.some((q) => !q.running) ? 'act' : null,
            btn('Academie', `/buildings/${a.id}`)
          );
          a.running.forEach((l) =>
            line(
              `▶️ <b>${escapeHtml(l.education)}</b> <small class="text-muted">· bezig${l.people ? ` · ${l.people} personen${l.station ? ` van ${escapeHtml(l.station.replace(`${CONFIG.vru.prefix} `, ''))}` : ''}` : ''} · klaar ${when(l.endsAt)}</small>`
            )
          );
        });

        if (!queue.length) {
          wrap.append(Object.assign(document.createElement('small'), { className: 'text-muted', textContent: 'Wachtrij leeg: voor alle bekende specialisten is iemand opgeleid. ✅' }));
          return;
        }
        const h = document.createElement('div');
        h.innerHTML = '<b>Wachtrij: dit opleiden zodra er een klaslokaal vrij is</b>';
        h.style.margin = '8px 0 4px';
        wrap.append(h);
        let n = 0;
        queue.forEach((q) => {
          const why = [
            q.owned ? '<b>voertuig staat al stil</b>' : null,
            q.missions ? `${q.missions}× gemist (14 d)` : null,
            q.unlocked ? `${q.unlocked} meldingstype(s)` : null,
          ].filter(Boolean);
          line(
            `${q.running ? '▶️' : `<b>${++n}.</b>`} <b>${escapeHtml(q.education)}</b> <small class="text-muted">· voor ${escapeHtml(q.vehicle)}</small><br><small>${
              q.running
                ? `loopt al, klaar ${when(q.running.endsAt)}`
                : `${q.days ? `${q.days} dagen · ` : ''}${q.people} personen${q.station ? ` van <b>${short(q.station.caption)}</b>` : ''}${why.length ? ` · ${why.join(' · ')}` : ''}`
            }</small>`,
            q.running ? null : 'opt'
          );
        });
        const foot = document.createElement('small');
        foot.className = 'text-muted';
        foot.textContent =
          'Kies bij het starten personeel van de aangegeven post: de opgeleiden kunnen dan direct op hun voertuig worden gekoppeld (zie Herverdelen). Per opleiding kun je maximaal 10 personen tegelijk laten meedoen; tijdens de opleiding zijn zij niet inzetbaar.';
        wrap.append(foot);
      } catch (e) {
        console.error('[MKS→HA] Training queue failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Opleidingen mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();
    return wrap;
  }
