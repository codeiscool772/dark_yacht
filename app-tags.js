/* Inside an SVG document, document.createElement() returns SVG-namespaced
   elements, so every node below is created in the XHTML namespace instead. */
const XHTML_NS = "http://www.w3.org/1999/xhtml";
function makeEl(name) { return document.createElementNS(XHTML_NS, name); }


    /* Same database as link-dump.html. Change ADMIN_KEY before sharing. */
    const DB_CONFIG = {
        url: "https://ready-turtle-126853.upstash.io",
        token: "gQAAAAAAAe-FAAIgcDIxZjk4YzY4YWI1ZmE0YTQ5YWI3MDcxYTkyYjJjZGMyYg",
        key: "y_cht_global_links",
        timeoutMs: 15000
    };

    const ADMIN_KEY = "i.love.kindles";
    const SESSION_KEY = "y_cht_admin_unlocked";
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
        async call(command) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), DB_CONFIG.timeoutMs);

            let response;
            try {
                response = await fetch(DB_CONFIG.url, {
                    method: "POST",
                    headers: {
                        Authorization: "Bearer " + DB_CONFIG.token,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(command),
                    signal: controller.signal
                });
            } catch (err) {
                throw new Error(err.name === "AbortError" ? "database timed out" : "could not reach the database");
            } finally {
                clearTimeout(timer);
            }

            const text = await response.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch (err) {
                throw new Error("database returned HTTP " + response.status);
            }
            if (!response.ok || data.error) {
                throw new Error(data.error || "database returned HTTP " + response.status);
            }
            return data.result;
        },

        /* Rewrite the tag field of every entry that carries `from`. One pass in
           Lua so a link is never half-renamed. Returns how many rows changed. */
        async retag(from, to) {
            const script = `
                local n = redis.call("LLEN", KEYS[1])
                local from = string.lower(ARGV[1])
                local to = ARGV[2]
                local changed = 0

                for i = 0, n - 1 do
                    local item = redis.call("LINDEX", KEYS[1], i)
                    if item then
                        local fields = {}
                        local startAt = 1
                        while true do
                            local first, last = string.find(item, "|||", startAt, true)
                            if not first then
                                fields[#fields + 1] = string.sub(item, startAt)
                                break
                            end
                            fields[#fields + 1] = string.sub(item, startAt, first - 1)
                            startAt = last + 1
                        end

                        if #fields >= 2 and string.lower(fields[2]) == from then
                            fields[2] = to
                            redis.call("LSET", KEYS[1], i, table.concat(fields, "|||"))
                            changed = changed + 1
                        end
                    end
                end

                return changed
            `;

            return this.call(["EVAL", script, 1, DB_CONFIG.key, from, to]);
        }
    };

    const els = {
        gate: document.getElementById("gate"),
        gateKey: document.getElementById("gateKey"),
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

    function tagOf(raw) {
        const parts = String(raw).split("|||");
        return parts.length > 1 ? normalizeTag(parts[1]) || FALLBACK_TAG : "";
    }

    async function load(keepStatus) {
        if (!keepStatus) setStatus("Loading...");

        try {
            state.links = (await DB.call(["LRANGE", DB_CONFIG.key, 0, -1])) || [];

            const counts = new Map();
            for (const raw of state.links) {
                const tag = tagOf(raw);
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

    function buildLinkRow(raw) {
        const parts = String(raw).split("|||");
        const row = makeEl("div");
        row.className = "row";

        const tag = makeEl("b");
        tag.textContent = "[" + (parts[1] || "none") + "]";

        const rawUrl = (parts[0] || "").trim();
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
        counts.textContent = "score " + (Number.parseInt(parts[2], 10) || 0) +
            " · reports " + (Number.parseInt(parts[3], 10) || 0);

        const remove = makeEl("button");
        remove.type = "button";
        remove.className = "mini-btn bad-btn";
        remove.textContent = "take down";
        remove.addEventListener("click", () => removeLink(raw, remove));

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

    async function removeLink(raw, button) {
        if (busy) return;
        if (!confirm("Take this link down?")) return;

        busy = true;
        if (button) button.disabled = true;
        setStatus("Removing...");

        try {
            // LREM by exact value: the stored entry includes its counters, so this
            // removes that one row and nothing else.
            await DB.call(["LREM", DB_CONFIG.key, 0, raw]);
            await load(true);
            setStatus("Link removed.");
        } catch (err) {
            setStatus("Could not remove: " + err.message);
            if (button) button.disabled = false;
        } finally {
            busy = false;
        }
    }

    function unlock() {
        localStorage.setItem(SESSION_KEY, "1");
        els.gate.hidden = true;
        els.app.hidden = false;
        load();
    }

    els.gateBtn.addEventListener("click", () => {
        if (els.gateKey.value === ADMIN_KEY) {
            els.gateStatus.textContent = "";
            unlock();
        } else {
            els.gateStatus.textContent = "Wrong key.";
            els.gateKey.select();
        }
    });

    els.gateKey.addEventListener("keydown", (event) => {
        if (event.key === "Enter") els.gateBtn.click();
    });

    els.reloadBtn.addEventListener("click", (event) => {
        event.preventDefault();
        load();
    });

    els.lockBtn.addEventListener("click", (event) => {
        event.preventDefault();
        localStorage.removeItem(SESSION_KEY);
        els.app.hidden = true;
        els.gate.hidden = false;
        els.gateKey.value = "";
        els.gateKey.focus();
    });

    if (localStorage.getItem(SESSION_KEY) === "1") {
        unlock();
    } else {
        els.gateKey.focus();
    }
    