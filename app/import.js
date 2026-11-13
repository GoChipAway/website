/* Import a backup from the homelab version (Settings → Backup there gives a .db file).
 *
 * Reads the SQLite file on the phone with sql.js and converts it to this app's records:
 * every item gets a permanent unique ID; the old number becomes its `seq` so everything keeps
 * the same order. Dates, statuses, steps and needs-first links all carry over.
 */
(function (root) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const St = isNode ? require("./store.js") : root.FeasibleStore;

  const SQLITE_MAGIC = "SQLite format 3\u0000";
  function isSqlite(bytes) {
    const head = String.fromCharCode(...bytes.slice(0, 16));
    return head === SQLITE_MAGIC;
  }

  function rows(db, sql) {
    const res = db.exec(sql);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
  }

  /** bytes: Uint8Array of the .db file; SQL: an initialized sql.js module. Returns { doc, counts }. */
  function homelabToDoc(bytes, SQL) {
    if (!isSqlite(bytes)) throw new Error("That isn't a backup from the homelab version");
    const db = new SQL.Database(bytes);
    try {
      let items, deps, settings;
      try {
        items = rows(db, "SELECT * FROM items ORDER BY id");
        deps = rows(db, "SELECT item_id, depends_on_id FROM deps");
      } catch (e) {
        throw new Error("That file isn't a backup from the homelab version");
      }
      try { settings = rows(db, "SELECT key, value FROM settings"); } catch (e) { settings = []; }

      const doc = St.emptyDoc();
      const ms = Date.now();
      const idMap = {};
      for (const r of items) idMap[r.id] = St.uuid();
      const nz = (v) => (v === undefined ? null : v);
      for (const r of items) {
        const id = idMap[r.id];
        const rec = {
          id, seq: r.id,
          parent_id: r.parent_id ? idMap[r.parent_id] || null : null,
          title: r.title || "(no name)", notes: r.notes || "", area: r.area || "",
          priority: nz(r.priority), difficulty: nz(r.difficulty), cost: nz(r.cost), hours: nz(r.hours),
          status: ["todo", "doing", "done"].includes(r.status) ? r.status : "todo",
          sort: r.sort || 0, created_at: r.created_at || St.now(), updated_at: r.updated_at || St.now(),
          started_at: nz(r.started_at), done_at: nz(r.done_at), deleted_at: null, _ts: {},
        };
        for (const f of Object.keys(rec)) if (!["id", "seq", "_ts"].includes(f)) rec._ts[f] = ms;
        doc.items[id] = rec;
      }
      let depCount = 0;
      for (const d of deps) {
        const a = idMap[d.item_id], b = idMap[d.depends_on_id];
        if (!a || !b) continue;
        const k = `${a}>${b}`;
        doc.deps[k] = { id: k, item_id: a, depends_on_id: b, created_at: St.now(), updated_at: St.now(), deleted_at: null, _ts: { deleted_at: ms } };
        depCount++;
      }
      // The homelab's mood hour limits aren't carried over: Quick wins means something different here
      // (easy jobs, 2 hours or less) and Lazy day is gone. Settings start at the defaults.
      void settings;
      doc.next_seq = items.reduce((m, r) => Math.max(m, r.id), 0) + 1;
      const projects = items.filter((r) => !r.parent_id).length;
      return { doc, counts: { projects, tasks: items.length - projects, links: depCount } };
    } finally {
      db.close();
    }
  }

  const api = { isSqlite, homelabToDoc };
  if (isNode) module.exports = api;
  else root.FeasibleImport = api;
})(typeof self !== "undefined" ? self : this);
