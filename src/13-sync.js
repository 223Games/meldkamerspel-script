
  /* ------------------------------------------------------------------ */
  /* Sync: share what the script learned between devices (GitHub Gist)   */
  /* ------------------------------------------------------------------ */

  // One private gist, one JSON file: { v, devices: { <deviceId>: { name, ts, data: { <key>: value } } } }
  const SYNC_FILE = 'meldkamerspel-sync.json';
  const SYNC_REMOTE_TYPES = 'mks_sync_remote_types_v1'; // mission memory of the OTHER devices
  const SYNC_STATUS = 'mks_sync_status_v1';

  /**
   * Keys and how to merge them. `log` keys are keyed by mission id (or are lists of unique events):
   * merging is idempotent, so remote entries are folded into the local copy. Mission memory holds
   * running totals: it is kept per device and only added up when read (memoryTypesMerged).
   */
  const SYNC_KEYS = {
    mks_shortage_v1: 'byId',
    mks_not_owned_v1: 'byId',
    mks_extras_completed_v1: 'events',
    mks_extras_credit_snaps_v1: 'events',
    mks_specialists_v1: 'register',
    mks_mem_types_v1: 'perDevice',
  };

  const syncConfig = () => ({ token: GM_getValue('syncToken', ''), gistId: GM_getValue('syncGistId', '') });

  function syncDeviceId() {
    let id = GM_getValue('syncDevice', '');
    if (!id) {
      id = `d${Math.random().toString(36).slice(2, 10)}`;
      GM_setValue('syncDevice', id);
    }
    return id;
  }

  const syncDeviceName = () =>
    /iphone|ipad|android/i.test(navigator.userAgent) ? 'mobiel' : /windows/i.test(navigator.userAgent) ? 'Windows' : /mac/i.test(navigator.userAgent) ? 'Mac' : 'browser';

  const lsRead = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
    } catch (e) {
      return fallback;
    }
  };
  const lsWrite = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* best-effort */
    }
  };

  /** GitHub API call through Tampermonkey (no CORS limits); resolves with parsed JSON. */
  function githubApi(method, path, token, body) {
    return new Promise((resolve, reject) =>
      GM_xmlhttpRequest({
        method,
        url: `https://api.github.com${path}`,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(JSON.parse(res.responseText || '{}'));
            } catch (e) {
              reject(e);
            }
          } else reject(new Error(`GitHub ${res.status}`));
        },
        onerror: () => reject(new Error('GitHub niet bereikbaar')),
      })
    );
  }

  /* ---------- merging ---------- */

  /** Logs keyed by mission id: union; same mission on two devices → highest counts, earliest time. */
  function mergeById(a = {}, b = {}) {
    const out = { ...a };
    Object.entries(b).forEach(([id, entry]) => {
      const mine = out[id];
      if (!mine) return (out[id] = entry);
      const pick = (x = {}, y = {}) => {
        const m = { ...x };
        Object.entries(y).forEach(([k, n]) => (m[k] = Math.max(m[k] || 0, n)));
        return m;
      };
      out[id] = {
        ...mine,
        ts: Math.min(mine.ts || Infinity, entry.ts || Infinity),
        ...(mine.cats || entry.cats ? { cats: pick(mine.cats, entry.cats) } : {}),
        ...(mine.names || entry.names ? { names: pick(mine.names, entry.names) } : {}),
        at: mine.at || entry.at || null,
      };
    });
    return out;
  }

  /** Event lists ({ ts, … }): union without exact duplicates, sorted, last 30 days. */
  function mergeEvents(a = [], b = []) {
    const seen = new Set();
    return [...a, ...b]
      .filter((e) => {
        const key = JSON.stringify(e);
        if (seen.has(key)) return false;
        seen.add(key);
        return Date.now() - e.ts < 30 * 86400e3;
      })
      .sort((x, y) => x.ts - y.ts);
  }

  /** Specialist register: earliest first seen, latest last seen (with its home). */
  function mergeRegister(a = {}, b = {}) {
    const out = { ...a };
    Object.entries(b).forEach(([name, r]) => {
      const mine = out[name];
      if (!mine) return (out[name] = r);
      const newer = (r.lastSeen || 0) > (mine.lastSeen || 0) ? r : mine;
      out[name] = { ...newer, firstSeen: Math.min(mine.firstSeen || Infinity, r.firstSeen || Infinity) };
    });
    return out;
  }

  /** Mission memory of several devices added up (counts, sums; max for maxima; latest name/time). */
  function addMemoryTypes(...sets) {
    const out = {};
    sets.forEach((types) =>
      Object.entries(types || {}).forEach(([typeId, t]) => {
        const o = (out[typeId] = out[typeId] || { name: t.name, n: 0, usedSum: {}, required: {}, requiredMax: {} });
        o.name = t.name || o.name;
        o.n += t.n || 0;
        Object.entries(t.usedSum || {}).forEach(([k, v]) => (o.usedSum[k] = (o.usedSum[k] || 0) + v));
        Object.entries(t.required || {}).forEach(([k, v]) => (o.required[k] = (o.required[k] || 0) + v));
        Object.entries(t.requiredMax || {}).forEach(([k, v]) => (o.requiredMax[k] = Math.max(o.requiredMax[k] || 0, v)));
        o.last = Math.max(o.last || 0, t.last || 0);
      })
    );
    return out;
  }

  /** Mission memory to READ: this device plus every other synced device. Writes stay local. */
  function memoryTypesMerged() {
    const remote = lsRead(SYNC_REMOTE_TYPES, {});
    return addMemoryTypes(lsRead('mks_mem_types_v1', {}), ...Object.values(remote));
  }

  /** Folds the other devices' data into this browser; returns the remote mission memory per device. */
  function applyRemote(devices, self) {
    const remoteTypes = {};
    Object.entries(devices || {}).forEach(([id, dev]) => {
      if (id === self) return;
      Object.entries(SYNC_KEYS).forEach(([key, how]) => {
        const value = dev.data?.[key];
        if (value === undefined) return;
        if (how === 'perDevice') remoteTypes[id] = value;
        else if (how === 'byId') lsWrite(key, mergeById(lsRead(key, {}), value));
        else if (how === 'events') lsWrite(key, mergeEvents(lsRead(key, []), value));
        else if (how === 'register') lsWrite(key, mergeRegister(lsRead(key, {}), value));
      });
    });
    lsWrite(SYNC_REMOTE_TYPES, remoteTypes);
  }

  /* ---------- sync run ---------- */

  let syncBusy = false;

  /** Download → merge → upload this device's own data. Quietly does nothing without a token. */
  async function syncNow() {
    const { token, gistId } = syncConfig();
    if (!token || syncBusy) return null;
    syncBusy = true;
    try {
      const self = syncDeviceId();
      let id = gistId;
      let doc = { v: 1, devices: {} };
      if (id) {
        const gist = await githubApi('GET', `/gists/${id}`, token);
        const file = gist.files?.[SYNC_FILE];
        if (file?.content) doc = JSON.parse(file.content);
      }
      applyRemote(doc.devices, self);

      const data = {};
      Object.keys(SYNC_KEYS).forEach((key) => {
        const value = lsRead(key, null);
        if (value !== null) data[key] = value;
      });
      doc.devices = { ...(doc.devices || {}), [self]: { name: syncDeviceName(), ts: Date.now(), data } };
      const body = { files: { [SYNC_FILE]: { content: JSON.stringify(doc) } } };
      if (id) await githubApi('PATCH', `/gists/${id}`, token, body);
      else {
        const created = await githubApi('POST', '/gists', token, { ...body, public: false, description: 'Meldkamerspel-script: gedeelde leerdata' });
        id = created.id;
        GM_setValue('syncGistId', id);
      }
      const status = { ts: Date.now(), ok: true, devices: Object.values(doc.devices).map((d) => `${d.name} (${new Date(d.ts).toLocaleString('nl-NL')})`) };
      lsWrite(SYNC_STATUS, status);
      log('Synced', status);
      return status;
    } catch (e) {
      console.error('[MKS→HA] Sync failed', e);
      lsWrite(SYNC_STATUS, { ts: Date.now(), ok: false, error: e.message });
      return null;
    } finally {
      syncBusy = false;
    }
  }

  /** Tampermonkey menu: token (gist rights only) and, on the 2nd/3rd device, the gist id of the first. */
  function registerSyncMenu() {
    GM_registerMenuCommand('Synchronisatie instellen (leerdata delen)', async () => {
      const token = window.prompt(
        'GitHub-token met alleen "gist"-rechten (github.com → Settings → Developer settings → Personal access tokens).\nLeeg = synchronisatie uit.',
        GM_getValue('syncToken', '')
      );
      if (token === null) return;
      const gistId = window.prompt(
        'Gist-ID. Op je eerste apparaat leeg laten: het script maakt er een. Op je andere apparaten het ID van het eerste apparaat invullen (staat in VRU-paneel → Instellingen).',
        GM_getValue('syncGistId', '')
      );
      if (gistId === null) return;
      GM_setValue('syncToken', token.trim());
      GM_setValue('syncGistId', gistId.trim());
      const status = token.trim() ? await syncNow() : null;
      window.alert(
        !token.trim()
          ? 'Synchronisatie staat uit.'
          : status
            ? `Gesynchroniseerd. Gist-ID: ${GM_getValue('syncGistId', '')}\nApparaten: ${status.devices.join(', ')}`
            : 'Synchroniseren mislukt: controleer token en gist-ID (F12 → console).'
      );
    });
  }

  /** Every 15 minutes and when the page starts (a few seconds in, so the game loads first). */
  function startSync() {
    if (!syncConfig().token) return;
    setTimeout(syncNow, 5000);
    setInterval(syncNow, 15 * 60e3);
  }

  /** One line for the settings section. */
  function syncStatusText() {
    const { token, gistId } = syncConfig();
    if (!token) return 'Synchronisatie: uit (Tampermonkey-menu → Synchronisatie instellen)';
    const s = lsRead(SYNC_STATUS, null);
    const when = s ? new Date(s.ts).toLocaleString('nl-NL') : 'nog niet';
    return s?.ok
      ? `Synchronisatie: ${when} · gist ${gistId} · apparaten: ${s.devices.join(', ')}`
      : `Synchronisatie: ${s ? `mislukt (${s.error})` : 'wacht op eerste run'} · gist ${gistId || '(nog geen)'}`;
  }
