// Docs Lite front end: a small hash-routed SPA with three screens
// (sign in, document list, editor). No framework; DOM is built with h() so
// user-provided text is always inserted as text, never as HTML.
import { sanitizeHtml, escapeHtml } from './shared/sanitize.js';

const app = document.getElementById('app');
const state = { user: null, config: { supportedImports: ['.txt', '.md', '.docx'], maxUploadMb: 5 } };
let teardown = null; // cleanup for the current screen (timers, listeners)

// ------------------------------------------------------------------ helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function api(method, url, body, headers = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    init.body = body;
    init.headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError("Can't reach the server. Check your connection.", 0, null);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') {
      state.user = null;
      navigate('#/login');
    }
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}

let toastTimer;
function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast toast-${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function roleLabel(role) {
  return { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' }[role] || role;
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function pickFile(onFile) {
  const input = h('input', { type: 'file', accept: state.config.supportedImports.join(',') });
  input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
  input.click();
}

function validateUpload(file) {
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
  if (!state.config.supportedImports.includes(ext)) {
    throw new Error(`Unsupported file type. Use ${state.config.supportedImports.join(', ')}`);
  }
  if (file.size > state.config.maxUploadMb * 1024 * 1024) {
    throw new Error(`File is larger than ${state.config.maxUploadMb} MB`);
  }
}

function uploadHeaders(file) {
  return { 'X-Filename': encodeURIComponent(file.name) };
}

// ------------------------------------------------------------------- shell

function topBar(...right) {
  return h(
    'header',
    { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' }, h('img', { src: '/favicon.svg', alt: '' }), 'Docs Lite'),
    h('div', { class: 'topbar-right' }, ...right,
      state.user && h('span', { class: 'who', title: state.user.email }, state.user.name),
      state.user && h('button', { class: 'btn btn-ghost', onclick: logout }, 'Sign out'))
  );
}

async function logout() {
  await api('POST', '/api/logout').catch(() => {});
  state.user = null;
  navigate('#/login');
}

// ------------------------------------------------------------------ sign in

const DEMO_ACCOUNTS = [
  ['alice@demo.test', 'Alice Chen', 'Owns the welcome doc'],
  ['bob@demo.test', 'Bob Patel', 'Editor on the welcome doc'],
  ['carol@demo.test', 'Carol Diaz', 'Viewer on the welcome doc'],
];

function renderLogin() {
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username', placeholder: 'you@demo.test' });
  const password = h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in');

  async function signIn(emailValue, passwordValue) {
    error.hidden = true;
    submit.disabled = true;
    try {
      const { user } = await api('POST', '/api/login', { email: emailValue, password: passwordValue });
      state.user = user;
      navigate('#/');
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  }

  app.replaceChildren(
    h('main', { class: 'login' },
      h('div', { class: 'login-card' },
        h('div', { class: 'brand brand-lg' }, h('img', { src: '/favicon.svg', alt: '' }), 'Docs Lite'),
        h('p', { class: 'muted' }, 'Write, format and share documents with your team.'),
        h('form', {
          class: 'stack',
          onsubmit: (e) => {
            e.preventDefault();
            signIn(email.value, password.value);
          },
        },
          h('label', {}, 'Email', email),
          h('label', {}, 'Password', password),
          error,
          submit),
        h('div', { class: 'demo-accounts' },
          h('p', { class: 'muted small' }, 'Demo accounts (password ', h('code', {}, 'demo1234'), '). Click to sign in:'),
          ...DEMO_ACCOUNTS.map(([addr, name, note]) =>
            h('button', { class: 'demo-account', type: 'button', onclick: () => signIn(addr, 'demo1234') },
              h('strong', {}, name), h('span', {}, addr), h('small', {}, note)))))));
  email.focus();
}

// --------------------------------------------------------------- home list

async function renderHome() {
  app.replaceChildren(topBar(), h('main', { class: 'home' }, h('p', { class: 'muted' }, 'Loading documents…')));
  let data;
  try {
    data = await api('GET', '/api/documents');
  } catch (e) {
    if (e.status !== 401) app.replaceChildren(topBar(), h('main', { class: 'home' }, h('p', { class: 'form-error' }, e.message)));
    return;
  }

  async function createDoc() {
    try {
      const { document: doc } = await api('POST', '/api/documents', {});
      navigate(`#/d/${doc.id}?new=1`);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function importDoc() {
    pickFile(async (file) => {
      try {
        validateUpload(file);
        toast(`Importing ${file.name}…`);
        const { document: doc } = await api('POST', '/api/documents/import', file, uploadHeaders(file));
        toast(`Imported “${doc.title}”`, 'success');
        navigate(`#/d/${doc.id}`);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  async function deleteDoc(doc) {
    if (!confirm(`Delete “${doc.title}”? This removes it for everyone it's shared with.`)) return;
    try {
      await api('DELETE', `/api/documents/${doc.id}`);
      toast('Document deleted', 'success');
      renderHome();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  const docRow = (doc, shared) =>
    h('li', { class: 'doc-row' },
      h('a', { href: `#/d/${doc.id}`, class: 'doc-link' },
        h('span', { class: 'doc-icon', 'aria-hidden': 'true' }),
        h('span', { class: 'doc-title' }, doc.title),
        h('span', { class: 'doc-meta' },
          shared
            ? [h('span', { class: `badge badge-${doc.role}` }, roleLabel(doc.role)), ` · ${doc.ownerName} · `]
            : doc.shareCount
              ? [h('span', { class: 'badge badge-shared' }, `Shared with ${doc.shareCount}`), ' · ']
              : null,
          `Edited ${timeAgo(doc.updatedAt)}`)),
      !shared && h('button', {
        class: 'icon-btn', title: 'Delete document', 'aria-label': `Delete ${doc.title}`,
        onclick: () => deleteDoc(doc),
      }, '🗑'));

  const section = (title, docs, shared, empty) =>
    h('section', { class: 'doc-section' },
      h('h2', {}, title, h('span', { class: 'count' }, docs.length)),
      docs.length
        ? h('ul', { class: 'doc-list' }, docs.map((d) => docRow(d, shared)))
        : h('p', { class: 'empty' }, empty));

  app.replaceChildren(
    topBar(),
    h('main', { class: 'home' },
      h('div', { class: 'home-actions' },
        h('button', { class: 'card-action', onclick: createDoc },
          h('span', { class: 'plus' }, '+'), h('strong', {}, 'Blank document'), h('small', {}, 'Start from scratch')),
        h('button', { class: 'card-action', onclick: importDoc },
          h('span', { class: 'plus' }, '⇪'), h('strong', {}, 'Import a file'),
          h('small', {}, `${state.config.supportedImports.filter((e) => e !== '.markdown').join(', ')} up to ${state.config.maxUploadMb} MB`))),
      section('My documents', data.owned, false, 'You have no documents yet. Create one or import a file.'),
      section('Shared with me', data.shared, true, 'Nothing has been shared with you yet.')));
}

// ------------------------------------------------------------------ editor

const BLOCK_STYLES = [
  ['p', 'Normal text'],
  ['h1', 'Heading 1'],
  ['h2', 'Heading 2'],
  ['h3', 'Heading 3'],
];

async function renderEditor(id, isNew) {
  app.replaceChildren(topBar(), h('main', { class: 'editor-page' }, h('p', { class: 'muted' }, 'Opening document…')));
  let doc;
  try {
    ({ document: doc } = await api('GET', `/api/documents/${id}`));
  } catch (e) {
    if (e.status === 401) return;
    app.replaceChildren(topBar(),
      h('main', { class: 'editor-page' },
        h('div', { class: 'notice notice-error' }, e.message,
          h('a', { href: '#/', class: 'btn btn-ghost' }, 'Back to documents'))));
    return;
  }

  const editable = doc.role === 'owner' || doc.role === 'editor';
  let version = doc.version;
  let dirty = false; // unsaved content
  let saving = false;
  let conflict = null; // server copy when a 409 happens
  let saveTimer = null;
  let retryTimer = null;

  // ---- elements
  const status = h('span', { class: 'save-status', 'aria-live': 'polite' });
  const titleInput = h('input', {
    class: 'title-input', value: doc.title, maxlength: '200', 'aria-label': 'Document title',
    readonly: !editable,
  });
  const editor = h('div', {
    class: 'page-content', id: 'editor', role: 'textbox', 'aria-multiline': 'true',
    'aria-label': 'Document content', contenteditable: editable ? 'true' : 'false', spellcheck: 'true',
  });
  editor.innerHTML = sanitizeHtml(doc.content) || '';
  const banner = h('div', { class: 'banner', hidden: true });

  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = `save-status ${kind}`;
  };
  const describeSaved = (d) => `Saved · last edit by ${d.updatedBy || 'unknown'} ${timeAgo(d.updatedAt)}`;
  setStatus(editable ? describeSaved(doc) : `View only · last edit by ${doc.updatedBy || 'unknown'} ${timeAgo(doc.updatedAt)}`);

  // ---- saving (debounced autosave + optimistic concurrency)
  function scheduleSave() {
    if (!editable || conflict) return;
    dirty = true;
    setStatus('Unsaved changes…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 800);
  }

  async function flush() {
    clearTimeout(saveTimer);
    if (saving || !dirty || conflict) return;
    saving = true;
    dirty = false;
    setStatus('Saving…');
    try {
      const { document: saved } = await api('PATCH', `/api/documents/${id}`, {
        content: editor.innerHTML,
        baseVersion: version,
      });
      version = saved.version;
      doc = saved;
      setStatus(dirty ? 'Unsaved changes…' : 'All changes saved', dirty ? '' : 'ok');
    } catch (e) {
      if (e.status === 409) {
        dirty = true;
        showConflict(e.body.document);
      } else if (e.status === 401 || e.status === 403 || e.status === 404) {
        setStatus(e.message, 'error');
      } else {
        dirty = true;
        setStatus("Couldn't save. Retrying…", 'error');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, 3000);
      }
    } finally {
      saving = false;
      if (dirty && !conflict) saveTimer = setTimeout(flush, 800);
    }
  }

  function showConflict(serverDoc) {
    conflict = serverDoc;
    setStatus('Not saved: edit conflict', 'error');
    banner.replaceChildren(
      h('span', {}, `${serverDoc.updatedBy || 'Someone'} saved a newer version while you were editing.`),
      h('button', {
        class: 'btn btn-ghost', onclick: () => {
          editor.innerHTML = serverDoc.content;
          version = serverDoc.version;
          conflict = null;
          dirty = false;
          banner.hidden = true;
          setStatus(describeSaved(serverDoc), 'ok');
        },
      }, 'Load their version'),
      h('button', {
        class: 'btn btn-primary', onclick: () => {
          version = serverDoc.version; // overwrite: rebase onto latest and resend mine
          conflict = null;
          banner.hidden = true;
          flush();
        },
      }, 'Keep mine'));
    banner.hidden = false;
  }

  async function saveTitle() {
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.value = doc.title;
      toast('Title cannot be empty', 'error');
      return;
    }
    if (title === doc.title) return;
    try {
      const { document: saved } = await api('PATCH', `/api/documents/${id}`, { title });
      doc.title = saved.title;
      titleInput.value = saved.title;
      document.title = `${saved.title} · Docs Lite`;
      toast('Renamed', 'success');
    } catch (e) {
      titleInput.value = doc.title;
      toast(e.message, 'error');
    }
  }

  // ---- polling for other people's edits (lightweight collaboration signal)
  async function poll() {
    if (document.hidden || saving) return;
    try {
      const { document: latest } = await api('GET', `/api/documents/${id}`);
      if (latest.title !== doc.title && document.activeElement !== titleInput) {
        titleInput.value = latest.title;
        doc.title = latest.title;
      }
      if (latest.version <= version || conflict) return;
      if (!dirty && document.activeElement !== editor) {
        editor.innerHTML = latest.content;
        version = latest.version;
        doc = latest;
        setStatus(editable ? describeSaved(latest) : `View only · last edit by ${latest.updatedBy} ${timeAgo(latest.updatedAt)}`, 'ok');
        toast(`Updated with ${latest.updatedBy}'s latest changes`);
      } else if (!dirty) {
        banner.replaceChildren(
          h('span', {}, `${latest.updatedBy} made changes.`),
          h('button', {
            class: 'btn btn-primary', onclick: () => {
              editor.innerHTML = latest.content;
              version = latest.version;
              doc = latest;
              banner.hidden = true;
            },
          }, 'Show latest'));
        banner.hidden = false;
      }
    } catch (e) {
      if (e.status === 404) {
        setStatus('This document is no longer available to you', 'error');
        editor.setAttribute('contenteditable', 'false');
      }
    }
  }

  // ---- toolbar
  const exec = (command, value = null) => {
    editor.focus();
    document.execCommand(command, false, value);
    updateToolbar();
    scheduleSave();
  };

  const blockSelect = h('select', { 'aria-label': 'Text style', onchange: (e) => exec('formatBlock', e.target.value) },
    BLOCK_STYLES.map(([tag, label]) => h('option', { value: tag }, label)));

  const toolButton = (command, label, title, extraClass = '') =>
    h('button', {
      type: 'button', class: `tool ${extraClass}`, title, 'aria-label': title, dataset: { command },
      onmousedown: (e) => e.preventDefault(), // keep the text selection
      onclick: () => exec(command),
    }, label);

  const toolButtons = [
    toolButton('bold', 'B', 'Bold (Ctrl+B)', 'tool-b'),
    toolButton('italic', 'I', 'Italic (Ctrl+I)', 'tool-i'),
    toolButton('underline', 'U', 'Underline (Ctrl+U)', 'tool-u'),
    toolButton('strikeThrough', 'S', 'Strikethrough', 'tool-s'),
  ];
  const listButtons = [
    toolButton('insertUnorderedList', '• List', 'Bulleted list'),
    toolButton('insertOrderedList', '1. List', 'Numbered list'),
  ];
  const clearButton = toolButton('removeFormat', 'Clear', 'Clear formatting');

  function updateToolbar() {
    for (const btn of [...toolButtons, ...listButtons]) {
      let on = false;
      try {
        on = document.queryCommandState(btn.dataset.command);
      } catch {}
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    let block = '';
    try {
      block = String(document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, '');
    } catch {}
    blockSelect.value = BLOCK_STYLES.some(([t]) => t === block) ? block : 'p';
  }

  const toolbar = editable
    ? h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
        blockSelect, h('span', { class: 'sep' }), ...toolButtons, h('span', { class: 'sep' }), ...listButtons,
        h('span', { class: 'sep' }), clearButton,
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'tool', title: 'Append a file to this document', onclick: importInto }, 'Import file'))
    : h('div', { class: 'toolbar toolbar-readonly' },
        h('span', {}, `You have view-only access. Ask ${doc.owner.name} for edit access.`));

  // ---- import into this document
  function importInto() {
    pickFile(async (file) => {
      try {
        validateUpload(file);
        await flush(); // never lose local edits
        if (conflict) throw new Error('Resolve the edit conflict before importing');
        const { document: updated } = await api('POST', `/api/documents/${id}/import`, file, uploadHeaders(file));
        editor.innerHTML = updated.content;
        version = updated.version;
        doc = updated;
        setStatus('All changes saved', 'ok');
        toast(`Added the contents of ${file.name}`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  // ---- sharing dialog (owner only)
  function openShare() {
    const emailInput = h('input', { type: 'email', required: true, placeholder: 'name@demo.test', list: 'people', 'aria-label': 'Email' });
    const roleSelect = h('select', { 'aria-label': 'Access level' },
      h('option', { value: 'editor' }, 'Can edit'), h('option', { value: 'viewer' }, 'Can view'));
    const people = h('datalist', { id: 'people' });
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const list = h('ul', { class: 'share-list' });

    const renderShares = (shares) => {
      doc.shares = shares;
      list.replaceChildren(
        h('li', {}, h('div', {}, h('strong', {}, `${doc.owner.name} (you)`), h('small', {}, doc.owner.email)),
          h('span', { class: 'badge badge-owner' }, 'Owner')),
        ...shares.map((s) =>
          h('li', {},
            h('div', {}, h('strong', {}, s.name), h('small', {}, s.email)),
            h('select', {
              'aria-label': `Access for ${s.name}`,
              onchange: async (e) => {
                try {
                  renderShares((await api('POST', `/api/documents/${id}/shares`, { email: s.email, role: e.target.value })).shares);
                  toast(`${s.name} can now ${e.target.value === 'editor' ? 'edit' : 'view'}`, 'success');
                } catch (ex) {
                  toast(ex.message, 'error');
                }
              },
            },
              h('option', { value: 'editor', selected: s.role === 'editor' }, 'Can edit'),
              h('option', { value: 'viewer', selected: s.role === 'viewer' }, 'Can view')),
            h('button', {
              class: 'icon-btn', title: `Remove ${s.name}`, 'aria-label': `Remove ${s.name}`,
              onclick: async () => {
                try {
                  renderShares((await api('DELETE', `/api/documents/${id}/shares/${s.userId}`)).shares);
                  toast(`Removed ${s.name}`, 'success');
                } catch (ex) {
                  toast(ex.message, 'error');
                }
              },
            }, '✕'))));
    };
    renderShares(doc.shares || []);
    api('GET', '/api/users').then(({ users }) =>
      people.replaceChildren(...users.map((u) => h('option', { value: u.email }, u.name)))).catch(() => {});

    const dialog = h('dialog', { class: 'dialog', onclose: () => dialog.remove() },
      h('form', {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          try {
            const { shares } = await api('POST', `/api/documents/${id}/shares`, { email: emailInput.value, role: roleSelect.value });
            renderShares(shares);
            toast(`Shared with ${emailInput.value}`, 'success');
            emailInput.value = '';
          } catch (ex) {
            err.textContent = ex.message;
            err.hidden = false;
          }
        },
      },
        h('h2', {}, `Share “${doc.title}”`),
        h('div', { class: 'share-add' }, emailInput, roleSelect, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Share')),
        people,
        err,
        h('h3', {}, 'People with access'),
        list,
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, 'Done'))));
    document.body.append(dialog);
    dialog.showModal();
    emailInput.focus();
  }

  // ---- events
  editor.addEventListener('input', scheduleSave);
  editor.addEventListener('keyup', updateToolbar);
  editor.addEventListener('mouseup', updateToolbar);
  editor.addEventListener('blur', () => dirty && flush());
  editor.addEventListener('paste', (e) => {
    // Paste through the same sanitizer the server uses, so foreign styles,
    // scripts and links never enter the document.
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    const clean = html
      ? sanitizeHtml(html)
      : escapeHtml(text).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    document.execCommand('insertHTML', false, clean);
    // Chrome re-applies computed styles to inserted nodes; strip them so the
    // editor shows exactly what will be saved.
    for (const el of editor.querySelectorAll('[style]')) el.removeAttribute('style');
    for (const span of editor.querySelectorAll('span')) span.replaceWith(...span.childNodes);
    scheduleSave();
  });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      editor.focus();
    }
    if (e.key === 'Escape') {
      titleInput.value = doc.title;
      titleInput.blur();
    }
  });
  titleInput.addEventListener('blur', () => editable && saveTitle());

  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      flush();
    }
  };
  const onBeforeUnload = (e) => {
    if (dirty || saving) {
      flush();
      e.preventDefault();
      e.returnValue = '';
    }
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onBeforeUnload);
  const pollTimer = setInterval(poll, 8000);

  teardown = () => {
    if (dirty) flush();
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    clearInterval(pollTimer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.title = 'Docs Lite';
  };

  document.execCommand('defaultParagraphSeparator', false, 'p');
  document.execCommand('styleWithCSS', false, false);
  document.title = `${doc.title} · Docs Lite`;

  app.replaceChildren(
    topBar(
      h('span', { class: `badge badge-${doc.role}` }, roleLabel(doc.role)),
      doc.role === 'owner'
        ? h('button', { class: 'btn btn-primary', onclick: openShare }, 'Share')
        : h('span', { class: 'muted small' }, `Owned by ${doc.owner.name}`)),
    h('main', { class: 'editor-page' },
      h('div', { class: 'doc-head' },
        h('a', { href: '#/', class: 'back', 'aria-label': 'Back to documents' }, '←'),
        titleInput,
        status),
      toolbar,
      banner,
      h('div', { class: 'page' }, editor)));

  if (isNew && editable) {
    titleInput.focus();
    titleInput.select();
  } else if (editable) {
    editor.focus();
  }
}

// ------------------------------------------------------------------ router

async function render() {
  if (teardown) {
    teardown();
    teardown = null;
  }
  const [route, query = ''] = (location.hash.slice(1) || '/').split('?');

  if (!state.user) {
    try {
      state.user = (await api('GET', '/api/me')).user;
    } catch {
      state.user = null;
    }
    if (!state.user && route !== '/login') return navigate('#/login');
  }
  if (route === '/login') return state.user ? navigate('#/') : renderLogin();

  const docMatch = route.match(/^\/d\/([\w-]+)$/);
  if (docMatch) return renderEditor(docMatch[1], new URLSearchParams(query).has('new'));
  return renderHome();
}

window.addEventListener('hashchange', render);
api('GET', '/api/config').then((c) => (state.config = c)).catch(() => {}).finally(render);
