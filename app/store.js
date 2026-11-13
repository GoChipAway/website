/* On-device data store and "local API".
 *
 * The screens were written against the homelab server's API (/api/items, /api/plan, ...).
 * This file answers those same requests on the phone, with the same rules, so the screens
 * barely change.
 *
 * Sync-ready from day one, so household sharing can be added later without starting over:
 * - every record has a permanent unique id (not 1, 2, 3)
 * - every field change is timestamped (rec._ts[field]), so two phones can merge edits field by field
 * - deletes are marked (deleted_at), not erased, so a delete can travel to other phones
 * - each phone has its own device_id
 */
(function (root) {
  "use strict";
  const L = typeof module !== "undefined" && module.exports ? require("./logic.js") : root.FeasibleLogic;
  const M = typeof module !== "undefined" && module.exports ? require("./merge.js") : root.FeasibleMerge;

  const SCHEMA = 1;
  // settings that aren't mood limits (Reset on the Moods card leaves these alone)
  const OTHER_DEFAULTS = { doing_limit: 3 };
  const MAX_PHOTOS = 10; // per item: a few "this is the spot" pictures, not a camera roll
  const ITEM_FIELDS = ["parent_id", "title", "notes", "area", "priority", "difficulty", "cost", "hours", "status",
    "sort", "created_at", "started_at", "done_at", "deleted_at"];

  // ---------- time ----------
  const pad = (n) => String(n).padStart(2, "0");
  // local time, no zone, to the second: "2026-11-09T07:30:00" (same format as the homelab app)
  function now(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const today = () => now().slice(0, 10);

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    if (typeof require !== "undefined") return require("crypto").randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  class ApiError extends Error {
    constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
  }
  const bad = (msg) => { throw new ApiError(400, msg); };
  const notFound = (msg = "Not found") => { throw new ApiError(404, msg); };

  function emptyDoc() {
    return { schema: SCHEMA, device_id: uuid(), next_seq: 1, items: {}, deps: {}, photos: {}, settings: {} };
  }

  // =====================================================================
  class Store {
    /** adapter: { loadDoc(), saveDoc(doc), putPhoto(id, kind, blob), photoURL(id, kind), deletePhoto(id), readPhoto(id, kind) } */
    constructor(adapter) {
      this.adapter = adapter;
      this.doc = null;
    }

    /**
     * Load the saved list. Rules that keep people's data safe across app updates:
     *  - Anything we can't read is set aside under a new name first, never written over.
     *  - A list saved by a newer version of the app is never touched by an older one.
     *  - Before an update changes the saved format, a copy of the old one is kept.
     */
    async open() {
      let doc;
      try { doc = await this.adapter.loadDoc(); } catch (e) { doc = undefined; }
      if (doc === undefined || (doc !== null && !(doc.schema && doc.items))) {
        await this.adapter.setAside();
        this.setAside = true;
        doc = null;
      }
      if (doc && doc.schema > SCHEMA) {
        throw new ApiError(409, "Your list was saved by a newer version of ChipAway. Update the app to open it.");
      }
      this.doc = doc || emptyDoc();
      const before = doc ? JSON.stringify(doc) : null;
      if (this.upgrade()) {
        if (before) await this.adapter.saveSafetyCopy(JSON.parse(before), "before-update");
        await this.save();
      }
      return this;
    }

    /** Bring older data up to date. Returns true if anything changed. */
    upgrade() {
      let changed = this.flattenSteps() > 0;
      // Lazy day merged into Quick wins (Nov 2026) and Quick wins now means "easy and short".
      // An hour limit saved under the old meaning doesn't carry over, so both go back to the default.
      const st = this.doc.settings;
      if (st.lazy_hours) {
        delete st.lazy_hours;
        if (st.quick_hours) st.quick_hours = { value: null, updated_at: Date.now() };
        changed = true;
      }
      return changed;
    }

    /** Steps are gone (Nov 2026): every item stands on its own, and order comes from "needs first".
     *  Anything still broken into steps (older data, or a homelab import) is converted, losing nothing:
     *  - each step becomes its own item, filling in the project's location, priority and difficulty
     *    where it had none, and also waiting on whatever the project waited on
     *  - the project becomes a finish-line item that needs every one of its former steps, so it still
     *    shows the full cost and time ("All in") and unlocks when the last piece is done
     *  Returns how many projects (or orphaned steps) were converted. */
    flattenSteps() {
      const items = this.doc.items;
      const live = (i) => i && !i.deleted_at;
      const kidsOf = {};
      let changed = 0;
      for (const it of Object.values(items)) {
        if (!live(it) || !it.parent_id) continue;
        const p = items[it.parent_id];
        if (!live(p)) { this.set(it, "parent_id", null); changed++; continue; }
        (kidsOf[p.id] = kidsOf[p.id] || []).push(it);
      }
      const t = now();
      for (const [pid, kids] of Object.entries(kidsOf)) {
        const p = items[pid];
        const projectWaitsOn = Object.values(this.doc.deps).filter((d) => !d.deleted_at && d.item_id === pid).map((d) => d.depends_on_id);
        for (const k of kids) {
          const fill = { parent_id: null };
          if (!k.area && p.area) fill.area = p.area;
          if (!k.priority && p.priority) fill.priority = p.priority;
          if (!k.difficulty && p.difficulty) fill.difficulty = p.difficulty;
          this.setMany(k, fill);
          for (const d of projectWaitsOn) if (d !== k.id) this.addDep(k.id, d);
          this.addDep(pid, k.id); // the old project now waits on each former step
        }
        if (kids.every((k) => k.status === "done")) {
          if (p.status !== "done") {
            const last = kids.map((k) => k.done_at || "").sort().pop() || t;
            this.setMany(p, { status: "done", done_at: last, started_at: p.started_at || last });
          }
        } else if (p.status === "done") {
          this.setMany(p, { status: "todo", done_at: null });
        }
        changed++;
      }
      return changed;
    }

    /** Saves happen one at a time, in order, so two quick changes can't write the file at once.
     *  Each save writes the list as it is when its turn comes. */
    save({ quiet = false } = {}) {
      const run = (this.saving || Promise.resolve()).catch(() => {}).then(() => this.adapter.saveDoc(this.doc));
      this.saving = run;
      // tell sync something changed here (not for saves that came from sync itself)
      if (!quiet && this.onSaved) run.then(() => this.onSaved(), () => {});
      return run;
    }

    /**
     * Take in a list that sync merged with the cloud, plus photo files it downloaded ({ id: { full, thumb } }).
     * It's merged once more with the list as it is right now, so a change made while sync was running is kept.
     * Returns true if anything here changed.
     */
    async applySynced(merged, photos = {}) {
      for (const [id, ph] of Object.entries(photos)) {
        if (ph.full) await this.adapter.putPhoto(id, "full", ph.full);
        if (ph.thumb) await this.adapter.putPhoto(id, "thumb", ph.thumb);
      }
      const { doc, changedMine } = M.mergeDocs(this.doc, merged);
      if (!changedMine && !Object.keys(photos).length) return false;
      if (doc.schema > SCHEMA) throw new ApiError(409, "Your list was synced by a newer version of ChipAway. Update the app to keep syncing.");
      this.doc = doc;
      this.upgrade();
      await this.save({ quiet: true });
      // photos deleted on another device: remove their files here too
      for (const p of Object.values(doc.photos)) {
        if (p.deleted_at) { try { await this.adapter.deletePhoto(p.id); } catch (e) { /* already gone */ } }
      }
      if (this.adapter.warm) await this.adapter.warm(Object.values(doc.photos).filter((p) => !p.deleted_at).map((p) => p.id));
      return true;
    }

    // ---------- record helpers ----------
    set(rec, field, value) {
      if (rec[field] === value) return;
      rec[field] = value;
      rec._ts = rec._ts || {};
      rec._ts[field] = Date.now();
      rec.updated_at = now();
    }
    setMany(rec, obj) { for (const [k, v] of Object.entries(obj)) this.set(rec, k, v); }

    liveItems() { return Object.values(this.doc.items).filter((i) => !i.deleted_at); }
    liveDeps() {
      const it = this.doc.items;
      return Object.values(this.doc.deps).filter((d) => !d.deleted_at && it[d.item_id] && !it[d.item_id].deleted_at
        && it[d.depends_on_id] && !it[d.depends_on_id].deleted_at);
    }
    state() {
      return L.buildState(this.liveItems(), this.liveDeps().map((d) => [d.item_id, d.depends_on_id]));
    }
    newItem(fields) {
      const t = now();
      const rec = {
        id: uuid(), seq: this.doc.next_seq++, parent_id: null, title: "", notes: "", area: "", priority: null,
        difficulty: null, cost: null, hours: null, status: "todo", sort: 0, created_at: t, updated_at: t,
        started_at: null, done_at: null, deleted_at: null, _ts: {},
        ...fields,
      };
      const ms = Date.now();
      for (const f of ITEM_FIELDS) rec._ts[f] = ms;
      this.doc.items[rec.id] = rec;
      return rec;
    }
    depKey(a, b) { return `${a}>${b}`; }
    /** replace the full set of things `itemId` waits on */
    writeDeps(itemId, wanted) {
      for (const d of Object.values(this.doc.deps)) {
        if (d.item_id === itemId && !d.deleted_at && !wanted.has(d.depends_on_id)) this.set(d, "deleted_at", now());
      }
      for (const w of wanted) this.addDep(itemId, w);
    }
    addDep(a, b) {
      const k = this.depKey(a, b);
      const ex = this.doc.deps[k];
      if (ex) { if (ex.deleted_at) this.set(ex, "deleted_at", null); return; }
      const t = now();
      this.doc.deps[k] = { id: k, item_id: a, depends_on_id: b, created_at: t, updated_at: t, deleted_at: null, _ts: { deleted_at: Date.now() } };
    }
    settingsValues() {
      const out = { ...L.LIMIT_DEFAULTS, ...OTHER_DEFAULTS };
      for (const [k, v] of Object.entries(this.doc.settings)) {
        if (k in out && v && v.value !== null && v.value !== undefined && !Number.isNaN(Number(v.value))) out[k] = Number(v.value);
      }
      return out;
    }
    photosByItem() {
      const m = {};
      const items = this.doc.items;
      const ps = Object.values(this.doc.photos).filter((p) => !p.deleted_at && items[p.item_id] && !items[p.item_id].deleted_at)
        .sort((a, b) => (a.sort ?? Infinity) - (b.sort ?? Infinity) || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
      for (const p of ps) (m[p.item_id] = m[p.item_id] || []).push(p.id);
      return m;
    }

    fullView() {
      const st = this.state();
      const items = L.itemView(st);
      const photos = this.photosByItem();
      for (const v of items) {
        delete v._ts; delete v.deleted_at;
        v.photos = photos[v.id] || [];
      }
      const areas = [...new Set(items.map((i) => i.area).filter(Boolean))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      return { items, areas, modes: L.MODES, settings: this.settingsValues() };
    }

    // ---------- the same rules the server had ----------
    validateItem(b) {
      const out = {};
      out.title = String(b.title ?? "").trim();
      if (!out.title) bad("Give it a name");
      if (out.title.length > 200) bad("Name is too long (200 characters max)");
      out.notes = String(b.notes ?? "");
      out.area = String(b.area ?? "").trim();
      out.priority = b.priority || null;
      if (out.priority && !["low", "medium", "high"].includes(out.priority)) bad("priority must be low, medium or high");
      out.difficulty = b.difficulty || null;
      if (out.difficulty && !["easy", "medium", "hard"].includes(out.difficulty)) bad("difficulty must be easy, medium or hard");
      for (const k of ["cost", "hours"]) {
        const v = b[k];
        if (v === null || v === undefined || v === "") out[k] = null;
        else {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) bad(`${k === "cost" ? "Cost" : "Time"} can't be negative`);
          out[k] = n;
        }
      }
      out.status = b.status || "todo";
      if (!["todo", "doing", "done"].includes(out.status)) bad("bad status");
      out.depends_on = Array.isArray(b.depends_on) ? b.depends_on.map(String) : [];
      out.created_on = b.created_on || null;
      if (out.created_on) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(out.created_on) || Number.isNaN(Date.parse(out.created_on))) bad("Added date must look like 2026-11-02");
        if (out.created_on > today()) bad("Added date can't be in the future");
      }
      return out;
    }
    saveDeps(st, itemId, depIds) {
      const wanted = new Set(depIds.filter((d) => st.items[d] && d !== itemId));
      const badId = L.wouldCycle(st, itemId, wanted);
      if (badId !== null) {
        bad(`“${st.items[badId].title}” can't be a dependency here: it would make a loop (it already waits on this).`);
      }
      this.writeDeps(itemId, wanted);
    }
    createdAt(createdOn, current) {
      if (!createdOn) return current || now();
      if (current && current.slice(0, 10) === createdOn) return current;
      if (createdOn === today()) return now();
      return `${createdOn}T12:00:00`;
    }
    statusTimes(old, status) {
      let started = old ? old.started_at : null;
      let done = old ? old.done_at : null;
      if ((status === "doing" || status === "done") && !started) started = now();
      if (status === "done") done = old && old.status === "done" ? done : now();
      else done = null;
      if (status === "todo") started = null;
      return [started, done];
    }

    // ---------- endpoints ----------
    async createItem(body) {
      const b = this.validateItem(body);
      const [started, done] = this.statusTimes(null, b.status);
      const snapshot = JSON.stringify(this.doc);
      const rec = this.newItem({
        title: b.title, notes: b.notes, area: b.area, priority: b.priority, difficulty: b.difficulty,
        cost: b.cost, hours: b.hours, status: b.status,
        created_at: this.createdAt(b.created_on), started_at: started, done_at: done,
      });
      try { this.saveDeps(this.state(), rec.id, b.depends_on); }
      catch (e) { this.doc = JSON.parse(snapshot); throw e; } // nothing is saved if the links are refused
      await this.save();
      return { ...this.fullView(), id: rec.id };
    }

    async updateItem(id, body) {
      const b = this.validateItem(body);
      const old = this.state().items[id];
      if (!old) notFound();
      const snapshot = JSON.stringify(this.doc);
      try {
        const [started, done] = this.statusTimes(old, b.status);
        this.setMany(this.doc.items[id], {
          title: b.title, notes: b.notes, area: b.area, priority: b.priority, difficulty: b.difficulty,
          cost: b.cost, hours: b.hours, status: b.status, started_at: started, done_at: done,
          created_at: this.createdAt(b.created_on, old.created_at),
        });
        this.saveDeps(this.state(), id, b.depends_on);
        await this.save();
        return { ...this.fullView(), id };
      } catch (e) {
        this.doc = JSON.parse(snapshot);
        throw e;
      }
    }

    async addLink(id, body) {
      let st = this.state();
      if (!st.items[id]) notFound();
      const direction = body.direction || "needs";
      if (!["needs", "unlocks"].includes(direction)) bad("direction must be needs or unlocks");
      const snapshot = JSON.stringify(this.doc);
      try {
        let created = null, other;
        if (body.new) {
          const title = String(body.new.title || "").trim();
          if (!title) bad("Give it a name");
          created = other = this.newItem({ title }).id;
          st = this.state();
        } else if (body.other_id) {
          other = String(body.other_id);
          if (!st.items[other]) notFound("That item doesn't exist");
        } else bad("Pick something or give a name");
        const [waiter, target] = direction === "needs" ? [id, other] : [other, id];
        const current = new Set(st.deps[waiter] || []);
        current.add(target);
        this.saveDeps(st, waiter, [...current]);
        await this.save();
        return { ...this.fullView(), id, created_id: created };
      } catch (e) {
        this.doc = JSON.parse(snapshot);
        throw e;
      }
    }

    async removeLink(id, otherId) {
      const d = this.doc.deps[this.depKey(id, otherId)];
      if (d && !d.deleted_at) this.set(d, "deleted_at", now());
      await this.save();
      return this.fullView();
    }

    /** restore: { started_at, done_at } puts the exact times back (Undo). */
    async setStatus(id, status, restore) {
      if (!["todo", "doing", "done"].includes(status)) bad("bad status");
      if (restore && this.doc.items[id] && !this.doc.items[id].deleted_at) {
        this.setMany(this.doc.items[id], { status, started_at: restore.started_at || null, done_at: restore.done_at || null });
        await this.save();
        return this.fullView();
      }
      const old = this.state().items[id];
      if (!old) notFound();
      if (!(status === "done" && old.status === "done")) {
        const [started, done] = this.statusTimes(old, status);
        this.setMany(this.doc.items[id], { status, started_at: started, done_at: done });
      }
      await this.save();
      return this.fullView();
    }

    async deleteItem(id) {
      const rec = this.doc.items[id];
      if (!rec || rec.deleted_at) notFound();
      const t = now();
      const gone = new Set([id]);
      this.set(rec, "deleted_at", t);
      for (const d of Object.values(this.doc.deps)) {
        if (!d.deleted_at && (gone.has(d.item_id) || gone.has(d.depends_on_id))) this.set(d, "deleted_at", t);
      }
      for (const p of Object.values(this.doc.photos)) {
        if (!p.deleted_at && gone.has(p.item_id)) {
          this.set(p, "deleted_at", t);
          try { await this.adapter.deletePhoto(p.id); } catch (e) { /* file already gone */ }
        }
      }
      await this.save();
      return this.fullView();
    }

    async saveSettings(body) {
      if (body.doing_limit !== null && body.doing_limit !== undefined) {
        const n = Number(body.doing_limit);
        if (!(Number.isInteger(n) && n >= 1 && n <= 10)) bad("Pick a number from 1 to 10");
        this.doc.settings.doing_limit = { value: n, updated_at: Date.now() };
      }
      for (const k of Object.keys(L.LIMIT_DEFAULTS)) {
        const v = body[k];
        if (v === null || v === undefined) continue;
        const n = Number(v);
        if (!(n > 0 && n <= 24)) bad("Hours must be more than 0 and at most 24");
        this.doc.settings[k] = { value: n, updated_at: Date.now() };
      }
      await this.save();
      return this.fullView();
    }
    async resetSettings() {
      for (const k of Object.keys(L.LIMIT_DEFAULTS)) this.doc.settings[k] = { value: null, updated_at: Date.now() };
      await this.save();
      return this.fullView();
    }

    plan(body) {
      const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
      const hours = num(body.hours), budget = num(body.budget);
      if ((hours !== null && hours < 0) || (budget !== null && budget < 0)) bad("Time and budget can't be negative");
      return L.plan(this.state(), {
        hours, budget, mode: body.mode || "all", // only things you can start now; waiting ones come back in res.waiting
        shuffle: Number(body.shuffle) || 0, area: body.area || null, limits: this.settingsValues(),
        avoid: Array.isArray(body.avoid) ? body.avoid : null,
      });
    }

    // ---------- photos ----------
    async addPhoto(itemId, full, thumb, w, h) {
      const rec = this.doc.items[itemId];
      if (!rec || rec.deleted_at) notFound();
      const have = Object.values(this.doc.photos).filter((p) => p.item_id === itemId && !p.deleted_at).length;
      if (have >= MAX_PHOTOS) bad(`That's the most photos one item can have (${MAX_PHOTOS})`);
      const order = this.numberPhotos(itemId);
      const t = now();
      const id = uuid();
      await this.adapter.putPhoto(id, "full", full);
      await this.adapter.putPhoto(id, "thumb", thumb);
      this.doc.photos[id] = { id, item_id: itemId, w, h, sort: order.length, created_at: t, updated_at: t, deleted_at: null, _ts: { deleted_at: Date.now(), sort: Date.now() } };
      await this.save();
      return { ...this.fullView(), photo_id: id };
    }
    /** Give an item's photos sort numbers in their current order (older photos have none). Returns the ids in order. */
    numberPhotos(itemId) {
      const ids = this.photosByItem()[itemId] || [];
      ids.forEach((pid, i) => this.set(this.doc.photos[pid], "sort", i));
      return ids;
    }
    /** New photo order for an item. The first one is the thumbnail in lists and the planner. */
    async orderPhotos(itemId, ids) {
      const cur = this.photosByItem()[itemId] || [];
      if (!Array.isArray(ids) || ids.length !== cur.length || !cur.every((pid) => ids.includes(pid))) bad("That photo order doesn't match this item's photos");
      ids.forEach((pid, i) => this.set(this.doc.photos[pid], "sort", i));
      await this.save();
      return this.fullView();
    }
    async deletePhoto(photoId) {
      const p = this.doc.photos[photoId];
      if (!p || p.deleted_at) notFound("That photo is already gone");
      this.set(p, "deleted_at", now());
      try { await this.adapter.deletePhoto(photoId); } catch (e) { /* ignore */ }
      await this.save();
      return this.fullView();
    }
    photoURL(id, kind = "thumb") { return this.adapter.photoURL(id, kind); }

    // ---------- export / backup / restore ----------
    exportCSV() {
      const rows = L.itemView(this.state());
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      const numOut = (v) => (v === null || v === undefined ? "" : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
      const q = (s) => {
        s = String(s ?? "");
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [["ID", "Project", "Location", "Priority", "Difficulty", "Cost", "Hours", "Status", "Needs first", "Waiting", "Notes", "Created", "Started", "Done"]];
      for (const r of rows) { // itemView is already in the order things were made
        lines.push([r.seq, r.title, r.area, r.priority || "", r.difficulty || "", numOut(r.cost), numOut(r.hours),
          r.derived_status, r.depends_on.map((d) => byId[d].title).join("; "), r.blocked ? "yes" : "", r.notes, r.created_at,
          r.started_at || "", r.done_at || ""]);
      }
      return lines.map((l) => l.map(q).join(",")).join("\r\n") + "\r\n";
    }

    /** Everything as one object: the list plus every live photo (base64). */
    async backupObject() {
      const photos = {};
      for (const p of Object.values(this.doc.photos)) {
        if (p.deleted_at) continue;
        try {
          photos[p.id] = { full: await this.adapter.readPhoto(p.id, "full"), thumb: await this.adapter.readPhoto(p.id, "thumb") };
        } catch (e) { /* skip a missing file rather than fail the whole backup */ }
      }
      return { format: "feasible-backup", version: 1, exported_at: now(), doc: this.doc, photos };
    }
    /** Everything in one JSON file, photos included (base64). */
    async backup() { return JSON.stringify(await this.backupObject()); }

    /**
     * Replace everything with a phone backup (parsed object) or a converted homelab backup (doc).
     * Nothing here is lost if it fails part way:
     *  - a backup from a newer version of the app is refused before anything changes
     *  - a safety copy of what's here now is kept first, photos included (it's a backup file of its own)
     *  - the new photos are written before the new list is saved, and the old photos are only
     *    removed after that, so a crash leaves either the old list with its photos or the new one with its
     */
    async restoreDoc(doc, photos = {}) {
      if (!doc || !doc.items || !doc.schema) bad("That file isn't a ChipAway backup");
      if (doc.schema > SCHEMA) throw new ApiError(409, "That backup was made by a newer version of ChipAway. Update the app to restore it.");
      await this.adapter.saveSafetyCopy(await this.backupObject(), "before-restore");
      const keep = new Set();
      for (const [id, ph] of Object.entries(photos || {})) {
        if (ph.full) await this.adapter.putPhoto(id, "full", ph.full);
        if (ph.thumb) await this.adapter.putPhoto(id, "thumb", ph.thumb);
        keep.add(id);
      }
      const old = this.doc;
      this.doc = doc;
      this.doc.device_id = old.device_id; // this is still the same device, whoever made the backup
      this.upgrade();
      await this.save();
      for (const p of Object.values(old.photos)) {
        if (keep.has(p.id)) continue;
        try { await this.adapter.deletePhoto(p.id); } catch (e) { /* already gone */ }
      }
      return this.fullView();
    }

    // ---------- router: same paths as the homelab server ----------
    async request(method, path, body) {
      const m = method.toUpperCase();
      const p = path.replace(/\?.*$/, "").replace(/\/+$/, "");
      let r;
      if (p === "/api/items" && m === "GET") return this.fullView();
      if (p === "/api/items" && m === "POST") return this.createItem(body || {});
      if (p === "/api/plan" && m === "POST") return this.plan(body || {});
      if (p === "/api/settings" && m === "PUT") return this.saveSettings(body || {});
      if (p === "/api/settings" && m === "DELETE") return this.resetSettings();
      if ((r = p.match(/^\/api\/items\/([^/]+)$/))) {
        if (m === "PUT") return this.updateItem(r[1], body || {});
        if (m === "DELETE") return this.deleteItem(r[1]);
      }
      if ((r = p.match(/^\/api\/items\/([^/]+)\/status$/)) && m === "POST") return this.setStatus(r[1], (body || {}).status, (body || {}).restore);
      if ((r = p.match(/^\/api\/items\/([^/]+)\/links$/)) && m === "POST") return this.addLink(r[1], body || {});
      if ((r = p.match(/^\/api\/items\/([^/]+)\/links\/([^/]+)$/)) && m === "DELETE") return this.removeLink(r[1], r[2]);
      if ((r = p.match(/^\/api\/photos\/([^/]+)$/)) && m === "DELETE") return this.deletePhoto(r[1]);
      if ((r = p.match(/^\/api\/items\/([^/]+)\/photo-order$/)) && m === "POST") return this.orderPhotos(r[1], (body || {}).ids);
      throw new ApiError(404, `No such action: ${m} ${p}`);
    }
  }

  // =====================================================================
  // Storage adapters
  // =====================================================================

  /** In memory (tests). */
  class MemoryAdapter {
    constructor() { this.doc = null; this.files = {}; this.safety = null; }
    async loadDoc() { return this.doc ? JSON.parse(this.doc) : null; }
    async saveDoc(doc) { this.doc = JSON.stringify(doc); }
    async saveSafetyCopy(doc, why = "before-restore") { this.safety = JSON.stringify(doc); this.safetyWhy = why; }
    async setAside() { if (this.doc) { this.asideCopy = this.doc; this.doc = null; } }
    async putPhoto(id, kind, data) { this.files[`${id}.${kind}`] = data; }
    async readPhoto(id, kind) { return this.files[`${id}.${kind}`]; }
    photoURL(id, kind) { const d = this.files[`${id}.${kind}`]; return d ? `data:image/jpeg;base64,${d}` : ""; }
    async deletePhoto(id) { delete this.files[`${id}.full`]; delete this.files[`${id}.thumb`]; }
  }

  /** Browser storage (for trying it in a web browser). Photos are base64 JPEG strings. */
  class IndexedDBAdapter {
    constructor(name = "feasible") { this.name = name; this.urls = {}; }
    db() {
      if (this._db) return this._db;
      this._db = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.name, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore("kv"); req.result.createObjectStore("photos"); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return this._db;
    }
    async op(store, mode, fn) {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const r = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(r && "result" in r ? r.result : undefined);
        tx.onerror = () => reject(tx.error);
      });
    }
    async loadDoc() { const s = await this.op("kv", "readonly", (o) => o.get("doc")); return s ? JSON.parse(s) : null; }
    async saveDoc(doc) { await this.op("kv", "readwrite", (o) => o.put(JSON.stringify(doc), "doc")); }
    async saveSafetyCopy(doc, why = "before-restore") { await this.op("kv", "readwrite", (o) => o.put(JSON.stringify(doc), why)); }
    async setAside() {
      const s = await this.op("kv", "readonly", (o) => o.get("doc"));
      if (s) await this.op("kv", "readwrite", (o) => { o.put(s, `unreadable-${Date.now()}`); return o.delete("doc"); });
    }
    async putPhoto(id, kind, data) {
      await this.op("photos", "readwrite", (o) => o.put(data, `${id}.${kind}`));
      this.urls[`${id}.${kind}`] = `data:image/jpeg;base64,${data}`;
    }
    async readPhoto(id, kind) { return this.op("photos", "readonly", (o) => o.get(`${id}.${kind}`)); }
    async warm(ids) { for (const id of ids) for (const k of ["thumb", "full"]) { const d = await this.readPhoto(id, k); if (d) this.urls[`${id}.${k}`] = `data:image/jpeg;base64,${d}`; } }
    photoURL(id, kind) { return this.urls[`${id}.${kind}`] || ""; }
    async deletePhoto(id) {
      await this.op("photos", "readwrite", (o) => { o.delete(`${id}.full`); return o.delete(`${id}.thumb`); });
      delete this.urls[`${id}.full`]; delete this.urls[`${id}.thumb`];
    }
  }

  /** On the phone: files in the app's private storage (Capacitor Filesystem). */
  class DeviceAdapter {
    constructor(Filesystem, Capacitor) { this.fs = Filesystem; this.cap = Capacitor; this.dir = "DATA"; this.uris = {}; }
    async read(path) {
      try { return (await this.fs.readFile({ path, directory: this.dir, encoding: "utf8" })).data; }
      catch (e) { return null; }
    }
    async write(path, data) {
      // write a temp file, then swap it in, so a crash mid-save can't leave a half-written file
      await this.fs.writeFile({ path: `${path}.tmp`, data, directory: this.dir, encoding: "utf8", recursive: true });
      try { await this.fs.deleteFile({ path, directory: this.dir }); } catch (e) { /* first save */ }
      await this.fs.rename({ from: `${path}.tmp`, to: path, directory: this.dir, toDirectory: this.dir });
    }
    async loadDoc() {
      // if the phone died between "write temp" and "swap it in", the temp file is the newest good copy;
      // it's also the fallback if the main file can't be read
      for (const f of ["feasible.json", "feasible.json.tmp"]) {
        const s = await this.read(f);
        if (!s) continue;
        try { return JSON.parse(s); } catch (e) { /* try the next one */ }
      }
      if ((await this.read("feasible.json")) || (await this.read("feasible.json.tmp"))) throw new Error("unreadable");
      return null;
    }
    /** Keep a file we couldn't read under a new name so nothing ever writes over it. */
    async setAside() {
      const stamp = now().replace(/[:T]/g, "-");
      for (const f of ["feasible.json", "feasible.json.tmp"]) {
        try { await this.fs.rename({ from: f, to: `unreadable-${stamp}-${f}`, directory: this.dir, toDirectory: this.dir }); } catch (e) { /* not there */ }
      }
    }
    async saveDoc(doc) { await this.write("feasible.json", JSON.stringify(doc)); }
    async saveSafetyCopy(doc, why = "before-restore") { await this.write(`${why}-${now().replace(/[:T]/g, "-")}.json`, JSON.stringify(doc)); }
    async putPhoto(id, kind, base64) {
      const path = `photos/${id}.${kind}.jpg`;
      await this.fs.writeFile({ path, data: base64, directory: this.dir, recursive: true });
      await this.cacheURI(id, kind);
    }
    async cacheURI(id, kind) {
      const { uri } = await this.fs.getUri({ path: `photos/${id}.${kind}.jpg`, directory: this.dir });
      this.uris[`${id}.${kind}`] = this.cap.convertFileSrc(uri);
    }
    async warm(ids) { for (const id of ids) for (const k of ["thumb", "full"]) { try { await this.cacheURI(id, k); } catch (e) { /* missing */ } } }
    async readPhoto(id, kind) { return (await this.fs.readFile({ path: `photos/${id}.${kind}.jpg`, directory: this.dir })).data; }
    photoURL(id, kind) { return this.uris[`${id}.${kind}`] || ""; }
    async deletePhoto(id) {
      for (const k of ["full", "thumb"]) { try { await this.fs.deleteFile({ path: `photos/${id}.${k}.jpg`, directory: this.dir }); } catch (e) { /* gone */ } }
      delete this.uris[`${id}.full`]; delete this.uris[`${id}.thumb`];
    }
  }

  const api = { Store, ApiError, MemoryAdapter, IndexedDBAdapter, DeviceAdapter, emptyDoc, uuid, now, today, SCHEMA, MAX_PHOTOS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FeasibleStore = api;
})(typeof self !== "undefined" ? self : this);
