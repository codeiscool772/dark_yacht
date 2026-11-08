/* Inside an SVG document, document.createElement() returns SVG-namespaced
   elements, so every node below is created in the XHTML namespace instead. */
const XHTML_NS = "http://www.w3.org/1999/xhtml";
function makeEl(name) { return document.createElementNS(XHTML_NS, name); }

const toggleBtn = document.getElementById("theme-toggle");
// document.body is null inside an SVG document, so fall back to the root.
const themeRoot = document.body || document.documentElement;

toggleBtn.addEventListener("click", () => {
    const dark = themeRoot.classList.toggle("dark-mode");
    toggleBtn.textContent = dark ? "Light" : "Dark";
    toggleBtn.setAttribute("aria-pressed", String(dark));
});

document.querySelector(".mirror-grid").addEventListener("click", async (event) => {
    const button = event.target.closest(".mirror-copy");
    if (!button) return;

    const url = button.parentElement.querySelector(".mirror-link").href;
    const label = button.getAttribute("aria-label");
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(url);
        } else {
            const input = makeEl("textarea");
            input.value = url;
            input.setAttribute("readonly", "");
            input.style.position = "fixed";
            input.style.opacity = "0";
            document.body.appendChild(input);
            input.select();
            const copied = document.execCommand("copy");
            input.remove();
            if (!copied) throw new Error("Clipboard copy was rejected");
        }
        button.dataset.state = "copied";
        button.setAttribute("aria-label", `Copied: ${label.replace(/^Copy /, "")}`);
        button.title = button.getAttribute("aria-label");
    } catch (error) {
        console.error("Could not copy link", error);
        button.dataset.state = "failed";
        button.setAttribute("aria-label", `Copy failed: ${label.replace(/^Copy /, "")}`);
        button.title = button.getAttribute("aria-label");
    }

    window.setTimeout(() => {
        delete button.dataset.state;
        button.setAttribute("aria-label", label);
        button.title = label;
    }, 1800);
});
