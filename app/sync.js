/* Sync through the person's own Google Drive, in the hidden app-data folder only ChipAway can see.
 *
 * What's stored there: the list as one file (chipaway-list.json) and each photo as two files
 * (photo-<id>.full.jpg and photo-<id>.thumb.jpg). Photos never change once taken, so they never conflict.
 *
 * One sync round:
 *  1. list the folder (one request)
 *  2. download the cloud list, merge it with this device's field by field (merge.js)
 *  3. upload photos the cloud doesn't have yet, then the merged list if the cloud's was behind
 *  4. download photos this device doesn't have yet, then save the merged list here if anything came in
 *  5. tidy up: delete cloud files of photos that were deleted
 * The phone and the PC aren't used at the same time, so there's no live connection: a round runs when
 * the app opens, when it comes back to the screen, and a few seconds after each change.
 *
 * Everything that talks to Google is in DriveFolder, so the rest can be tested without it, and swapped
 * for a real backend later (household sharing) without touching the merge or the screens.
 */
(function (root) {
  "use strict";
  const M = typeof module !== "undefined" && module.exports ? require("./merge.js") : root.FeasibleMerge;
  const St = typeof module !== "undefined" && module.exports ? require("./store.js") : root.FeasibleStore;

  const LIST = "chipaway-list.json";
  const photoName = (id, kind) => `photo-${id}.${kind}.jpg`;
  const PHOTO_RE = /^photo-(.+)\.(full|thumb)\.jpg$/;

  class SyncError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  // ---------------------------------------------------------------------
  /** The app-data folder over Drive's REST API. getToken() returns a current access token. */
  class DriveFolder {
    constructor(getToken, fetchFn) {
      this.getToken = getToken;
      this.fetch = fetchFn || ((...a) => root.fetch(...a));
    }
    async call(url, opts = {}, retried = false) {
      const token = await this.getToken(retried);
      const res = await this.fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
      if (res.status === 401 && !retried) return this.call(url, opts, true); // token expired: get a fresh one once
      if (res.status === 401 || res.status === 403) throw new SyncError("auth", "Google sign-in needs to be renewed");
      if (!res.ok) throw new SyncError("drive", `Google Drive said ${res.status}`);
      return res;
    }
    /** name -> file id, for everything in the folder */
    async list() {
      const out = {};
      let page = "";
      do {
        const q = new URLSearchParams({ spaces: "appDataFolder", fields: "nextPageToken,files(id,name)", pageSize: "1000" });
        if (page) q.set("pageToken", page);
        const j = await (await this.call(`https://www.googleapis.com/drive/v3/files?${q}`)).json();
        for (const f of j.files || []) out[f.name] = f.id;
        page = j.nextPageToken || "";
      } while (page);
      return out;
    }
    async readText(id) { return (await this.call(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).text(); }
    async readBase64(id) {
      const buf = new Uint8Array(await (await this.call(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    }
    /** create (id null) or replace a file's content. body is a string or a Uint8Array. */
    async write(id, name, body, mime) {
      if (id) {
        await this.call(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": mime }, body });
        return id;
      }
      const boundary = "chipaway" + Math.random().toString(36).slice(2);
      const meta = JSON.stringify({ name, parents: ["appDataFolder"] });
      const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
      const tail = `\r\n--${boundary}--`;
      const blob = new Blob([head, body, tail]);
      const res = await this.call("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
        method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: blob,
      });
      return (await res.json()).id;
    }
    writeText(id, name, text) { return this.write(id, name, text, "application/json"); }
    writeBase64(id, name, b64) { return this.write(id, name, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), "image/jpeg"); }
    async remove(id) { await this.call(`https://www.googleapis.com/drive/v3/files/${id}`, { method: "DELETE" }); }
    /** Delete everything ChipAway keeps in this person's Drive. */
    async removeAll() { for (const id of Object.values(await this.list())) await this.remove(id); }
  }

  // ---------------------------------------------------------------------
  class Syncer {
    /** store: the open Store. folder: a DriveFolder (or a stand-in with the same calls). */
    constructor(store, folder, { onStatus = () => {}, delayMs = 3000 } = {}) {
      this.store = store;
      this.folder = folder;
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

    async hasPhoto(id) {
      try { return !!(await this.store.adapter.readPhoto(id, "full")); } catch (e) { return false; }
    }

    async round() {
      const store = this.store, folder = this.folder;
      this.onStatus({ state: "syncing" });
      const files = await folder.list();
      let remote = null;
      if (files[LIST]) {
        try { remote = JSON.parse(await folder.readText(files[LIST])); }
        catch (e) { throw new SyncError("damaged", "The list in Google Drive couldn't be read. Nothing was changed."); }
        if (!remote || !remote.items) throw new SyncError("damaged", "The list in Google Drive couldn't be read. Nothing was changed.");
        if (remote.schema > St.SCHEMA) throw new SyncError("newer", "Your list was synced by a newer version of ChipAway. Update the app to keep syncing.");
      }
      const startedFrom = JSON.stringify(store.doc);
      const { doc: merged, changedTheirs } = M.mergeDocs(JSON.parse(startedFrom), remote);

      // photos up: anything live here the cloud doesn't have
      for (const p of Object.values(merged.photos)) {
        if (p.deleted_at) continue;
        for (const kind of ["full", "thumb"]) {
          if (files[photoName(p.id, kind)]) continue;
          let data;
          try { data = await store.adapter.readPhoto(p.id, kind); } catch (e) { data = null; }
          if (data) files[photoName(p.id, kind)] = await folder.writeBase64(null, photoName(p.id, kind), data);
        }
      }
      // then the list, so another device never sees a photo before its file is there
      if (changedTheirs) {
        const out = { ...merged, device_id: undefined };
        files[LIST] = await folder.writeText(files[LIST] || null, LIST, JSON.stringify(out));
      }

      // photos down: anything live in the merged list this device doesn't have
      const fetched = {};
      for (const p of Object.values(merged.photos)) {
        if (p.deleted_at || (await this.hasPhoto(p.id))) continue;
        if (!files[photoName(p.id, "full")]) continue; // not uploaded yet by the other device; next round
        fetched[p.id] = {
          full: await folder.readBase64(files[photoName(p.id, "full")]),
          thumb: files[photoName(p.id, "thumb")] ? await folder.readBase64(files[photoName(p.id, "thumb")]) : null,
        };
      }

      // and here: merged again with what's here now, so a change made during this round isn't lost
      const changedHere = await store.applySynced(merged, fetched);

      // tidy up the cloud: files of photos that were deleted, and stray files of unknown photos
      for (const [name, id] of Object.entries(files)) {
        const m = PHOTO_RE.exec(name);
        if (!m) continue;
        const p = merged.photos[m[1]];
        if (p && p.deleted_at) { try { await folder.remove(id); } catch (e) { /* next time */ } }
      }
      return changedHere;
    }
  }

  const api = { DriveFolder, Syncer, SyncError, LIST, photoName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FeasibleSync = api;
})(typeof self !== "undefined" ? self : this);
