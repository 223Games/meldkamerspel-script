  /* ------------------------------------------------------------------ */
  /* Mission memory: learn what each mission type really needed          */
  /* ------------------------------------------------------------------ */

  const MEMORY_KEYS = { open: 'mks_mem_open_v1', types: 'mks_mem_types_v1' };
  const memRead = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
    } catch (e) {
      return fallback;
    }
  };
  const memWrite = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage full: memory is best-effort */
    }
  };

  // Requirement category -> AAO field / button attribute (from the game's AAO form)
  const AAO_KEY_BY_CATEGORY = {
    firetrucks: 'fire',
    platform_trucks: 'dlk',
    battalion_chief_vehicles: 'elw',
    mobile_command_vehicles: 'elw2',
    elw3: 'elw3',
    heavy_rescue_vehicles: 'rw',
    water_tankers: 'gwl2wasser',
    hazmat_vehicles: 'gwgefahrgut',
    gwmess: 'gwmesstechnik',
    mobile_air_vehicles: 'gwa',
  };
  const CATEGORY_LABELS = {
    firetrucks: 'TS',
    platform_trucks: 'AL',
    battalion_chief_vehicles: 'OvD',
    mobile_command_vehicles: 'HOvD',
    elw3: 'CO',
    heavy_rescue_vehicles: 'HV',
    water_tankers: 'WT/SL',
    hazmat_vehicles: 'AGS',
    gwmess: 'VEB',
    mobile_air_vehicles: 'AB',
  };
  const formatNeeds = (needs) =>
    Object.entries(needs)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n}× ${CATEGORY_LABELS[k] || k}`)
      .join(', ') || '—';

  /**
   * Stores what we saw of one open mission. Called on every look at the mission window and when dispatching.
   * used: everything assigned (+ selected) — required: on scene + "missing" per category, i.e. what the game really asked.
   */
  function rememberMissionSnapshot(missionId, snap) {
    const open = memRead(MEMORY_KEYS.open, {});
    const prev = open[missionId] || { used: {}, required: {} };
    const maxMerge = (a, b) => {
      const out = { ...a };
      Object.entries(b || {}).forEach(([k, v]) => (out[k] = Math.max(out[k] || 0, v)));
      return out;
    };
    open[missionId] = {
      typeId: snap.typeId,
      name: snap.name || prev.name,
      used: maxMerge(prev.used, snap.used),
      required: maxMerge(prev.required, snap.required),
      ts: Date.now(),
    };
    // Keep the store small: drop missions older than 3 days
    Object.keys(open).forEach((id) => {
      if (Date.now() - open[id].ts > 3 * 86400e3) delete open[id];
    });
    memWrite(MEMORY_KEYS.open, open);
  }

  /** Mission completed: fold its snapshot into the statistics of its type. */
  function finalizeMissionMemory(missionId) {
    const open = memRead(MEMORY_KEYS.open, {});
    const snap = open[missionId];
    if (!snap) return;
    delete open[missionId];
    memWrite(MEMORY_KEYS.open, open);

    const types = memRead(MEMORY_KEYS.types, {});
    const t = (types[snap.typeId] = types[snap.typeId] || { name: snap.name, n: 0, usedSum: {}, required: {}, requiredMax: {} });
    t.name = snap.name || t.name;
    t.n += 1;
    Object.entries(snap.used).forEach(([k, v]) => (t.usedSum[k] = (t.usedSum[k] || 0) + v));
    Object.entries(snap.required).forEach(([k, v]) => {
      if (v <= 0) return;
      t.required[k] = (t.required[k] || 0) + 1;
      t.requiredMax[k] = Math.max(t.requiredMax[k] || 0, v);
    });
    t.last = Date.now();
    memWrite(MEMORY_KEYS.types, types);
    log('Mission memory', snap.typeId, snap.name, t);
  }

  /**
   * Minimum per category for a mission type: official requirements (chance >= minChance)
   * plus categories the game asked for in at least 30% of your completed missions of this type.
   */
  function estimateMinimum(typeId, requirementsCache) {
    const req = requirementsCache?.[typeId];
    const official = {};
    const sometimes = [];
    if (req) {
      Object.entries(req.r).forEach(([k, v]) => {
        if (!CATEGORY_LABELS[k]) return;
        const chance = req.c[k];
        if (chance !== undefined && chance < CONFIG.minChance) sometimes.push({ k, chance, v });
        else official[k] = v;
      });
    }
    const stats = memRead(MEMORY_KEYS.types, {})[typeId] || null;
    const min = { ...official };
    const learned = [];
    if (stats && stats.n >= 2) {
      Object.entries(stats.required).forEach(([k, times]) => {
        if (!CATEGORY_LABELS[k]) return;
        const rate = times / stats.n;
        const max = stats.requiredMax[k] || 1;
        if (rate >= 0.3 && max > (min[k] || 0)) {
          min[k] = max;
          learned.push(`${CATEGORY_LABELS[k]} (${times}/${stats.n}×)`);
        }
      });
    }
    const usual = stats?.n
      ? Object.fromEntries(Object.entries(stats.usedSum).map(([k, sum]) => [k, Math.round(sum / stats.n)]))
      : null;
    const stillSometimes = sometimes.filter((x) => !((min[x.k] || 0) > (official[x.k] || 0)));
    return { official, min, sometimes: stillSometimes, learned, stats, usual };
  }

  /** Best AAO for a minimum: covers everything with the least extra; else the one covering most. */
  function pickAao(min, aaos) {
    if (!Object.values(min).some((n) => n > 0)) return null;
    const scored = aaos.map((a) => {
      let missing = 0;
      let extra = 0;
      Object.keys(CATEGORY_LABELS).forEach((k) => {
        const have = a.counts[k] || 0;
        const need = min[k] || 0;
        if (have < need) missing += need - have;
        else extra += have - need;
      });
      return { a, missing, extra };
    });
    scored.sort((x, y) => x.missing - y.missing || x.extra - y.extra);
    return scored[0] || null;
  }

  /** AAO definitions: from the last mission window, else the game's AAO edit forms (cached 1 hour). */
  async function loadAaoDefinitions() {
    const fromWindow = memRead('mks_mem_aaos_win_v1', null); // read from the AAO buttons in a mission window
    if (fromWindow?.data?.length) return fromWindow.data;
    const cached = memRead('mks_mem_aaos_v1', null);
    if (cached && Date.now() - cached.ts < 3600e3) return cached.data;
    const list = await fetchDoc('/aaos');
    const ids = [...new Set([...list.querySelectorAll('a[href$="/edit"]')].map((a) => a.getAttribute('href').match(/\/aaos\/(\d+)\/edit/)?.[1]).filter(Boolean))];
    const data = [];
    for (const id of ids) {
      const form = (await fetchDoc(`/aaos/${id}/edit`)).querySelector('form');
      if (!form) continue;
      const value = (name) => Number(form.querySelector(`[name="aao[${name}]"]`)?.value || 0);
      const counts = {};
      Object.entries(AAO_KEY_BY_CATEGORY).forEach(([cat, key]) => (counts[cat] = value(key)));
      data.push({ id, caption: form.querySelector('[name="aao[caption]"]')?.value || `AAO ${id}`, counts });
    }
    memWrite('mks_mem_aaos_v1', { ts: Date.now(), data });
    return data;
  }

  /** Fire-only mission types available with your station count, cached 24 h. */
  async function loadFireMissionTypes() {
    const cached = memRead('mks_mem_firetypes_v1', null);
    if (cached && Date.now() - cached.ts < 24 * 3600e3) return cached.data;
    const types = await loadMissionCatalog();
    const data = types
      .filter((t) => {
        const p = t.prerequisites || {};
        return p.fire_stations && !p.main_building && p.fire_stations < 100 && Object.keys(p).every((k) => ['main_building', 'fire_stations'].includes(k));
      })
      .map((t) => ({ id: String(t.id), name: t.name, stations: t.prerequisites.fire_stations, credits: t.average_credits || 0, r: t.requirements || {}, c: t.chances || {} }));
    memWrite('mks_mem_firetypes_v1', { ts: Date.now(), data });
    return data;
  }

  // Extra AAOs for mobile, on top of "2. 2 TS" … "12. Groot + HOvD". Keys = AAO form fields.
  // "1. TS" is included: it was missing in the live account, so small missions got a bigger proposal.
  const EXTRA_AAOS = [
    { caption: '1. TS', color: '43a047', v: { fire: 1 } },
    { caption: '13. TS + OvD', color: '43a047', v: { fire: 1, elw: 1 } },
    { caption: '14. 3 TS', color: 'e53935', v: { fire: 3 } },
    { caption: '15. Zeer grote brand (4 TS, AL, OvD, WT)', color: 'b71c1c', v: { fire: 4, dlk: 1, elw: 1, gwl2wasser: 1 } },
    { caption: '16. Beknelling (2 TS, HV, OvD)', color: '1e88e5', v: { fire: 2, rw: 1, elw: 1 } },
    { caption: '17. Gevaarlijke stoffen (2 TS, OvD, AGS)', color: 'fdd835', v: { fire: 2, elw: 1, gwgefahrgut: 1 } },
    { caption: '18. GS + meten (2 TS, OvD, AGS, VEB)', color: 'f9a825', v: { fire: 2, elw: 1, gwgefahrgut: 1, gwmesstechnik: 1 } },
    { caption: '19. Rook/AB (2 TS, OvD, AB)', color: '6d4c41', v: { fire: 2, elw: 1, gwa: 1 } },
    { caption: '20. GRIP (4 TS, AL, OvD, HOvD, CO, WT)', color: '4a148c', v: { fire: 4, dlk: 1, elw: 1, elw2: 1, elw3: 1, gwl2wasser: 1 } },
    { caption: '21. Alleen AL/HW', color: '8e24aa', v: { dlk: 1 } },
    { caption: '22. Alleen OvD', color: '757575', v: { elw: 1 } },
    { caption: '23. Alleen WT/SL', color: '00838f', v: { gwl2wasser: 1 } },
    { caption: '24. Grote wateroverlast (2 TS, pomp 6000)', color: '0277bd', v: { fire: 2, water_damage_pump_value: 6000 } },
  ];

  /** Creates one AAO through the game's own "new" form (all defaults kept, only our fields changed). */
  async function createAao(def) {
    const doc = await fetchDoc('/aaos/new');
    const form = [...doc.forms].find((f) => /\/aaos\/?$/.test(f.getAttribute('action') || ''));
    if (!form) throw new Error('AAO-formulier niet gevonden');
    const fd = new FormData(form);
    // Empty number fields make the save fail silently: send 0
    form.querySelectorAll('input[type="number"]').forEach((i) => i.name && fd.set(i.name, i.value || '0'));
    form.querySelectorAll('input[type="checkbox"]').forEach((c) => {
      if (/\[(reset|automatic_text_color)\]/.test(c.name)) fd.set(c.name, '1');
    });
    fd.set('aao[caption]', def.caption);
    const colorField = form.querySelector('[name="aao[color]"]');
    if (colorField) fd.set('aao[color]', def.color); // without '#'
    const unknown = [];
    Object.entries(def.v).forEach(([key, n]) => {
      if (form.querySelector(`[name="aao[${key}]"]`)) fd.set(`aao[${key}]`, String(n));
      else unknown.push(key);
    });
    if (unknown.length) throw new Error(`velden onbekend: ${unknown.join(', ')}`);
    await fetch('/aaos', { method: 'POST', body: fd, credentials: 'include' });
  }

  /** Creates the extra AAOs that don't exist yet. Returns { created, skipped, failed }. */
  async function createExtraAaos(onProgress) {
    const existing = (await fetchDoc('/aaos')).body.textContent.replace(/\s+/g, ' ');
    const result = { created: [], skipped: [], failed: [] };
    for (const def of EXTRA_AAOS) {
      if (existing.includes(def.caption)) {
        result.skipped.push(def.caption);
        continue;
      }
      onProgress?.(def.caption);
      try {
        await createAao(def);
        result.created.push(def.caption);
      } catch (e) {
        result.failed.push(`${def.caption}: ${e.message}`);
      }
    }
    // Verify against the list, the POST itself says nothing useful
    const after = (await fetchDoc('/aaos')).body.textContent.replace(/\s+/g, ' ');
    result.created = result.created.filter((c) => {
      if (after.includes(c)) return true;
      result.failed.push(`${c}: niet opgeslagen`);
      return false;
    });
    localStorage.removeItem('mks_mem_aaos_v1');
    localStorage.removeItem('mks_mem_aaos_win_v1');
    return result;
  }

  /** VRU panel section: proposal per mission type, searchable, exportable for mobile. */
  async function renderMissionMemory() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<em>Meldingstypes en inzetvoorstellen laden…</em>';

    (async () => {
      try {
        const [fireTypes, aaos, buildings] = await Promise.all([loadFireMissionTypes(), loadAaoDefinitions(), fetchJson('/api/buildings')]);
        const stationCount = buildings.filter((b) => b.building_type === 0).length;
        const reqCache = Object.fromEntries(fireTypes.map((t) => [t.id, { r: t.r, c: t.c }]));
        const memory = memRead(MEMORY_KEYS.types, {});

        const rows = fireTypes
          .filter((t) => t.stations <= stationCount)
          .map((t) => {
            const est = estimateMinimum(t.id, reqCache);
            const best = pickAao(est.min, aaos);
            return { t, est, best, seen: memory[t.id]?.n || 0 };
          })
          .sort((a, b) => b.seen - a.seen || a.t.name.localeCompare(b.t.name));

        const learnedCount = rows.filter((r) => r.est.learned.length).length;
        const seenCount = rows.filter((r) => r.seen).length;
        wrap.innerHTML = `
          <small class="text-muted">${rows.length} meldingstypes · ${seenCount} al gezien en afgerond · ${learnedCount} bijgesteld door wat je zag · minimum = officieel (≥${CONFIG.minChance}% kans) + wat het spel in ≥30% van jouw meldingen extra vroeg</small>
          <div style="display:flex;gap:4px;margin:4px 0">
            <input type="search" class="form-control input-sm mks-mem-search" placeholder="Zoek melding…">
            <a href="#" class="btn btn-xs btn-default mks-mem-export" title="Download een spiekbriefje voor op je mobiel">📱 Spiekbriefje</a>
            <a href="#" class="btn btn-xs btn-success mks-mem-aaos" title="Maakt ${EXTRA_AAOS.length} extra inzetvoorstellen aan (bestaande worden overgeslagen)">➕ Extra AAO's</a>
            <a href="#" class="btn btn-xs btn-default mks-mem-reset" title="Geleerde gegevens wissen">Wis</a>
          </div>
          <div class="mks-mem-list"></div>`;
        const list = wrap.querySelector('.mks-mem-list');

        const rowHtml = (r) => {
          const extra = r.est.sometimes.length ? ` · soms: ${r.est.sometimes.map((s) => `${CATEGORY_LABELS[s.k]} ${s.chance}%`).join(', ')}` : '';
          const learned = r.est.learned.length ? ` · <span class="text-warning">geleerd: +${escapeHtml(r.est.learned.join(', '))}</span>` : '';
          const aao = r.best ? `👉 ${escapeHtml(r.best.a.caption)}${r.best.missing ? ' <span class="text-danger">(dekt niet alles)</span>' : ''}` : '';
          return `<div class="mks-mem-row" data-name="${escapeHtml(r.t.name.toLowerCase())}" style="margin-bottom:4px">
            <b>${escapeHtml(r.t.name)}</b> <small class="text-muted">${r.seen ? `${r.seen}× gezien` : 'nog niet gezien'}</small><br>
            <small>min: <b>${formatNeeds(r.est.min)}</b>${extra}${learned}<br>${aao}</small></div>`;
        };
        list.innerHTML = rows.map(rowHtml).join('');

        wrap.querySelector('.mks-mem-search').addEventListener('input', (e) => {
          const q = e.target.value.trim().toLowerCase();
          list.querySelectorAll('.mks-mem-row').forEach((el) => (el.style.display = !q || el.dataset.name.includes(q) ? '' : 'none'));
        });
        wrap.querySelector('.mks-mem-aaos').addEventListener('click', async (e) => {
          e.preventDefault();
          const btn = e.currentTarget;
          if (btn.dataset.busy) return;
          if (!window.confirm(`Deze inzetvoorstellen aanmaken (bestaande worden overgeslagen)?\n\n${EXTRA_AAOS.map((a) => a.caption).join('\n')}`)) return;
          btn.dataset.busy = '1';
          try {
            const r = await createExtraAaos((caption) => (btn.textContent = `… ${caption.split('.')[0]}`));
            btn.textContent = `✓ ${r.created.length} nieuw`;
            btn.title = [
              r.created.length && `Aangemaakt: ${r.created.join(', ')}`,
              r.skipped.length && `Bestond al: ${r.skipped.join(', ')}`,
              r.failed.length && `Mislukt: ${r.failed.join('; ')}`,
            ]
              .filter(Boolean)
              .join('\n');
            if (r.failed.length) {
              btn.className = 'btn btn-xs btn-danger';
              window.alert(btn.title);
            }
          } catch (err) {
            console.error('[MKS→HA] AAO create failed', err);
            btn.textContent = 'Mislukt';
            btn.title = err.message;
            btn.className = 'btn btn-xs btn-danger';
          }
          delete btn.dataset.busy;
        });
        wrap.querySelector('.mks-mem-reset').addEventListener('click', (e) => {
          e.preventDefault();
          if (!window.confirm('Alle geleerde inzetgegevens wissen?')) return;
          memWrite(MEMORY_KEYS.types, {});
          memWrite(MEMORY_KEYS.open, {});
          e.target.textContent = '✓';
        });
        wrap.querySelector('.mks-mem-export').addEventListener('click', (e) => {
          e.preventDefault();
          const html = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inzetvoorstellen</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--accent:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--muted:#9a9a9a;--line:#333;--accent:#ef5350}}
body{font:15px/1.4 system-ui,sans-serif;margin:0;padding:12px 16px;background:var(--bg);color:var(--fg)}
h1{font-size:18px;margin:0 0 8px}input{width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);margin-bottom:10px}
.r{border-bottom:1px solid var(--line);padding:8px 0}.n{font-weight:600}.m{color:var(--muted);font-size:13px}.a{color:var(--accent);font-size:13px;font-weight:600}
</style></head><body><h1>🚒 Inzetvoorstellen per melding</h1>
<input id="q" type="search" placeholder="Zoek melding…" autofocus>
${rows
  .map(
    (r) =>
      `<div class="r" data-n="${escapeHtml(r.t.name.toLowerCase())}"><div class="n">${escapeHtml(r.t.name)}</div><div>min: ${formatNeeds(r.est.min)}${
        r.est.sometimes.length ? ` <span class="m">· soms ${r.est.sometimes.map((s) => `${CATEGORY_LABELS[s.k]} ${s.chance}%`).join(', ')}</span>` : ''
      }</div>${r.best ? `<div class="a">👉 ${escapeHtml(r.best.a.caption)}</div>` : ''}</div>`
  )
  .join('')}
<p class="m">Gemaakt ${new Date().toLocaleString('nl-NL')} · ${rows.length} meldingstypes</p>
<script>document.getElementById('q').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('.r').forEach(r=>r.style.display=!q||r.dataset.n.includes(q)?'':'none')})<\/script></body></html>`;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
          a.download = 'inzetvoorstellen.html';
          document.body.append(a);
          a.click();
          a.remove();
        });
      } catch (e) {
        console.error('[MKS→HA] Mission memory failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Laden mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();
    return wrap;
  }

