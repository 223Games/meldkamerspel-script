  /* ------------------------------------------------------------------ */
  /* VRU completeness beyond the base fleet: specials, trailers, regional */
  /* ------------------------------------------------------------------ */

  /**
   * Real VRU vehicles (Brandbase regio 09, Nov 2026) that have a game equivalent, on top of VRU_STATIONS.
   * Hook-lift containers (haakarmbakken) are replaced by a full vehicle or trailer on purpose (not wanted unless unavoidable).
   * `posts` = station codes (one vehicle per post unless `count`), `regional` = not at a post (the game needs a fire station).
   */
  const VRU_EXTRAS = [
    { id: 'ab', typeId: 5, label: 'AB', posts: ['07', '64'], real: 'Adembeschermingshaakarmbak → AB-voertuig (09-44 staat al in de postlijst)' },
    { id: 'riet', typeId: 153, label: 'DB-RI', posts: ['06', '37', '58', '61'], real: 'Rietdak Brandbestrijdingsteamvoertuig' },
    { id: 'ria', typeId: 154, label: 'RIA', posts: ['06', '37', '58', '61'], real: 'Rietdak-aanhanger (trailer)' },
    { id: 'vi', typeId: 155, label: 'DB-VI', posts: ['21', '23'], real: 'Veetakel Installatie voertuig' },
    { id: 'via', typeId: 156, label: 'VIA', posts: ['29'], real: 'Veetakel Installatie Aanhanger' },
    { id: 'co', typeId: 31, label: 'CO', posts: ['01', '18'], real: 'Commandovoertuig Multi CoPI' },
    { id: 'sb', typeId: 68, label: 'SB', posts: ['18'], count: 2, real: 'Schuimblusvoertuig: 2 in totaal (de eerste staat al in de postlijst)' },
    { id: 'or', typeId: 49, label: 'PM-OR', posts: ['12', '57', '62'], real: 'Oppervlaktereddingsteam voertuig' },
    { id: 'msa', typeId: 71, label: 'MSA', posts: ['04', '14', '16', '21', '26', '30', '32', '56', '58'], real: 'Motorspuitaanhanger (trailer)' },
    { id: 'dpa', typeId: 72, label: 'DPA', posts: ['26', '41', '44', '55'], real: 'Dompelpomphaakarmbak → aanhanger' },
    { id: 'gp', typeId: 137, label: 'DB-GP', posts: ['48'], real: 'Ontsteuningsteamvoertuig Gaspakteam' },
    { id: 'bo', typeId: 139, label: 'TS-BO', posts: ['45', '60'], real: 'Basis Ontsmettingshaakarmbak → TS-BO' },
    { id: 'go', typeId: 142, label: 'TS-GO', posts: ['55'], real: 'Decontaminatiehaakarmbak → TS-GO' },
    { id: 'ah', typeId: 122, label: 'DB-AH', posts: ['44'], real: 'Arbeidshygiëne-haakarmbak → DB-AH' },
    { id: 'vz', typeId: 120, label: 'DB-VZ', posts: ['29', '35', '44'], real: 'Verzorgingsvoertuig' },
    { id: 'ags', typeId: 24, label: 'AGS', regional: true, count: 2, real: 'AGS West + Oost (regionaal)' },
    { id: 'hovd', typeId: 19, label: 'HOvD', regional: true, count: 2, real: 'HOvD West + Oost (regionaal)' },
    { id: 'vl', typeId: 56, label: 'DA-VL', regional: true, real: 'Communicatieadviseur CoPI (regionaal)' },
    { id: 'veb', typeId: 11, label: 'VEB', regional: true, real: 'Verkenningsvoertuig 09-9017 (regionaal)' },
    { id: 'tdv', typeId: 129, label: 'DB-TDV', regional: true, count: 2, real: 'Droneteams 09-9189 / 09-9289 (regionaal)' },
    { id: 'pclog', typeId: 124, label: 'DB-PC-LOG', regional: true, real: 'Dienstvoertuig PC-Log (regionaal)' },
  ];

  /** Real VRU vehicles without a game equivalent: not tracked, only listed. */
  const VRU_NO_GAME_EQUIVALENT = [
    'Quick Response Team + teamleider (01, 27, 53)',
    'Bijzondere Blusmiddelen Voertuig (28)',
    'Multifunctioneel Terreinvoertuig (03, 31, 55) en Verrijker (62)',
    'Poederblus- en milieuaanhanger (04, 68)',
    'Leiding & Coördinatie Unit (55): dichtstbij is de CO',
    'Brandweervaartuigen/boot (04, 14, 27, 36, 57, 59): vragen een blusboot-ligplaats, geen kazerne',
    'Brand-/bronpomp-/waterbassin-haakarmbak (22, 33, 64) en HA-voertuigen: haakarm, bewust niet',
    'Informatie Manager ×2, Commandant van Dienst, Team Brandonderzoek, Piket (regionaal)',
  ];

  const ACHIEVED_KEY = 'mks_vru_achieved_v1';

  /** Per extra: what is open. Posts that are not built yet are open with `unbuilt`. */
  function vruExtrasStatus(stations, vehicles) {
    const byCode = new Map();
    stations.forEach((b) => {
      const c = stationCodeFromName(b.caption);
      if (c) byCode.set(c, b);
    });
    const countAt = (typeId, buildingId) => vehicles.filter((v) => v.vehicle_type === typeId && v.building_id === buildingId).length;
    const items = [];
    VRU_EXTRAS.forEach((x) => {
      const need = x.count || 1;
      if (x.regional) {
        const have = vehicles.filter((v) => v.vehicle_type === x.typeId && stations.some((s) => s.id === v.building_id)).length;
        items.push({ key: `${x.id}@regio`, x, where: 'regionaal', missing: Math.max(0, need - have) });
        return;
      }
      x.posts.forEach((code) => {
        const b = byCode.get(code);
        const perPost = x.posts.length === 1 ? need : 1;
        const have = b ? countAt(x.typeId, b.id) : 0;
        items.push({ key: `${x.id}@${code}`, x, where: `09-${code}`, missing: Math.max(0, perPost - have), unbuilt: !b });
      });
    });
    return items;
  }

  /** Records what is complete (kept, so completed work stays counted) and returns the open items. */
  function recordAchievements(keys) {
    const done = memRead(ACHIEVED_KEY, {});
    let changed = false;
    keys.forEach((k) => {
      if (!done[k]) {
        done[k] = Date.now();
        changed = true;
      }
    });
    if (changed) memWrite(ACHIEVED_KEY, done);
    return done;
  }
