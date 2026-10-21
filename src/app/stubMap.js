// Stub map for plain browsers (e2e, `vite preview`): same API as createMapPanel() -> { element, show, load, getUrl, destroy }.
// No real map: a plain panel whose "position" is a Google Maps URL (always isAllowedMapUrl-valid, so core accepts it). The position
// starts at a spot derived from `seed` (the player name) and moves a step on every click on the view, like panning would. getUrl()
// returns the current position; load(url) adopts any allowed url and shows its text. The shown url is also in [data-url] (on the panel), so
// tests can read it. Markup mirrors the real panel: .map-panel > (.map-bar +) .map-view. A 'view' stub has no bar.
import '../map/mapPanel.css';
import { isAllowedMapUrl } from '../../electron/allowlist.js';

const PROVIDERS = { google: 'Google Maps', apple: 'Apple Maps' };
const POS = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;

const hash = (s) => {
  let n = 7;
  for (const ch of String(s)) n = Math.imul(n ^ ch.charCodeAt(0), 2654435761) >>> 0;
  return n;
};

/** @param {HTMLElement} container  @param {{ mode?:'play'|'view', seed?:string }} [o] */
export function createStubMap(container, { mode = 'play', seed = 'player' } = {}) {
  const h = hash(seed);
  let provider = 'google';
  let lat = 40 + (h % 100000) / 10000;
  let lng = 5 + ((h >>> 8) % 100000) / 10000;   // somewhere in Europe, unique per seed
  let url = null;
  let clicks = 0;

  const home = () => (provider === 'apple'
    ? `https://maps.apple.com/frame?z=17&center=${lat.toFixed(6)}%2C${lng.toFixed(6)}`
    : `https://www.google.com/maps/@${lat.toFixed(6)},${lng.toFixed(6)},15z`);

  const element = document.createElement('div');
  element.className = mode === 'view' ? 'map-panel map-panel-view' : 'map-panel';
  element.dataset.stubMap = mode;
  const view = document.createElement('div');
  view.className = 'map-view';
  view.style.cssText = 'position:relative;flex:1;min-height:0;overflow:hidden;background:#1d2733;color:#dfe8f2;display:grid;place-content:center;gap:8px;text-align:center;padding:16px;font:600 14px system-ui,sans-serif;cursor:grab';
  const title = document.createElement('div');
  const urlEl = document.createElement('code');
  urlEl.style.cssText = 'font:12px ui-monospace,monospace;overflow-wrap:anywhere;max-width:90ch;opacity:.85';
  view.append(title, urlEl);
  if (mode !== 'view') {
    const bar = document.createElement('div');
    bar.className = 'map-bar';
    bar.textContent = 'Stub map (browser mode)';
    element.append(bar);
  }
  element.append(view);
  container.append(element);

  function set(next) {
    url = next;
    element.dataset.url = url;
    urlEl.textContent = url;
    title.textContent = `${PROVIDERS[provider]} (stub, ${mode})`;
  }
  set(home());

  // a click "pans": the position moves a little, so a later getUrl() differs from an earlier one
  const onClick = () => {
    const m = POS.exec(url);
    if (m) { lat = +m[1]; lng = +m[2]; }
    clicks++;   // the step grows with every click, so moving back and forth never lands on an earlier spot
    lat += 0.0013 + clicks * 0.00001;
    lng += 0.0017 + clicks * 0.00002;
    set(home());
  };
  view.addEventListener('click', onClick);

  return {
    element,
    show(p) {
      if (!PROVIDERS[p]) throw new Error(`unknown map provider: ${p}`);
      provider = p;
      set(home());
    },
    load(next) { if (isAllowedMapUrl(next)) set(next); },
    getUrl: () => url,
    destroy() { view.removeEventListener('click', onClick); element.remove(); },
  };
}
