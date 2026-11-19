import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml } from '../public/shared/sanitize.js';
import { markdownToHtml, textToHtml, importFile, ImportError } from '../src/importers.js';

test('sanitizer keeps formatting tags and strips everything else', () => {
  assert.equal(sanitizeHtml('<b>a</b><i>b</i><div>c</div>'), '<strong>a</strong><em>b</em><p>c</p>');
  assert.equal(sanitizeHtml('<p style="color:red" class="x">t</p>'), '<p>t</p>');
  assert.equal(sanitizeHtml('<style>p{}</style><script src=x></script><iframe></iframe>ok'), 'ok');
  assert.equal(sanitizeHtml('<svg><script>alert(1)</script></svg>x'), 'x');
  assert.equal(sanitizeHtml('<!-- c --><img src=x onerror="alert(1)">'), '');
  // Attribute containing ">" can't smuggle a live tag: leftovers become text.
  assert.ok(!/<img|onerror="[^"]*"\s*>/.test(sanitizeHtml('<img alt=">" onerror=alert(1)>')));
  assert.equal(sanitizeHtml('5 < 6 & 7 > 3'), '5 &lt; 6 & 7 &gt; 3');
});

test('markdown converter handles headings, lists, inline styles and escapes HTML', () => {
  const html = markdownToHtml('# Title\n#### Deep\n\nText with **bold**, *em* and `code`.\n\n1. a\n2. b\n\n> quote\n\n<b>raw</b>');
  assert.equal(
    html,
    [
      '<h1>Title</h1>',
      '<h3>Deep</h3>',
      '<p>Text with <strong>bold</strong>, <em>em</em> and <code>code</code>.</p>',
      '<ol><li>a</li><li>b</li></ol>',
      '<blockquote>quote</blockquote>',
      '<p>&lt;b&gt;raw&lt;/b&gt;</p>',
    ].join('\n')
  );
});

test('plain text keeps paragraphs and line breaks', () => {
  assert.equal(textToHtml('one\ntwo\n\nthree'), '<p>one<br>two</p>\n<p>three</p>');
});

test('importFile rejects empty, binary and unsupported files', () => {
  assert.throws(() => importFile('a.txt', Buffer.alloc(0)), ImportError);
  assert.throws(() => importFile('a.txt', Buffer.from([0, 1, 2])), ImportError);
  assert.throws(() => importFile('a.exe', Buffer.from('x')), /Unsupported file type/);
});
