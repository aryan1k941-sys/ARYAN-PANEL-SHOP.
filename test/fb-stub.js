// In-memory Firebase RTDB stub used ONLY for local testing (never shipped).
const G = (globalThis.__FB = globalThis.__FB || { tree: {}, listeners: [], log: [] });
const seg = p => String(p || '').split('/').filter(Boolean);
const getAt = (p) => { let n = G.tree; for (const s of seg(p)) { if (n == null || typeof n !== 'object') return null; n = n[s]; } return n === undefined ? null : n; };
const clone = v => v == null ? null : JSON.parse(JSON.stringify(v));
function setAt(p, v) {
  const s = seg(p); if (!s.length) { G.tree = v || {}; return; }
  let n = G.tree; for (let i = 0; i < s.length - 1; i++) { if (n[s[i]] == null || typeof n[s[i]] !== 'object') n[s[i]] = {}; n = n[s[i]]; }
  const k = s[s.length - 1]; if (v == null) delete n[k]; else n[k] = clone(v);
  // prune empty parents
}
class Snap { constructor(path, val) { this._p = path; this._v = val; this.key = seg(path).pop() || null; }
  exists() { return this._v != null; } val() { return clone(this._v); }
  forEach(cb) { if (this._v && typeof this._v === 'object') for (const k of Object.keys(this._v)) { if (cb(new Snap(this._p + '/' + k, this._v[k])) === true) break; } }
  child(c) { return new Snap(this._p + '/' + c, this._v && this._v[c] != null ? this._v[c] : null); } }
const rel = (a, b) => { const x = seg(a), y = seg(b); const n = Math.min(x.length, y.length); for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false; return true; };
function fire(path) { for (const l of [...G.listeners]) if (rel(l.path, path)) { try { l.cb(new Snap(l.path, clone(getAt(l.path)))); } catch (e) { setTimeout(() => { throw e; }); } } }
export const initializeApp = (c) => ({ c });
export const getDatabase = () => ({});
const AUTH = { get currentUser() { return G.user || null; } };
G.fire = fire; G.setAt = setAt;
export const getAuth = () => AUTH;
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb(G.user || null), 5); return () => {}; };
export const signInWithEmailAndPassword = async () => { throw new Error('stub'); };
export const signOut = async () => { G.user = null; }; export class GoogleAuthProvider {} export const signInWithPopup = async () => { throw new Error('stub'); };
export const ref = (db, path = '') => ({ path: seg(path).join('/'), key: seg(path).pop() || null });
export const child = (r, p) => ref(null, r.path + '/' + p);
export const onValue = (r, cb) => { const l = { path: r.path, cb }; G.listeners.push(l); setTimeout(() => cb(new Snap(r.path, clone(getAt(r.path)))), 5); return () => { G.listeners = G.listeners.filter(x => x !== l); }; };
export const get = async (r) => new Snap(r.path, clone(getAt(r.path)));
export const set = async (r, v) => { G.log.push(['set', r.path]); setAt(r.path, v); fire(r.path); };
export const update = async (r, v) => { G.log.push(['update', r.path]); for (const k of Object.keys(v)) setAt(r.path + '/' + k, v[k]); fire(r.path); };
export const remove = async (r) => { setAt(r.path, null); fire(r.path); };
let pid = 0;
export const push = (r, v) => { const k = '-P' + Date.now().toString(36) + (pid++); const nr = ref(null, r.path + '/' + k); const p = Promise.resolve(); if (v !== undefined) { setAt(nr.path, v); fire(nr.path); } nr.then = p.then.bind(p); nr.catch = p.catch.bind(p); return nr; };
export const runTransaction = async (r, fn) => { const cur = clone(getAt(r.path)); const nv = fn(cur); if (nv === undefined) return { committed: false, snapshot: new Snap(r.path, cur) }; setAt(r.path, nv); fire(r.path); return { committed: true, snapshot: new Snap(r.path, nv) }; };
export const serverTimestamp = () => Date.now();
export const query = (r) => r; export const orderByChild = () => null; export const equalTo = () => null; export const limitToLast = () => null; export const orderByKey=()=>null;
export const getStorage = () => ({}); export const uploadBytes = async () => ({}); export const uploadBytesResumable = () => ({}); export const getDownloadURL = async () => 'https://example.com/x.png'; export const deleteObject = async () => {}; export const listAll = async () => ({ items: [], prefixes: [] });
