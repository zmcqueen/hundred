import './style.css';
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, onSnapshot, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { configured, db, onUser, signIn, signOut, driveToken, finishRedirect } from './firebase.js';
import { gameFolder, uploadAndShare, deleteFile, sharedObjectUrl, fetchShared } from './drive.js';
import { makeThumbnail, extFor, saveFiles } from './media.js';

const app = document.getElementById('app');
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const INDEX_TTL_DAYS = 14; // the board index is disposable; Drive files stay with their owners

let user = null;
let cleanup = [];
let currentRender = null;
let game = null;          // { id, ...data }
let captures = [];        // [{ id, ...data }]
let players = new Map();  // uid -> data
const pending = new Map(); // number -> { localUrl, progress, error, retry }

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const mount = (...nodes) => { app.replaceChildren(...nodes); window.scrollTo(0, 0); };
function toast(msg, ms = 3500) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
const firstName = (n) => (n || 'Someone').split(' ')[0];

// ---------- routing ----------
function route() {
  cleanup.forEach((f) => f());
  cleanup = [];
  if (!configured) return viewNotConfigured();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'g' && parts[1]) {
    if (!user) return viewSignIn(true);
    return openGame(parts[1], parts[2], parts[3]);
  }
  game = null;
  return user ? viewHome() : viewSignIn(false);
}
window.addEventListener('hashchange', route);

// ---------- views ----------
function viewNotConfigured() {
  mount(h('main', { class: 'center' },
    h('h1', { class: 'logo' }, 'Hundred'),
    h('p', {}, 'Firebase is not configured yet. Copy .env.example to .env.local and fill it in.')));
}

function viewSignIn(invited) {
  mount(h('main', { class: 'center' },
    h('h1', { class: 'logo' }, 'Hundred'),
    h('p', { class: 'lede' }, invited
      ? "You've been invited to a game. Find every number from 1 to 100 out in the world, together."
      : 'Find every number from 1 to 100 out in the world, together.'),
    h('button', { class: 'btn google', onclick: () => signIn().catch(showError) }, 'Sign in with Google'),
    h('p', { class: 'fine' },
      'Your photos and videos go to a "Hundred" folder in your own Google Drive, shared by link with your group. We never store them.')));
}

function viewHome() {
  const recent = JSON.parse(localStorage.getItem('hundred.recent') || '[]');
  const name = h('input', { class: 'input', placeholder: 'Game name (optional)', maxLength: 60 });
  mount(h('main', { class: 'page' },
    h('header', { class: 'bar' }, h('span', { class: 'logo small' }, 'Hundred'),
      h('button', { class: 'link', onclick: () => signOut() }, 'Sign out')),
    h('h2', {}, `Hi ${firstName(user.displayName)}`),
    h('div', { class: 'card' },
      name,
      h('button', { class: 'btn', onclick: () => createGame(name.value.trim()).catch(showError) }, 'Start a game')),
    recent.length ? h('h3', {}, 'Your games') : null,
    h('ul', { class: 'list' }, recent.map((g) => h('li', {}, h('a', { href: `#/g/${g.id}` }, g.name))))));
}

async function createGame(name) {
  const max = 100;
  const ref = doc(collection(db, 'games'));
  const data = {
    name: name || `${firstName(user.displayName)}'s game`,
    max,
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    expireAt: Timestamp.fromMillis(Date.now() + INDEX_TTL_DAYS * 864e5),
  };
  await setDoc(ref, data);
  location.hash = `#/g/${ref.id}`;
}

function rememberGame(g) {
  const recent = JSON.parse(localStorage.getItem('hundred.recent') || '[]').filter((x) => x.id !== g.id);
  recent.unshift({ id: g.id, name: g.name });
  try { localStorage.setItem('hundred.recent', JSON.stringify(recent.slice(0, 10))); } catch {}
}

async function openGame(id, sub, arg) {
  if (!game || game.id !== id) {
    mount(h('main', { class: 'center' }, h('p', {}, 'Loading…')));
    const snap = await getDoc(doc(db, 'games', id)).catch(showError);
    if (!snap?.exists()) return mount(h('main', { class: 'center' }, h('p', {}, 'That game does not exist.'), h('a', { href: '#/' }, 'Home')));
    game = { id, ...snap.data() };
    captures = [];
    players = new Map();
    await setDoc(doc(db, 'games', id, 'players', user.uid), {
      name: user.displayName || 'Player', photoURL: user.photoURL || null, joinedAt: serverTimestamp(),
    }, { merge: true });
    rememberGame(game);
  }
  let rerender;
  if (sub === 'n' && arg) rerender = viewNumber(Number(arg));
  else if (sub === 'save') rerender = viewSaveAll();
  else rerender = viewBoard();
  currentRender = rerender;
  cleanup.push(() => { if (currentRender === rerender) currentRender = null; });
  rerender();

  // Live index: every board updates the instant anyone submits.
  const unsubCaps = onSnapshot(collection(db, 'games', id, 'captures'), (qs) => {
    captures = qs.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.toMillis?.() ?? Date.now()) - (b.createdAt?.toMillis?.() ?? Date.now()));
    for (const c of captures) if (c.uid === user.uid && pending.get(c.number)?.captureId === c.id && c.fileId) pending.delete(c.number);
    rerender();
  }, showError);
  const unsubPlayers = onSnapshot(collection(db, 'games', id, 'players'), (qs) => {
    players = new Map(qs.docs.map((d) => [d.id, d.data()]));
    rerender();
  });
  cleanup.push(unsubCaps, unsubPlayers);
}

function byNumber() {
  const m = new Map();
  for (const c of captures) {
    if (!m.has(c.number)) m.set(c.number, []);
    m.get(c.number).push(c);
  }
  return m;
}

// ---------- board ----------
function viewBoard() {
  const pages = Math.ceil(game.max / 100);
  let page = Number(sessionStorage.getItem(`hundred.page.${game.id}`) || 0);
  const count = h('span', { class: 'count' });
  const faces = h('div', { class: 'faces' });
  const grid = h('div', { class: 'grid' });
  const tabs = pages > 1 ? h('div', { class: 'tabs' }) : null;
  const cells = new Map();

  mount(h('main', { class: 'page board' },
    h('header', { class: 'bar' },
      h('a', { href: '#/', class: 'logo small' }, 'Hundred'),
      h('button', { class: 'link', onclick: invite }, 'Invite')),
    h('div', { class: 'gamehead' }, h('h2', {}, game.name), count),
    faces,
    tabs,
    grid,
    h('div', { class: 'actions' },
      h('a', { class: 'btn ghost', href: `#/g/${game.id}/save` }, 'Save everything to my phone'))));

  function buildCells() {
    grid.replaceChildren();
    cells.clear();
    const start = page * 100 + 1;
    const end = Math.min(game.max, start + 99);
    for (let n = start; n <= end; n++) {
      const num = h('span', { class: 'num' }, n);
      const cell = h('button', { class: 'cell', onclick: () => tapNumber(n) }, num);
      cells.set(n, cell);
      grid.append(cell);
    }
  }
  buildCells();

  return function render() {
    const map = byNumber();
    const found = new Set([...map.keys(), ...pending.keys()]);
    count.textContent = `${found.size} / ${game.max}`;
    faces.replaceChildren(...[...players.values()].map((p) =>
      p.photoURL ? h('img', { class: 'face', src: p.photoURL, alt: p.name, title: p.name, referrerPolicy: 'no-referrer' })
        : h('span', { class: 'face', title: p.name }, (p.name || '?')[0])));
    if (tabs) {
      tabs.replaceChildren(...Array.from({ length: pages }, (_, i) =>
        h('button', { class: `tab ${i === page ? 'on' : ''}`, onclick: () => {
          page = i; sessionStorage.setItem(`hundred.page.${game.id}`, i); buildCells(); render();
        } }, `${i * 100 + 1}–${Math.min(game.max, i * 100 + 100)}`)));
    }
    for (const [n, cell] of cells) {
      const list = map.get(n) || [];
      const p = pending.get(n);
      const latest = list[list.length - 1];
      cell.classList.toggle('found', Boolean(list.length || p));
      cell.querySelector('.badge')?.remove();
      cell.querySelector('.ring')?.remove();
      if (list.length > 1) cell.append(h('span', { class: 'badge' }, list.length));
      if (p) {
        cell.style.backgroundImage = `url(${p.localUrl})`;
        cell.dataset.thumb = '';
        cell.append(p.error
          ? h('span', { class: 'ring err', title: p.error }, '!')
          : h('span', { class: 'ring', style: { '--p': p.progress || 0 } }));
      } else if (latest?.thumbId && cell.dataset.thumb !== latest.thumbId) {
        cell.dataset.thumb = latest.thumbId;
        sharedObjectUrl(latest.thumbId)
          .then((url) => { if (cell.dataset.thumb === latest.thumbId) cell.style.backgroundImage = `url(${url})`; })
          .catch(() => {});
      } else if (!latest) {
        cell.style.backgroundImage = '';
        cell.dataset.thumb = '';
      }
      if (latest && !latest.fileId && !p) cell.append(h('span', { class: 'ring', style: { '--p': 0.5 } }));
    }
  };
}

function invite() {
  const url = `${location.origin}/#/g/${game.id}`;
  const text = `Play Hundred with me: ${game.name}`;
  if (navigator.share) navigator.share({ title: 'Hundred', text, url }).catch(() => {});
  else navigator.clipboard.writeText(url).then(() => toast('Invite link copied'));
}

function tapNumber(n) {
  const p = pending.get(n);
  if (p?.error) return p.retry();
  if (byNumber().has(n)) { location.hash = `#/g/${game.id}/n/${n}`; return; }
  capture(n);
}

// ---------- capture ----------
function capture(n, mode) {
  // iOS: one camera with a photo/video switch. Android needs us to pick.
  if (!mode && !isIOS) return chooseMode(n);
  const input = h('input', {
    type: 'file',
    accept: mode === 'photo' ? 'image/*' : mode === 'video' ? 'video/*' : 'image/*,video/*',
    style: { display: 'none' },
  });
  if (mode !== 'library') input.setAttribute('capture', 'environment');
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) viewPreview(n, file);
  });
  document.body.append(input);
  input.click();
}

function chooseMode(n) {
  const close = () => sheet.remove();
  const pick = (m) => () => { close(); capture(n, m); };
  const sheet = h('div', { class: 'sheet', onclick: (e) => e.target === sheet && close() },
    h('div', { class: 'sheet-body' },
      h('div', { class: 'sheet-num' }, n),
      h('button', { class: 'btn', onclick: pick('video') }, 'Record video'),
      h('button', { class: 'btn', onclick: pick('photo') }, 'Take photo'),
      h('button', { class: 'btn ghost', onclick: pick('library') }, 'Choose from library'),
      h('button', { class: 'link', onclick: close }, 'Cancel')));
  document.body.append(sheet);
}

function viewPreview(n, file) {
  const url = URL.createObjectURL(file);
  const media = file.type.startsWith('video/')
    ? h('video', { src: url, controls: true, playsInline: true, autoplay: true, muted: true, loop: true })
    : h('img', { src: url, alt: `Number ${n}` });
  const submit = h('button', { class: 'btn big', onclick: () => submitCapture(n, file, url).catch(showError) }, `Submit ${n}`);
  const overlay = h('div', { class: 'preview' },
    h('div', { class: 'preview-num' }, n),
    h('div', { class: 'preview-media' }, media),
    h('div', { class: 'preview-actions' },
      h('button', { class: 'btn ghost', onclick: () => { overlay.remove(); URL.revokeObjectURL(url); capture(n); } }, 'Retake'),
      submit),
    h('button', { class: 'link close', onclick: () => { overlay.remove(); URL.revokeObjectURL(url); } }, 'Cancel'));
  document.body.append(overlay);
}

async function submitCapture(n, file, previewUrl) {
  // Token first: if it needs a popup, it has to open while we still have the tap.
  const token = await driveToken();
  document.querySelector('.preview')?.remove();
  URL.revokeObjectURL(previewUrl);

  // Back to the board right away, with our own thumbnail already in the square.
  const thumbBlob = await makeThumbnail(file).catch(() => null);
  const localUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : '';
  const entry = { localUrl, progress: 0, error: null };
  pending.set(n, entry);
  if (location.hash !== `#/g/${game.id}`) location.hash = `#/g/${game.id}`; else route();

  const g = game;
  const run = async () => {
    entry.error = null;
    const bump = () => window.dispatchEvent(new Event('hashchange-soft'));
    try {
      const folder = await gameFolder(token, g.id, g.name);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = `${String(n).padStart(3, '0')}_${firstName(user.displayName)}_${stamp}`;
      let thumbId = null;
      if (thumbBlob) thumbId = await uploadAndShare(token, { blob: thumbBlob, name: `${base}_thumb.jpg`, folderId: folder });
      // The index learns about it as soon as the thumbnail is up, so friends see it fast.
      if (!entry.captureId) {
        const ref = await addDoc(collection(db, 'games', g.id, 'captures'), {
          number: n, uid: user.uid, playerName: user.displayName || 'Player',
          thumbId, fileId: null, mimeType: file.type || 'application/octet-stream',
          createdAt: serverTimestamp(),
          expireAt: Timestamp.fromMillis(Date.now() + INDEX_TTL_DAYS * 864e5),
        });
        entry.captureId = ref.id;
      }
      const fileId = await uploadAndShare(token, {
        blob: file, name: `${base}.${extFor(file.type)}`, folderId: folder,
        onProgress: (p) => { entry.progress = p; bump(); },
      });
      await updateDoc(doc(db, 'games', g.id, 'captures', entry.captureId), { fileId });
      pending.delete(n);
      bump();
    } catch (e) {
      console.error(e);
      entry.error = e.message || 'Upload failed';
      bump();
      toast(`Upload for ${n} failed. Tap the square to retry.`);
    }
  };
  entry.retry = () => run();
  run();
}

// lightweight re-render without tearing down listeners
let softQueued = false;
window.addEventListener('hashchange-soft', () => {
  if (softQueued) return;
  softQueued = true;
  requestAnimationFrame(() => { softQueued = false; currentRender?.(); });
});

// ---------- one number ----------
function viewNumber(n) {
  const list = h('div', { class: 'stack' });
  mount(h('main', { class: 'page' },
    h('header', { class: 'bar' },
      h('a', { href: `#/g/${game.id}`, class: 'link' }, '‹ Board'),
      h('button', { class: 'link', onclick: () => capture(n) }, 'Add another')),
    h('div', { class: 'bignum' }, n),
    list));
  const cards = new Map();
  return function render() {
    const caps = byNumber().get(n) || [];
    if (!caps.length) { list.replaceChildren(h('p', {}, 'Nothing yet.')); return; }
    for (const c of caps) {
      if (cards.has(c.id) && cards.get(c.id).dataset.file === String(c.fileId)) continue;
      const card = captureCard(c);
      if (cards.has(c.id)) cards.get(c.id).replaceWith(card); else list.append(card);
      cards.set(c.id, card);
    }
    for (const [id, card] of cards) if (!caps.find((c) => c.id === id)) { card.remove(); cards.delete(id); }
  };
}

function captureCard(c) {
  const isVideo = c.mimeType?.startsWith('video/');
  const box = h('div', { class: 'media' }, h('p', { class: 'muted' }, c.fileId ? 'Loading…' : 'Still uploading…'));
  const save = h('button', { class: 'btn', disabled: true }, isVideo ? 'Save video' : 'Save photo');
  let fileObj = null;
  if (c.fileId) {
    // Fetch now, so the Save tap can open the share sheet straight away (iOS insists).
    fetchShared(c.fileId).then(async (blob) => {
      fileObj = new File([blob], `hundred_${String(c.number).padStart(3, '0')}_${firstName(c.playerName)}.${extFor(c.mimeType)}`, { type: c.mimeType });
      const url = await sharedObjectUrl(c.fileId);
      box.replaceChildren(isVideo
        ? h('video', { src: url, controls: true, playsInline: true, preload: 'metadata' })
        : h('img', { src: url, alt: `Number ${c.number}` }));
      save.disabled = false;
    }).catch((e) => box.replaceChildren(h('p', { class: 'muted' }, `Could not load: ${e.message}`)));
  }
  save.onclick = () => fileObj && saveFiles([fileObj]).then((r) => r === 'downloaded' && toast('Downloaded'));
  const mine = c.uid === user.uid;
  const del = mine ? h('button', { class: 'link danger', onclick: () => removeCapture(c) }, 'Delete') : null;
  const card = h('div', { class: 'capture' }, box,
    h('div', { class: 'capture-meta' }, h('span', {}, firstName(c.playerName)), h('span', { class: 'row' }, del, save)));
  card.dataset.file = String(c.fileId);
  return card;
}

async function removeCapture(c) {
  if (!confirm(`Delete your capture for ${c.number}? This also removes it from your Drive.`)) return;
  try {
    const token = await driveToken();
    await Promise.allSettled([c.fileId && deleteFile(token, c.fileId), c.thumbId && deleteFile(token, c.thumbId)]);
    await deleteDoc(doc(db, 'games', game.id, 'captures', c.id));
  } catch (e) { showError(e); }
}

// ---------- save everything ----------
const BATCH = 10; // share sheets get unhappy with huge batches, and each one needs its own tap
function viewSaveAll() {
  const body = h('div', { class: 'stack' });
  mount(h('main', { class: 'page' },
    h('header', { class: 'bar' }, h('a', { href: `#/g/${game.id}`, class: 'link' }, '‹ Board')),
    h('h2', {}, 'Save everything'),
    h('p', { class: 'muted' }, `Saves in groups of ${BATCH}. On iPhone pick "Save ${BATCH} items" in the share sheet.`),
    body));
  const done = new Set(JSON.parse(localStorage.getItem(`hundred.saved.${game.id}`) || '[]'));
  let drawn = '';
  return function render() {
    const ready = captures.filter((c) => c.fileId).sort((a, b) => a.number - b.number);
    const key = ready.map((c) => c.id).join();
    if (key === drawn) return;
    drawn = key;
    const batches = [];
    for (let i = 0; i < ready.length; i += BATCH) batches.push(ready.slice(i, i + BATCH));
    body.replaceChildren(...batches.map((b, i) => batchRow(b, i, done)));
    if (!batches.length) body.append(h('p', {}, 'Nothing uploaded yet.'));
  };
}

function batchRow(batch, i, done) {
  const label = `${batch[0].number}–${batch[batch.length - 1].number} (${batch.length})`;
  const btn = h('button', { class: 'btn', disabled: true }, `Loading ${label}…`);
  let files = null;
  Promise.all(batch.map(async (c) => new File([await fetchShared(c.fileId)],
    `hundred_${String(c.number).padStart(3, '0')}_${firstName(c.playerName)}_${c.id.slice(0, 4)}.${extFor(c.mimeType)}`,
    { type: c.mimeType })))
    .then((f) => { files = f; btn.disabled = false; btn.textContent = `Save ${label}`; })
    .catch((e) => { btn.textContent = `Could not load ${label}: ${e.message}`; });
  const id = batch.map((c) => c.id).join();
  btn.onclick = async () => {
    if (!files) return;
    const r = await saveFiles(files);
    if (r !== 'cancelled') {
      done.add(id);
      try { localStorage.setItem(`hundred.saved.${game.id}`, JSON.stringify([...done])); } catch {}
      btn.classList.add('ghost');
      btn.textContent = `Saved ${label}`;
    }
  };
  if (done.has(id)) btn.classList.add('ghost');
  return btn;
}

// ---------- errors & boot ----------
function showError(e) {
  console.error(e);
  const msg = e?.code === 'auth/popup-closed-by-user' ? 'Sign-in was closed.' : (e?.message || String(e));
  toast(msg, 6000);
}

let booted = false;
finishRedirect().finally(() => {
  onUser((u) => {
    const changed = (u?.uid || null) !== (user?.uid || null);
    user = u;
    if (changed || !booted) { booted = true; game = null; route(); }
  });
});
