/* Merging two copies of a ChipAway list (this device's and the one in the cloud).
 *
 * Every record has a permanent id and every field change carries a timestamp (rec._ts[field], milliseconds),
 * so two copies merge field by field: for each field the newer change wins. If the phone renamed an item
 * while the PC changed its cost, both changes survive. Deletes are marked (deleted_at), not erased, so a
 * delete is just another field change and travels like one.
 *
 * The merge gives the same answer whichever copy is "mine" and whichever is "theirs", and merging a copy
 * with itself changes nothing, so two devices syncing at once just costs one more round, never a lost edit.
 *
 * Rules:
 * - records only one side has are kept as they are
 * - a field with no timestamp counts as older than any timestamped change (time 0)
 * - an exact tie (same timestamp, different value) goes to the larger value as text, so both sides agree
 * - settings: each one carries its own updated_at; newer wins
 * - device_id stays this device's own; next_seq moves past every seq either side has handed out
 *
 * Photo files are not in the list itself: photoIdsToFetch() says which ones this device is missing.
 */
(function (root) {
  "use strict";

  const COLLECTIONS = ["items", "deps", "photos"];
  const NOT_FIELDS = new Set(["id", "_ts"]);

  const ts = (rec, f) => (rec && rec._ts && typeof rec._ts[f] === "number" ? rec._ts[f] : 0);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // larger value as text wins an exact tie; undefined counts as smallest
  const tieWinner = (a, b) => {
    const sa = a === undefined ? "" : JSON.stringify(a), sb = b === undefined ? "" : JSON.stringify(b);
    return sa >= sb ? a : b;
  };

  function mergeRecord(a, b) {
    const out = { id: a.id, _ts: {} };
    const fields = new Set([...Object.keys(a), ...Object.keys(b)].filter((f) => !NOT_FIELDS.has(f)));
    for (const f of fields) {
      const ta = ts(a, f), tb = ts(b, f);
      let v;
      if (ta > tb) v = a[f];
      else if (tb > ta) v = b[f];
      else v = same(a[f], b[f]) ? a[f] : tieWinner(a[f], b[f]);
      if (v !== undefined) out[f] = v;
      const t = Math.max(ta, tb);
      if (t) out._ts[f] = t;
    }
    // updated_at is a human-readable "last changed" time, not a merged field: keep the later one
    if (a.updated_at || b.updated_at) out.updated_at = (a.updated_at || "") > (b.updated_at || "") ? a.updated_at : b.updated_at;
    return out;
  }

  function mergeSettings(a = {}, b = {}) {
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[k], y = b[k];
      if (!x || !y) { out[k] = x || y; continue; }
      const tx = x.updated_at || 0, ty = y.updated_at || 0;
      out[k] = tx > ty ? x : ty > tx ? y : tieWinner(x, y);
    }
    return out;
  }

  /**
   * Merge two saved lists. `mine` is this device's; the result keeps its device_id.
   * Returns { doc, changedMine, changedTheirs }: whether the result differs from each input,
   * so the caller knows whether to save locally and whether to upload.
   */
  function mergeDocs(mine, theirs) {
    if (!theirs) return { doc: mine, changedMine: false, changedTheirs: true };
    const doc = {
      schema: Math.max(mine.schema || 1, theirs.schema || 1),
      device_id: mine.device_id,
      next_seq: 1,
      items: {}, deps: {}, photos: {},
      settings: mergeSettings(mine.settings, theirs.settings),
    };
    for (const c of COLLECTIONS) {
      const A = mine[c] || {}, B = theirs[c] || {};
      for (const id of new Set([...Object.keys(A), ...Object.keys(B)])) {
        doc[c][id] = A[id] && B[id] ? mergeRecord(A[id], B[id]) : JSON.parse(JSON.stringify(A[id] || B[id]));
      }
    }
    const maxSeq = Object.values(doc.items).reduce((m, i) => Math.max(m, Number(i.seq) || 0), 0);
    doc.next_seq = Math.max(mine.next_seq || 1, theirs.next_seq || 1, maxSeq + 1);
    const body = (d) => JSON.stringify({ schema: d.schema, items: d.items, deps: d.deps, photos: d.photos, settings: d.settings }, sortedKeys);
    const merged = body(doc);
    return { doc, changedMine: merged !== body(mine), changedTheirs: merged !== body(theirs) };
  }

  // JSON.stringify replacer that sorts object keys, so equal content compares equal
  function sortedKeys(_k, v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
  }

  /** Live photos in `doc` whose files aren't on this device yet. haveFile(id) -> boolean. */
  function photoIdsToFetch(doc, haveFile) {
    return Object.values(doc.photos || {}).filter((p) => !p.deleted_at && !haveFile(p.id)).map((p) => p.id);
  }

  const api = { mergeDocs, mergeRecord, mergeSettings, photoIdsToFetch };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FeasibleMerge = api;
})(typeof self !== "undefined" ? self : this);
