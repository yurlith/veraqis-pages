// VERAQIS Studio — service worker registration and the update prompt.
//
// The worker never activates itself. When a new version is waiting, the page
// offers a reload and applies it only when the user agrees and no analysis is
// running — an update must not swap the app out mid-task.

const isBusy = () => {
  const busy = document.getElementById('studio-busy');
  return !!(busy && !busy.hidden);
};

function showUpdateBanner(registration) {
  if (document.getElementById('studio-update-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'studio-update-banner';
  bar.className = 'st-update';
  bar.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.textContent = 'A new VERAQIS version is available.';
  bar.appendChild(text);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn ghost st-sm';
  btn.textContent = 'Reload safely';
  btn.addEventListener('click', () => {
    if (isBusy()) {
      text.textContent = 'The update will apply after the current analysis finishes.';
      return;
    }
    const waiting = registration.waiting;
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
      // controllerchange fires once the new worker takes over.
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    } else {
      location.reload();
    }
  });
  bar.appendChild(btn);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn ghost st-sm';
  dismiss.textContent = 'Later';
  dismiss.addEventListener('click', () => bar.remove());
  bar.appendChild(dismiss);

  document.body.appendChild(bar);
}

function showOfflineState() {
  const set = (online) => {
    const n = document.getElementById('studio-offline-state');
    if (!n) return;
    n.textContent = online ? '' : 'You are offline — Studio is running from its local copy.';
    n.hidden = online;
  };
  window.addEventListener('online', () => set(true));
  window.addEventListener('offline', () => set(false));
  set(navigator.onLine !== false);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // Scope is /studio/ — the worker never sees the rest of the site.
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/studio/' });
      if (reg.waiting) showUpdateBanner(reg);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          // 'installed' with an existing controller means an update is waiting.
          if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(reg);
        });
      });
      showOfflineState();
    } catch {
      // Private browsing and some enterprise policies block registration.
      // Studio works without it; only offline use is lost.
      showOfflineState();
    }
  });
} else {
  showOfflineState();
}
