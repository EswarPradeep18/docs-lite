// Turns an uploaded file into sanitized editor HTML.
// Supported: .txt, .md/.markdown, .docx (paragraphs, headings, bold/italic/
// underline, bulleted and numbered lists). Anything else is rejected with a
// clear message.
import path from 'node:path';
import { sanitizeHtml, escapeHtml } from '../public/shared/sanitize.js';
import { readZipEntries, extractEntry, ZipError } from './zip.js';

export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx'];

export class ImportError extends Error {}

export function importFile(filename, buffer) {
  const ext = path.extname(filename || '').toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new ImportError(
      `Unsupported file type "${ext || 'none'}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`
    );
  }
  if (!buffer || buffer.length === 0) throw new ImportError('The file is empty');

  let html;
  if (ext === '.docx') html = docxToHtml(buffer);
  else {
    const text = decodeText(buffer);
    html = ext === '.txt' ? textToHtml(text) : markdownToHtml(text);
  }
  html = sanitizeHtml(html).trim();
  if (!html) throw new ImportError('No readable text was found in the file');
  return html;
}

export function titleFromFilename(filename) {
  const base = path.basename(filename || '', path.extname(filename || '')).trim();
  return (base || 'Imported document').slice(0, 200);
}

function decodeText(buffer) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (text.includes('\u0000')) throw new ImportError('The file does not look like text');
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------- plain text

export function textToHtml(text) {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// ------------------------------------------------------------------ markdown

function inlineMarkdown(text) {
  // Escape first so user text can never become markup, then add formatting.
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
}

export function markdownToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let paragraph = [];
  let list = null; // { type: 'ul'|'ol', items: [] }
  let inCode = false;
  let code = [];

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.type}>${list.items.map((i) => `<li>${inlineMarkdown(i)}</li>`).join('')}</${list.type}>`);
    }
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (/^```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }

    let m;
    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushParagraph();
      flushList();
      const level = Math.min(m[1].length, 3);
      out.push(`<h${level}>${inlineMarkdown(m[2])}</h${level}>`);
    } else if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph();
      flushList();
      out.push('<hr>');
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushParagraph();
      if (list?.type !== 'ul') flushList();
      list ??= { type: 'ul', items: [] };
      list.items.push(m[1]);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushParagraph();
      if (list?.type !== 'ol') flushList();
      list ??= { type: 'ol', items: [] };
      list.items.push(m[1]);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${inlineMarkdown(m[1])}</blockquote>`);
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  if (inCode) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushParagraph();
  flushList();
  return out.join('\n');
}

// ---------------------------------------------------------------------- docx

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// <w:b/>, <w:b w:val="true"/> -> on; <w:b w:val="0"/> or "false" -> off
function toggleOn(rPr, tag) {
  const m = rPr.match(new RegExp(`<w:${tag}(?:\\s+w:val="([^"]*)")?\\s*/>`));
  if (!m) return false;
  const val = (m[1] ?? 'true').toLowerCase();
  return !['0', 'false', 'none', 'off'].includes(val);
}

/** Map numId -> 'ol' | 'ul' using word/numbering.xml (first level's format). */
function parseNumbering(xml) {
  const result = new Map();
  if (!xml) return result;
  const abstractFormats = new Map();
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const fmt = m[2].match(/<w:numFmt\s+w:val="([^"]+)"/);
    abstractFormats.set(m[1], fmt ? fmt[1] : 'bullet');
  }
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abs = m[2].match(/<w:abstractNumId\s+w:val="(\d+)"/);
    const fmt = abs ? abstractFormats.get(abs[1]) : 'bullet';
    result.set(m[1], fmt === 'bullet' || !fmt ? 'ul' : 'ol');
  }
  return result;
}

function runsToHtml(inner) {
  let html = '';
  for (const r of inner.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)) {
    const run = r[1];
    const rPr = (run.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '';
    let text = '';
    for (const piece of run.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g)) {
      if (piece[1] !== undefined) text += escapeHtml(decodeXml(piece[1]));
      else if (piece[2] === 'tab') text += ' ';
      else text += '<br>';
    }
    if (!text) continue;
    if (toggleOn(rPr, 'u')) text = `<u>${text}</u>`;
    if (toggleOn(rPr, 'i')) text = `<em>${text}</em>`;
    if (toggleOn(rPr, 'b')) text = `<strong>${text}</strong>`;
    html += text;
  }
  return html;
}

export function docxToHtml(buffer) {
  let entries;
  try {
    entries = readZipEntries(buffer);
  } catch (e) {
    if (e instanceof ZipError) throw new ImportError('This .docx file could not be read (not a valid Word document)');
    throw e;
  }
  const docXml = extractEntry(buffer, entries, 'word/document.xml');
  if (!docXml) throw new ImportError('This .docx file has no document body');
  const numberingXml = extractEntry(buffer, entries, 'word/numbering.xml');
  const listTypes = parseNumbering(numberingXml?.toString('utf8'));

  const xml = docXml.toString('utf8');
  const out = [];
  let list = null;
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.join('')}</${list.type}>`);
    list = null;
  };

  for (const p of xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const inner = p[1] || '';
    const pPr = (inner.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || '';
    const style = (pPr.match(/<w:pStyle\s+w:val="([^"]+)"/) || [])[1] || '';
    const numId = (pPr.match(/<w:numId\s+w:val="(\d+)"/) || [])[1];
    const content = runsToHtml(inner);

    const isList = (numId && numId !== '0') || /^ListParagraph$/i.test(style);
    if (isList) {
      if (!content) continue;
      const type = listTypes.get(numId) || 'ul';
      if (list?.type !== type) flushList();
      list ??= { type, items: [] };
      list.items.push(`<li>${content}</li>`);
      continue;
    }

    flushList();
    if (!content) continue;
    const heading = style.match(/^Heading([1-9])$/i);
    if (/^Title$/i.test(style)) out.push(`<h1>${content}</h1>`);
    else if (heading) {
      const level = Math.min(Number(heading[1]), 3);
      out.push(`<h${level}>${content}</h${level}>`);
    } else out.push(`<p>${content}</p>`);
  }
  flushList();
  return out.join('\n');
}
