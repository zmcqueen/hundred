// Everything here talks to Google Drive directly from the phone.
// Our own backend never sees a byte of media.
import { driveToken, forgetDriveToken } from './firebase.js';

// VITE_DRIVE_BASE lets local tests point at scripts/fake-drive.mjs.
const BASE = import.meta.env.VITE_DRIVE_BASE || 'https://www.googleapis.com';
const API = `${BASE}/drive/v3`;
const UPLOAD = `${BASE}/upload/drive/v3`;
const KEY = import.meta.env.VITE_DRIVE_API_KEY;

async function authed(url, opts = {}, token) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) forgetDriveToken();
  if (!res.ok) throw new Error(`Drive ${res.status}: ${await res.text()}`);
  return res;
}

const folderCache = new Map();

/** Find or make "Hundred/<game name>" in the player's Drive. */
export async function gameFolder(token, gameId, gameName) {
  if (folderCache.has(gameId)) return folderCache.get(gameId);
  const stored = localStorage.getItem(`hundred.folder.${gameId}`);
  if (stored) { folderCache.set(gameId, stored); return stored; }

  const root = await findOrCreateFolder(token, 'Hundred', null);
  const folder = await findOrCreateFolder(token, gameName || `Game ${gameId}`, root);
  folderCache.set(gameId, folder);
  try { localStorage.setItem(`hundred.folder.${gameId}`, folder); } catch {}
  return folder;
}

async function findOrCreateFolder(token, name, parent) {
  // drive.file only lists folders this app made, which is what we want.
  const q = [
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${name.replace(/'/g, "\\'")}'`,
    `trashed=false`,
    parent ? `'${parent}' in parents` : null,
  ].filter(Boolean).join(' and ');
  const found = await (await authed(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`, {}, token)).json();
  if (found.files?.length) return found.files[0].id;
  const made = await (await authed(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: parent ? [parent] : undefined }),
  }, token)).json();
  return made.id;
}

/**
 * Resumable upload, so a long video survives a flaky connection better
 * and we can report progress. Returns the new file ID.
 */
export function uploadFile(token, { blob, name, folderId, onProgress }) {
  return (async () => {
    const init = await authed(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': blob.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify({ name, parents: [folderId], mimeType: blob.type || undefined }),
    }, token);
    const session = init.headers.get('Location');
    if (!session) throw new Error('Drive did not return an upload session');

    // XHR rather than fetch: fetch has no upload progress events.
    const id = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', session);
      xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText).id);
        else reject(new Error(`Upload failed ${xhr.status}: ${xhr.responseText}`));
      };
      xhr.onerror = () => reject(new Error('Upload failed: network error'));
      xhr.send(blob);
    });
    return id;
  })();
}

/** Anyone with the link can view. That's how the other players' browsers read it. */
export async function shareByLink(token, fileId) {
  await authed(`${API}/files/${fileId}/permissions?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  }, token);
}

export async function uploadAndShare(token, opts) {
  const id = await uploadFile(token, opts);
  await shareByLink(token, id);
  return id;
}

export async function deleteFile(token, fileId) {
  await authed(`${API}/files/${fileId}`, { method: 'DELETE' }, token);
}

const blobCache = new Map();

/** Read a link-shared file with the public API key. No sign-in needed for this part. */
export function fetchShared(fileId) {
  if (blobCache.has(fileId)) return blobCache.get(fileId);
  const p = fetch(`${API}/files/${fileId}?alt=media&key=${KEY}`).then(async (r) => {
    if (!r.ok) throw new Error(`Drive ${r.status}`);
    return r.blob();
  });
  p.catch(() => blobCache.delete(fileId));
  blobCache.set(fileId, p);
  return p;
}

const urlCache = new Map();
export async function sharedObjectUrl(fileId) {
  if (urlCache.has(fileId)) return urlCache.get(fileId);
  const url = URL.createObjectURL(await fetchShared(fileId));
  urlCache.set(fileId, url);
  return url;
}

export { driveToken };
