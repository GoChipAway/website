/* ChipAway — single-page front end. No build step, no framework. */
(() => {
  "use strict";

  const $app = document.getElementById("app");
  const S = { items: [], byId: {}, areas: [], modes: {}, settings: { quick_hours: 2, doing_limit: 3 }, loaded: false };

  // hour limits come from Settings
  const hoursText = (h) => {
    const t = Math.round(h * 60), hh = Math.floor(t / 60), mm = t % 60;
    if (!hh) return `${mm} minutes`;
    if (!mm) return hh === 1 ? "an hour" : `${hh} hours`;
    return `${hh}h ${mm}m`;
  };
  function modeHint(m) {
    const L = S.settings;
    return {
      all: "The best picks that fit your time and money.",
      quick: `Easy jobs, ${hoursText(L.quick_hours)} or less each.`,
      forgotten: "What's been on the list the longest, oldest first.",
      broke: "Only things that cost nothing.",
      payday: "Leans toward the big-ticket stuff you've been putting off.",
      challenge: "Hard jobs you've been avoiding.",
    }[m] || "";
  }
  const MODE_ORDER = ["all", "quick", "forgotten", "broke", "payday", "challenge"];

  // ---------- small helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
  // costs and budgets are whole dollars; anything typed with cents is rounded
  const wholeDollars = (v) => { const n = readNum(v); return n === null ? null : Math.round(n); };

  function money(v, { free = true } = {}) {
    if (v === null || v === undefined) return "—";
    if (v === 0) return free ? "Free" : "$0";
    return "$" + (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
  function hrs(v, { quick = true } = {}) {
    if (v === null || v === undefined) return "—";
    if (v === 0) return quick ? "Quick" : "0h";
    const t = Math.round(v * 60), h = Math.floor(t / 60), m = t % 60;
    if (!h) return (m || 1) + "m";
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  // ---------- time typed as hours + minutes ----------
  // Two small boxes: "2 h" for most jobs, "45 m" for short ones. No decimals to think about.
  // Both blank = no time given. Stored as hours, like before.
  const readNum = (v) => {
    const m = String(v ?? "").replace(/[$,\s]/g, "").match(/^\d*\.?\d+|^\d+\.?/);
    return m ? Number(m[0]) : null;
  };
  const splitHM = (hours) => {
    if (hours === null || hours === undefined || hours === "") return ["", ""];
    const t = Math.round(Number(hours) * 60), h = Math.floor(t / 60), m = t % 60;
    return [h || !m ? String(h) : "", m ? String(m) : ""];
  };
  function hmHTML(id, hours, { placeholder = "0", cls = "hm" } = {}) {
    const [h, m] = splitHM(hours);
    const box = (part, v, lbl, ph = placeholder) => `<label class="hm-part" for="${id}_${part}"><input id="${id}_${part}" type="tel" inputmode="numeric" pattern="[0-9]*" enterkeyhint="done" autocomplete="off" maxlength="4" placeholder="${ph}" value="${v}" aria-label="${lbl}"><span>${part}</span></label>`;
    return `<div class="${cls}" data-hm="${id}">${box("h", h, "Hours")}${box("m", m, "Minutes", "0")}</div>`;
  }
  function readHM(id) {
    const h = readNum(document.getElementById(id + "_h").value), m = readNum(document.getElementById(id + "_m").value);
    if (h === null && m === null) return null;
    return Math.round(((h || 0) + (m || 0) / 60) * 10000) / 10000;
  }
  function setHM(id, hours) {
    const [h, m] = splitHM(hours);
    document.getElementById(id + "_h").value = h;
    document.getElementById(id + "_m").value = m;
  }
  // tidy "90 m" into "1 h 30 m" once you leave the box
  function tidyHM(id) {
    const m = readNum(document.getElementById(id + "_m").value);
    if (m !== null && m >= 60) setHM(id, readHM(id));
  }
  // dates: "2026-10-03T12:00:00" -> "Oct 3, 2026" and "4 weeks ago"
  const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = () => localDay(new Date());
  function parseDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function fmtDate(iso) {
    const d = parseDay(iso);
    if (!d) return "—";
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }
  function ago(iso) {
    const d = parseDay(iso);
    if (!d) return "";
    const days = Math.round((parseDay(today()) - d) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 14) return `${days} days ago`;
    if (days < 60) return `${Math.round(days / 7)} weeks ago`;
    if (days < 365 * 2) return `${Math.round(days / 30.44)} months ago`;
    return `${Math.floor(days / 365.25)} years ago`;
  }

  function store(k, v) { try { localStorage.setItem("feasible." + k, JSON.stringify(v)); } catch (e) { /* no storage */ } }
  function recall(k, d) { try { const v = localStorage.getItem("feasible." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }

  let toastTimer;
  function toast(msg, err = false, action = null) {
    const t = document.getElementById("toast");
    t.textContent = "";
    const s = document.createElement("span");
    s.textContent = msg;
    t.append(s);
    if (action) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "toast-act"; b.textContent = action.label;
      b.addEventListener("click", () => { t.className = ""; clearTimeout(toastTimer); action.fn(); });
      t.append(b);
    }
    t.className = "show" + (err ? " err" : "") + (action ? " act" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ""), err ? 4500 : action ? 5000 : 2200);
  }

  // Everything is answered on the phone by the local store (store.js), which speaks the same
  // requests the homelab server did. Nothing leaves the device.
  let dataStore = null;
  async function api(path, opts = {}) {
    if (!dataStore) {
      dataStore = await Native.openStore();
      if (dataStore.setAside) toast("ChipAway couldn't read your saved list, so it was set aside safely, not deleted. Restore a backup in Settings, or email gochipaway@gmail.com for help.", true);
    }
    let data;
    try {
      data = await dataStore.request(opts.method || "GET", path, opts.body);
    } catch (e) {
      throw new Error(e.detail || e.message || "Something went wrong");
    }
    if (data && data.items) absorb(data);
    return data;
  }
  function absorb(d) {
    S.items = d.items;
    S.byId = Object.fromEntries(d.items.map((i) => [i.id, i]));
    S.areas = d.areas || [];
    S.modes = d.modes || S.modes;
    S.settings = d.settings || S.settings;
    S.loaded = true;
    // items come in the order they were made (seq, then id: the same on every device)
    S.rank = Object.fromEntries(d.items.map((i, n) => [i.id, n]));
  }
  const madeOrder = (a, b) => S.rank[a.id] - S.rank[b.id];

  // ---------- sync with Google Drive (optional; off until the person signs in) ----------
  // The list and photos also live in the person's own Google Drive, in a folder only ChipAway can see,
  // so the web companion on a PC shows the same list. Sync runs when the app opens, when it comes back
  // to the screen, and a few seconds after each change (sync.js).
  const SYNC = { on: recall("sync.on", false), email: recall("sync.email", ""), syncer: null, status: { state: "idle" } };
  const syncFolder = () => new FeasibleSync.DriveFolder(() => Native.googleToken({ interactive: false }));
  async function startSync() {
    if (!dataStore) await api("/api/items");
    SYNC.syncer = new FeasibleSync.Syncer(dataStore, syncFolder(), {
      onStatus: (st) => { SYNC.status = st; if (route().name === "settings") drawSyncStatus(); },
    });
    dataStore.onSaved = () => SYNC.syncer && SYNC.syncer.soon();
    return runSync();
  }
  function stopSync() {
    if (Native.forgetWebToken) Native.forgetWebToken();
    if (SYNC.syncer) clearTimeout(SYNC.syncer.timer);
    SYNC.syncer = null;
    if (dataStore) dataStore.onSaved = null;
    SYNC.on = false; SYNC.email = ""; SYNC.status = { state: "idle" };
    store("sync.on", false); store("sync.email", "");
  }
  async function runSync() {
    if (!SYNC.syncer) return false;
    try {
      const changed = await SYNC.syncer.now();
      if (changed) {
        absorb(dataStore.fullView());
        const name = route().name;
        if (name !== "new" && name !== "edit") render(); // never redraw a form someone is typing in
      }
      return changed;
    } catch (e) { return false; } // shown on the Settings page; the list here is untouched
  }
  window.addEventListener("chipaway:resume", () => { if (SYNC.syncer) runSync(); });

  /** Google's sign-in (from a tap), then turn sync on and run the first round. Resolves to whether it synced. */
  async function signInWithGoogle(onStarted = () => {}) {
    const token = await Native.googleToken({ interactive: true });
    let email = "";
    try { email = (await (await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token}` } })).json()).email || ""; } catch (e) { /* shown without it */ }
    SYNC.on = true; SYNC.email = email || SYNC.email;
    store("sync.on", true); store("sync.email", SYNC.email);
    SYNC.status = { state: "syncing" };
    onStarted();
    await startSync();
    return SYNC.status.state === "ok";
  }

  // ---------- first visit to the web app: sign in, or just use it in this browser ----------
  const needsWelcome = () => !Native.isApp && Native.canSignIn && !SYNC.on && !recall("web.welcomed", false);
  function renderWelcome() {
    setTabs("");
    document.body.classList.add("welcoming");
    $app.innerHTML = `<div class="welcome card">
      <h2>Welcome to ChipAway</h2>
      <p class="muted">How do you want to use it here?</p>
      <div class="welcome-choice">
        <button class="btn primary" id="wSignIn">Sign in with Google</button>
        <p class="small muted">See the same list as ChipAway on your phone. It syncs through your own Google Drive, in a folder only ChipAway can see. Turn on sync in the phone app too (Settings → Sync).</p>
      </div>
      <div class="welcome-choice">
        <button class="btn" id="wLocal">Use it without signing in</button>
        <p class="small muted">Your list is kept only in this browser. It isn't on your phone, and clearing your browser's data erases it. You can sign in later in Settings.</p>
      </div>
    </div>`;
    const done = () => { store("web.welcomed", true); document.body.classList.remove("welcoming"); location.hash = "#/plan"; render(); };
    document.getElementById("wLocal").addEventListener("click", done);
    const b = document.getElementById("wSignIn");
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const ok = await signInWithGoogle();
        done();
        toast(ok ? "Syncing with Google Drive." : syncStatusText(), !ok);
      } catch (e) {
        b.disabled = false;
        if (e.code !== "cancelled") toast(e.message, true);
      }
    });
  }
  const agoShort = (ms) => {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return new Date(ms).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
  };
  function syncStatusText() {
    const st = SYNC.status;
    if (st.state === "syncing") return "Syncing…";
    if (st.state === "error") {
      if (st.code === "auth") return "Google needs you to sign in again.";
      return st.message || "Couldn't sync. It'll try again next time.";
    }
    if (SYNC.syncer && SYNC.syncer.lastSynced) return `Synced ${agoShort(SYNC.syncer.lastSynced)}.`;
    return "Not synced yet.";
  }
  function drawSyncStatus() {
    const el = document.getElementById("syncStatus");
    if (el) el.textContent = syncStatusText();
    const again = document.getElementById("syncAgain");
    if (again) again.hidden = !(SYNC.status.state === "error" && SYNC.status.code === "auth");
  }

  // ---------- item helpers ----------
  const dependents = (id) => S.items.filter((i) => i.depends_on.includes(id));

  // ---------- photos ----------
  const photoURL = (pid, kind = "thumb") => (dataStore ? dataStore.photoURL(pid, kind) : "");
  // first photo as a small square. The photo is the reminder, so show it wherever the item shows up.
  function thumbHTML(it, cls = "thumb") {
    const pid = (it.photos || [])[0];
    const url = pid && photoURL(pid);
    return url ? `<img class="${cls}" src="${url}" alt="" loading="lazy" data-view="${pid}">` : "";
  }

  // shrink a picked/taken photo: full size up to 1600px for viewing, a 240px square for lists
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't open that picture")); };
      img.src = url;
    });
  }
  async function processPhoto(file) {
    const img = await loadImage(file);
    const W = img.naturalWidth, H = img.naturalHeight;
    const scale = Math.min(1, 1600 / Math.max(W, H));
    const c = document.createElement("canvas");
    c.width = Math.round(W * scale); c.height = Math.round(H * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const full = c.toDataURL("image/jpeg", 0.82).split(",")[1];
    const t = document.createElement("canvas");
    t.width = t.height = 240;
    const side = Math.min(W, H);
    t.getContext("2d").drawImage(img, (W - side) / 2, (H - side) / 2, side, side, 0, 0, 240, 240);
    const thumb = t.toDataURL("image/jpeg", 0.78).split(",")[1];
    return { full, thumb, w: c.width, h: c.height };
  }
  const MAX_PHOTOS = 10;
  // a picked batch that would go past the cap keeps the first ones that fit
  const fitPhotos = (files, have) => [...files].slice(0, Math.max(0, MAX_PHOTOS - have));
  const capNote = (skipped) => (skipped ? ` ${skipped} didn't fit: ${MAX_PHOTOS} is the most per item.` : "");
  async function addPhotos(itemId, files) {
    let n = 0;
    const picked = files.length;
    files = fitPhotos(files, (S.byId[itemId].photos || []).length);
    addPhotos.skipped = picked - files.length;
    for (const f of files) {
      try {
        const p = await processPhoto(f);
        absorb(await dataStore.addPhoto(itemId, p.full, p.thumb, p.w, p.h));
        n++;
      } catch (err) { toast(err.message, true); }
    }
    return n;
  }
  // two hidden pickers: the camera, and the gallery (several at once)
  function photoPickers(prefix) {
    return `<input type="file" accept="image/*" capture="environment" id="${prefix}Cam" hidden>
      <input type="file" accept="image/*" multiple id="${prefix}Lib" hidden>
      <button type="button" class="btn small" data-pick-photo="${prefix}Cam">📷 Take photo</button>
      <button type="button" class="btn small" data-pick-photo="${prefix}Lib">🖼️ Choose from photos</button>`;
  }
  function wirePickers(root, onFiles) {
    root.querySelectorAll("[data-pick-photo]").forEach((b) => b.addEventListener("click", () => document.getElementById(b.dataset.pickPhoto).click()));
    root.querySelectorAll('input[type=file][accept="image/*"]').forEach((inp) => inp.addEventListener("change", async () => {
      const files = [...inp.files];
      inp.value = "";
      if (files.length) await onFiles(files);
    }));
  }

  // full-screen viewer: swipe or arrows between an item's photos; delete, move, or make it the thumbnail from here
  function openViewer(pid) {
    const owner = S.items.find((i) => (i.photos || []).includes(pid));
    if (!owner) return;
    let list = [...owner.photos], idx = list.indexOf(pid);
    let changed = false;
    const v = document.createElement("div");
    v.className = "viewer";
    v.setAttribute("role", "dialog");
    v.setAttribute("aria-label", "Photo");
    const draw = () => {
      const cur = list[idx];
      v.innerHTML = `<div class="viewer-top"><span>${esc(owner.title)}${list.length > 1 ? ` · ${idx + 1} of ${list.length}` : ""}</span>
          <span class="spacer"></span><button class="vbtn" data-act="del" aria-label="Delete photo">Delete</button><button class="vbtn" data-act="close" aria-label="Close">✕</button></div>
        <img src="${photoURL(cur, "full") || photoURL(cur)}" alt="">
        ${list.length > 1 ? `<button class="vnav prev" data-act="prev" aria-label="Previous">‹</button><button class="vnav next" data-act="next" aria-label="Next">›</button>
        <div class="viewer-bottom">
          <button class="vbtn" data-act="left" ${idx === 0 ? "disabled" : ""} aria-label="Move earlier">← Move</button>
          ${idx === 0 ? `<span class="vcover">★ Thumbnail</span>` : `<button class="vbtn" data-act="cover">Make thumbnail</button>`}
          <button class="vbtn" data-act="right" ${idx === list.length - 1 ? "disabled" : ""} aria-label="Move later">Move →</button>
        </div>` : ""}`;
    };
    // moving takes the photo with it, so the viewer stays on the same picture
    const reorder = async (to) => {
      const next = [...list];
      const [cur] = next.splice(idx, 1);
      next.splice(to, 0, cur);
      try {
        absorb(await dataStore.request("POST", `/api/items/${owner.id}/photo-order`, { ids: next }));
        list = next; idx = to; changed = true; draw(); // the ★ Thumbnail label is the confirmation
      } catch (err) { toast(err.message, true); }
    };
    const close = () => { v.remove(); if (changed) render(); };
    draw();
    v.addEventListener("click", async (e) => {
      const act = (e.target.closest("[data-act]") || {}).dataset?.act;
      if (act === "close" || e.target === v) close();
      else if (act === "left" && idx > 0) reorder(idx - 1);
      else if (act === "right" && idx < list.length - 1) reorder(idx + 1);
      else if (act === "cover") reorder(0);
      else if (act === "prev") { idx = (idx - 1 + list.length) % list.length; draw(); }
      else if (act === "next") { idx = (idx + 1) % list.length; draw(); }
      else if (act === "del") {
        const b = e.target.closest("[data-act]");
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to delete"; return; }
        try {
          absorb(await dataStore.request("DELETE", `/api/photos/${list[idx]}`));
          v.remove(); toast("Photo deleted"); render();
        } catch (err) { toast(err.message, true); }
      }
    });
    let x0 = null;
    v.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    v.addEventListener("touchend", (e) => {
      if (x0 === null || list.length < 2) return;
      const dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 50) { idx = (idx + (dx < 0 ? 1 : -1) + list.length) % list.length; draw(); }
    });
    document.body.appendChild(v);
  }
  document.addEventListener("click", (e) => {
    const t = e.target.closest("img[data-view]");
    if (t && !t.closest(".viewer")) { e.preventDefault(); e.stopPropagation(); openViewer(t.dataset.view); }
  }, true);
  document.addEventListener("keydown", (e) => {
    const v = document.querySelector(".viewer");
    if (!v) return;
    if (e.key === "Escape") v.querySelector('[data-act="close"]').click();
    if (e.key === "ArrowRight") v.querySelector('[data-act="next"]')?.click();
    if (e.key === "ArrowLeft") v.querySelector('[data-act="prev"]')?.click();
  });
  const isDone = (it) => it.derived_status === "done";
  const PRI_RANK = { high: 3, medium: 2, low: 1 };
  const DIFF_RANK = { easy: 1, medium: 2, hard: 3 };

  function chipsFor(it, { showStatus = true, compact = false } = {}) {
    const out = [];
    const p = it.eff_priority;
    if (p) out.push(`<span class="chip p-${p}${it.priority ? "" : " faint"}"><span class="dot"></span>${cap(p)}</span>`);
    if (it.eff_difficulty) out.push(`<span class="chip${it.difficulty ? "" : " faint"}">${cap(it.eff_difficulty)}</span>`);
    if (!compact) {
      const area = it.area;
      if (area) out.push(`<span class="chip">${esc(area)}</span>`);
    }
    if (showStatus) {
      if (isDone(it)) out.push(`<span class="chip done">Done</span>`);
      else {
        if (it.derived_status === "doing") out.push(`<span class="chip doing">Doing</span>`);
        if (it.blocked) out.push(`<span class="chip blocked">Waiting on ${it.waiting_on.length}</span>`);
        if (it.unlocks > 0) out.push(`<span class="chip unlocks">Unlocks ${it.unlocks}</span>`);
      }
    }
    return out.join("");
  }

  const itemNums = (it) => `<b>${money(it.cost)}</b><span class="muted">${hrs(it.hours)}</span>`;

  function itemRow(it, { check = true, extra = "", note = "", age = false, chips = true } = {}) {
    const done = isDone(it);
    const subText = [note, age ? `added ${ago(it.created_at)}` : ""].filter(Boolean).join(" · ");
    const sub = subText ? `<div class="sub">${subText}</div>` : "";
    return `<div class="item${done ? " is-done" : ""}" data-open="${it.id}">
      ${check ? `<button class="check${done ? " on" : ""}" data-toggle="${it.id}" aria-label="${done ? "Mark not done" : "Mark done"}" title="${it.blocked && !done ? "Still waiting on something — you can check it off anyway" : ""}"></button>` : ""}
      <div class="body"><a class="title" href="#/item/${it.id}">${esc(it.title)}</a>${sub}${chips ? `<div class="chips">${chipsFor(it)}</div>` : ""}</div>
      ${thumbHTML(it)}<div class="nums">${itemNums(it)}</div>${extra}
    </div>`;
  }

  function toggleDone(id) {
    const it = S.byId[id];
    if (it) return changeStatus(id, isDone(it) ? "todo" : "done");
  }

  // what's started and not finished, oldest start first
  const doingNow = () => S.items.filter((i) => i.status === "doing" && !isDone(i))
    .sort((a, b) => String(a.started_at || "").localeCompare(String(b.started_at || "")));

  // Every To do / Doing / Done change goes through here: one tap, and Undo puts it back exactly.
  // Going past the Doing limit just turns the Doing now line red on the Plan page; no extra taps.
  async function changeStatus(id, next) {
    const it = S.byId[id];
    if (!it) return;
    const cur = isDone(it) ? "done" : it.status;
    if (cur === next) return;
    const prev = { status: it.status, started_at: it.started_at || null, done_at: it.done_at || null };
    try {
      await api(`/api/items/${id}/status`, { method: "POST", body: { status: next } });
    } catch (e) { toast(e.message, true); return; }
    let msg;
    if (next === "done") {
      const freed = dependents(id).filter((d) => !d.blocked && !isDone(d));
      msg = freed.length ? `Done. That frees up ${freed.length === 1 ? "“" + freed[0].title + "”" : freed.length + " things"}.` : "Done. Nice.";
    } else if (next === "doing") {
      const n = doingNow().length;
      msg = n > 1 ? `Started. ${n} going now.` : "Started.";
    } else msg = cur === "done" ? "Reopened." : "Back to To do.";
    render();
    toast(msg, false, { label: "Undo", fn: async () => {
      try { await api(`/api/items/${id}/status`, { method: "POST", body: { status: prev.status, restore: prev } }); render(); toast("Undone."); }
      catch (e) { toast(e.message, true); }
    } });
  }


  // ---------- router ----------
  function route() {
    const h = location.hash.replace(/^#\/?/, "");
    const [path, query] = h.split("?");
    const parts = path.split("/").filter(Boolean);
    const q = new URLSearchParams(query || "");
    return { name: parts[0] || "plan", id: parts[1] ? decodeURIComponent(parts[1]) : null, q };
  }

  function setTabs(name) {
    const tab = name === "item" || name === "new" || name === "edit" ? "projects" : name;
    document.querySelectorAll("[data-tab]").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
  }

  async function render() {
    if (needsWelcome()) return renderWelcome();
    const r = route();
    setTabs(r.name);
    if (!S.loaded) {
      try { await api("/api/items"); } catch (e) { $app.innerHTML = `<div class="card empty"><h2>Can't reach the app</h2><p>${esc(e.message)}</p></div>`; return; }
    }
    if (r.name === "plan") return renderPlan();
    if (r.name === "projects") return renderProjects();
    if (r.name === "item") return renderItem(r.id);
    if (r.name === "new") return renderForm(null);
    if (r.name === "edit") return renderForm(r.id);
    if (r.name === "settings") return renderSettings();
    location.hash = "#/plan";
  }
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

  // delegated clicks for rows and checks
  $app.addEventListener("click", (e) => {
    const t = e.target.closest("[data-toggle]");
    if (t) { e.preventDefault(); e.stopPropagation(); toggleDone(t.dataset.toggle); return; }
    const o = e.target.closest("[data-open]");
    if (o && !e.target.closest("a,button,input,select")) location.hash = `#/item/${o.dataset.open}`;
  });

  // =====================================================================
  // PLAN
  // =====================================================================
  // Every time the app opens: Anything, 8 hours, $500. Fit/Everything and location are remembered.
  // The plan only ever shows things you can start now; anything waiting on prep is listed under Show everything.
  const PLAN_START = { hours: 8, budget: 500, mode: "all" };
  const P = { all: false, area: "", ...recall("plan", {}), ...PLAN_START };
  delete P.view; // left over in what older builds remembered
  let planSeed = 0;
  let planAvoid = []; // picks already shown since the last change; "Something else" skips them
  let planTimer;

  function renderPlan() {
    if (!S.items.length) {
      $app.innerHTML = `<div class="card empty pad">
        <h1>What can you get done?</h1>
        <p>Add the projects around the house you keep meaning to do. Give them a cost, a time, a priority and how hard they are. Then tell ChipAway how much time and money you've got.</p>
        <a class="btn primary" href="#/new">Add your first project</a></div>`;
      return;
    }
    const areaOpts = S.areas.map((a) => `<option ${P.area === a ? "selected" : ""}>${esc(a)}</option>`).join("");
    // what's already started: one line, tap to see them. Red-ish once you're past your limit.
    const doing = doingNow();
    const doingBar = doing.length ? `<details class="doing-now${doing.length > S.settings.doing_limit ? " past-limit" : ""}" id="doingNow" ${recall("doingOpen", false) ? "open" : ""}>
        <summary><span class="lbl">Doing now · ${doing.length}</span><span class="names">${doing.map((i) => esc(i.title)).join(", ")}</span></summary>
        <div class="card">${doing.map((i) => itemRow(i)).join("")}</div></details>` : "";
    $app.innerHTML = `
      ${doingBar}
      <section class="card ask">
        <div class="seg full scope" role="radiogroup" aria-label="What to show">
          <button data-all="0" class="${P.all ? "" : "on"}">Fit my time &amp; money</button>
          <button data-all="1" class="${P.all ? "on" : ""}">Show everything</button>
        </div>
        <div id="fitBox" class="${P.all ? "hidden" : ""}">
        <div class="limits">
          <div class="limit"><div class="lim-head"><label for="hours_h">Time</label><span class="step"><button type="button" data-step="-1" aria-label="Less time">−</button><button type="button" data-step="1" aria-label="More time">+</button></span></div>${hmHTML("hours", P.hours, { placeholder: "–" })}</div>
          <div class="limit"><label for="budget">Budget · $</label><input id="budget" type="tel" inputmode="numeric" pattern="[0-9]*" enterkeyhint="done" autocomplete="off" placeholder="any" value="${P.budget ?? ""}"><button class="clear" data-clear="budget" title="No budget limit">×</button></div>
        </div>
        </div>
        ${S.areas.length ? `<label class="loc"><span aria-hidden="true">📍</span><select id="area" aria-label="Location"><option value="">Anywhere</option>${areaOpts}</select></label>` : ""}
        <div class="modes" role="radiogroup" aria-label="Mood">${MODE_ORDER.map((m) => `<button class="mode${P.mode === m ? " on" : ""}" data-mode="${m}" role="radio" aria-checked="${P.mode === m}">${esc(S.modes[m] || m)}</button>`).join("")}</div>
        <div class="mode-hint" id="modeHint">${modeHint(P.mode)}</div>
      </section>
      <div id="results"></div>`;

    const $b = document.getElementById("budget");
    const $hh = document.getElementById("hours_h"), $hm = document.getElementById("hours_m");
    // "$1,200" works; anything unreadable counts as no limit
    const update = () => {
      P.hours = readHM("hours");
      P.budget = wholeDollars($b.value);
      store("plan", P);
      planSeed = 0; planAvoid = [];
      clearTimeout(planTimer);
      planTimer = setTimeout(runPlan, 180);
    };
    for (const el of [$hh, $hm, $b]) {
      for (const ev of ["input", "change", "keyup", "compositionend", "blur"]) el.addEventListener(ev, update);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
    }
    $hm.addEventListener("blur", () => tidyHM("hours"));
    // − / +: half hours up to an hour, whole hours after that; never below 30 minutes
    $app.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
      const cur = readHM("hours");
      let v;
      if (b.dataset.step === "1") v = cur === null ? 1 : cur < 1 ? Math.min(1, Math.floor(cur * 2) / 2 + 0.5) : Math.floor(cur) + 1;
      else v = cur === null ? 8 : cur > 1 ? Math.ceil(cur) - 1 : 0.5;
      setHM("hours", v);
      update();
    }));
    const $dn = document.getElementById("doingNow");
    if ($dn) $dn.addEventListener("toggle", () => store("doingOpen", $dn.open));
    $app.querySelectorAll("[data-clear]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.clear === "hours") setHM("hours", null);
      else document.getElementById(b.dataset.clear).value = "";
      update();
    }));
    const setMode = (m) => {
      P.mode = m;
      $app.querySelectorAll("[data-mode]").forEach((x) => { x.classList.toggle("on", x.dataset.mode === m); x.setAttribute("aria-checked", x.dataset.mode === m); });
      document.getElementById("modeHint").textContent = modeHint(m);
    };
    $app.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
      setMode(b.dataset.mode === P.mode ? "all" : b.dataset.mode);
      update();
    }));
    $app.querySelectorAll("[data-all]").forEach((b) => b.addEventListener("click", () => {
      P.all = b.dataset.all === "1";
      $app.querySelectorAll("[data-all]").forEach((x) => x.classList.toggle("on", x === b));
      document.getElementById("fitBox").classList.toggle("hidden", P.all);
      update();
    }));
    const $area = document.getElementById("area");
    if ($area) $area.addEventListener("change", () => { P.area = $area.value; update(); });
    if (P.area && !S.areas.includes(P.area)) P.area = "";
    runPlan();
  }

  async function runPlan() {
    const $r = document.getElementById("results");
    if (!$r) return;
    let res;
    try {
      res = await api("/api/plan", { method: "POST", body: { hours: P.all ? null : P.hours, budget: P.all ? null : P.budget, mode: P.mode, shuffle: planSeed, area: P.area || null, avoid: planAvoid } });
    } catch (e) { $r.innerHTML = `<div class="card empty"><p>${esc(e.message)}</p></div>`; return; }
    if (!document.getElementById("results")) return;
    $r.innerHTML = planHTML(res);
    const sh = document.getElementById("shuffle");
    if (sh) sh.addEventListener("click", () => {
      // push everything shown so far to the back; once every option has had a turn, start over
      const shown = res.plan.map((p) => p.target);
      const fresh = shown.filter((t) => !planAvoid.includes(t));
      planAvoid = fresh.length ? [...planAvoid, ...shown] : [];
      planSeed = Math.floor(Math.random() * 1e9) + 1;
      runPlan();
    });
    $r.querySelectorAll("[data-start]").forEach((b) => b.addEventListener("click", async () => {
      await changeStatus(b.dataset.start, "doing");
    }));
    $r.querySelectorAll("[data-goall]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault(); $app.querySelector('[data-all="1"]').click(); window.scrollTo(0, 0);
    }));
  }

  function planHTML(res) {
    const openCount = S.items.filter((i) => !isDone(i)).length;
    if (!openCount) {
      return `<div class="card empty pad"><h2>Everything's done</h2><p>Nothing left on the list. Enjoy it, or add the next thing.</p><a class="btn primary" href="#/new">Add a project</a></div>`;
    }
    if (P.all) return everythingHTML(res);
    const unlimited = res.hours === null && res.budget === null;
    let html = "";
    if (!res.plan.length) {
      html += `<div class="summary"><span class="big">Nothing fits that</span></div>
        <div class="card pad muted">${res.candidates ? "Everything that matches is bigger than your time or budget." : "Nothing matches that mood right now."} ${res.near.length ? "Here's what's closest:" : "Try a different mood, or loosen the limits."}</div>`;
    } else {
      const n = res.plan.length;
      html += `<div class="summary"><span class="big">${unlimited ? "Top picks right now" : `You could knock out ${n} thing${n === 1 ? "" : "s"}`}</span></div>`;
      if (!unlimited) {
        const pctH = res.hours ? Math.min(100, (100 * res.used_hours) / res.hours) : 0;
        const pctC = res.budget ? Math.min(100, (100 * res.used_cost) / res.budget) : 0;
        html += `<div class="meter">
          <div class="m"><div class="lbl">Time</div><div class="val">${hrs(res.used_hours, { quick: false })}${res.hours !== null ? ` <span class="muted small">of ${hrs(res.hours, { quick: false })}</span>` : ""}</div>${res.hours ? `<div class="bar"><span style="width:${pctH}%"></span></div>` : ""}</div>
          <div class="m"><div class="lbl">Cost</div><div class="val">${money(res.used_cost, { free: false })}${res.budget !== null ? ` <span class="muted small">of ${money(res.budget, { free: false })}</span>` : ""}</div>${res.budget ? `<div class="bar"><span style="width:${pctC}%"></span></div>` : ""}</div>
        </div>`;
      }
      html += `<div class="list">${res.plan.map((p, i) => pickHTML(p, i + 1)).join("")}</div>
        <div class="shuffle-row"><button class="btn" id="shuffle" title="Show a different mix">↻ Something else</button></div>`;
    }
    if (res.also.length) {
      html += `<h3>${res.plan.length ? "Also fits on its own" : "Fits"}</h3><div class="card">${res.also.map(miniHTML).join("")}</div>`;
    }
    if (res.near.length) {
      html += `<h3>Just out of reach</h3><div class="card">${res.near.map((n) => {
        const it = S.byId[n.target];
        const over = [n.over_hours > 0 ? `+${hrs(n.over_hours, { quick: false })}` : "", n.over_cost > 0 ? `+${money(n.over_cost, { free: false })}` : ""].filter(Boolean).join(" · ");
        return `<a class="mini" href="#/item/${it.id}"><div class="t">${esc(it.title)}</div><span class="nums">${money(n.cost, { free: false })} · ${hrs(n.hours, { quick: false })}</span><span class="over small">${over}</span></a>`;
      }).join("")}</div>`;
    }
    if (res.waiting.length) {
      const n = res.waiting.length;
      html += `<p class="muted small" style="margin-top:16px">${n} thing${n === 1 ? " is" : "s are"} waiting on something else first, so ${n === 1 ? "it's" : "they're"} not listed. <a href="#" data-goall>Show everything</a> lists them with what they're waiting on.</p>`;
    }
    return html;
  }

  // Show everything: no time or money limits, a checklist instead of cards
  function everythingHTML(res) {
    let html = "";
    const n = res.plan.length;
    html += `<div class="summary"><span class="big">${n ? `${n} thing${n === 1 ? "" : "s"} you can do now` : "Nothing you can start right now"}</span>
      ${n ? `<span class="muted small">${money(res.used_cost, { free: false })} · ${hrs(res.used_hours, { quick: false })} in all</span>` : ""}</div>`;
    if (n) html += `<div class="card">${res.plan.map((p) => itemRow(S.byId[p.target], { age: res.mode === "forgotten" })).join("")}</div>`;
    else html += `<div class="card pad muted">${res.waiting.length ? "Everything left is waiting on something else. It's listed below." : "Nothing matches that mood. Try Anything."}</div>`;
    if (res.waiting.length) {
      html += `<h3>Waiting on something · ${res.waiting.length}</h3><div class="card">${res.waiting.map((w) => {
        const it = S.byId[w.target];
        const after = w.after.map((a) => esc(S.byId[a].title));
        const note = after.length ? `after ${after.length > 2 ? `${after.slice(0, 2).join(", ")} +${after.length - 2} more` : after.join(" and ")}` : "";
        return itemRow(it, { note, age: res.mode === "forgotten" });
      }).join("")}</div>`;
    }
    return html;
  }

  // one pick on the plan: everything picked can be started now, so each is a single item
  function pickHTML(p, n) {
    const it = S.byId[p.target];
    const sub = P.mode === "forgotten" ? `<div class="sub">added ${ago(it.created_at)}</div>` : "";
    const actions = `<div class="pick-actions">${it.status === "todo" ? `<button class="btn small" data-start="${it.id}">Start it</button>` : ""}<button class="btn small ${it.status === "doing" ? "finish" : "primary"}" data-toggle="${it.id}">Mark done</button></div>`;
    return `<div class="card pick">
      <div class="pick-head"><span class="n">${n}</span>
        <div class="t"><a href="#/item/${it.id}">${esc(it.title)}</a>${sub}<div class="chips" style="margin-top:5px">${chipsFor(it, { compact: true })}</div></div>
        ${thumbHTML(it)}<div class="nums">${money(p.cost)}<br><span class="muted">${hrs(p.hours)}</span></div>
      </div>${actions}</div>`;
  }

  const miniHTML = (a) => {
    const it = S.byId[a.target];
    return `<a class="mini" href="#/item/${it.id}"><div class="t">${esc(it.title)}</div><span class="nums">${money(a.cost)} · ${hrs(a.hours)}</span></a>`;
  };

  // =====================================================================
  // PROJECTS LIST
  // =====================================================================
  const L = recall("list", { filter: "open", sort: "priority", flat: false, q: "" });

  const SORTS = {
    priority: ["Priority", (a, b) => (PRI_RANK[b.eff_priority] || 1.5) - (PRI_RANK[a.eff_priority] || 1.5) || (b.derived_status === "doing") - (a.derived_status === "doing")],
    cost_asc: ["Cheapest", (a, b) => costOf(a) - costOf(b)],
    cost_desc: ["Most expensive", (a, b) => costOf(b) - costOf(a)],
    time_asc: ["Quickest", (a, b) => timeOf(a) - timeOf(b)],
    time_desc: ["Longest", (a, b) => timeOf(b) - timeOf(a)],
    easy: ["Easiest", (a, b) => (DIFF_RANK[a.eff_difficulty] || 2) - (DIFF_RANK[b.eff_difficulty] || 2)],
    hard: ["Hardest", (a, b) => (DIFF_RANK[b.eff_difficulty] || 2) - (DIFF_RANK[a.eff_difficulty] || 2)],
    unlocks: ["Unlocks the most", (a, b) => b.unlocks - a.unlocks],
    oldest: ["Oldest first", (a, b) => (a.created_at || "").localeCompare(b.created_at || "") || madeOrder(a, b)],
    newest: ["Newest first", (a, b) => (b.created_at || "").localeCompare(a.created_at || "") || madeOrder(b, a)],
    name: ["A–Z", (a, b) => a.title.localeCompare(b.title)],
  };
  const costOf = (i) => i.cost ?? 0;
  const timeOf = (i) => i.hours ?? 0;

  const FILTERS = {
    open: ["Open", (i) => !isDone(i)],
    ready: ["Can start now", (i) => !isDone(i) && !i.blocked],
    doing: ["Doing", (i) => i.derived_status === "doing"],
    blocked: ["Waiting", (i) => !isDone(i) && i.blocked],
    done: ["Done", (i) => isDone(i)],
    all: ["All", () => true],
  };

  // Done: the history of the house. Newest finished first, grouped by month, with this year's totals.
  function doneHTML(rows) {
    const when = (i) => i.done_at || i.updated_at || "";
    rows = [...rows].sort((a, b) => when(b).localeCompare(when(a)));
    const sum = (arr) => ({
      n: arr.length,
      cost: arr.reduce((a, i) => a + (i.cost ?? 0), 0),
      hours: arr.reduce((a, i) => a + (i.hours ?? 0), 0),
    });
    const line = (t) => [money(t.cost, { free: false }), t.hours ? hrs(t.hours, { quick: false }) : ""].filter(Boolean).join(" · ");
    const year = today().slice(0, 4);
    const thisYear = sum(rows.filter((i) => when(i).startsWith(year)));
    const all = sum(rows);
    const head = thisYear.n
      ? `<div class="done-sum"><div class="lbl">Done in ${year}</div><div class="big">${thisYear.n} project${thisYear.n === 1 ? "" : "s"}</div><div class="sub">${line(thisYear)}</div>
          ${all.n > thisYear.n ? `<div class="all">All time: ${all.n} projects · ${line(all)}</div>` : ""}</div>`
      : `<div class="done-sum"><div class="lbl">All time</div><div class="big">${all.n} project${all.n === 1 ? "" : "s"}</div><div class="sub">${line(all)}</div></div>`;
    const groups = new Map();
    for (const i of rows) {
      const k = when(i).slice(0, 7) || "unknown";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    }
    let html = head;
    for (const [k, items] of groups) {
      const d = parseDay(k + "-01");
      const name = d ? d.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "Earlier";
      const t = sum(items);
      html += `<div class="month-h"><span>${name}</span><span class="muted">${t.n} done${t.cost ? " · " + money(t.cost, { free: false }) : ""}</span></div>
        <div class="card done-list">${items.map((i) => itemRow(i, { chips: false, note: [`finished ${ago(when(i))}`, i.area ? esc(i.area) : ""].filter(Boolean).join(" · ") })).join("")}</div>`;
    }
    return html;
  }

  function renderProjects() {
    if (!S.items.length) {
      $app.innerHTML = `<div class="card empty pad"><h1>No projects yet</h1><p>Start with whatever's been bugging you the longest.</p><a class="btn primary" href="#/new">Add a project</a></div>`;
      return;
    }
    $app.innerHTML = `
      <h1>Projects</h1>
      <div class="toolbar">
        <input class="search" id="q" type="search" placeholder="Search" value="${esc(L.q)}" aria-label="Search projects">
        <select class="plain" id="sort" aria-label="Sort by">${Object.entries(SORTS).map(([k, [n]]) => `<option value="${k}" ${L.sort === k ? "selected" : ""}>${n}</option>`).join("")}</select>
      </div>
      <div class="filters" id="filters"></div>
      <div id="listOut" style="margin-top:12px"></div>`;
    const draw = () => {
      const pool = S.items;
      const q = L.q.trim().toLowerCase();
      const match = (i) => {
        if (!q) return true;
        return [i.title, i.notes, i.area].join(" ").toLowerCase().includes(q);
      };
      const searched = pool.filter(match);
      document.getElementById("filters").innerHTML = Object.entries(FILTERS).map(([k, [n, f]]) =>
        `<button data-filter="${k}" class="${L.filter === k ? "on" : ""}">${n}<span class="c">${searched.filter(f).length}</span></button>`).join("");
      const rows = searched.filter(FILTERS[L.filter][1]).sort((a, b) => SORTS[L.sort][1](a, b) || a.title.localeCompare(b.title));
      const out = document.getElementById("listOut");
      document.getElementById("sort").hidden = L.filter === "done"; // Done is always newest-finished first
      if (rows.length && L.filter === "done") out.innerHTML = doneHTML(rows);
      else if (!rows.length) {
        out.innerHTML = `<div class="card empty"><p>${q ? "Nothing matches that search." : L.filter === "done" ? "Nothing finished yet." : L.filter === "blocked" ? "Nothing is waiting on anything. Good." : "Nothing here."}</p></div>`;
      } else {
        const age = L.sort === "oldest" || L.sort === "newest";
        out.innerHTML = `<div class="card">${rows.map((i) => itemRow(i, { age })).join("")}</div>`;
      }
      store("list", L);
    };
    document.getElementById("q").addEventListener("input", (e) => { L.q = e.target.value; draw(); });
    document.getElementById("sort").addEventListener("change", (e) => { L.sort = e.target.value; draw(); });
    document.getElementById("filters").addEventListener("click", (e) => {
      const b = e.target.closest("[data-filter]"); if (!b) return; L.filter = b.dataset.filter; draw();
    });

    draw();
  }

  // =====================================================================
  // ITEM DETAIL
  // =====================================================================
  function renderItem(id) {
    const it = S.byId[id];
    if (!it) { $app.innerHTML = `<div class="card empty"><h2>Not found</h2><p>It may have been deleted.</p><a class="btn" href="#/projects">Back to projects</a></div>`; return; }
    const done = isDone(it);

    const fact = (lbl, val) => `<div><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`;
    const dash = `<span class="inh">—</span>`;
    let facts = "";
    facts += fact("Cost", money(it.cost));
    facts += fact("Time", hrs(it.hours));
    facts += fact("Priority", it.priority ? cap(it.priority) : dash);
    facts += fact("Difficulty", it.difficulty ? cap(it.difficulty) : dash);
    facts += fact("Location", it.area ? esc(it.area) : dash);
    facts += fact("Added", `${fmtDate(it.created_at)} <span class="inh">${ago(it.created_at)}</span>`);

    const cur = done ? "done" : it.status === "doing" ? "doing" : "todo";
    const actions = `<div class="seg status-seg" role="radiogroup" aria-label="Status">${[["todo", "To do"], ["doing", "Doing"], ["done", "Done"]]
      .map(([v, n]) => `<button data-status="${v}" class="${cur === v ? "on" : ""}" role="radio" aria-checked="${cur === v}">${n}</button>`).join("")}</div>`;

    // needs first / unlocks: both editable here, so links can be added any time
    const unlinkBtn = (waiter, target, what) =>
      `<button class="unlink" data-unlink="${waiter}:${target}" aria-label="Remove link to ${esc(what)}" title="Remove this link">×</button>`;
    const needs = it.depends_on.map((d) => S.byId[d]).filter(Boolean);
    const deps = `<h3>Needs first</h3><div class="card">${needs.map((d) => itemRow(d, { extra: unlinkBtn(it.id, d.id, d.title) })).join("")}
      <div class="link-add${needs.length ? "" : " alone"}" data-link="needs"><input type="search" placeholder="${needs.length ? "Add another…" : "What has to happen first?"}" aria-label="Add something this needs first"><div class="dep-results hidden"></div></div></div>`;
    const chainIds = it.chain_ids || [];
    let chain = "";
    if (!done && chainIds.length) {
      chain = `<div class="chain" style="margin-top:14px"><b>Before you can do this</b>, finish:
        <ol>${chainIds.map((c) => { const x = S.byId[c]; return `<li><a href="#/item/${c}">${esc(x.title)}</a> <span class="muted small">· ${money(x.cost)} · ${hrs(x.hours)}</span></li>`; }).join("")}</ol>
        All in: <b>${money(it.chain_cost, { free: false })}</b> and <b>${hrs(it.chain_hours, { quick: false })}</b>.</div>`;
    }
    const deps2 = dependents(it.id);
    const unlocks = `<h3>Unlocks</h3><div class="card">${deps2.map((d) => itemRow(d, { extra: unlinkBtn(d.id, it.id, d.title) })).join("")}
      <div class="link-add${deps2.length ? "" : " alone"}" data-link="unlocks"><input type="search" placeholder="${deps2.length ? "Add another…" : "Anything waiting on this?"}" aria-label="Add something that needs this"><div class="dep-results hidden"></div></div></div>`;

    $app.innerHTML = `
      <a class="crumb" href="#/projects">← Projects</a>
      <h1>${esc(it.title)}</h1>
      <div class="chips" style="margin:6px 0 10px">${chipsFor(it, { compact: true })}</div>
      <div class="row">${actions}<span class="spacer"></span><a class="btn ghost" href="#/edit/${it.id}">Edit</a></div>
      <div class="photos" id="photos">${(it.photos || []).map((pid, i) => `<span class="ph-wrap${i === 0 && it.photos.length > 1 ? " cover" : ""}"><img class="ph" src="${photoURL(pid)}" alt="" data-view="${pid}"></span>`).join("")}
        <div class="ph-add${(it.photos || []).length >= MAX_PHOTOS ? " hidden" : ""}">${photoPickers("ip")}</div></div>
      <div class="facts">${facts}</div>
      ${chain}
      ${it.notes ? `<h3>Notes</h3><div class="notes">${esc(it.notes)}</div>` : ""}
      ${deps}
      ${unlocks}
      ${it.done_at ? `<p class="muted small" style="margin-top:22px">Finished ${fmtDate(it.done_at)}.</p>` : ""}`;

    $app.querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", async () => {
      await changeStatus(it.id, b.dataset.status);
    }));
    wirePickers(document.getElementById("photos"), async (files) => {
      const n = await addPhotos(it.id, files);
      const note = capNote(addPhotos.skipped);
      if (n || note) toast((n === 1 ? "Photo added." : `${n} photos added.`) + note);
      renderItem(it.id);
    });
    $app.querySelectorAll("[data-link]").forEach((box) => linkPicker(box, it, box.dataset.link));
    $app.querySelectorAll("[data-unlink]").forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const [waiter, target] = b.dataset.unlink.split(":");
      try {
        await api(`/api/items/${waiter}/links/${target}`, { method: "DELETE" });
        toast(`“${S.byId[waiter].title}” no longer waits on “${S.byId[target].title}”`);
        renderItem(it.id);
      } catch (err) { toast(err.message, true); }
    }));
  }

  // =====================================================================
  // LINKING (dependencies, added any time)
  // =====================================================================
  // does a (directly or down the chain) already wait on b?
  const waitsOn = (a, b) => S.byId[a].depends_on.includes(b) || (S.byId[a].chain_ids || []).includes(b);
  // things that could be linked to `subject` without a loop.
  // direction "needs": subject waits on the candidate. "unlocks": the candidate waits on subject.
  // subject can be null (a brand-new item in the form); then anything open goes.
  function linkCandidates(subjectId, direction, already = []) {
    const s = subjectId ? S.byId[subjectId] : null;
    const ex = new Set(already);
    if (s) ex.add(s.id);
    return S.items.filter((x) => {
      if (ex.has(x.id) || isDone(x)) return false;
      if (!s) return true;
      if (direction === "needs") return !waitsOn(x.id, s.id) && !s.depends_on.includes(x.id);
      return !waitsOn(s.id, x.id) && !x.depends_on.includes(s.id);
    });
  }
  // Matching is by words, so "replace 2nd floor panel door" still finds "Electric panel door, 2nd floor"
  // and you don't end up with two of the same thing.
  const STOP = new Set(["the", "and", "for", "with", "new", "replace", "fix", "install", "buy", "get", "put", "add", "make"]);
  const words = (t) => t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  function matchScore(x, q) {
    const hay = x.title.toLowerCase();
    const ql = q.trim().toLowerCase();
    if (hay.includes(ql)) return 100 + (hay.startsWith(ql) ? 10 : 0);
    const ws = words(ql);
    if (!ws.length) return 0;
    const hw = words(hay);
    const has = (w) => hw.some((h) => h === w || (w.length >= 4 && h.startsWith(w)) || (h.length >= 4 && w.startsWith(h)));
    const hits = ws.filter(has).length;
    const key = ws.filter((w) => !STOP.has(w));
    const keyHits = key.filter(has).length;
    if (hits === ws.length) return 50 + hits;
    if (key.length && keyHits >= Math.max(2, Math.ceil(key.length * 0.6))) return 10 + keyHits;
    return 0;
  }
  function candidateList(cands, q) {
    const ql = q.trim();
    if (!ql) return cands.slice().sort(madeOrder).slice(0, 12);
    return cands.map((x) => [matchScore(x, ql), x]).filter(([sc]) => sc > 0)
      .sort((a, b) => b[0] - a[0] || madeOrder(a[1], b[1])).slice(0, 6).map(([, x]) => x);
  }
  // the list under a "needs first" box: matches, then "＋ Make …" for a name that isn't on the list yet
  function findOrMakeHTML(cands, q, { canMake = true } = {}) {
    const t = q.trim();
    const make = canMake && t && !S.items.some((x) => x.title.toLowerCase() === t.toLowerCase() && !isDone(x));
    return candidateList(cands, q).map((x) => `<button type="button" data-pick="${x.id}">${esc(x.title)}${x.area ? `<div class="sub">${esc(x.area)}</div>` : ""}</button>`).join("")
      + (make ? `<button type="button" class="create" data-create>＋ Make “${esc(t)}”<div class="sub">New project</div></button>` : "")
      || `<div class="pad muted small">${t ? "Nothing matches." : "Type a name to find it or make it."}</div>`;
  }

  /**
   * The find-or-type dropdown under a text box (needs first on an item's page and in the form, and Location).
   * draw() returns the list's HTML ("" hides it); onClick(e) handles a tap in the list.
   * Enter picks the first match or "Make", unless enterBlurs (then it just closes the keyboard).
   */
  function dropdown($in, $res, { draw, onClick, enterBlurs = false, onFocus = null, onInput = null }) {
    const show = () => {
      if (!$in.value.trim() && document.activeElement !== $in) { $res.classList.add("hidden"); return; }
      $res.innerHTML = draw();
      $res.classList.toggle("hidden", !$res.innerHTML);
    };
    $in.addEventListener("focus", () => { if (onFocus) onFocus(); show(); });
    $in.addEventListener("input", () => { if (onInput) onInput(); show(); });
    $in.addEventListener("blur", () => setTimeout(() => { if (!$res.contains(document.activeElement)) $res.classList.add("hidden"); }, 150));
    $in.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const first = !enterBlurs && ($res.querySelector("[data-pick]") || $res.querySelector("[data-create]"));
      if (first) first.click(); else $in.blur();
    });
    $res.addEventListener("click", onClick);
    return show;
  }

  // the search-or-create box on an item's page
  function linkPicker(box, it, direction) {
    const $in = box.querySelector("input"), $res = box.querySelector(".dep-results");
    const link = async (payload, name) => {
      try {
        const res = await api(`/api/items/${it.id}/links`, { method: "POST", body: { direction, ...payload } });
        if (res.created_id) toast(`Made “${name}”. Tap it to add cost and time.`);
        else toast(direction === "needs" ? `“${it.title}” now waits on “${name}”` : `“${name}” now waits on “${it.title}”`);
        renderItem(it.id);
        const again = $app.querySelector(`[data-link="${direction}"] input`);
        if (again) again.focus();
      } catch (err) { toast(err.message, true); }
    };
    dropdown($in, $res, {
      draw: () => findOrMakeHTML(linkCandidates(it.id, direction), $in.value),
      onClick: (e) => {
        const p = e.target.closest("[data-pick]");
        if (p) { const x = S.byId[p.dataset.pick]; link({ other_id: x.id }, x.title); return; }
        if (e.target.closest("[data-create]")) { const title = $in.value.trim(); link({ new: { title } }, title); }
      },
    });
  }

  // =====================================================================
  // FORM
  // =====================================================================
  // the More options line: what's in there, or on Edit, what's already filled in
  function moreSummary(it) {
    if (!it) return "location, needs first, notes, date added";
    const bits = [{ todo: "to do", doing: "in progress", done: "done" }[it.status] || "to do"];
    if (it.area) bits.push(esc(it.area));
    if (it.depends_on.length) bits.push(`needs ${it.depends_on.length} first`);
    if (it.notes.trim()) bits.push("notes");
    bits.push(`added ${fmtDate(it.created_at)}`);
    return bits.join(", ");
  }

  function renderForm(id) {
    const editing = id ? S.byId[id] : null;
    if (id && !editing) { location.hash = "#/projects"; return; }
    const f = editing
      ? { ...editing, depends_on: [...editing.depends_on] }
      : { title: "", notes: "", area: "", priority: null, difficulty: null, cost: null, hours: null, status: "todo", depends_on: [] };

    const seg = (name, opts, cur, cls = "") => `<div class="seg full ${cls}" data-seg="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${(cur ?? "") === v ? "on" : ""}">${l}</button>`).join("")}</div>`;

    $app.innerHTML = `
      <a class="crumb" href="${editing ? `#/item/${editing.id}` : "javascript:history.back()"}">← ${editing ? "Back" : "Cancel"}</a>
      <h1>${editing ? "Edit" : "New project"}</h1>
      <form class="form" id="form" style="margin-top:14px">
        <div class="field"><label for="f_title">Name</label><input type="text" id="f_title" required maxlength="200" autocapitalize="sentences" autocorrect="on" spellcheck="true" value="${esc(f.title)}" placeholder="e.g. Paint the stairs"></div>
        ${editing ? "" : `<div class="field"><div class="lbl">Photo <span class="muted">(optional)</span></div><div class="photos" id="newPhotos"><div class="ph-add">${photoPickers("np")}</div></div></div>`}
        <div class="two" id="costTime">
          <div class="field"><label for="f_cost">Cost</label><div class="prefix"><span>$</span><input type="tel" id="f_cost" inputmode="numeric" pattern="[0-9]*" enterkeyhint="done" autocomplete="off" maxlength="7" value="${f.cost === null || f.cost === undefined || f.cost === "" ? "" : Math.round(f.cost)}" placeholder="0 if free"></div>
            <div class="quick-chips" data-fill="f_cost"><button type="button" data-v="0">Free</button><button type="button" data-v="25">25</button><button type="button" data-v="50">50</button><button type="button" data-v="100">100</button><button type="button" data-v="250">250</button></div></div>
          <div class="field"><label for="f_time_h">Time</label>${hmHTML("f_time", f.hours, { cls: "hm boxed" })}
            <div class="quick-chips" data-fillhm="f_time"><button type="button" data-v="0.25">15m</button><button type="button" data-v="0.5">30m</button><button type="button" data-v="1">1h</button><button type="button" data-v="2">2h</button><button type="button" data-v="4">4h</button><button type="button" data-v="8">8h</button></div></div>
        </div>
        <div class="field"><div class="lbl">Priority</div>${seg("priority", [["", "—"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]], f.priority, "p")}</div>
        <div class="field"><div class="lbl">Difficulty</div>${seg("difficulty", [["", "—"], ["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]], f.difficulty)}</div>
        <details class="more" id="more"><summary>More options <span class="muted">· ${moreSummary(editing)}</span></summary>
        <div class="more-body">
        ${editing ? `<div class="field"><div class="lbl">Status</div>${seg("status", [["todo", "To do"], ["doing", "Doing"], ["done", "Done"]], f.status)}</div>` : ""}
        <div class="field"><label for="f_area">Location <span class="muted">(optional)</span></label>
          <input type="text" id="f_area" autocapitalize="words" autocorrect="on" spellcheck="true" value="${esc(f.area)}" placeholder="${S.areas.length ? "Find it or type a new one…" : "Basement, Garage, Kitchen…"}">
          <div class="dep-results hidden" id="areaResults"></div></div>
        <div class="field"><div class="lbl">Can't start until these are done</div>
          <div class="dep-picked" id="depPicked"></div>
          <input type="search" id="depSearch" placeholder="Find it or type a new one…" aria-label="Find something this depends on">
          <div class="dep-results hidden" id="depResults"></div>
          <div class="hint">Type a name that isn't on the list yet to make it on the spot. You can also add these later from the item's page.</div></div>
        <div class="field"><label for="f_notes">Notes</label><textarea id="f_notes" autocapitalize="sentences" autocorrect="on" spellcheck="true" placeholder="Measurements, model numbers, where the stuff is…">${esc(f.notes)}</textarea></div>
        <div class="field"><label for="f_added">Added</label><input type="date" id="f_added" max="${today()}" value="${editing ? (editing.created_at || "").slice(0, 10) : today()}" style="max-width:220px">
          <div class="hint">When it went on the list.</div></div>
        </div>
        </details>
        <div id="confirmBox"></div>
        <div class="form-actions"><button class="btn primary" type="submit">${editing ? "Save" : "Add project"}</button>
          ${editing ? `<button class="btn danger" type="button" id="del">Delete</button>` : ""}
          <a class="btn ghost" href="${editing ? `#/item/${editing.id}` : "#/projects"}">Cancel</a></div>
      </form>`;

    const $form = document.getElementById("form");

    $form.querySelectorAll("[data-seg]").forEach((g) => g.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      g.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      f[g.dataset.seg] = b.dataset.v || null;
      if (g.dataset.seg === "status") f.status = b.dataset.v;
    }));
    $form.querySelectorAll("[data-fill]").forEach((g) => g.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      document.getElementById(g.dataset.fill).value = b.dataset.v;
    }));
    // location: same find-or-type box as "can't start until"
    const $area = document.getElementById("f_area"), $ar = document.getElementById("areaResults");
    let areaTyped = false; // until you type, show every location, not just the one already set
    dropdown($area, $ar, {
      enterBlurs: true,
      onFocus: () => { areaTyped = false; },
      onInput: () => { areaTyped = true; },
      draw: () => {
        const q = $area.value.trim(), ql = q.toLowerCase();
        const list = S.areas.filter((a) => !areaTyped || a.toLowerCase().includes(ql));
        const exact = S.areas.some((a) => a.toLowerCase() === ql);
        return (q && !areaTyped ? `<button type="button" data-area="">None</button>` : "")
          + list.map((a) => `<button type="button" data-area="${esc(a)}">${esc(a)}</button>`).join("")
          + (q && !exact && areaTyped ? `<button type="button" class="create" data-area="${esc(q)}">+ New location “${esc(q)}”</button>` : "");
      },
      onClick: (e) => {
        const b = e.target.closest("[data-area]"); if (!b) return;
        $area.value = b.dataset.area; $ar.classList.add("hidden"); $area.blur();
      },
    });
    $form.querySelectorAll("[data-fillhm]").forEach((g) => g.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      setHM(g.dataset.fillhm, Number(b.dataset.v));
    }));
    document.getElementById("f_time_m").addEventListener("blur", () => tidyHM("f_time"));

    // dependency picker
    const $picked = document.getElementById("depPicked"), $ds = document.getElementById("depSearch"), $dr = document.getElementById("depResults");
    // new items typed here get made when you save, so Cancel leaves nothing behind
    f.newDeps = [];
    // photos picked while adding are kept here and saved with the new item
    f.newPhotos = [];
    const $np = document.getElementById("newPhotos");
    const drawNewPhotos = () => {
      $np.querySelectorAll(".staged").forEach((x) => x.remove());
      $np.insertAdjacentHTML("afterbegin", f.newPhotos.map((p, i) =>
        `<span class="staged"><img class="ph" src="data:image/jpeg;base64,${p.thumb}" alt=""><button type="button" data-unphoto="${i}" aria-label="Remove photo">×</button></span>`).join(""));
      $np.querySelector(".ph-add").classList.toggle("hidden", f.newPhotos.length >= MAX_PHOTOS);
    };
    if ($np) {
      wirePickers($np, async (files) => {
        const keep = fitPhotos(files, f.newPhotos.length);
        for (const file of keep) {
          try { f.newPhotos.push(await processPhoto(file)); } catch (err) { toast(err.message, true); }
        }
        drawNewPhotos();
        if (files.length > keep.length) toast(capNote(files.length - keep.length).trim());
      });
      $np.addEventListener("click", (e) => {
        const b = e.target.closest("[data-unphoto]");
        if (b) { f.newPhotos.splice(Number(b.dataset.unphoto), 1); drawNewPhotos(); }
      });
    }
    const drawResults = dropdown($ds, $dr, {
      draw: () => findOrMakeHTML(linkCandidates(editing ? editing.id : null, "needs", f.depends_on), $ds.value,
        { canMake: !f.newDeps.some((n) => n.title.toLowerCase() === $ds.value.trim().toLowerCase()) }),
      onClick: (e) => {
        const b = e.target.closest("[data-pick]");
        if (b) { f.depends_on.push(b.dataset.pick); $ds.value = ""; drawDeps(); $ds.focus(); return; }
        if (e.target.closest("[data-create]")) { f.newDeps.push({ title: $ds.value.trim() }); $ds.value = ""; drawDeps(); $ds.focus(); }
      },
    });
    function drawDeps() {
      $picked.innerHTML = f.depends_on.map((d) => S.byId[d]).filter(Boolean).map((d) =>
        `<span class="chip">${esc(d.title)}<button type="button" data-unpick="${d.id}" aria-label="Remove">×</button></span>`).join("")
        + f.newDeps.map((n, i) => `<span class="chip">${esc(n.title)} <span class="muted">· new</span><button type="button" data-unnew="${i}" aria-label="Remove">×</button></span>`).join("");
      drawResults();
    }
    $picked.addEventListener("click", (e) => {
      const b = e.target.closest("[data-unpick]");
      if (b) { f.depends_on = f.depends_on.filter((d) => d !== b.dataset.unpick); drawDeps(); return; }
      const n = e.target.closest("[data-unnew]");
      if (n) { f.newDeps.splice(Number(n.dataset.unnew), 1); drawDeps(); }
    });
    drawDeps();
    $dr.classList.add("hidden");

    $form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {
        title: document.getElementById("f_title").value.trim(),
        created_on: document.getElementById("f_added") ? document.getElementById("f_added").value || null : null,
        notes: document.getElementById("f_notes").value,
        area: document.getElementById("f_area").value.trim(),
        priority: f.priority || null,
        difficulty: f.difficulty || null,
        cost: wholeDollars(document.getElementById("f_cost").value),
        hours: readHM("f_time"),
        status: f.status || "todo",
        depends_on: f.depends_on,
      };
      if (!body.title) { toast("Give it a name", true); return; }
      try {
        const res = editing
          ? await api(`/api/items/${editing.id}`, { method: "PUT", body })
          : await api("/api/items", { method: "POST", body });
        if (!editing && f.newPhotos.length) {
          for (const p of f.newPhotos) {
            try { absorb(await dataStore.addPhoto(res.id, p.full, p.thumb, p.w, p.h)); }
            catch (err) { toast(`Couldn't save a photo: ${err.message}`, true); }
          }
        }
        let made = 0;
        for (const n of f.newDeps) {
          try {
            await api(`/api/items/${res.id}/links`, { method: "POST", body: { direction: "needs", new: n } });
            made++;
          } catch (err) { toast(`Couldn't add “${n.title}”: ${err.message}`, true); }
        }
        toast((editing ? "Saved" : "Added") + (made ? `, plus ${made} new thing${made === 1 ? "" : "s"} it needs first` : ""));
        location.hash = `#/item/${res.id}`;
      } catch (err) { toast(err.message, true); }
    });

    const del = document.getElementById("del");
    if (del) del.addEventListener("click", () => {
      document.getElementById("confirmBox").innerHTML = `<div class="confirm">Delete “${esc(editing.title)}”? This can't be undone.
        <span class="spacer"></span><button class="btn small danger" type="button" id="delYes" style="background:var(--danger-ink);color:#fff">Delete</button><button class="btn small" type="button" id="delNo">Keep it</button></div>`;
      document.getElementById("delNo").addEventListener("click", () => (document.getElementById("confirmBox").innerHTML = ""));
      document.getElementById("delYes").addEventListener("click", async () => {
        try { await api(`/api/items/${editing.id}`, { method: "DELETE" }); toast("Deleted"); location.hash = "#/projects"; }
        catch (err) { toast(err.message, true); }
      });
    });
    if (!editing) document.getElementById("f_title").focus();
  }

  // =====================================================================
  // SETTINGS
  // =====================================================================
  function renderSettings() {
    const open = S.items.filter((i) => !isDone(i));
    const doneN = S.items.length - open.length;
    const openCost = open.reduce((a, i) => a + (i.cost || 0), 0);
    const openHours = open.reduce((a, i) => a + (i.hours || 0), 0);
    const theme = recall("theme", "auto");
    $app.innerHTML = `
      <h1>Settings</h1>
      <div class="facts">
        <div><div class="lbl">Open</div><div class="val">${open.length} things</div></div>
        <div><div class="lbl">Done</div><div class="val">${doneN}</div></div>
        <div><div class="lbl">Cost to finish everything</div><div class="val">${money(openCost, { free: false })}</div></div>
        <div><div class="lbl">Time to finish everything</div><div class="val">${hrs(openHours, { quick: false })}</div></div>
      </div>
      <h3>Look</h3>
      <div class="card"><div class="set-row"><div class="t">Theme</div>
        <div class="seg" id="theme"><button data-v="auto" class="${theme === "auto" ? "on" : ""}">Auto</button><button data-v="light" class="${theme === "light" ? "on" : ""}">Light</button><button data-v="dark" class="${theme === "dark" ? "on" : ""}">Dark</button></div></div></div>
      <h3>Moods</h3>
      <div class="card">
        ${[["quick_hours", "quick"]].map(([k, m]) => `
        <div class="set-row"><div class="t">${esc(S.modes[m] || m)}<div class="sub" data-hint="${m}">${modeHint(m)}</div></div>
          <div class="stepper" data-key="${k}"><button type="button" data-step="-1" aria-label="Fewer hours">−</button>
            <input type="number" inputmode="decimal" min="0.5" max="24" step="0.5" value="${S.settings[k]}" aria-label="${esc(S.modes[m] || m)} hours"><span>h</span>
            <button type="button" data-step="1" aria-label="More hours">+</button></div></div>`).join("")}
        <div class="set-row"><div class="t"><div class="sub">Default is 2 hours.</div></div><button class="btn small ghost" id="resetModes">Reset</button></div>
      </div>
      <h3>Doing</h3>
      <div class="card">
        <div class="set-row"><div class="t">Doing at once<div class="sub">Past this, the Doing now line on the Plan page turns red.</div></div>
          <div class="stepper" id="doingLimit"><button type="button" data-step="-1" aria-label="Fewer">−</button>
            <input type="text" readonly value="${S.settings.doing_limit}" aria-label="Doing at once">
            <button type="button" data-step="1" aria-label="More">+</button></div></div>
      </div>
      <h3>How the planner picks</h3>
      <div class="card">
        <p class="pad" style="margin:0;padding-bottom:4px">It ranks by priority, then bumps things you've already started (finish what you started) and things that free up other work. It only suggests things you can start right now; anything waiting on something else shows up under <b>Show everything</b>. <b>Fit my time &amp; money</b> fills your limits from the top. Blank cost counts as free and blank time counts as quick.</p>
        <dl class="modes-help">${MODE_ORDER.map((m) => `<dt>${esc(S.modes[m] || m)}</dt><dd data-hint="${m}">${modeHint(m)}</dd>`).join("")}</dl>
      </div>
      <h3>Sync</h3>
      <div class="card" id="syncCard">${SYNC.on ? `
        <div class="set-row"><div class="t">Syncing with Google Drive<div class="sub">${esc(SYNC.email)} · <span id="syncStatus">${esc(syncStatusText())}</span></div></div><button class="btn" id="syncNow">Sync now</button></div>
        <div class="set-row" id="syncAgain" ${SYNC.status.state === "error" && SYNC.status.code === "auth" ? "" : "hidden"}><div class="t">Sign in again<div class="sub">Google asked to confirm it's still you.</div></div><button class="btn primary" id="syncSignIn">Sign in</button></div>
        <div class="set-row"><div class="t">Stop syncing<div class="sub">Everything stays on this ${Native.isApp ? "phone" : "computer"}. The copy in Google Drive stays too, until you delete it.</div></div><button class="btn" id="syncStop">Stop</button></div>
        <div class="set-row"><div class="t">Delete my cloud copy<div class="sub">Removes ChipAway's list and photos from your Google Drive and stops syncing. Nothing here is deleted.</div></div><button class="btn danger" id="syncDelete">Delete</button></div>`
      : `
        <div class="set-row"><div class="t">Sync with Google Drive<div class="sub">Keep your list and photos in your own Google Drive too, in a folder only ChipAway can see, and see them on a computer at gochipaway.com/app. Optional: without it everything stays on this ${Native.isApp ? "phone" : "computer"}.</div></div>
          <button class="btn primary" id="syncSignIn" ${Native.canSignIn ? "" : "disabled"}>Sign in with Google</button></div>`}
      </div>
      <h3>Your data</h3>
      <div class="card">
        <div class="set-row"><div class="t">Export to spreadsheet<div class="sub">Your whole list as a CSV file for Excel or Google Sheets.</div></div><button class="btn" id="exportCsv">Export CSV</button></div>
        <div class="set-row"><div class="t">Back up<div class="sub">Everything in one file, photos included. Save it to Google Drive or email it to yourself.</div></div><button class="btn" id="backup">Back up</button></div>
        <div class="set-row"><div class="t">Import or restore<div class="sub">A ChipAway backup file. Replaces everything here; what's here now is kept as a safety copy first.</div></div>
          <label class="btn">Choose file…<input type="file" id="restore" hidden></label></div>
      </div>
      <p class="muted small" style="margin-top:14px">${SYNC.on ? `Everything is stored on this ${Native.isApp ? "phone" : "computer"} and in your Google Drive. Nothing is sent anywhere else.` : Native.isApp ? "Everything is stored on this phone. Nothing is sent anywhere unless you back it up, share it or turn on sync." : "Everything is stored only in this browser. Clearing the browser's data erases it, so back it up or turn on sync."}</p>
      <h3>About</h3>
      <div class="card">
        <a class="set-row link-row" href="https://gochipaway.com/privacy/"><div class="t">Privacy policy</div><span class="muted">›</span></a>
        <a class="set-row link-row" href="https://gochipaway.com/"><div class="t">gochipaway.com</div><span class="muted">›</span></a>
        <a class="set-row link-row" href="mailto:gochipaway@gmail.com?subject=ChipAway"><div class="t">Send feedback<div class="sub">gochipaway@gmail.com</div></div><span class="muted">›</span></a>
      </div>
      <p class="muted small" style="margin-top:14px" id="appVersion">ChipAway</p>`;
    Native.version().then((v) => { const el = document.getElementById("appVersion"); if (el && v) el.textContent = `ChipAway ${v}`; });
    document.getElementById("theme").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      store("theme", b.dataset.v); applyTheme(); renderSettings();
    });
    let saveTimer;
    const saveLimit = (key, input) => {
      let v = Math.round(Number(input.value) * 4) / 4;
      if (!(v > 0)) return;
      v = Math.min(24, Math.max(0.25, v));
      S.settings = { ...S.settings, [key]: v };
      $app.querySelectorAll("[data-hint]").forEach((el) => (el.textContent = modeHint(el.dataset.hint)));
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try { await api("/api/settings", { method: "PUT", body: { [key]: v } }); toast("Saved"); }
        catch (err) { toast(err.message, true); }
      }, 400);
    };
    // the mood-hours boxes only; Doing at once has its own handler below
    $app.querySelectorAll(".stepper[data-key]").forEach((st) => {
      const input = st.querySelector("input");
      st.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
        const cur = Number(input.value) || 0;
        const step = cur <= 1 && Number(b.dataset.step) < 0 ? 0.25 : cur < 1 && Number(b.dataset.step) > 0 ? 0.25 : 0.5;
        input.value = Math.min(24, Math.max(0.25, cur + Number(b.dataset.step) * step));
        saveLimit(st.dataset.key, input);
      }));
      input.addEventListener("input", () => saveLimit(st.dataset.key, input));
      input.addEventListener("blur", () => { input.value = S.settings[st.dataset.key]; });
    });
    const $dl = document.getElementById("doingLimit");
    $dl.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", async () => {
      const v = Math.min(10, Math.max(1, S.settings.doing_limit + Number(b.dataset.step)));
      if (v === S.settings.doing_limit) return;
      S.settings = { ...S.settings, doing_limit: v };
      $dl.querySelector("input").value = v;
      try { await api("/api/settings", { method: "PUT", body: { doing_limit: v } }); toast("Saved"); }
      catch (err) { toast(err.message, true); }
    }));
    document.getElementById("resetModes").addEventListener("click", async () => {
      try { await api("/api/settings", { method: "DELETE" }); toast("Back to 2 hours"); renderSettings(); }
      catch (err) { toast(err.message, true); }
    });
    // ---- sync ----
    const signIn = document.getElementById("syncSignIn");
    if (signIn) signIn.addEventListener("click", async () => {
      signIn.disabled = true;
      try {
        const ok = await signInWithGoogle(() => renderSettings());
        if (ok) toast("Syncing with Google Drive.");
        else toast(syncStatusText(), true);
        renderSettings();
      } catch (e) {
        signIn.disabled = false;
        if (e.code !== "cancelled") toast(e.message, true);
      }
    });
    const syncNowBtn = document.getElementById("syncNow");
    if (syncNowBtn) syncNowBtn.addEventListener("click", async () => {
      syncNowBtn.disabled = true;
      await runSync();
      syncNowBtn.disabled = false;
      if (SYNC.status.state === "ok") toast("Synced.");
    });
    const syncStop = document.getElementById("syncStop");
    if (syncStop) syncStop.addEventListener("click", () => {
      stopSync();
      toast("Sync is off. Everything is still here.");
      renderSettings();
    });
    const syncDel = document.getElementById("syncDelete");
    if (syncDel) syncDel.addEventListener("click", async () => {
      if (syncDel.dataset.armed !== "1") { syncDel.dataset.armed = "1"; syncDel.textContent = "Tap again to delete"; return; }
      syncDel.disabled = true;
      try {
        await syncFolder().removeAll();
        stopSync();
        toast("Your cloud copy is deleted. Everything is still on this phone.");
        renderSettings();
      } catch (e) { syncDel.disabled = false; toast(e.message || "Couldn't delete it. Try again.", true); }
    });

    const stamp = () => today();
    document.getElementById("exportCsv").addEventListener("click", async () => {
      try { await Native.saveFile(`chipaway-${stamp()}.csv`, dataStore.exportCSV(), { mime: "text/csv" }); }
      catch (err) { if (!/cancel/i.test(err.message || "")) toast(err.message, true); }
    });
    document.getElementById("backup").addEventListener("click", async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = "Packing…";
      try { await Native.saveFile(`chipaway-backup-${stamp()}.json`, await dataStore.backup(), { mime: "application/json" }); }
      catch (err) { if (!/cancel/i.test(err.message || "")) toast(err.message, true); }
      finally { b.disabled = false; b.textContent = "Back up"; }
    });
    document.getElementById("restore").addEventListener("change", async (e) => {
      const file = e.target.files[0]; if (!file) return;
      e.target.value = "";
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let doc, photos = {}, what;
        if (FeasibleImport.isSqlite(bytes)) {
          const SQL = await Native.loadSqlJs();
          const r = FeasibleImport.homelabToDoc(bytes, SQL);
          doc = r.doc;
          const n = r.counts.projects + r.counts.tasks;
          what = `${n} item${n === 1 ? "" : "s"} from the old homelab version`;
        } else {
          let j;
          try { j = JSON.parse(new TextDecoder().decode(bytes)); } catch (err) { throw new Error("That isn't a ChipAway backup"); }
          if (!j || j.format !== "feasible-backup" || !j.doc) throw new Error("That isn't a ChipAway backup");
          doc = j.doc; photos = j.photos || {};
          const n = Object.values(doc.items).filter((i) => !i.deleted_at).length;
          what = `the backup from ${fmtDate(j.exported_at)} (${n} item${n === 1 ? "" : "s"}, ${Object.keys(photos).length} photo${Object.keys(photos).length === 1 ? "" : "s"})`;
        }
        const syncNote = SYNC.on ? "\n\nSync is on: anything in your Google Drive copy that isn't in this backup will come back on the next sync. To start over from the backup, stop syncing and delete your cloud copy first." : "";
        if (!confirm(`Replace everything here with ${what}?${syncNote}`)) return;
        absorb(await dataStore.restoreDoc(doc, photos));
        await dataStore.adapter.warm(Object.keys(dataStore.doc.photos));
        toast("Done. Everything's in.");
        // fresh data starts the planner fresh: Anything, everywhere
        P.mode = "all"; P.area = ""; store("plan", P);
        renderSettings();
      } catch (err) { toast(err.message, true); }
    });
  }

  function applyTheme() {
    const t = recall("theme", "auto");
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  }

  applyTheme();
  render();
  if (SYNC.on) startSync();
})();
