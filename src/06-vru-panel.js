  /* ------------------------------------------------------------------ */
  /* VRU panel (main page): tasks, hiring, expansion, advice, progress   */
  /* ------------------------------------------------------------------ */

  // Approximate credit prices per vehicle type (measured in the shop, Oct 2026)
  const VEHICLE_PRICES = {
    0: 5000, 1: 5000, 6: 5000, 7: 5000, 8: 5000, 9: 5000, 12: 5000, 14: 5000, 15: 5000, 17: 5000,
    2: 10000, 18: 10000, 3: 10000, 33: 10000, 4: 12180, 5: 11680, 10: 17300, 34: 17000,
  };
  const DEFAULT_VEHICLE_PRICE = 15000; // types not measured (SB, CO, …)
  /**
   * Price of the NEXT fire station, given how many you already have (blog.meldkamerspel.com/kostenoverzicht/brandweerkosten):
   * from 23 stations on: 100.000 + 200.000 × log2(stations − 22); before that a flat 100.000.
   * A small station ("Kazerne (klein)") costs half.
   */
  const stationBuildPrice = (existingStations, small = CONFIG.vru.defaultBuildingType === 17) => {
    const normal = existingStations < 23 ? 100000 : 100000 + 200000 * Math.log2(existingStations - 22);
    return Math.round(small ? normal / 2 : normal);
  };
  const countFireStations = (buildings) => buildings.filter((b) => b.building_type === 0).length;
  const LEVEL_STEP_PRICES = [10000, 50000, 100000, 100000, 100000]; // level n -> n+1

  // How often a vehicle kind is needed in your fire missions (share of mission types)
  const NEED_WEIGHT = { AL: 34, OvD: 17, HV: 12, WT: 7, TS: 3, NB: 3, TST: 3, WO: 2, SB: 1, AB: 1, SW: 1 };

  // Hand-picked build order: fills the biggest gaps around your current coverage first
  const BUILD_PRIORITY = [
    '66', '51', '48', '27', '18', '55', '39', '44', '20', '62', '13', '50', '36', '64',
    '35', '65', '10', '09', '17', '43', '47', '49', '45', '46', '28', '25', '29', '59',
  ];

  const formatCredits = (n) => `${Math.round(n).toLocaleString('nl-NL')}`;
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** Counts owned vehicles per label (TS, AL, OvD, …). */
  function countLabels(vehicles) {
    const counts = {};
    vehicles.forEach((v) => {
      const label = labelOf(v.vehicle_type);
      if (label) counts[label] = (counts[label] || 0) + 1;
    });
    return counts;
  }

  /** Ranks stations that are not built yet. */
  function rankUnbuiltStations(buildings, vehicles) {
    const built = new Set(buildings.map((b) => stationCodeFromName(b.caption)).filter(Boolean));
    const owned = countLabels(vehicles);
    const nextStationPrice = stationBuildPrice(countFireStations(buildings));
    const all = Object.keys(VRU_STATIONS).map((c) => String(c).padStart(2, '0'));

    return all
      .filter((c) => !built.has(c))
      .map((code) => {
        const vehiclesRef = VRU_STATIONS[code][1];
        // Specialists = everything except the first fire engine (that one comes free with the station)
        const specialists = vehiclesRef.filter(([, t]) => labelOf(t) !== 'TS');
        const score = specialists.reduce((s, [, t]) => s + (NEED_WEIGHT[labelOf(t)] || 1) / (1 + (owned[labelOf(t)] || 0)), 0);
        const priority = BUILD_PRIORITY.indexOf(code);
        const firstSpecialist = specialists[0];
        const cost =
          nextStationPrice + (firstSpecialist ? LEVEL_STEP_PRICES[0] + (VEHICLE_PRICES[firstSpecialist[1]] || DEFAULT_VEHICLE_PRICE) : 0);
        return { code, name: VRU_STATIONS[code][0], specialists, score, priority, cost };
      })
      .sort((a, b) => {
        // Hand-picked order first, then by how much the station adds
        const pa = a.priority === -1 ? 999 : a.priority;
        const pb = b.priority === -1 ? 999 : b.priority;
        return pa - pb || b.score - a.score;
      });
  }

  /** What a built station still misses compared to the VRU reference. */
  function stationStatus(building, vehicles) {
    const code = stationCodeFromName(building.caption);
    const ref = code && VRU_STATIONS[code] ? VRU_STATIONS[code][1] : [];
    const own = vehicles.filter((v) => v.building_id === building.id);
    const ownNumbers = new Set(own.map((v) => (v.caption || '').match(/09-(\d{4})/)?.[1]).filter(Boolean));
    const missing = ref.filter(([suffix]) => !ownNumbers.has(suffix));
    const slots = building.level + 1;
    const free = Math.max(0, slots - own.length);
    const levelsNeeded = Math.max(0, own.length + missing.length - slots);
    let levelCost = 0;
    for (let l = building.level; l < building.level + levelsNeeded; l++) levelCost += LEVEL_STEP_PRICES[Math.min(l, 4)];
    const vehicleCost = missing.reduce((s, [, t]) => s + (VEHICLE_PRICES[t] || DEFAULT_VEHICLE_PRICE), 0);
    return { code, ref, own, missing, slots, free, levelsNeeded, cost: levelCost + vehicleCost };
  }

  async function loadTasks() {
    const doc = await fetchDoc('/tasks/index');
    const pane = doc.getElementById('all') || doc.body;
    const num = (s) => parseInt(String(s).replace(/\./g, ''), 10) || 0;
    return [...pane.querySelectorAll('.task_panel.hidden-xs')].map((p) => {
      p.querySelectorAll('script').forEach((s) => s.remove());
      const heading = p.querySelector('.panel-heading');
      const category = heading?.querySelector('b')?.textContent.replace(/[[\]]/g, '').trim() || '';
      const title = (heading?.textContent || '')
        .replace(/\[[^\]]*\]/, '')
        .replace(/Meer taken volgen/, '')
        .replace(/\s+/g, ' ')
        .trim();
      const body = (p.querySelector('.task_body')?.textContent || '').replace(/\s+/g, ' ');
      const progress = body.match(/([\d.]+)\s*\/\s*([\d.]+)/);
      const reward = (body.match(/[\d.]+ Credits|\d+ coins?/gi) || []).join(' + ');
      const form = p.querySelector('form[action*="claim_reward"]');
      const claimable = !!form?.querySelector('input[type=submit]:not([disabled])');
      return {
        category,
        title,
        done: progress ? num(progress[1]) : 0,
        total: progress ? num(progress[2]) : 1,
        reward,
        claimable,
        form,
      };
    });
  }

  async function claimTask(form) {
    const res = await fetch(form.getAttribute('action'), { method: 'POST', body: new FormData(form), credentials: 'include' });
    log('Claimed task', res.status);
    return res.ok;
  }

  function initPanel() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-danger btn-sm';
    button.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;box-shadow:0 2px 6px rgba(0,0,0,.3);';
    button.innerHTML = '🚒 VRU <span class="badge" style="display:none"></span>';
    const badge = button.querySelector('.badge');

    const panel = document.createElement('div');
    panel.className = 'panel panel-default';
    panel.style.cssText =
      'position:fixed;left:12px;bottom:52px;z-index:9999;width:500px;max-width:calc(100vw - 24px);max-height:75vh;overflow:auto;display:none;box-shadow:0 4px 16px rgba(0,0,0,.35);font-size:13px;';
    panel.innerHTML = `
      <div class="panel-heading" style="display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:1">
        <b>🚒 VRU-paneel</b>
        <span>
          <a href="#" class="mks-refresh" title="Vernieuwen">↻</a>
          <a href="#" class="mks-close" title="Sluiten" style="margin-left:10px">✕</a>
        </span>
      </div>
      <div class="panel-body" style="padding:8px 10px"></div>`;
    const body = panel.querySelector('.panel-body');

    document.body.append(panel, button);

    const open = () => panel.style.display !== 'none';
    button.addEventListener('click', () => {
      panel.style.display = open() ? 'none' : 'block';
      if (open()) render();
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

    // Badge: claimable tasks + stations without recruitment
    async function updateBadge() {
      try {
        const [tasks, buildings] = await Promise.all([loadTasks(), fetchJson('/api/buildings')]);
        const claimable = tasks.filter((t) => t.claimable).length;
        const notHiring = buildings.filter((b) => b.building_type === 0 && !b.hiring_phase).length;
        const total = claimable + notHiring;
        badge.textContent = total;
        badge.style.display = total ? 'inline-block' : 'none';
        button.title = `${claimable} taak/taken te claimen, ${notHiring} post(en) zonder werving`;
      } catch (e) {
        console.error('[MKS→HA] Badge update failed', e);
      }
    }
    updateBadge();
    setInterval(updateBadge, 5 * 60e3);

    async function render() {
      body.innerHTML = '<em>Laden…</em>';
      try {
        const [buildings, vehicles, credits, tasks] = await Promise.all([
          fetchJson('/api/buildings'),
          fetchJson('/api/vehicles'),
          fetchJson('/api/credits'),
          loadTasks(),
        ]);
        const fireStations = buildings
          .filter((b) => b.building_type === 0)
          .sort((a, b) => a.caption.trim().localeCompare(b.caption.trim()));
        const balance = credits.credits_user_current;

        body.innerHTML = '';
        body.append(
          section('🎯 Prioriteiten, teamhulp & vergeten voertuigen', await renderPriorities(), true),
          section('📋 Taken', renderTasks(tasks), false),
          section('👥 Werving', renderHiring(fireStations), false),
          section('🧭 Ontwikkelplan (incl. personeel)', await renderPlan(balance), true),
          section('🔀 Herverdelen: voertuigen & personeel', await renderRedistribution(), true),
          section('📚 Inzetgeheugen per melding', await renderMissionMemory(), false),
          section('🗺️ VRU-voortgang', renderProgress(fireStations, buildings, vehicles), false),
          section('📈 Rapport', await renderReport(balance, fireStations.length), false),
          section('⚙️ Instellingen', renderSettings(), false),
        );
        updateBadge();
      } catch (e) {
        console.error('[MKS→HA] Panel failed', e);
        body.innerHTML = `<div class="alert alert-danger">Laden mislukt: ${escapeHtml(e.message)}</div>`;
      }
    }

    function section(title, content, isOpen) {
      const details = document.createElement('details');
      details.open = isOpen;
      details.style.marginBottom = '8px';
      details.innerHTML = `<summary style="cursor:pointer;font-weight:bold;margin-bottom:4px">${title}</summary>`;
      details.append(content);
      return details;
    }

    function el(html) {
      const div = document.createElement('div');
      div.innerHTML = html;
      return div;
    }

    function actionButton(label, onClick, cls = 'btn-success') {
      const a = document.createElement('a');
      a.href = '#';
      a.className = `btn btn-xs ${cls}`;
      a.textContent = label;
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        if (a.dataset.busy) return;
        a.dataset.busy = '1';
        a.textContent = '…';
        try {
          const ok = await onClick();
          a.textContent = ok === false ? 'Mislukt' : '✓';
          a.className = `btn btn-xs ${ok === false ? 'btn-danger' : 'btn-default'}`;
        } catch (err) {
          console.error(err);
          a.textContent = 'Mislukt';
          a.className = 'btn btn-xs btn-danger';
        }
      });
      return a;
    }

    /* ---- Tasks ---- */
    function renderTasks(tasks) {
      const open = tasks
        .filter((t) => t.claimable || t.done < t.total)
        .sort((a, b) => Number(b.claimable) - Number(a.claimable) || b.done / b.total - a.done / a.total);
      const wrap = el('');
      const claimable = open.filter((t) => t.claimable);
      if (claimable.length > 1) {
        const all = actionButton(`Alles claimen (${claimable.length})`, async () => {
          for (const t of claimable) await claimTask(t.form);
          setTimeout(render, 500);
        });
        all.style.marginBottom = '6px';
        wrap.append(all);
      }
      if (!open.length) wrap.append(el('<em>Geen openstaande taken.</em>'));
      open.slice(0, 15).forEach((t) => {
        const pct = Math.min(100, Math.round((t.done / t.total) * 100));
        const row = el(`
          <div style="display:flex;justify-content:space-between;gap:6px">
            <span>${t.category ? `<small class="text-muted">[${escapeHtml(t.category)}]</small> ` : ''}${escapeHtml(t.title)}</span>
            <span style="white-space:nowrap"><b>${formatCredits(t.done)}/${formatCredits(t.total)}</b></span>
          </div>
          <div class="progress" style="height:6px;margin:2px 0 1px"><div class="progress-bar ${t.claimable ? 'progress-bar-success' : ''}" style="width:${pct}%"></div></div>
          <small class="text-muted">${escapeHtml(t.reward)}</small>`);
        row.style.marginBottom = '6px';
        if (t.claimable) {
          const btn = actionButton('Claim', async () => {
            const ok = await claimTask(t.form);
            setTimeout(updateBadge, 500);
            return ok;
          });
          btn.style.marginLeft = '6px';
          row.querySelector('small').after(btn);
        }
        wrap.append(row);
      });
      if (open.length > 15) wrap.append(el(`<small class="text-muted">+ ${open.length - 15} meer op de takenpagina</small>`));
      return wrap;
    }

    /* ---- Hiring ---- */
    function renderHiring(stations) {
      const wrap = el('');
      const notHiring = stations.filter((b) => !b.hiring_phase);
      const hiring = stations.filter((b) => b.hiring_phase);
      const hire = (b) => () =>
        fetch(`/buildings/${b.id}/hire_do/${CONFIG.vru.autoHireDays || 3}`, { credentials: 'include' }).then((r) => r.ok);

      if (notHiring.length > 1) {
        const all = actionButton(`Alle ${notHiring.length} posten ${CONFIG.vru.autoHireDays || 3} dagen laten werven`, async () => {
          for (const b of notHiring) await hire(b)();
          setTimeout(render, 500);
        });
        all.style.marginBottom = '6px';
        wrap.append(all);
      }
      notHiring.forEach((b) => {
        const row = el(`<span>${escapeHtml(b.caption.trim())} <small class="text-muted">(${b.personal_count} personeel)</small></span>`);
        row.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:3px';
        row.append(actionButton(`${CONFIG.vru.autoHireDays || 3} dagen werven`, hire(b)));
        wrap.append(row);
      });
      if (hiring.length)
        wrap.append(
          el(
            `<small class="text-muted">Werft al: ${hiring
              .map((b) => `${escapeHtml(b.caption.trim().replace(`${CONFIG.vru.prefix} `, ''))} (${b.hiring_phase}d)`)
              .join(', ')}</small>`
          )
        );
      if (!stations.length) wrap.append(el('<em>Geen brandweerposten.</em>'));
      return wrap;
    }

    /* ---- Progress ---- */
    function renderProgress(stations, buildings, vehicles) {
      const wrap = el('');
      const total = Object.keys(VRU_STATIONS).length;
      const statuses = stations.map((b) => ({ b, s: stationStatus(b, vehicles) })).filter((x) => x.s.code);
      const builtCodes = new Set(statuses.map((x) => x.s.code));
      const unbuilt = rankUnbuiltStations(buildings, vehicles);
      const refVehicles = Object.values(VRU_STATIONS).reduce((n, [, v]) => n + v.length, 0);
      const vruVehicles = statuses.reduce((n, x) => n + (x.s.ref.length - x.s.missing.length), 0);
      const finishBuilt = statuses.reduce((n, x) => n + x.s.cost, 0);
      const existingStations = countFireStations(buildings);
      const finishUnbuilt = unbuilt.reduce((n, s, i) => {
        const vehiclesCost = VRU_STATIONS[s.code][1]
          .slice(1)
          .reduce((c, [, t]) => c + (VEHICLE_PRICES[t] || DEFAULT_VEHICLE_PRICE), 0);
        const levels = VRU_STATIONS[s.code][1].length - 1;
        let levelCost = 0;
        for (let l = 0; l < levels; l++) levelCost += LEVEL_STEP_PRICES[Math.min(l, 4)];
        return n + stationBuildPrice(existingStations + i) + vehiclesCost + levelCost; // every station raises the next price
      }, 0);

      wrap.append(
        el(`<div><b>${builtCodes.size}/${total}</b> posten · <b>${vruVehicles}/${refVehicles}</b> VRU-voertuigen</div>
            <div class="progress" style="height:8px;margin:3px 0"><div class="progress-bar progress-bar-danger" style="width:${Math.round(
              (builtCodes.size / total) * 100
            )}%"></div></div>
            <small class="text-muted">Afmaken ≈ ${formatCredits(finishBuilt)} (bestaande posten) + ${formatCredits(finishUnbuilt)} (nieuwe posten)</small>`)
      );

      const list = el('');
      list.style.marginTop = '6px';
      statuses
        .sort((a, b) => a.s.code.localeCompare(b.s.code))
        .forEach(({ b, s }) => {
          const complete = !s.missing.length;
          list.append(
            el(
              `<div style="margin-bottom:2px">${complete ? '✅' : '🟡'} 09-${s.code} ${escapeHtml(VRU_STATIONS[s.code][0])} <small class="text-muted">${
                s.ref.length - s.missing.length
              }/${s.ref.length}${complete ? '' : ` · mist ${s.missing.map(([n, t]) => `${n} ${labelOf(t)}`).join(', ')}`}</small></div>`
            )
          );
        });
      if (unbuilt.length)
        list.append(
          el(
            `<div style="margin-top:4px"><small class="text-muted">Nog te bouwen (${unbuilt.length}): ${unbuilt
              .map((s) => `09-${s.code} ${escapeHtml(s.name)}`)
              .join(', ')}</small></div>`
          )
        );
      wrap.append(list);
      return wrap;
    }
  }

