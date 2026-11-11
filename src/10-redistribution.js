  /* ------------------------------------------------------------------ */
  /* Redistribution: vehicles at the wrong station + personnel balance   */
  /* ------------------------------------------------------------------ */

  // Never suggested for moving: hose truck, hook-lift trucks/containers, trailers and deliberate specialists
  const MOVE_EXCLUDED_TYPES = new Set([
    10, 26, 27, 29, 32, 45, 51, 61, 69, 89, 91, 121, 123, 127, 134, 136, 138, 141, 149, // SL + hook-lift
    36, 70, 71, 72, 154, 156, // trailers
    19, 24, 31, 11, 56, // HOvD, AGS, CO, DB-VEB, DA-VL
  ]);
  const SPECIALIST_NAME = /09-\d{2}(29|91|97|87|89|95)\b/; // specialist call signs we hand out ourselves

  /** Vehicle kind used for matching official slots: TS and TST are interchangeable. */
  const kindOf = (typeId) => {
    const label = labelOf(typeId);
    return label === 'TST' ? 'TS' : label;
  };

  const distanceKm = (a, b) => {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.latitude - a.latitude);
    const dLon = rad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
  };

  /** Moves a vehicle with the game's own "Hierheen verplaatsen" link and checks the result. */
  async function moveVehicle(vehicleId, targetBuildingId) {
    await fetch(`/vehicles/${vehicleId}/move/do/${targetBuildingId}`, { credentials: 'include' });
    const moved = (await fetchJson('/api/vehicles', { fresh: true })).find((v) => v.id === vehicleId);
    log(`Moved ${vehicleId} → ${targetBuildingId}`, moved?.building_id === targetBuildingId);
    if (moved?.building_id !== targetBuildingId) throw new Error('verplaatsen niet gelukt (voertuig onderweg of post vol?)');
    return true;
  }

  function planRedistribution(data) {
    const { stationRows, typeInfo, vehicles } = data;
    const crewOf = (typeId) => typeInfo[typeId]?.maxCrew || 3;

    // Simulation state per station: free slots, crew, filled official slots
    const state = new Map(
      stationRows.map((r) => {
        const code = stationCodeFromName(r.station.caption);
        const filled = new Set(r.own.map((v) => (v.caption || '').match(/09-(\d{4})/)?.[1]).filter(Boolean));
        return [
          r.station.id,
          {
            row: r,
            code,
            freeSlots: Math.max(0, r.station.level + 1 - r.own.length),
            crewNeeded: r.crewNeeded,
            staff: r.staff.length,
            open: code && VRU_STATIONS[code] ? VRU_STATIONS[code][1].filter(([suffix]) => !filled.has(suffix)) : [],
          },
        ];
      })
    );

    const moves = [];
    const renames = [];
    const stuck = [];

    stationRows.forEach((r) => {
      const home = state.get(r.station.id);
      if (!home.code || !VRU_STATIONS[home.code]) return;
      const official = VRU_STATIONS[home.code][1];

      r.own.forEach((v) => {
        if (MOVE_EXCLUDED_TYPES.has(v.vehicle_type) || SPECIALIST_NAME.test(v.caption || '')) return;
        const number = (v.caption || '').match(/09-(\d{4})/)?.[1];
        const isOfficial = official.some(([suffix, t]) => suffix === number && kindOf(t) === kindOf(v.vehicle_type));
        if (isOfficial) return;

        // 1. An open official slot of this kind at its own station: just rename
        const ownSlot = home.open.find(([, t]) => kindOf(t) === kindOf(v.vehicle_type));
        if (ownSlot) {
          home.open = home.open.filter((s) => s !== ownSlot);
          renames.push({ vehicle: v, station: r.station, to: vehicleName(ownSlot[0], v.vehicle_type) });
          return;
        }

        // 2. Another station that officially has this kind, lacks it, and has room
        const crew = v.max_personnel_override || crewOf(v.vehicle_type);
        const targets = [...state.values()]
          .filter((s) => s !== home && s.open.some(([, t]) => kindOf(t) === kindOf(v.vehicle_type)))
          .map((s) => ({ s, km: distanceKm(r.station, s.row.station) }))
          .sort((a, b) => Number(b.s.freeSlots > 0) - Number(a.s.freeSlots > 0) || a.km - b.km);
        const target = targets.find((t) => t.s.freeSlots > 0);

        if (!target) {
          stuck.push({ vehicle: v, station: r.station, waiting: targets[0] || null });
          return;
        }
        const slot = target.s.open.find(([, t]) => kindOf(t) === kindOf(v.vehicle_type));
        target.s.open = target.s.open.filter((s) => s !== slot);
        target.s.freeSlots -= 1;
        home.freeSlots += 1;
        home.crewNeeded -= crew;
        target.s.crewNeeded += crew;
        const shortage = target.s.crewNeeded - target.s.staff;
        moves.push({
          vehicle: v,
          from: r.station,
          to: target.s.row.station,
          km: target.km,
          newName: vehicleName(slot[0], v.vehicle_type),
          personnel: shortage > 0 ? `${shortage} personeel tekort op de nieuwe post` : `personeel ok (${target.s.staff}/${target.s.crewNeeded})`,
          personnelOk: shortage <= 0,
        });
      });
    });

    // Personnel: untrained, unbound people from stations with surplus to stations with a shortage
    const transfers = [];
    const donors = [...state.values()]
      .map((s) => ({
        s,
        spare: Math.min(
          s.staff - Math.max(MIN_STATION_PERSONNEL, s.crewNeeded),
          s.row.staff.filter((p) => !p.keys.length && !p.boundVehicleId).length
        ),
        pool: s.row.staff.filter((p) => !p.keys.length && !p.boundVehicleId),
      }))
      .filter((d) => d.spare > 0)
      .sort((a, b) => b.spare - a.spare);
    [...state.values()]
      .filter((s) => s.staff < s.crewNeeded)
      .sort((a, b) => b.crewNeeded - b.staff - (a.crewNeeded - a.staff))
      .forEach((s) => {
        let need = s.crewNeeded - s.staff;
        donors
          .filter((d) => d.spare > 0)
          .sort((a, b) => distanceKm(a.s.row.station, s.row.station) - distanceKm(b.s.row.station, s.row.station))
          .forEach((d) => {
            if (need <= 0) return;
            const take = Math.min(d.spare, need);
            const people = d.pool.splice(0, take);
            d.spare -= take;
            need -= take;
            transfers.push({ from: d.s.row.station, to: s.row.station, people });
          });
        if (need > 0) transfers.push({ from: null, to: s.row.station, people: [], missing: need });
      });

    return { moves, renames, stuck, transfers };
  }

  async function renderRedistribution() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<em>Voertuigen en personeel van alle posten controleren…</em>';

    (async () => {
      try {
        const data = await analysePersonnel();
        const { moves, renames, stuck, transfers } = planRedistribution(data);
        const transferInfo = await loadTransferInfo(data.stations[0].id);
        const short = (caption) => escapeHtml(caption.trim().replace(`${CONFIG.vru.prefix} `, ''));
        wrap.innerHTML = '';

        const button = (label, onClick, cls, confirmText) => {
          const a = document.createElement('a');
          a.href = '#';
          a.className = `btn btn-xs ${cls}`;
          a.style.marginLeft = '4px';
          a.textContent = label;
          a.addEventListener('click', async (e) => {
            e.preventDefault();
            if (a.dataset.busy || (confirmText && !window.confirm(confirmText))) return;
            a.dataset.busy = '1';
            a.textContent = '…';
            try {
              await onClick();
              a.textContent = '✓';
              a.className = 'btn btn-xs btn-default';
            } catch (err) {
              console.error('[MKS→HA]', err);
              a.textContent = 'Mislukt';
              a.title = err.message;
              a.className = 'btn btn-xs btn-danger';
            }
          });
          return a;
        };
        const line = (html, ...buttons) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;gap:6px;margin-bottom:6px';
          row.innerHTML = `<span>${html}</span>`;
          const right = document.createElement('span');
          right.style.whiteSpace = 'nowrap';
          buttons.forEach((b) => right.append(b));
          row.append(right);
          wrap.append(row);
        };
        const heading = (text) => {
          const h = document.createElement('div');
          h.style.cssText = 'font-weight:bold;margin:6px 0 3px';
          h.textContent = text;
          wrap.append(h);
        };

        if (!moves.length && !renames.length && !stuck.length && !transfers.length) {
          wrap.innerHTML = '<em>Alles staat op de juiste post en het personeel is in balans. ✅</em>';
          return;
        }

        if (moves.length || renames.length || stuck.length) heading('🚒 Voertuigen die hier officieel niet horen');
        renames.forEach((r) =>
          line(
            `✏️ <b>${short(r.vehicle.caption)}</b> <small class="text-muted">· ${short(r.station.caption)}</small><br><small>Hoort hier wel, maar onder het officiële nummer → <b>${short(r.to)}</b></small>`,
            button('Hernoem', () => renameVehicle(r.vehicle.id, r.to), 'btn-success')
          )
        );
        moves.forEach((m) =>
          line(
            `🔀 <b>${short(m.vehicle.caption)}</b> <small class="text-muted">· nu ${short(m.from.caption)}</small><br><small>→ <b>${short(m.to.caption)}</b> (${m.km.toFixed(
              1
            )} km), wordt <b>${short(m.newName)}</b> · ${m.personnelOk ? '👷' : '⚠️'} ${escapeHtml(m.personnel)}</small>`,
            button(
              'Verplaats + hernoem',
              async () => {
                await moveVehicle(m.vehicle.id, m.to.id);
                await renameVehicle(m.vehicle.id, m.newName);
              },
              'btn-warning',
              `${m.vehicle.caption.trim()} verplaatsen van ${m.from.caption.trim()} naar ${m.to.caption.trim()} en hernoemen naar ${m.newName}?`
            )
          )
        );
        stuck.forEach((s) =>
          line(
            `⏸️ <b>${short(s.vehicle.caption)}</b> <small class="text-muted">· ${short(s.station.caption)}</small><br><small>${
              s.waiting
                ? `Hoort officieel bij ${short(s.waiting.s.row.station.caption)}, maar daar is geen plek: eerst die post een level omhoog.`
                : 'Geen gebouwde post waar dit voertuig officieel hoort en nog ontbreekt. Laat staan of bouw de juiste post.'
            }</small>`
          )
        );

        if (transfers.length) {
          heading(`👷 Personeel herverdelen (nog ${transferInfo.remaining} verplaatsingen deze week)`);
          transfers.forEach((t) => {
            if (!t.from) {
              line(`⚠️ <b>${short(t.to.caption)}</b><br><small>Nog ${t.missing} personeel tekort, niemand over: start werving.</small>`);
              return;
            }
            line(
              `➡️ <b>${t.people.length}</b> personeel <small class="text-muted">(zonder opleiding)</small> van <b>${short(t.from.caption)}</b> naar <b>${short(t.to.caption)}</b>`,
              button(
                'Verplaats',
                () => transferPersonnel(t.to.id, t.people.map((p) => p.id)),
                'btn-warning',
                `${t.people.length} personeel (${t.people.map((p) => p.name).join(', ')}) van ${t.from.caption.trim()} naar ${t.to.caption.trim()} verplaatsen?\n\nDit kan NIET ongedaan worden.`
              )
            );
          });
        }
      } catch (e) {
        console.error('[MKS→HA] Redistribution failed', e);
        wrap.innerHTML = `<div class="alert alert-danger">Controle mislukt: ${escapeHtml(e.message)}</div>`;
      }
    })();
    return wrap;
  }

