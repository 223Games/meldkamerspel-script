  /* ------------------------------------------------------------------ */
  /* Mission windows (lightbox iframes on the main page)                 */
  /* ------------------------------------------------------------------ */

  function tryDispatchAssistant(doc) {
    const isMissionPage = /^\/missions\/\d+/.test(doc.location?.pathname || '') && !!doc.getElementById('mission-form');
    if (!isMissionPage || doc.documentElement.dataset.mksAssist) return; // not a mission, or already running
    doc.documentElement.dataset.mksAssist = '1';
    initDispatchAssistant(doc);
  }

  function watchMissionWindows() {
    const attach = (iframe) => {
      if (iframe.dataset.mksWatched) return;
      iframe.dataset.mksWatched = '1';
      // "load" fires on every navigation inside the frame (e.g. "Alarmeren en volgende")
      iframe.addEventListener('load', () => {
        try {
          initPage(iframe.contentDocument);
        } catch (e) {
          console.error('[MKS→HA] Cannot access lightbox window', e);
        }
      });
      if (iframe.contentDocument?.readyState === 'complete') initPage(iframe.contentDocument);
    };

    document.querySelectorAll('iframe.lightbox_iframe').forEach(attach);
    onBodyChange(() => document.querySelectorAll('iframe.lightbox_iframe').forEach(attach));
    log('Watching lightbox windows');
  }

