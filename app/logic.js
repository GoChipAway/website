/* Project math: rollups, dependencies, and the planner.
 *
 * A straight port of the homelab version's logic.py. Same rules, same answers.
 *
 * Vocabulary
 * - An item is one thing to do. Items used to have steps (sub-tasks); those went away in Build 3
 *   and older data is flattened on load (store.js flattenSteps), so every item stands on its own.
 * - A dependency ("needs first") says "this can't start until that is done".
 *
 * IDs are strings (permanent unique IDs, so lists can be shared between devices later).
 * Ordering ties are broken by `seq`, a counter in the order items were made, then by id. Each device
 * keeps its own counter, so two devices can hand out the same seq; the id keeps the order the same everywhere.
 */
(function (root) {
  "use strict";

  const PRIORITY_WEIGHT = { high: 3.0, medium: 2.0, low: 1.0 };
  const pw = (p) => (p in PRIORITY_WEIGHT ? PRIORITY_WEIGHT[p] : 1.5);
  const DIFF_RANK = { easy: 1, medium: 2, hard: 3 };

  // Hour limits per task for the moods that have one. Changeable in Settings.
  const LIMIT_DEFAULTS = { quick_hours: 2.0 };

  const MODES = {
    all: "Anything",
    quick: "Quick wins",
    forgotten: "Forgotten",
    broke: "Broke",
    payday: "Payday",
    challenge: "Challenge",
  };

  // ---------- small set helpers ----------
  const union = (a, b) => { const o = new Set(a); for (const x of b) o.add(x); return o; };
  const minus = (a, b) => { const o = new Set(); for (const x of a) if (!b.has(x)) o.add(x); return o; };
  const intersects = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
  const isSubset = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true; };
  const sum = (ids, f) => { let s = 0; for (const x of ids) s += f(x); return s; };

  // compare tuples like Python does
  function cmpTuple(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  class State {
    constructor(items, deps) {
      this.items = items; // id -> item
      this.deps = deps; // id -> Set(ids it depends on)
      this.status = {}; // status, by id
      this.required = new Map(); // open item -> Set(open items needed first, all the way down)
      this.waiting_on = {}; // id -> [unmet direct deps]
      this.order = Object.keys(items).sort((a, b) => items[a].seq - items[b].seq || (a < b ? -1 : a > b ? 1 : 0));
      this.rank = {};
      this.order.forEach((id, n) => { this.rank[id] = n; });
    }
    /** Position in creation order: seq, then id. Unique, and the same on every device. */
    seq(i) { return this.rank[i]; }
    bySeq(list) { return [...list].sort((a, b) => this.seq(a) - this.seq(b)); }
    isOpen(i) { return this.items[i].status !== "done"; }
    effPriority(i) { return this.items[i].priority || null; }
    effDifficulty(i) { return this.items[i].difficulty || null; }
    hours(i) { return Number(this.items[i].hours || 0); }
    cost(i) { return Number(this.items[i].cost || 0); }
    req(i) { return this.required.get(i) || new Set(); }
  }

  function buildState(items, deps) {
    const byId = {};
    for (const it of items) byId[it.id] = { ...it };
    const dmap = {};
    for (const [a, b] of deps) {
      if (byId[a] && byId[b]) (dmap[a] = dmap[a] || new Set()).add(b);
    }
    const st = new State(byId, dmap);
    for (const i of st.order) st.status[i] = byId[i].status;
    for (const i of st.order) {
      st.waiting_on[i] = st.bySeq([...(dmap[i] || [])].filter((d) => st.status[d] !== "done"));
    }

    // required: open items that must be done before each open item (transitive)
    const visiting = new Set();
    function req(i) {
      if (st.required.has(i)) return st.required.get(i);
      if (visiting.has(i)) return new Set(); // cycle guard; cycles are refused on save but be safe
      visiting.add(i);
      let out = new Set();
      for (const d of st.waiting_on[i]) {
        if (d === i || !st.isOpen(d)) continue;
        out.add(d);
        out = union(out, req(d));
      }
      out.delete(i);
      visiting.delete(i);
      st.required.set(i, out);
      return out;
    }
    for (const i of st.order) if (st.isOpen(i)) req(i);
    return st;
  }

  /** Return an offending dep id if saving these deps would create a loop, else null. */
  function wouldCycle(st, itemId, newDeps) {
    for (const d of newDeps) {
      if (d === itemId) return d;
      const seen = new Set();
      const stack = [d];
      while (stack.length) {
        const x = stack.pop();
        if (seen.has(x)) continue;
        seen.add(x);
        if (x === itemId) return d;
        for (const n of st.deps[x] || []) stack.push(n);
      }
    }
    return null;
  }

  /** Order items so prerequisites come first; ties in the order they were made. */
  function orderLeaves(st, leaves) {
    const remaining = new Set(leaves);
    const out = [];
    while (remaining.size) {
      let ready = [...remaining].filter((i) => !intersects(st.req(i), remaining));
      if (!ready.length) ready = [...remaining]; // shouldn't happen, but never loop forever
      ready.sort((a, b) => st.seq(a) - st.seq(b));
      out.push(ready[0]);
      remaining.delete(ready[0]);
    }
    return out;
  }

  function unlockCount(st) {
    const counts = {};
    for (const r of st.required.values()) for (const x of r) counts[x] = (counts[x] || 0) + 1;
    return counts;
  }

  /** Every item plus computed fields the UI needs. */
  function itemView(st) {
    const unlocks = unlockCount(st);
    return st.order.map((i) => {
      const it = st.items[i];
      const req = st.req(i);
      const open = st.isOpen(i);
      return {
        ...it,
        derived_status: st.status[i],
        depends_on: st.bySeq(st.deps[i] || []),
        waiting_on: st.waiting_on[i],
        eff_priority: st.effPriority(i),
        eff_difficulty: st.effDifficulty(i),
        blocked: st.waiting_on[i].length > 0 && open,
        unlocks: unlocks[i] || 0,
        chain_ids: open ? orderLeaves(st, req) : [],
        chain_cost: sum(req, (x) => st.cost(x)) + st.cost(i),
        chain_hours: sum(req, (x) => st.hours(x)) + st.hours(i),
        remaining_cost: open ? st.cost(i) : 0,
        remaining_hours: open ? st.hours(i) : 0,
      };
    });
  }

  // ---------------- planner ----------------

  function leafScore(st, i, unlocks, mode) {
    let s = pw(st.effPriority(i));
    const it = st.items[i];
    if (it.status === "doing") s += 1.0; // finish what you started
    s += Math.min((unlocks[i] || 0) * 0.4, 1.2); // doing this frees up other work
    if (it.hours !== null && it.hours !== undefined && st.hours(i) <= 1) s += 0.25;
    if (mode === "payday") s += Math.min(st.cost(i) / 100.0, 2.0);
    if (mode === "challenge" && st.effDifficulty(i) === "hard") s += 1.0;
    return s;
  }

  /** How long it's been on the list, in days. */
  function ageDays(st, i, now) {
    const t = Date.parse(st.items[i].created_at || "");
    if (Number.isNaN(t)) return 0;
    return Math.max(0, ((now || Date.now()) - t) / 86400000);
  }

  function leafPasses(st, i, mode, lim) {
    lim = { ...LIMIT_DEFAULTS, ...(lim || {}) };
    const h = st.hours(i), c = st.cost(i), d = st.effDifficulty(i);
    // quick wins: easy jobs, a couple of hours at most (no difficulty set counts as easy)
    if (mode === "quick") return (d === null || d === "easy") && h <= lim.quick_hours;
    if (mode === "broke") return c === 0;
    return true;
  }

  // small seeded random number generator, so "Something else" is repeatable for a given seed
  function rngFor(seed) {
    let a = seed >>> 0;
    return {
      uniform(lo, hi) {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        return lo + (hi - lo) * r;
      },
    };
  }

  function plan(st, { hours = null, budget = null, mode = "all", shuffle = 0, area = null, limits = null, now = null, avoid = null } = {}) {
    avoid = avoid && avoid.length ? new Set(avoid) : null;
    mode = mode in MODES ? mode : "all";
    const unlocks = unlockCount(st);
    const rng = shuffle ? rngFor(shuffle) : null;
    const openLeaves = st.order.filter((i) => st.isOpen(i));
    const areaOk = (i) => !area || (st.items[i].area || "").trim().toLowerCase() === area.trim().toLowerCase();

    // only what you can start right now, each on its own. Blocked ones are listed separately so they stay visible.
    let units = [];
    const waiting = [];
    for (const i of openLeaves) {
      if (!areaOk(i)) continue;
      if (st.waiting_on[i].length) { waiting.push(i); continue; }
      units.push({ target: i, leaves: new Set([i]), own: new Set([i]) });
    }

    // mood filters
    const unitOk = (u) => {
      if (mode === "challenge") return [...u.own].some((x) => st.effDifficulty(x) === "hard");
      if (mode === "payday") return [...u.leaves].some((x) => st.cost(x) > 0);
      return [...u.leaves].every((x) => leafPasses(st, x, mode, limits));
    };
    units = units.filter(unitOk);

    for (const u of units) {
      let base;
      if (mode === "forgotten") {
        // oldest on the list first; "Something else" shakes it up a little
        base = ageDays(st, u.target, now);
        if (rng) base *= rng.uniform(0.75, 1.25);
      } else {
        base = Math.max(...[...u.own].map((x) => leafScore(st, x, unlocks, mode)));
        // a long chain of prep work is a bigger commitment; nudge it down a little
        base -= 0.15 * minus(u.leaves, u.own).size;
        if (rng) base += rng.uniform(-0.9, 0.9);
      }
      // "Something else": what you were just shown goes to the back, so the next set is really different
      if (avoid && avoid.has(u.target)) base -= 100;
      u.score = base;
      u.cost = sum(u.leaves, (x) => st.cost(x));
      u.hours = sum(u.leaves, (x) => st.hours(x));
    }
    units.sort((a, b) => cmpTuple([-a.score, a.hours, a.cost, st.seq(a.target)], [-b.score, b.hours, b.cost, st.seq(b.target)]));

    const fits = (c, h, usedC, usedH) => {
      if (budget !== null && usedC + c > budget + 1e-9) return false;
      if (hours !== null && usedH + h > hours + 1e-9) return false;
      return true;
    };

    const picked = [];
    let included = new Set();
    let usedC = 0, usedH = 0;
    const unlimited = hours === null && budget === null;
    for (const u of units) {
      const nw = unlimited ? new Set(u.leaves) : minus(u.leaves, included);
      if (!nw.size) continue;
      const c = sum(nw, (x) => st.cost(x));
      const h = sum(nw, (x) => st.hours(x));
      if (!unlimited && !fits(c, h, usedC, usedH)) continue;
      picked.push({ target: u.target, steps: orderLeaves(st, nw), cost: c, hours: h, prep: minus(nw, u.own).size });
      const fresh = minus(nw, included);
      included = union(included, nw);
      usedC += sum(fresh, (x) => st.cost(x));
      usedH += sum(fresh, (x) => st.hours(x));
    }

    // things that would fit on their own but didn't make the combined plan
    const also = [];
    const pickedTargets = new Set(picked.map((p) => p.target));
    for (const u of units) {
      if (pickedTargets.has(u.target) || isSubset(u.own, included)) continue;
      if (unlimited || fits(u.cost, u.hours, 0, 0)) {
        also.push({ target: u.target, steps: orderLeaves(st, u.leaves), cost: u.cost, hours: u.hours, prep: minus(u.leaves, u.own).size });
      }
      if (also.length >= 8) break;
    }

    // the closest misses: just over the limit
    let near = [];
    if (!unlimited) {
      for (const u of units) {
        if (pickedTargets.has(u.target) || fits(u.cost, u.hours, 0, 0)) continue;
        const overH = hours !== null ? Math.max(0, u.hours - hours) : 0;
        const overC = budget !== null ? Math.max(0, u.cost - budget) : 0;
        near.push([overH / Math.max(hours || 1, 1) + overC / Math.max(budget || 1, 1), u, overH, overC]);
      }
      near.sort((a, b) => a[0] - b[0]); // stable, like Python's sort
      near = near.slice(0, 3).map(([, u, oh, oc]) => ({ target: u.target, cost: u.cost, hours: u.hours, over_hours: oh, over_cost: oc }));
    }

    const waitKey = (i) => -(mode === "forgotten" ? ageDays(st, i, now) : leafScore(st, i, unlocks, mode));
    return {
      mode, view: "tasks", hours, budget,
      plan: picked,
      used_hours: usedH,
      used_cost: usedC,
      also, near,
      candidates: units.length,
      open_total: openLeaves.length,
      // blocked items, best first, with the open work each one is waiting for
      waiting: [...waiting]
        .sort((a, b) => cmpTuple([waitKey(a), st.seq(a)], [waitKey(b), st.seq(b)]))
        .map((i) => ({ target: i, after: orderLeaves(st, st.req(i)), cost: st.cost(i), hours: st.hours(i) })),
    };
  }

  const api = { PRIORITY_WEIGHT, DIFF_RANK, LIMIT_DEFAULTS, MODES, buildState, wouldCycle, orderLeaves, unlockCount, itemView, leafScore, ageDays, leafPasses, plan };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FeasibleLogic = api;
})(typeof self !== "undefined" ? self : this);
