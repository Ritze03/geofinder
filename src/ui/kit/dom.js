// Tiny DOM builder. Text children are always text nodes (never innerHTML), so player names/labels are safe.
const PROPS = new Set(['value', 'disabled', 'checked', 'hidden', 'selected']);

/**
 * h('button', { class: 'btn', onClick: fn, disabled: true, dataset: { x: 1 }, maxlength: 14 }, 'Label', child, [more])
 * Props: class | style (string) | dataset (object) | onXxx (listener, event = xxx lowercased) | value/disabled/checked/hidden (properties)
 * | anything else becomes an attribute (null/undefined/false are skipped). Children: strings, numbers, Nodes, arrays, null.
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

/** Append children (strings, numbers, Nodes, arrays, null) to `el`. */
export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
