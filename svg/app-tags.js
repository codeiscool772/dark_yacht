/* Inside an SVG document, document.createElement() returns SVG-namespaced
   elements, so every node below is created in the XHTML namespace instead. */
const XHTML_NS = "http://www.w3.org/1999/xhtml";
function makeEl(name) { return document.createElementNS(XHTML_NS, name); }

/* Use the Supabase project URL and public anon key (never a service-role key). */
    const DB_CONFIG = {
        url: "https://ksksuhhxdnhxjlhheyrb.supabase.co",
        anonKey: "sb_publishable_8_2RUMyvkF6wGNg5eWQaOw_NjIPp5fz",
        timeoutMs: 15000
    };

    const SESSION_KEY = "y_cht_supabase_admin_session";
    const FALLBACK_TAG = "general";

    function normalizeTag(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/\|+/g, "")
            .replace(/[^a-z0-9 _+-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 24);
    }

    const DB = {
        async send(path, options = {}, accessToken = null) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), DB_CONFIG.timeoutMs);
            let response;
            try {
                response = await fetch(DB_CONFIG.url.replace(/\/+$/, "") + path, {
                    method: options.method || "GET",
                    headers: {
                        apikey: DB_CONFIG.anonKey,
                        Authorization: "Bearer " + (accessToken || DB_CONFIG.anonKey),
                        ...(options.body ? { "Content-Type": "application/json" } : {}),
                        ...(options.prefer ? { Prefer: options.prefer } : {})
                    },
                    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
                    signal: controller.signal
                });
            } catch (err) {
                throw new Error(err.name === "AbortError" ? "Supabase timed out" : "could not reach Supabase");
            } finally {
                clearTimeout(timer);
            }

            const text = await response.text();
            let data = null;
            if (text) {
                try {
                    data = JSON.parse(text);
                } catch (err) {
                    throw new Error("Supabase returned HTTP " + response.status);
                }
            }
            if (!response.ok) {
                throw new Error(data && (data.message || data.error_description || data.error) ||
                    "Supabase returned HTTP " + response.status);
            }
            return data;
        },

        saveSession(session) {
            session.expires_at = Date.now() + session.expires_in * 1000;
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
        },

        getSession() {
            const stored = sessionStorage.getItem(SESSION_KEY);
            return stored ? JSON.parse(stored) : null;
        },

        async accessToken() {
            const session = this.getSession();
            if (!session) return null;
            if (session.expires_at > Date.now() + 60000) return session.access_token;

            const refreshed = await this.send("/auth/v1/token?grant_type=refresh_token", {
                method: "POST",
                body: { refresh_token: session.refresh_token }
            });
            this.saveSession(refreshed);
            return refreshed.access_token;
        },

        async request(path, options = {}) {
            return this.send(path, options, await this.accessToken());
        },

        async login(email, password) {
            const session = await this.send("/auth/v1/token?grant_type=password", {
                method: "POST",
                body: { email: email, password: password }
            });
            this.saveSession(session);
        },

        async logout() {
            const session = this.getSession();
            try {
                if (session) {
                    await this.send("/auth/v1/logout", { method: "POST" }, session.access_token);
                }
            } finally {
                sessionStorage.removeItem(SESSION_KEY);
            }
        },

        async isAdmin() {
            return this.request("/rest/v1/rpc/is_link_admin", { method: "POST", body: {} });
        },

        async getLinks() {
            const rows = [];
            let lastId = null;
            let page;
            do {
                const after = lastId === null ? "" : "&id=gt." + lastId;
                page = await this.request(
                    "/rest/v1/links?select=id,url,tag,likes,reports&order=id.asc&limit=1000" + after
                );
                rows.push(...page);
                if (page.length) lastId = page[page.length - 1].id;
            } while (page.length === 1000);
            return rows;
        },

        async retag(from, to) {
            return this.request("/rest/v1/rpc/retag_links", {
                method: "POST",
                body: { p_from: from, p_to: to }
            });
        }
    };

    const els = {
        gate: document.getElementById("gate"),
        gateEmail: document.getElementById("gateEmail"),
        gatePassword: document.getElementById("gatePassword"),
        gateBtn: document.getElementById("gateBtn"),
        gateStatus: document.getElementById("gateStatus"),
        app: document.getElementById("app"),
        tagList: document.getElementById("tagList"),
        linkList: document.getElementById("linkList"),
        status: document.getElementById("status"),
        reloadBtn: document.getElementById("reloadBtn"),
        lockBtn: document.getElementById("lockBtn")
    };

    let state = { tags: [], links: [] };
    let busy = false;

    function setStatus(text) {
        els.status.textContent = text || "";
    }

    function tagOf(link) {
        return normalizeTag(link.tag) || FALLBACK_TAG;
    }

    async function load(keepStatus) {
        if (!keepStatus) setStatus("Loading...");

        try {
            state.links = await DB.getLinks();

            const counts = new Map();
            for (const link of state.links) {
                const tag = tagOf(link);
                if (!tag) continue;
                counts.set(tag, (counts.get(tag) || 0) + 1);
            }
            state.tags = [...counts.entries()]
                .map(([tag, count]) => ({ tag, count }))
                .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));

            render();
            if (!keepStatus) setStatus("");
        } catch (err) {
            setStatus("Could not load: " + err.message);
        }
    }

    function render() {
        els.tagList.replaceChildren();
        if (state.tags.length === 0) {
            els.tagList.textContent = "No tags yet.";
        } else {
            for (const entry of state.tags) {
                els.tagList.append(buildTagRow(entry));
            }
        }

        els.linkList.replaceChildren();
        if (state.links.length === 0) {
            els.linkList.textContent = "No links.";
        } else {
            for (let i = state.links.length - 1; i >= 0; i--) {
                els.linkList.append(buildLinkRow(state.links[i]));
            }
        }
    }

    function buildTagRow(entry) {
        const row = makeEl("div");
        row.className = "row";

        const name = makeEl("b");
        name.textContent = entry.tag;

        const count = makeEl("span");
        count.className = "small-note";
        count.textContent = entry.count + (entry.count === 1 ? " link" : " links");

        const rename = makeEl("button");
        rename.type = "button";
        rename.className = "mini-btn";
        rename.textContent = "rename";
        rename.addEventListener("click", () => renameTag(entry.tag, rename));

        const merge = makeEl("button");
        merge.type = "button";
        merge.className = "mini-btn ok-btn";
        merge.textContent = "merge";
        merge.addEventListener("click", () => mergeTag(entry.tag, merge));

        const kill = makeEl("button");
        kill.type = "button";
        kill.className = "mini-btn bad-btn";
        kill.textContent = "kill";
        kill.addEventListener("click", () => killTag(entry.tag, kill));

        row.append(name, count, rename, merge, kill);
        return row;
    }

    function buildLinkRow(link) {
        const row = makeEl("div");
        row.className = "row";

        const tag = makeEl("b");
        tag.textContent = "[" + (link.tag || "none") + "]";

        const rawUrl = (link.url || "").trim();
        const url = makeEl("a");
        if (rawUrl) {
            url.href = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : "https://" + rawUrl;
        }
        url.textContent = rawUrl || "(bad entry)";
        url.target = "_blank";
        url.rel = "noopener noreferrer";
        url.className = "small-note";

        const counts = makeEl("span");
        counts.className = "small-note";
        counts.textContent = "score " + (Number(link.likes) || 0) +
            " · reports " + (Number(link.reports) || 0);

        const remove = makeEl("button");
        remove.type = "button";
        remove.className = "mini-btn bad-btn";
        remove.textContent = "take down";
        remove.addEventListener("click", () => removeLink(link.id, remove));

        row.append(tag, url, counts, remove);
        return row;
    }

    async function applyRetag(from, to, button, message) {
        if (busy) return;
        busy = true;
        if (button) button.disabled = true;
        setStatus("Updating [" + from + "]...");

        try {
            const changed = await DB.retag(from, to);
            await load(true);
            setStatus(message.replace("{n}", changed));
        } catch (err) {
            setStatus("Could not update: " + err.message);
            if (button) button.disabled = false;
        } finally {
            busy = false;
        }
    }

    function renameTag(tag, button) {
        const typed = prompt("New name for [" + tag + "]", tag);
        if (typed === null) return;

        const next = normalizeTag(typed);
        if (!next || next === tag) return;

        applyRetag(tag, next, button, "Renamed [" + tag + "] to [" + next + "] on {n} link(s).");
    }

    function mergeTag(tag, button) {
        const typed = prompt("Merge [" + tag + "] into which tag?", "");
        if (typed === null) return;

        const target = normalizeTag(typed);
        if (!target || target === tag) return;

        applyRetag(tag, target, button, "Moved {n} link(s) from [" + tag + "] to [" + target + "].");
    }

    function killTag(tag, button) {
        if (!confirm("Kill [" + tag + "]? Its links move to [" + FALLBACK_TAG + "].")) return;
        applyRetag(tag, FALLBACK_TAG, button, "Killed [" + tag + "], {n} link(s) moved to [" + FALLBACK_TAG + "].");
    }

    async function removeLink(id, button) {
        if (busy) return;
        if (!confirm("Take this link down?")) return;

        busy = true;
        if (button) button.disabled = true;
        setStatus("Removing...");

        try {
            await DB.request(
                "/rest/v1/links?id=eq." + encodeURIComponent(id),
                { method: "DELETE", prefer: "return=minimal" }
            );
            await load(true);
            setStatus("Link removed.");
        } catch (err) {
            setStatus("Could not remove: " + err.message);
            if (button) button.disabled = false;
        } finally {
            busy = false;
        }
    }

    async function unlock(signIn) {
        els.gateBtn.disabled = true;
        els.gateStatus.textContent = "Signing in...";
        try {
            if (signIn) {
                await DB.login(els.gateEmail.value.trim(), els.gatePassword.value);
            }
            if (!(await DB.isAdmin())) {
                await DB.logout();
                throw new Error("This account is not authorized to manage links.");
            }
        } catch (err) {
            els.gateStatus.textContent = "Sign-in failed: " + err.message;
            els.gateBtn.disabled = false;
            return;
        }

        els.gate.hidden = true;
        els.app.hidden = false;
        els.gatePassword.value = "";
        load();
    }

    els.gateBtn.addEventListener("click", () => {
        unlock(true);
    });

    els.gatePassword.addEventListener("keydown", (event) => {
        if (event.key === "Enter") els.gateBtn.click();
    });

    els.reloadBtn.addEventListener("click", (event) => {
        event.preventDefault();
        load();
    });

    els.lockBtn.addEventListener("click", async (event) => {
        event.preventDefault();
        try {
            await DB.logout();
        } catch (err) {
            els.gateStatus.textContent = "Signed out locally; Supabase logout failed: " + err.message;
        }
        els.app.hidden = true;
        els.gate.hidden = false;
        els.gateEmail.focus();
        els.gateBtn.disabled = false;
    });

    if (DB.getSession()) {
        unlock(false);
    } else {
        els.gateEmail.focus();
    }
