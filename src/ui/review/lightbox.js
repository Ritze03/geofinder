// Full-size image overlay for the review screen. One at a time; closes on Escape, backdrop click or the Close button.
// openLightbox({ src, caption }) -> { close() }. The overlay lives on document.body (position: fixed), so a screen's destroy()
// should call closeLightbox() to make sure none is left behind.
import { h } from '../kit/index.js';

let current = null;

export function closeLightbox() {
  if (current) current.close();
}

/** @param {{src:string, caption?:string, alt?:string}} o */
export function openLightbox({ src, caption = '', alt = '' }) {
  closeLightbox();
  const prevFocus = document.activeElement;
  const closeBtn = h('button', { type: 'button', class: 'btn lb-close', onClick: () => close() }, 'Close');
  const box = h('figure', { class: 'lb-box' },
    h('img', { src, alt: alt || caption || 'Capture' }),
    h('figcaption', null, caption ? h('b', null, caption) : null, closeBtn));
  const el = h('div', { class: 'lb-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': caption || 'Capture', onClick: (e) => { if (e.target === el) close(); } }, box);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); closeBtn.focus(); } // single focusable control: keep focus inside
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(el);
  closeBtn.focus();

  function close() {
    if (current !== handle) return;
    current = null;
    document.removeEventListener('keydown', onKey, true);
    el.remove();
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus();
  }
  const handle = { close };
  current = handle;
  return handle;
}
