/* Sync with ChipAway's shared lists on Supabase (households). (It replaced the earlier Google Drive sync.)
 *
 * The server keeps the list as one row per record (item, needs-first link, photo, assignment, setting), and
 * bumps a counter (rev) whenever a row changes. The server merges field by field with the same rules as
 * merge.js (see supabase/schema.sql), so two people saving at once never overwrite each other.
 *
 * One sync round:
 *  1. pull: rows with a rev higher than the last one this device saw, merged into the list here (merge.js)
 *  2. photos up: files the server doesn't have yet, before the records that point to them
 *  3. push: only records that differ from what the server last had (tracked by a fingerprint per record)
 *  4. photos down: files this device is missing
 *  5. save here (merged again with what's here now, so an edit made during the round is kept)
 *  6. tidy up: photo files of deleted photos are removed from the server
 *
 * What this device knows about the server lives in doc.cloud and never leaves the device:
 *   { household, rev, sent: { "item:<id>": fingerprint }, up: { <photo id>: true }, gone: { <photo id>: true } }
 * If the household changes (joined another one, signed in as someone else) it starts over from rev 0.
 *
 * The very first upload from a device keeps a safety copy of the list on the device beforehand.
 *
 * Everything that talks to the server is in SupabaseRemote, so the rest is tested against a stand-in.
 */
(function (root) {
  "use strict";
  const M = typeof module !== "undefined" && module.exports ? require("./merge.js") : root.FeasibleMerge;
  const St = typeof module !== "undefined" && module.exports ? require("./store.js") : root.FeasibleStore;

  // record kind on the server <-> collection in the list
  const KINDS = { item: "items", dep: "deps", photo: "photos", assign: "assigns" };
  const PAGE = 1000;   // rows per pull request
  const BATCH = 400;   // records per push request (server allows 500)

  class SyncError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  // A short fingerprint of a record, the same whatever order its fields are in.
  function fingerprint(rec) {
    const s = JSON.stringify(rec, M.sortedKeys);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2 ^ c, 2246822519);
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
  }

  /** Every record in a list as server rows: [{ kind, id, data }] */
  function toRows(doc) {
    const rows = [];
    for (const [kind, coll] of Object.entries(KINDS)) {
      for (const [id, rec] of Object.entries(doc[coll] || {})) rows.push({ kind, id, data: rec });
    }
    for (const [id, s] of Object.entries(doc.settings || {})) if (s) rows.push({ kind: "setting", id, data: s });
    return rows;
  }

  /** Server rows as a (partial) list that merge.js can merge in. */
  function fromRows(rows) {
    const doc = { schema: St.SCHEMA, items: {}, deps: {}, photos: {}, assigns: {}, settings: {} };
    for (const r of rows) {
      if (r.kind === "setting") doc.settings[r.id] = r.data;
      else if (KINDS[r.kind]) doc[KINDS[r.kind]][r.id] = r.data;
    }
    return doc;
  }

  /**
   * What leaves this device when the server says rows are hidden from this person: those rows, plus (for an
   * item) its photos, Who's on it and needs-first links. [{ kind, coll, id }]
   */
  function hiddenRecords(doc, hidden) {
    const out = new Map();
    const add = (kind, id) => { if (doc[KINDS[kind]] && doc[KINDS[kind]][id]) out.set(`${kind}:${id}`, { kind, coll: KINDS[kind], id }); };
    const items = new Set();
    for (const r of hidden) {
      if (!KINDS[r.kind]) continue;
      add(r.kind, r.id);
      if (r.kind === "item") items.add(r.id);
    }
    if (items.size) {
      for (const p of Object.values(doc.photos || {})) if (items.has(p.item_id)) add("photo", p.id);
      for (const a of Object.values(doc.assigns || {})) if (items.has(a.item_id)) add("assign", a.id);
      for (const d of Object.values(doc.deps || {})) if (items.has(d.item_id) || items.has(d.depends_on_id)) add("dep", d.id);
    }
    return [...out.values()];
  }

  // ---------------------------------------------------------------------
  /**
   * The household's rows and photos over Supabase's REST API.
   *   url:          the project URL, e.g. https://abcd.supabase.co
   *   key:          the project's public (anon) key
   *   getToken():   a current access token for the signed-in person (getToken(true) = renew it first)
   *   household:    the household id
   */
  class SupabaseRemote {
    constructor({ url, key, getToken, household, fetchFn }) {
      this.url = url.replace(/\/+$/, "");
      this.key = key;
      this.getToken = getToken;
      this.household = household;
      this.fetch = fetchFn || ((...a) => root.fetch(...a));
    }
    async call(path, opts = {}, retried = false) {
      const token = await this.getToken(retried);
      let res;
      try {
        res = await this.fetch(this.url + path, { ...opts, headers: { apikey: this.key, Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
      } catch (e) { throw new SyncError("offline", "Couldn't reach ChipAway's server. Check the connection."); }
      if (res.status === 401 && !retried) return this.call(path, opts, true); // token ran out: renew once
      if (res.status === 401) throw new SyncError("auth", "Sign in again to keep syncing");
      return res;
    }
    async check(res, what) {
      if (res.ok) return res;
      let detail = "";
      try { const j = await res.json(); detail = j.message || j.error || ""; } catch (e) { /* no body */ }
      if (/not_member/.test(detail)) throw new SyncError("removed", "You're no longer in this shared list.");
      throw new SyncError("server", `${what} failed (${res.status}${detail ? `: ${detail}` : ""})`);
    }
    /** Rows changed since `since`, oldest first, up to `limit`. A row this person can't see (it's in a list
     *  they aren't on) comes with data null: drop it here. */
    async pull(since, limit = PAGE) {
      if (!this.plainPull) {
        const res = await this.call("/rest/v1/rpc/pull_records", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ h: this.household, since, lim: limit }),
        });
        if (res.status !== 404) return (await this.check(res, "Downloading changes")).json();
        this.plainPull = true; // the server doesn't have lists yet: read the rows directly, as before
      }
      const q = new URLSearchParams({ select: "kind,id,data,rev", household_id: `eq.${this.household}`, rev: `gt.${since}`, order: "rev.asc", limit: String(limit) });
      const res = await this.check(await this.call(`/rest/v1/records?${q}`), "Downloading changes");
      return res.json();
    }
    /** Save records; the server merges each into what it has. */
    async push(rows) {
      const res = await this.check(await this.call("/rest/v1/rpc/push_records", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ h: this.household, recs: rows }),
      }), "Uploading changes");
      return res.json();
    }
    photoPath(id, kind) { return `${this.household}/${id}.${kind}.jpg`; }
    async putPhoto(id, kind, b64) {
      const body = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await this.check(await this.call(`/storage/v1/object/photos/${this.photoPath(id, kind)}`, {
        method: "POST", headers: { "Content-Type": "image/jpeg", "x-upsert": "true" }, body,
      }), "Uploading a photo");
    }
    /** base64, or null if the server doesn't have it (yet) */
    async getPhoto(id, kind) {
      const res = await this.call(`/storage/v1/object/authenticated/photos/${this.photoPath(id, kind)}`);
      if (res.status === 404 || res.status === 400) return null;
      await this.check(res, "Downloading a photo");
      const buf = new Uint8Array(await res.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    }
    async removePhotos(ids) {
      if (!ids.length) return;
      await this.check(await this.call("/storage/v1/object/photos", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: ids.flatMap((id) => [this.photoPath(id, "full"), this.photoPath(id, "thumb")]) }),
      }), "Removing photos");
    }
  }

  // ---------------------------------------------------------------------
  class CloudSyncer {
    /** store: the open Store. remote: a SupabaseRemote (or a stand-in with the same calls). */
    constructor(store, remote, { onStatus = () => {}, delayMs = 3000 } = {}) {
      this.store = store;
      this.remote = remote;
      this.onStatus = onStatus;
      this.delayMs = delayMs;
      this.running = null;
      this.again = false;
      this.timer = null;
      this.lastSynced = null;
    }

    /** A change was made here: sync a few seconds from now (several quick changes make one round). */
    soon() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.now().catch(() => {}); }, this.delayMs);
    }
    stop() { clearTimeout(this.timer); this.timer = null; }

    /** Sync now. A round already running finishes first, then one more runs. Resolves to whether anything here changed. */
    async now() {
      if (this.running) { this.again = true; return this.running; }
      this.running = (async () => {
        let changed = false;
        try {
          do { this.again = false; changed = (await this.round()) || changed; } while (this.again);
          this.lastSynced = Date.now();
          this.onStatus({ state: "ok", at: this.lastSynced, changed });
          return changed;
        } catch (e) {
          this.onStatus({ state: "error", code: e.code || "other", message: e.message });
          throw e;
        } finally { this.running = null; }
      })();
      return this.running;
    }

    /** This device's bookkeeping for the current household (fresh if it's a different household). */
    meta() {
      const c = this.store.doc.cloud;
      if (c && c.household === this.remote.household) return JSON.parse(JSON.stringify(c));
      return { household: this.remote.household, rev: 0, sent: {}, up: {}, gone: {} };
    }

    async hasPhoto(id) {
      try { return !!(await this.store.adapter.readPhoto(id, "full")); } catch (e) { return false; }
    }

    async round() {
      const store = this.store, remote = this.remote;
      this.onStatus({ state: "syncing" });
      const meta = this.meta();
      const firstTime = meta.rev === 0 && !Object.keys(meta.sent).length;

      // 1. pull everything newer than what this device has seen
      const pulled = [];
      for (;;) {
        const page = await remote.pull(meta.rev);
        for (const r of page) {
          pulled.push(r);
          meta.rev = Math.max(meta.rev, Number(r.rev) || 0);
        }
        if (page.length < PAGE) break;
      }
      const seen = pulled.filter((r) => r.data);
      for (const r of seen) meta.sent[`${r.kind}:${r.id}`] = fingerprint(r.data); // the server has exactly this now
      const remoteDoc = fromRows(seen); // kinds this version doesn't know are left on the server untouched
      const startedFrom = JSON.parse(JSON.stringify(store.doc));
      if (firstTime && Object.keys(startedFrom.items).length) {
        // the first upload from this device: keep a copy of the list exactly as it was, just in case
        await store.adapter.saveSafetyCopy(startedFrom, "before-cloud");
      }
      // moved to a list this person isn't on (or they came off its list): it leaves this device, with its
      // photos, Who's on it and links, and isn't sent back
      const drop = hiddenRecords(startedFrom, pulled.filter((r) => !r.data));
      for (const d of drop) { delete startedFrom[d.coll][d.id]; delete meta.sent[`${d.kind}:${d.id}`]; }
      const { doc: merged } = M.mergeDocs(startedFrom, remoteDoc);

      // 2. photos up: live photos this device has that the server hasn't had from anyone yet
      for (const p of Object.values(merged.photos)) {
        if (p.deleted_at || meta.up[p.id] || meta.sent[`photo:${p.id}`]) continue; // already uploaded by someone
        let full = null, thumb = null;
        try { full = await store.adapter.readPhoto(p.id, "full"); } catch (e) { full = null; }
        try { thumb = await store.adapter.readPhoto(p.id, "thumb"); } catch (e) { thumb = null; }
        if (!full) continue; // not on this device (another device will upload it)
        await remote.putPhoto(p.id, "full", full);
        if (thumb) await remote.putPhoto(p.id, "thumb", thumb);
        meta.up[p.id] = true;
      }

      // 3. push records the server doesn't have in this exact form
      const dirty = toRows(merged).filter((r) => meta.sent[`${r.kind}:${r.id}`] !== fingerprint(r.data));
      for (let i = 0; i < dirty.length; i += BATCH) {
        const batch = dirty.slice(i, i + BATCH);
        await remote.push(batch);
        // The server merged these with whatever it had. If someone else changed the same record meanwhile,
        // the next pull brings the combined version (its rev is newer than ours), so nothing is missed.
        for (const r of batch) meta.sent[`${r.kind}:${r.id}`] = fingerprint(r.data);
      }

      // 4. photos down
      const fetched = {};
      for (const p of Object.values(merged.photos)) {
        if (p.deleted_at || (await this.hasPhoto(p.id))) continue;
        const full = await remote.getPhoto(p.id, "full");
        if (!full) continue; // not uploaded yet by the device that took it; next round
        fetched[p.id] = { full, thumb: await remote.getPhoto(p.id, "thumb") };
      }

      // 5. save here, merged once more with the list as it is right now
      const changedHere = await store.applySynced(merged, fetched, drop);

      // 6. tidy up the server: files of photos deleted (by anyone), once
      const gone = Object.values(merged.photos).filter((p) => p.deleted_at && !meta.gone[p.id]).map((p) => p.id);
      if (gone.length) {
        try {
          await remote.removePhotos(gone);
          for (const id of gone) { meta.gone[id] = true; delete meta.up[id]; }
        } catch (e) { /* next time */ }
      }

      if (JSON.stringify(store.doc.cloud) !== JSON.stringify(meta)) {
        store.doc.cloud = meta;
        await store.save({ quiet: true });
      }
      return changedHere;
    }
  }

  const api = { CloudSyncer, SupabaseRemote, SyncError, fingerprint, toRows, fromRows, hiddenRecords, KINDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FeasibleCloud = api;
})(typeof self !== "undefined" ? self : this);
