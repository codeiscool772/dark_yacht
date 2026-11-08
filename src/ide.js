/* HTML IDE. Ace is vendored in vendor/ace, so nothing here touches the network. */

const STORE_KEY = "y_cht_ide_code";
const LAYOUT_KEY = "y_cht_ide_layout";

const EXAMPLE = [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    "  <style>",
    "    body { font-family: Arial, sans-serif; }",
    "    h1 { color: #3333cc; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <h1>hello</h1>",
    "  <p>edit the code and it updates.</p>",
    "  <script>",
    "    console.log(\"hi from the preview\");",
    "  </script>",
    "</body>",
    "</html>"
].join("\n");

const VOID_TAGS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr"
]);

const els = {
    panes: document.getElementById("panes"),
    preview: document.getElementById("preview"),
    status: document.getElementById("status"),
    cursor: document.getElementById("cursor"),
    problems: document.getElementById("problems"),
    runBtn: document.getElementById("runBtn"),
    resetBtn: document.getElementById("resetBtn"),
    downloadBtn: document.getElementById("downloadBtn"),
    layoutCode: document.getElementById("layoutCode"),
    layoutSplit: document.getElementById("layoutSplit"),
    layoutPreview: document.getElementById("layoutPreview"),
    openTab: document.getElementById("openTab"),
    editor: document.getElementById("editor")
};

let editor = null;
let saveTimer = null;
let runTimer = null;
let checkTimer = null;
let saveState = "";
let problemCount = null;

function updateStatus() {
    const parts = [];
    if (saveState) parts.push(saveState);
    if (problemCount !== null) {
        parts.push(problemCount === 0
            ? "no problems"
            : problemCount + (problemCount === 1 ? " problem" : " problems"));
    }
    els.status.textContent = parts.join(" · ");
    els.status.className = "small-note" +
        (saveState === "saved" ? " saved" : saveState ? " dirty" : "");
}

function run() {
    if (!editor) return;
    els.preview.srcdoc = editor.getValue();
}

function save() {
    if (!editor) return;
    try {
        localStorage.setItem(STORE_KEY, editor.getValue());
        saveState = "saved";
    } catch (err) {
        saveState = "not saved";
    }
    updateStatus();
}

/* Line number for a character offset, so problems point at the right row. */
function lineIndex(source) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
        if (source[i] === "\n") starts.push(i + 1);
    }
    return (offset) => {
        let low = 0;
        let high = starts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (starts[mid] <= offset) low = mid;
            else high = mid - 1;
        }
        return low + 1;
    };
}

/* Small offline check: unbalanced tags and duplicate ids. Ace's own worker
   runs too; its annotations are merged into the same list. */
function checkHtml(source) {
    const problems = [];

    const clean = source
        .replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, " "))
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (match) => match.replace(/[^\n]/g, " "));

    const lineOf = lineIndex(clean);
    const open = [];
    const tagPattern = /<\s*(\/?)\s*([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)\s*>/g;

    let match;
    while ((match = tagPattern.exec(clean))) {
        const closing = match[1] === "/";
        const name = match[2].toLowerCase();
        const selfClosing = match[4] === "/";
        const line = lineOf(match.index);

        if (!closing) {
            if (!selfClosing && !VOID_TAGS.has(name)) open.push({ name, line });
            continue;
        }

        if (open.length === 0) {
            problems.push({ line, text: "</" + name + "> closes nothing" });
            continue;
        }

        if (open[open.length - 1].name === name) {
            open.pop();
            continue;
        }

        const index = open.map((entry) => entry.name).lastIndexOf(name);
        if (index === -1) {
            problems.push({
                line,
                text: "</" + name + "> does not match the open <" + open[open.length - 1].name + ">"
            });
            continue;
        }

        while (open.length > index + 1) {
            const unclosed = open.pop();
            problems.push({ line: unclosed.line, text: "<" + unclosed.name + "> is never closed" });
        }
        open.pop();
    }

    while (open.length > 0) {
        const unclosed = open.pop();
        problems.push({ line: unclosed.line, text: "<" + unclosed.name + "> is never closed" });
    }

    const seen = new Set();
    const idPattern = /\sid\s*=\s*("([^"]*)"|'([^']*)')/gi;
    while ((match = idPattern.exec(clean))) {
        const value = (match[2] !== undefined ? match[2] : match[3] || "").trim();
        if (!value) continue;
        if (seen.has(value)) {
            problems.push({ line: lineOf(match.index), text: "duplicate id \"" + value + "\"" });
        }
        seen.add(value);
    }

    return problems.sort((a, b) => a.line - b.line);
}

function workerProblems() {
    if (!editor) return [];
    return editor.getSession().getAnnotations().map((annotation) => ({
        line: (annotation.row || 0) + 1,
        text: annotation.text || "problem"
    }));
}

function showProblems() {
    if (!editor) return;

    const merged = [];
    const seen = new Set();
    for (const problem of checkHtml(editor.getValue()).concat(workerProblems())) {
        const key = problem.line + "|" + problem.text;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(problem);
    }

    merged.sort((a, b) => a.line - b.line);
    problemCount = merged.length;
    els.problems.replaceChildren();

    if (merged.length === 0) {
        els.problems.hidden = true;
        updateStatus();
        return;
    }

    const head = document.createElement("div");
    head.className = "head";
    head.textContent = merged.length + (merged.length === 1 ? " problem" : " problems");

    const list = document.createElement("ul");
    merged.slice(0, 10).forEach((problem) => {
        const item = document.createElement("li");
        item.textContent = "line " + problem.line + ": " + problem.text;
        item.title = "Go to line " + problem.line;
        item.addEventListener("click", () => {
            editor.gotoLine(problem.line, 0, false);
            editor.focus();
        });
        list.append(item);
    });

    els.problems.hidden = false;
    els.problems.append(head, list);
    updateStatus();
}

function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(showProblems, 250);
}

function applyLayout(mode, remember) {
    const width = mode === "code" ? "hide-preview" : mode === "preview" ? "hide-code" : "";
    els.panes.classList.toggle("hide-code", width === "hide-code");
    els.panes.classList.toggle("hide-preview", width === "hide-preview");

    els.layoutCode.classList.toggle("active", mode === "code");
    els.layoutSplit.classList.toggle("active", mode === "split");
    els.layoutPreview.classList.toggle("active", mode === "preview");

    if (remember) {
        try {
            localStorage.setItem(LAYOUT_KEY, mode);
        } catch (err) {
            /* ignore */
        }
    }

    // Ace measures its container, so it has to be told when the pane resizes.
    if (editor) setTimeout(() => editor.resize(), 0);
}

function currentLayout() {
    try {
        const saved = localStorage.getItem(LAYOUT_KEY);
        if (saved === "code" || saved === "split" || saved === "preview") return saved;
    } catch (err) {
        /* ignore */
    }
    return "split";
}

function updateCursor() {
    if (!editor) return;
    const position = editor.getCursorPosition();
    els.cursor.textContent = "Ln " + (position.row + 1) + ", Col " + (position.column + 1);
}

function init() {
    if (typeof ace === "undefined") {
        els.editor.textContent = "Editor failed to load: vendor/ace/ace.js is missing.";
        return;
    }

    let saved = null;
    try {
        saved = localStorage.getItem(STORE_KEY);
    } catch (err) {
        /* storage can be blocked - the editor still works */
    }

    editor = ace.edit("editor");
    editor.setTheme("ace/theme/github");
    editor.session.setMode("ace/mode/html");
    editor.session.setUseWorker(true);
    editor.session.setUseWrapMode(true);
    editor.setOptions({
        fontSize: "13px",
        showPrintMargin: false,
        showFoldWidgets: true,
        displayIndentGuides: true,
        tabSize: 2,
        useSoftTabs: true,
        enableBasicAutocompletion: true,
        enableLiveAutocompletion: false,
        enableSnippets: false
    });

    // Set the text before listening, so the first paint is not a "change".
    editor.setValue(saved || EXAMPLE, -1);
    editor.clearSelection();

    editor.session.on("change", () => {
        saveState = "editing";
        updateStatus();

        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 400);

        // Live preview without rebuilding the iframe on every keystroke.
        clearTimeout(runTimer);
        runTimer = setTimeout(run, 600);
        scheduleCheck();
    });

    editor.session.on("changeAnnotation", showProblems);
    editor.selection.on("changeCursor", updateCursor);

    editor.commands.addCommand({
        name: "runPreview",
        bindKey: { win: "Ctrl-Enter", mac: "Cmd-Enter" },
        exec: run
    });

    editor.commands.addCommand({
        name: "saveFile",
        bindKey: { win: "Ctrl-S", mac: "Cmd-S" },
        exec: save
    });

    window.addEventListener("resize", () => editor.resize());

    applyLayout(currentLayout(), false);
    updateCursor();
    run();
    showProblems();
}

els.runBtn.addEventListener("click", run);

els.resetBtn.addEventListener("click", () => {
    if (!editor) return;
    editor.setValue(EXAMPLE, -1);
    editor.clearSelection();
    save();
    run();
    showProblems();
});

els.downloadBtn.addEventListener("click", () => {
    if (!editor) return;
    const blob = new Blob([editor.getValue()], { type: "text/html" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "page.html";
    link.click();
    URL.revokeObjectURL(link.href);
    saveState = "downloaded";
    updateStatus();
});

els.layoutCode.addEventListener("click", () => applyLayout("code", true));
els.layoutSplit.addEventListener("click", () => applyLayout("split", true));
els.layoutPreview.addEventListener("click", () => applyLayout("preview", true));

els.openTab.addEventListener("click", (event) => {
    event.preventDefault();
    if (!editor) return;
    const blob = new Blob([editor.getValue()], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
});

init();
