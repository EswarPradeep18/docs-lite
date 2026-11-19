// Allowlist HTML sanitizer shared by the server (on every write) and the
// browser (on paste). Only structural/formatting tags survive, and every
// attribute is dropped, so stored content can never carry scripts, event
// handlers, styles or links.

const ALLOWED = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h1', 'h2', 'h3',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'div',
]);

// Normalise equivalent tags so stored HTML is consistent.
const NORMALIZE = { b: 'strong', i: 'em', div: 'p' };
const VOID = new Set(['br', 'hr']);

// Elements whose *contents* must be discarded, not just the tags.
const DROP_WITH_CONTENT =
  /<(script|style|iframe|object|embed|template|noscript|title|head|svg|math)\b[\s\S]*?<\/\1\s*>/gi;

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

function escapeText(text) {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function sanitizeHtml(input) {
  let html = String(input ?? '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(DROP_WITH_CONTENT, '');

  const out = [];
  let last = 0;
  TAG.lastIndex = 0;
  let match;
  while ((match = TAG.exec(html))) {
    out.push(escapeText(html.slice(last, match.index)));
    last = TAG.lastIndex;

    const closing = match[1] === '/';
    let tag = match[2].toLowerCase();
    if (!ALLOWED.has(tag)) continue;
    tag = NORMALIZE[tag] || tag;

    if (VOID.has(tag)) {
      if (!closing) out.push(`<${tag}>`);
      continue;
    }
    out.push(closing ? `</${tag}>` : `<${tag}>`);
  }
  out.push(escapeText(html.slice(last)));
  return out.join('');
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
