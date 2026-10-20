// Avatar drawing, ported 1:1 from design/mockup.html (HEADS / FACES arrays, clipped highlight, colour ring).
import { COLORS, FACE_INK } from '../../contracts.js';

const K = FACE_INK;

const HEAD_SHAPES = {
  round: (c) => `<circle cx="50" cy="52" r="42" fill="${c}"/>`,
  square: (c) => `<rect x="10" y="12" width="80" height="80" rx="24" fill="${c}"/>`,
  wide: (c) => `<ellipse cx="50" cy="54" rx="44" ry="37" fill="${c}"/>`,
  hex: (c) => `<polygon points="50,8 87,29 87,71 50,93 13,71 13,29" fill="${c}" stroke="${c}" stroke-width="8" stroke-linejoin="round"/>`,
  dome: (c) => `<path d="M50 8C80 8 92 60 87 78Q85 92 70 92H30Q15 92 13 78C8 60 20 8 50 8Z" fill="${c}"/>`,
};

const FACE_SHAPES = {
  happy: `<circle cx="36" cy="47" r="5.5" fill="${K}"/><circle cx="64" cy="47" r="5.5" fill="${K}"/><path d="M33 63Q50 80 67 63" stroke="${K}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
  cool: `<rect x="20" y="38" width="26" height="17" rx="7" fill="${K}"/><rect x="54" y="38" width="26" height="17" rx="7" fill="${K}"/><path d="M46 45h8" stroke="${K}" stroke-width="4"/><path d="M38 67Q50 76 62 66" stroke="${K}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
  wink: `<circle cx="36" cy="47" r="5.5" fill="${K}"/><path d="M57 48Q64 39 71 48" stroke="${K}" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M34 62h32q-2 17-16 17t-16-17z" fill="${K}"/>`,
  oh: `<circle cx="36" cy="45" r="6.5" fill="${K}"/><circle cx="64" cy="45" r="6.5" fill="${K}"/><ellipse cx="50" cy="71" rx="8" ry="10" fill="${K}"/>`,
  sleepy: `<path d="M29 48Q36 55 43 48M57 48Q64 55 71 48" stroke="${K}" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M42 69h16" stroke="${K}" stroke-width="5" stroke-linecap="round"/><text x="72" y="30" font-size="16" font-weight="800" fill="${K}" font-family="sans-serif">z</text>`,
};

let clipN = 0;
const toNode = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild;
};

/** Hex of a COLORS id (unknown id => first colour). */
export const colorHex = (colorId) => (COLORS.find((c) => c.id === colorId) || COLORS[0]).hex;

/**
 * The bare avatar SVG (no ring).
 * @param {{color:string, head:string, face:string}} look  ids from COLORS / HEADS / FACES (a Profile works as is)
 * @param {number} [size=40] px
 * @returns {SVGElement}
 */
export function avatarSvg(look, size = 40) {
  const c = colorHex(look && look.color);
  const head = (HEAD_SHAPES[look && look.head] || HEAD_SHAPES.round)(c);
  const face = FACE_SHAPES[look && look.face] || FACE_SHAPES.happy;
  const id = `avclip${clipN++}`;
  return toNode(
    `<svg class="av" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><defs><clipPath id="${id}">${head}</clipPath></defs>${head}` +
      `<path clip-path="url(#${id})" d="M22 36Q30 19 50 15" stroke="#fff" stroke-opacity=".35" stroke-width="5" fill="none" stroke-linecap="round"/>${face}</svg>`,
  );
}

/**
 * Avatar with the colour ring used everywhere in the mockup (lobby list, chat, minis, review cards).
 * The outer element is size + 2*ringWidth px wide. Sets `--c` to the player colour, so descendants/CSS can use var(--c).
 * @param {{color:string, head:string, face:string}} look  a Profile (or just the three ids)
 * @param {{size?:number, ring?:boolean}} [opts]  size 40 default; ring:false returns the bare SVG
 * @returns {HTMLElement|SVGElement}
 */
export function avatar(look, { size = 40, ring = true } = {}) {
  const svg = avatarSvg(look, size);
  if (!ring) return svg;
  const span = document.createElement('span');
  span.className = 'ring';
  span.style.setProperty('--c', colorHex(look && look.color));
  span.append(svg);
  return span;
}
