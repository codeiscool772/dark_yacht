/* Inside an SVG document, document.createElement() returns SVG-namespaced
   elements, so every node below is created in the XHTML namespace instead. */
const XHTML_NS = "http://www.w3.org/1999/xhtml";
function makeEl(name) { return document.createElementNS(XHTML_NS, name); }

/* Same database as tags-admin.html. */
    const DB_CONFIG = {
        url: "https://ksksuhhxdnhxjlhheyrb.supabase.co",
        anonKey: "sb_publishable_8_2RUMyvkF6wGNg5eWQaOw_NjIPp5fz",
        pollMs: 15000,
        timeoutMs: 15000
    };

    const OTHER = "__other";
    const FALLBACK_TAG = "general";
    /* How many tags the dropdown shows before "Other...". */
    const MENU_SIZE = 12;

    const DB = {
        async request(path, options = {}) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), DB_CONFIG.timeoutMs);
            let response;
            try {
                response = await fetch(DB_CONFIG.url.replace(/\/+$/, "") + path, {
                    method: options.method || "GET",
                    headers: {
                        apikey: DB_CONFIG.anonKey,
                        Authorization: "Bearer " + DB_CONFIG.anonKey,
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

        async addLink(url, tag) {
            return this.request("/rest/v1/links", {
                method: "POST",
                body: { url: url, tag: tag },
                prefer: "return=minimal"
            });
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

            return {
                raw: rows.map((row) => JSON.stringify(row)),
                parsed: rows.map(parseEntry).filter(Boolean)
            };
        },

        async updateMetric(id, metric, delta) {
            return this.request("/rest/v1/rpc/update_link_metric", {
                method: "POST",
                body: {
                    p_id: id,
                    p_metric: metric === "report" ? "reports" : "likes",
                    p_delta: delta
                }
            });
        }
    };

    function parseEntry(row) {
        if (!row || typeof row.url !== "string") return null;
        const url = normalizeUrl(row.url);
        if (!url) return null;

        return {
            id: Number(row.id),
            url: url,
            label: row.url.trim(),
            tag: normalizeTag(row.tag) || FALLBACK_TAG,
            likes: Number(row.likes) || 0,
            reports: Number(row.reports) || 0
        };
    }

    function normalizeUrl(value) {
        const trimmed = String(value || "").trim();
        if (!trimmed) return null;

        const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : "https://" + trimmed;

        let parsed;
        try {
            parsed = new URL(candidate);
        } catch (err) {
            return null;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") return null;

        return parsed.href;
    }

    /* Lowercase and strip anything that would break the ||| separator. */
    function normalizeTag(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/\|+/g, "")
            .replace(/[^a-z0-9 _+-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 24);
    }

    /* True when the two words differ by at most one insert/delete/replace. */
    function withinOneEdit(a, b) {
        if (a === b) return true;
        if (Math.abs(a.length - b.length) > 1) return false;

        let i = 0;
        let j = 0;
        let edited = false;

        while (i < a.length && j < b.length) {
            if (a[i] === b[j]) {
                i++;
                j++;
                continue;
            }
            if (edited) return false;
            edited = true;

            if (a.length > b.length) {
                i++;
            } else if (a.length < b.length) {
                j++;
            } else {
                i++;
                j++;
            }
        }

        return true;
    }

    /* Fold a typed tag onto an existing one instead of creating a near-duplicate:
       "Games" and "game" become "games", "gamin" becomes "games" again. */
    function foldTag(candidate) {
        if (!candidate) return FALLBACK_TAG;
        if (tagCounts.has(candidate)) return candidate;

        const singular = candidate.replace(/s$/, "");
        if (singular !== candidate && tagCounts.has(singular)) return singular;

        const plural = candidate + "s";
        if (tagCounts.has(plural)) return plural;

        if (candidate.length >= 4) {
            let best = null;
            for (const tag of tagCounts.keys()) {
                if (Math.abs(tag.length - candidate.length) > 1) continue;
                if (!withinOneEdit(tag, candidate)) continue;
                if (!best || tag.length < best.length) best = tag;
            }
            if (best) return best;
        }

        return candidate;
    }

    /* Compare links without the trivia that makes duplicates look unique. */
    function dedupeKey(url) {
        try {
            const parsed = new URL(url);
            const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
            const path = parsed.pathname.replace(/\/+$/, "");
            return (host + path + parsed.search).toLowerCase();
        } catch (err) {
            return url.toLowerCase();
        }
    }

    /* Dropdown = the most used tags. Every tag in use is still reachable through
       the datalist on the custom field, so nothing is hidden. */
    function syncTagSelect() {
        const wanted = els.tag.value;
        const ranked = [...tagCounts.entries()]
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
            .map(([tag]) => tag);

        const menu = ranked.slice(0, MENU_SIZE);

        const fragment = document.createDocumentFragment();
        for (const tag of menu) {
            const option = makeEl("option");
            option.value = tag;
            option.textContent = tag;
            fragment.append(option);
        }

        const other = makeEl("option");
        other.value = OTHER;
        other.textContent = "Other...";
        fragment.append(other);

        els.tag.replaceChildren(fragment);

        const options = [...els.tag.options].map((option) => option.value);
        els.tag.value = options.includes(wanted) ? wanted : menu[0] || OTHER;
        toggleCustomTag();

        const all = [...ranked].sort((a, b) => a.localeCompare(b));
        const dataOptions = document.createDocumentFragment();
        for (const tag of all) {
            const option = makeEl("option");
            option.value = tag;
            dataOptions.append(option);
        }
        els.tagOptions.replaceChildren(dataOptions);
    }

    function toggleCustomTag() {
        const isOther = els.tag.value === OTHER;
        els.custom.hidden = !isOther;
        if (!isOther) els.custom.value = "";
    }

    const VoteTracker = {
        get(url) {
            try {
                const record = JSON.parse(localStorage.getItem("v_" + url));
                if (record && typeof record === "object") {
                    return { rating: record.rating || null, reported: Boolean(record.reported) };
                }
            } catch (err) {
                /* storage blocked or full — votes still work server-side */
            }
            return { rating: null, reported: false };
        },

        set(url, record) {
            try {
                localStorage.setItem("v_" + url, JSON.stringify(record));
            } catch (err) {
                /* ignore */
            }
        }
    };

    const els = {
        display: document.getElementById("linksDisplay"),
        url: document.getElementById("siteUrl"),
        tag: document.getElementById("siteTag"),
        custom: document.getElementById("customTag"),
        tagOptions: document.getElementById("tagOptions"),
        postBtn: document.getElementById("postBtn"),
        status: document.getElementById("postStatus"),
        sortNew: document.getElementById("sortNew"),
        sortScore: document.getElementById("sortScore")
    };

    let latestSignature = "";
    let renderToken = 0;
    let pollTimer = null;
    let pendingIds = new Set();
    let sortMode = "new";
    let currentLinks = [];
    let tagCounts = new Map();

    function setStatus(text) {
        els.status.textContent = text || "";
    }

    function buildRow(item) {
        const record = VoteTracker.get(item.url);
        const row = makeEl("div");
        row.className = "link-row";
        row.dataset.id = String(item.id);

        const anchor = makeEl("a");
        anchor.href = item.url;
        anchor.textContent = item.label || item.url;
        anchor.title = item.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";

        const tagLabel = makeEl("span");
        tagLabel.className = "tag-label";
        tagLabel.textContent = `[${item.tag}]`;

        const score = makeEl("span");
        score.className = "link-score";
        const scoreNumber = makeEl("span");
        scoreNumber.className = "score-number" + (item.likes < 0 ? " negative" : "");
        scoreNumber.textContent = item.likes;
        score.append("Score: ", scoreNumber);

        const likeBtn = makeEl("button");
        likeBtn.type = "button";
        likeBtn.className = "mini-btn" + (record.rating === "like" ? " active-like" : "");
        likeBtn.textContent = "👍";
        likeBtn.title = record.rating === "like" ? "Remove your upvote" : "Upvote";
        likeBtn.setAttribute("aria-pressed", String(record.rating === "like"));
        likeBtn.setAttribute("aria-label", "Upvote " + item.url);

        const dislikeBtn = makeEl("button");
        dislikeBtn.type = "button";
        dislikeBtn.className = "mini-btn" + (record.rating === "dislike" ? " active-dislike" : "");
        dislikeBtn.textContent = "👎";
        dislikeBtn.title = record.rating === "dislike" ? "Remove your downvote" : "Downvote";
        dislikeBtn.setAttribute("aria-pressed", String(record.rating === "dislike"));
        dislikeBtn.setAttribute("aria-label", "Downvote " + item.url);

        const reportBtn = makeEl("button");
        reportBtn.type = "button";
        reportBtn.className = "mini-btn mini-btn-report" + (record.reported ? " active-report" : "");
        reportBtn.textContent = `⚠️ Reports: ${item.reports}`;
        reportBtn.title = record.reported ? "Remove your report" : "Report this link as broken";
        reportBtn.setAttribute("aria-pressed", String(record.reported));
        reportBtn.setAttribute("aria-label", "Report " + item.url + " as broken");

        if (pendingIds.has(item.id)) {
            likeBtn.disabled = dislikeBtn.disabled = reportBtn.disabled = true;
        }

        likeBtn.addEventListener("click", () => handleAction(item, "like"));
        dislikeBtn.addEventListener("click", () => handleAction(item, "dislike"));
        reportBtn.addEventListener("click", () => handleAction(item, "report"));

        row.append(anchor, tagLabel, score, likeBtn, dislikeBtn, reportBtn);
        return row;
    }

    function sortLinks(list) {
        // The list arrives oldest-first; "top score" only reorders.
        if (sortMode !== "score") return list;
        return [...list].sort((a, b) => (b.likes - a.likes) || (b.id - a.id));
    }

    function syncSortButtons() {
        els.sortNew.classList.toggle("active-sort", sortMode === "new");
        els.sortScore.classList.toggle("active-sort", sortMode === "score");
        els.sortNew.setAttribute("aria-pressed", String(sortMode === "new"));
        els.sortScore.setAttribute("aria-pressed", String(sortMode === "score"));
    }

    function paint(links) {
        currentLinks = links;
        syncSortButtons();

        if (links.length === 0) {
            els.display.textContent = "No links yet.";
            return;
        }

        const newestFirst = [];
        // Newest rows have the largest IDs, so walk them backwards.
        for (let i = links.length - 1; i >= 0; i--) newestFirst.push(links[i]);

        const fragment = document.createDocumentFragment();
        for (const item of sortLinks(newestFirst)) fragment.append(buildRow(item));

        els.display.replaceChildren(fragment);
    }

    function recountTags(links) {
        tagCounts = new Map();
        for (const item of links) {
            tagCounts.set(item.tag, (tagCounts.get(item.tag) || 0) + 1);
        }
        if (!tagCounts.has(FALLBACK_TAG)) tagCounts.set(FALLBACK_TAG, 0);
    }

    function signatureOf(raw) {
        return raw.map(String).join("\n");
    }

    async function renderLinks(force) {
        const token = ++renderToken;
        try {
            const { raw, parsed } = await DB.getLinks();
            if (token !== renderToken) return; // a newer render already started

            recountTags(parsed);
            syncTagSelect();

            const signature = signatureOf(raw);
            if (!force && signature === latestSignature && pendingIds.size === 0) return;
            latestSignature = signature;

            paint(parsed);
        } catch (err) {
            if (token !== renderToken) return;

            latestSignature = "";
            els.display.textContent = "Data connection offline.";
            console.error("Link sync error:", err);
        }
    }

    async function handleAction(item, type) {
        if (pendingIds.has(item.id)) return;

        const record = VoteTracker.get(item.url);
        let delta = 0;

        if (type === "like") {
            if (record.rating === "like") {
                delta = -1;
                record.rating = null;
            } else {
                // Switching sides has to undo the old vote too.
                delta = record.rating === "dislike" ? 2 : 1;
                record.rating = "like";
            }
        } else if (type === "dislike") {
            if (record.rating === "dislike") {
                delta = 1;
                record.rating = null;
            } else {
                delta = record.rating === "like" ? -2 : -1;
                record.rating = "dislike";
            }
        } else {
            delta = record.reported ? -1 : 1;
            record.reported = !record.reported;
        }

        const row = els.display.querySelector(`[data-id="${item.id}"]`);
        pendingIds.add(item.id);
        toggleRow(row, true);

        try {
            await DB.updateMetric(item.id, type === "report" ? "report" : "like", delta);
            VoteTracker.set(item.url, record);
            pendingIds.delete(item.id);
            await renderLinks(true);
        } catch (err) {
            pendingIds.delete(item.id);
            toggleRow(row, false);
            alert("Sync error: " + err.message);
        }
    }

    function toggleRow(row, disabled) {
        if (!row) return;
        row.querySelectorAll("button").forEach((btn) => { btn.disabled = disabled; });
    }

    async function submitLink() {
        const rawUrl = els.url.value.trim();
        const usingOther = els.tag.value === OTHER;
        const typed = normalizeTag(usingOther ? els.custom.value : els.tag.value);

        if (!rawUrl) {
            alert("Enter a URL!");
            return;
        }
        if (usingOther && !typed) {
            alert("Type a tag name, or pick one from the list.");
            els.custom.focus();
            return;
        }

        const checked = normalizeUrl(rawUrl);
        if (!checked) {
            alert("Enter a valid URL!");
            return;
        }

        const tag = foldTag(typed);
        const folded = Boolean(typed) && tag !== typed;

        els.postBtn.disabled = true;
        els.postBtn.textContent = "Posting...";
        setStatus("");

        try {
            const existing = await DB.getLinks();
            if (existing.parsed.some((entry) => dedupeKey(entry.url) === dedupeKey(checked))) {
                setStatus("That link is already in the list.");
                return;
            }

            await DB.addLink(checked, tag);

            els.url.value = "";
            els.custom.value = "";
            toggleCustomTag();

            setStatus(folded ? "Added under the existing tag [" + tag + "]." : "Added.");

            await renderLinks(true);
        } catch (err) {
            alert("Server error: " + err.message);
        } finally {
            els.postBtn.textContent = "Submit Link";
            els.postBtn.disabled = false;
        }
    }

    function startPolling() {
        stopPolling();
        pollTimer = setInterval(() => {
            if (document.hidden) return;
            renderLinks(false);
        }, DB_CONFIG.pollMs);
    }

    function stopPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
    }

    els.postBtn.addEventListener("click", submitLink);
    els.tag.addEventListener("change", toggleCustomTag);

    els.sortNew.addEventListener("click", () => {
        sortMode = "new";
        paint(currentLinks);
    });
    els.sortScore.addEventListener("click", () => {
        sortMode = "score";
        paint(currentLinks);
    });

    for (const input of [els.url, els.custom]) {
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") submitLink();
        });
    }

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            stopPolling();
        } else {
            renderLinks(false);
            startPolling();
        }
    });

    renderLinks(true);
    startPolling();
