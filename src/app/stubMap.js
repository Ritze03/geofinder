// Stub map for plain browsers (e2e, `vite preview`): same shape as createMapPanel() -> { element, show, capture }.
// A canvas-drawn "street scene" that differs per provider and carries the player's name, so captures are real JPEG bytes
// that differ per player / provider / moment. Markup mirrors the real panel: .map-panel > .map-bar + .map-view.
import '../map/mapPanel.css';
import { colorHex } from '../ui/kit/index.js';

const W = 960;
const H = 600;
const PROVIDERS = { google: 'Google Maps', apple: 'Apple Maps' };

/** @param {{ name?:string, color?:string }} [who]  player name + colour id, drawn into the scene */
export function createStubMap({ name = 'Player', color = 'coral' } = {}) {
  let provider = 'google';
  let shots = 0;

  const element = document.createElement('div');
  element.className = 'map-panel';
  element.dataset.stubMap = '';
  const bar = document.createElement('div');
  bar.className = 'map-bar';
  bar.textContent = 'Stub map (browser mode)';
  const view = document.createElement('div');
  view.className = 'map-view';
  view.style.cssText = 'position:relative;overflow:hidden;background:#13131e';
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain';
  view.append(canvas);
  element.append(bar, view);

  function draw() {
    const g = canvas.getContext('2d');
    const apple = provider === 'apple';
    g.fillStyle = apple ? '#dfe9d2' : '#e8e0d0'; g.fillRect(0, 0, W, H);
    g.fillStyle = apple ? '#9ed0e8' : '#aadaff'; g.fillRect(0, H * 0.62, W, H * 0.38);            // water
    g.fillStyle = apple ? '#bcdba0' : '#c8e6b8'; g.fillRect(W * 0.08, H * 0.1, W * 0.3, H * 0.3); // park
    g.strokeStyle = '#fdfdfd'; g.lineWidth = 14;
    for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(i * W / 6, 0); g.lineTo(i * W / 6 + (shots % 3) * 20, H * 0.62); g.stroke(); }
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, i * H * 0.15); g.lineTo(W, i * H * 0.15 + 30); g.stroke(); }
    g.fillStyle = colorHex(color); g.beginPath(); g.arc(W * 0.7, H * 0.3, 46, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1b1428'; g.font = '700 54px system-ui, sans-serif';
    g.fillText(name, 40, H - 70);
    g.font = '600 26px system-ui, sans-serif';
    g.fillText(`${PROVIDERS[provider]} (stub)  #${shots}  ${new Date().toLocaleTimeString()}`, 40, H - 30);
  }
  draw();

  return {
    element,
    show(p) {
      if (!PROVIDERS[p]) throw new Error(`unknown map provider: ${p}`);
      provider = p;
      draw();
    },
    /** Real JPEG Blob of the current scene (what the real panel's capture() also returns). */
    capture() {
      shots++;
      draw();
      return new Promise((resolve, reject) => canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/jpeg', 0.8));
    },
  };
}
