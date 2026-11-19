// Single source of truth for document access. Every document route goes
// through resolveAccess(), so the rules live in one place:
//
//   owner  -> read, edit, rename, share, delete
//   editor -> read, edit, rename, import into
//   viewer -> read only
//   none   -> treated as "not found" so we never leak that a doc exists

export const ROLES = ['viewer', 'editor'];

export function resolveAccess(db, documentId, userId) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!doc) return { doc: null, role: null };
  if (doc.owner_id === userId) return { doc, role: 'owner' };
  const share = db
    .prepare('SELECT role FROM shares WHERE document_id = ? AND user_id = ?')
    .get(documentId, userId);
  return { doc, role: share ? share.role : null };
}

export const canRead = (role) => role === 'owner' || role === 'editor' || role === 'viewer';
export const canEdit = (role) => role === 'owner' || role === 'editor';
export const canManage = (role) => role === 'owner';
