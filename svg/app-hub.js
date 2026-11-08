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
