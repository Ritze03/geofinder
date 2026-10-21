// Dev/test stubs for the live map pieces, shared by the Play and Review preview harnesses (no webview, no network).
// Everything that happens is pushed into `calls` as { kind, arg } so interaction scripts can assert it:
//   map.show(provider) / map.load(url) / viewer.create / viewer.load(url) / viewer.destroy.
// The stubs render the loaded url as text ([data-url]), so a test can read which url a map/viewer currently shows.
const SCENE = 'position:relative;overflow:hidden;background:linear-gradient(#8cc3ee 0 38%,#6f7d6a 38% 55%,#3b3f46 55%);display:grid;place-items:center;align-content:center;gap:10px;color:#fff;font:700 16px system-ui;text-shadow:0 1px 6px #000a;text-align:center;padding:16px';

function scene(kind) {
  const box = document.createElement('div');
  box.style.cssText = SCENE;
  const title = document.createElement('div');
  title.textContent = kind;
  const urlEl = document.createElement('code');
  urlEl.dataset.url = '';
  urlEl.style.cssText = 'font:600 12px ui-monospace,monospace;max-width:90%;overflow-wrap:anywhere;background:#0008;padding:4px 8px;border-radius:8px';
  box.append(title, urlEl);
  return { box, title, urlEl };
}

/** Stub of createMapPanel() for the play map. Same markup shape (panel > .map-bar + view). */
export function createStubMap(calls, log = () => {}) {
  const element = document.createElement('div');
  element.className = 'map-panel';
  const bar = document.createElement('div');
  bar.className = 'map-bar';
  bar.textContent = 'STUB map-bar (must be hidden on the Play screen)';
  const s = scene('STUB Google Maps (live map placeholder)');
  s.box.className = 'map-view';
  s.box.dataset.stub = 'map';
  s.box.style.flex = '1';
  element.append(bar, s.box);
  const api = {
    element,
    show(p) {
      s.title.textContent = `STUB ${p === 'apple' ? 'Apple Maps' : 'Google Maps'} (live map placeholder)`;
      s.urlEl.textContent = '';
      calls.push({ kind: 'map.show', arg: p });
      log('map.show', p);
    },
    load(url) { s.urlEl.textContent = url; calls.push({ kind: 'map.load', arg: url }); log('map.load', url); },
    getUrl: () => s.urlEl.textContent || 'https://www.google.com/maps/@48.77,9.18,15z',
  };
  api.show('google');
  return api;
}

/** createViewer(container) stub: appends a div to the container that shows the loaded url. factory.live = Set of undestroyed viewers. */
export function stubViewerFactory(calls, log = () => {}) {
  const live = new Set();
  const factory = (container) => {
    const s = scene('STUB live viewer');
    const element = s.box;
    element.dataset.stub = 'viewer';
    container.append(element);
    const v = {
      element,
      load(url) { s.urlEl.textContent = url; calls.push({ kind: 'viewer.load', arg: url }); log('viewer.load', url); },
      destroy() { live.delete(v); element.remove(); calls.push({ kind: 'viewer.destroy' }); log('viewer.destroy'); },
    };
    live.add(v);
    calls.push({ kind: 'viewer.create' });
    log('viewer.create');
    return v;
  };
  factory.live = live;
  return factory;
}
