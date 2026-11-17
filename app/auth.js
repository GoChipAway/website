/* Signing in to ChipAway's shared lists (Supabase Auth), over its REST API.
 *
 * Two ways in, both without a password:
 *  - email: sendCode(email) emails a 6-digit code, verifyCode(email, code) signs in
 *  - Google: the phone's Google account picker (or Google's button on the web) hands over an ID token,
 *            signInWithGoogle(idToken) trades it for a ChipAway session
 * The same confirmed email address is the same person either way.
 *
 * A session is an access token (about an hour) plus a refresh token. token() hands out a current access
 * token, renewing it first when it's about to run out, so callers never deal with expiry.
 * The session is kept in `storage` (localStorage in the app) so people stay signed in.
 *
 * rpc(name, args) calls one of the database functions in supabase/schema.sql as the signed-in person.
 */
(function (root) {
  "use strict";
  const KEY = "chipaway.session";

  class AuthError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  class CloudAuth {
    /** url: project URL. key: public (publishable/anon) key. storage: { getItem, setItem, removeItem }. */
    constructor({ url, key, storage, fetchFn, onChange = () => {} }) {
      this.url = url.replace(/\/+$/, "");
      this.key = key;
      this.storage = storage;
      this.fetch = fetchFn || ((...a) => root.fetch(...a));
      this.onChange = onChange;
      this.session = null;
      this.renewing = null;
      try { this.session = JSON.parse(storage.getItem(KEY) || "null"); } catch (e) { this.session = null; }
    }

    get signedIn() { return !!(this.session && this.session.refresh_token); }
    get user() { return this.session ? this.session.user : null; }
    get email() { return (this.user && this.user.email) || ""; }
    get userId() { return (this.user && this.user.id) || null; }
    /** A name to show for this person: from Google if there is one, else the part of the email before the @. */
    get displayName() {
      const m = (this.user && this.user.user_metadata) || {};
      return m.full_name || m.name || (this.email ? this.email.split("@")[0] : "");
    }

    async post(path, body, token) {
      let res;
      try {
        res = await this.fetch(this.url + path, {
          method: "POST",
          headers: { apikey: this.key, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body || {}),
        });
      } catch (e) { throw new AuthError("offline", "Couldn't reach ChipAway's server. Check the connection."); }
      let j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (!res.ok) throw this.explain(res.status, j || {});
      return j;
    }

    explain(status, j) {
      const code = j.error_code || j.code || j.error || "";
      const msg = j.msg || j.message || j.error_description || "";
      if (status === 429 || /rate_limit/.test(code)) return new AuthError("rate", "Too many tries. Wait a few minutes and try again.");
      if (/refresh.token|session_not_found|invalid_grant/i.test(`${code} ${msg}`)) return new AuthError("auth", "Please sign in again.");
      if (/otp_expired|invalid.*(otp|token)|token.*(expired|invalid)/i.test(`${code} ${msg}`)) return new AuthError("code", "That code didn't work. Check it, or ask for a new one.");
      if (/email_address_invalid|invalid.*email/i.test(`${code} ${msg}`)) return new AuthError("email", "That doesn't look like an email address.");
      return new AuthError("server", msg || `Sign-in failed (${status})`);
    }

    keep(s) {
      if (!s || !s.access_token) throw new AuthError("server", "Sign-in failed: no session came back");
      this.session = {
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at ? s.expires_at * 1000 : Date.now() + (Number(s.expires_in) || 3600) * 1000,
        user: s.user || (this.session && this.session.user) || null,
      };
      try { this.storage.setItem(KEY, JSON.stringify(this.session)); } catch (e) { /* signed in for now, at least */ }
      this.onChange(this);
      return this.session;
    }

    /** Email a 6-digit sign-in code (makes the account the first time). */
    async sendCode(email) {
      const e = String(email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new AuthError("email", "That doesn't look like an email address.");
      await this.post("/auth/v1/otp", { email: e, create_user: true });
      return e;
    }

    async verifyCode(email, code) {
      const c = String(code || "").replace(/\s+/g, "");
      if (!/^\d{6,10}$/.test(c)) throw new AuthError("code", "The code is the 6 digits in the email.");
      const e = String(email).trim().toLowerCase();
      try {
        return this.keep(await this.post("/auth/v1/verify", { type: "email", email: e, token: c }));
      } catch (err) {
        // a first-time address gets the "confirm sign-up" email; its code is checked as type signup on some servers
        if (err.code !== "code") throw err;
        try { return this.keep(await this.post("/auth/v1/verify", { type: "signup", email: e, token: c })); }
        catch (e2) { throw err; }
      }
    }

    /** idToken: Google's ID token. nonce: the raw nonce, if one was given to Google (its hash is in the token). */
    async signInWithGoogle(idToken, nonce) {
      return this.keep(await this.post("/auth/v1/token?grant_type=id_token", { provider: "google", id_token: idToken, ...(nonce ? { nonce } : {}) }));
    }

    /**
     * Google sign-in in a browser goes to Google and comes back to the app with the session in the address
     * (#access_token=...&refresh_token=...). hash: location.hash. Returns true if it held a session.
     */
    async fromRedirect(hash) {
      const q = new URLSearchParams(String(hash || "").replace(/^#/, ""));
      if (q.get("error_description") || q.get("error")) throw new AuthError("failed", q.get("error_description") || "Google sign-in didn't finish");
      if (!q.get("access_token") || !q.get("refresh_token")) return false;
      const s = { access_token: q.get("access_token"), refresh_token: q.get("refresh_token"),
        expires_in: Number(q.get("expires_in")) || 3600, expires_at: Number(q.get("expires_at")) || undefined };
      let res;
      try { res = await this.fetch(`${this.url}/auth/v1/user`, { headers: { apikey: this.key, Authorization: `Bearer ${s.access_token}` } }); }
      catch (e) { throw new AuthError("offline", "Couldn't reach ChipAway's server. Check the connection."); }
      if (!res.ok) throw new AuthError("failed", "Google sign-in didn't finish. Try again.");
      s.user = await res.json();
      this.keep(s);
      return true;
    }

    /** Where to send a browser for Google sign-in; it comes back to `back` (see fromRedirect). */
    googleRedirectURL(back) {
      return `${this.url}/auth/v1/authorize?${new URLSearchParams({ provider: "google", redirect_to: back })}`;
    }

    /** Read rows (row-level security applies), e.g. get("members?select=user_id,name"). */
    async get(path) {
      const call = async (fresh) => this.fetch(`${this.url}/rest/v1/${path}`, {
        headers: { apikey: this.key, Authorization: `Bearer ${await this.token(fresh)}` },
      });
      let res;
      try { res = await call(false); if (res.status === 401) res = await call(true); }
      catch (e) { if (e instanceof AuthError) throw e; throw new AuthError("offline", "Couldn't reach ChipAway's server. Check the connection."); }
      if (!res.ok) throw new AuthError("server", `Couldn't load that (${res.status})`);
      return res.json();
    }

    /** A current access token. fresh: renew even if it hasn't run out (the server just said it had). */
    async token(fresh = false) {
      if (!this.signedIn) throw new AuthError("auth", "Not signed in");
      if (!fresh && this.session.expires_at > Date.now() + 60000) return this.session.access_token;
      if (!this.renewing) {
        this.renewing = this.post("/auth/v1/token?grant_type=refresh_token", { refresh_token: this.session.refresh_token })
          .then((s) => this.keep(s).access_token)
          .catch((e) => {
            // a refresh token that's been revoked or used up won't work again: sign out here.
            // No connection or a server hiccup: stay signed in and try again later.
            if (e.code === "auth") this.forget();
            throw e;
          })
          .finally(() => { this.renewing = null; });
      }
      return this.renewing;
    }

    /** Call a database function (supabase/schema.sql) as the signed-in person. */
    async rpc(name, args = {}) {
      const call = async (fresh) => this.fetch(`${this.url}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: this.key, Authorization: `Bearer ${await this.token(fresh)}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      let res;
      try { res = await call(false); if (res.status === 401) res = await call(true); }
      catch (e) { if (e instanceof AuthError) throw e; throw new AuthError("offline", "Couldn't reach ChipAway's server. Check the connection."); }
      let j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (!res.ok) {
        const m = (j && (j.message || j.msg)) || `failed (${res.status})`;
        const [code, ...rest] = m.split(": ");
        throw new AuthError(/^[a-z_]+$/.test(code) ? code : "server", rest.length ? rest.join(": ") : m);
      }
      return j;
    }

    forget() {
      this.session = null;
      try { this.storage.removeItem(KEY); } catch (e) { /* nothing kept */ }
      this.onChange(this);
    }

    /** Sign out here (and tell the server, if it can be reached). */
    async signOut() {
      const t = this.session && this.session.access_token;
      this.forget();
      if (t) { try { await this.post("/auth/v1/logout", {}, t); } catch (e) { /* signed out here anyway */ } }
    }
  }

  const api = { CloudAuth, AuthError };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FeasibleAuth = api;
})(typeof self !== "undefined" ? self : this);
