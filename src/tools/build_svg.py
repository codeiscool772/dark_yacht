#!/usr/bin/env python3
"""Rebuild the SVG copies of the site from the HTML pages in src/.

Each HTML page becomes an SVG document whose content lives in a
<foreignObject>, because the pages are ordinary HTML and SVG alone cannot
express forms, buttons or an editor.

    python tools/build_svg.py          # write svg/*.svg
    python tools/build_svg.py --check  # exit 1 if any file is out of date

Pages that hold their own scripts (the link dump and the tag console) have
the script pulled into svg/app-*.js so the SVG document stays well-formed.
"""

from __future__ import annotations

import sys
from html.parser import HTMLParser
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent
SVG_DIR = SRC.parent / "svg"

VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}

BOOLEAN_ATTRS = {
    "allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls",
    "default", "defer", "disabled", "hidden", "loop", "multiple", "muted",
    "novalidate", "open", "readonly", "required", "reversed", "selected",
}

# hrefs that point at an HTML page inside this site.
LINK_MAP = {
    "index.html": "index.svg",
    "link-dump.html": "links.svg",
    "tags-admin.html": "tags.svg",
    "ide.html": "ide.svg",
    "notes.html": "notes.svg",
    "stopwatch.html": "stopwatch.svg",
}

# Files the builder inlines. The app pages are HTML applications, so their SVG
# is a shell that frames the real page instead of duplicating it.
INLINE_PAGES = [
    ("index.html", "index.svg", "app-hub.js", "The hub page"),
    ("link-dump.html", "links.svg", "app-links.js", "The shared link list"),
    ("tags-admin.html", "tags.svg", "app-tags.js", "The tag console"),
]

APP_PAGES = [
    ("ide.html", "ide.svg", "HTML IDE"),
    ("notes.html", "notes.svg", "Notepad"),
    ("stopwatch.html", "stopwatch.svg", "Stopwatch"),
]

WRAPPER_STYLE = (
    "height:100%; overflow:auto; box-sizing:border-box; padding:20px; "
    "font-family:Arial,sans-serif; font-size:16px"
)

SCRIPT_HELPER = """/* Inside an SVG document, document.createElement() returns SVG-namespaced
   elements, so every node below is created in the XHTML namespace instead. */
const XHTML_NS = "http://www.w3.org/1999/xhtml";
function makeEl(name) { return document.createElementNS(XHTML_NS, name); }

"""


def escape_text(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def escape_attr(value: str) -> str:
    return escape_text(value).replace('"', "&quot;")


class PageParser(HTMLParser):
    """Collects the title, styles, body markup and inline scripts of a page."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.styles: list[str] = []
        self.scripts: list[str] = []
        self.body: list[str] = []
        self.open_tags: list[str] = []

        self._in_body = False
        self._in_title = False
        self._in_style = False
        self._script_parts: list[str] | None = None
        self._style_parts: list[str] | None = None

    def _attrs(self, attrs) -> str:
        rendered = []
        for name, value in attrs:
            if value is None:
                value = name if name in BOOLEAN_ATTRS else ""
            if value in LINK_MAP:
                value = LINK_MAP[value]
            rendered.append('%s="%s"' % (name, escape_attr(value)))
        return (" " + " ".join(rendered)) if rendered else ""

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()

        if tag == "title":
            self._in_title = True
            return
        if tag == "style":
            self._in_style = True
            self._style_parts = []
            return
        if tag == "script":
            src = dict(attrs).get("src")
            if src:
                return  # already an external file, nothing to inline
            self._script_parts = []
            return
        if tag == "body":
            self._in_body = True
            return
        if tag == "head":
            return

        if not self._in_body:
            return

        if tag in VOID:
            self.body.append("<%s%s/>" % (tag, self._attrs(attrs)))
            return

        self.body.append("<%s%s>" % (tag, self._attrs(attrs)))
        self.open_tags.append(tag)

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        if not self._in_body or tag in ("title", "style", "script", "head", "body"):
            return
        self.body.append("<%s%s/>" % (tag, self._attrs(attrs)))

    def handle_endtag(self, tag):
        tag = tag.lower()

        if tag == "title":
            self._in_title = False
            return
        if tag == "style":
            self._in_style = False
            if self._style_parts is not None:
                self.styles.append("".join(self._style_parts))
            self._style_parts = None
            return
        if tag == "script":
            if self._script_parts is not None:
                self.scripts.append("".join(self._script_parts))
                self._script_parts = None
            return
        if tag == "body":
            self._in_body = False
            return
        if tag in VOID or not self._in_body:
            return

        if tag not in self.open_tags:
            return

        # Close everything opened after this tag, so the output stays valid XML.
        while self.open_tags:
            current = self.open_tags.pop()
            self.body.append("</%s>" % current)
            if current == tag:
                break

    def handle_data(self, data):
        if self._in_title:
            self.title += data
            return
        if self._in_style:
            if self._style_parts is not None:
                self._style_parts.append(data)
            return
        if self._script_parts is not None:
            self._script_parts.append(data)
            return
        if self._in_body:
            self.body.append(escape_text(data))

    def handle_comment(self, data):
        if self._in_body:
            self.body.append("<!--%s-->" % data.replace("--", "- -"))

    def close(self):
        super().close()
        while self.open_tags:
            self.body.append("</%s>" % self.open_tags.pop())


def inline_svg(html_filename: str, svg_filename: str, script_name: str | None, description: str) -> tuple[str, str | None]:
    parser = PageParser()
    parser.feed((SRC / html_filename).read_text(encoding="utf-8"))
    parser.close()

    title = parser.title.strip() or html_filename

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- Generated by tools/build_svg.py from src/%s. Do not edit by hand. -->' % html_filename,
        '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style="display:block;background:#ffffff">',
        "  <title>%s</title>" % escape_text(title),
        "  <desc>%s, drawn as an SVG document.</desc>" % escape_text(description),
        "",
        '  <foreignObject x="0" y="0" width="100%" height="100%">',
        '    <div xmlns="http://www.w3.org/1999/xhtml"',
        '         style="%s">' % WRAPPER_STYLE,
        "",
    ]

    for css in parser.styles:
        parts.append("      <style>%s</style>" % escape_text(css))

    if parser.styles:
        parts.append("")

    body = "".join(parser.body).strip("\n")
    for line in body.splitlines():
        parts.append("      " + line.rstrip())

    parts.append("")
    if script_name and parser.scripts:
        parts.append('      <script src="%s"></script>' % script_name)
    parts.append("    </div>")
    parts.append("  </foreignObject>")
    parts.append("</svg>")
    parts.append("")

    script_out = None
    if script_name and parser.scripts:
        code = "\n".join(parser.scripts)
        script_out = SCRIPT_HELPER + code.replace("document.createElement(", "makeEl(").replace("\r\n", "\n").strip() + "\n"

    return "\n".join(parts), script_out


def app_svg(html_filename: str, svg_filename: str, title: str) -> str:
    return "\n".join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- Generated by tools/build_svg.py from src/%s. Do not edit by hand. -->' % html_filename,
        '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style="display:block;background:#ffffff">',
        "  <title>%s - caek</title>" % escape_text(title),
        "  <desc>%s page, drawn as an SVG document.</desc>" % escape_text(title),
        "",
        '  <foreignObject x="0" y="0" width="100%" height="100%">',
        '    <div xmlns="http://www.w3.org/1999/xhtml"',
        '         style="height:100%; display:flex; flex-direction:column; font-family:Arial,sans-serif;">',
        "",
        '      <div style="flex:none; padding:6px 12px; font-size:12px; color:#777777; border-bottom:1px solid #eeeeee;">',
        '        <a href="index.svg" style="color:#777777;">caek</a> &#183;',
        '        <a href="../src/%s" style="color:#777777;">open the plain page</a>' % html_filename,
        "      </div>",
        "",
        '      <iframe src="../src/%s" title="%s"' % (html_filename, escape_text(title)),
        '              style="flex:1 1 0; width:100%; min-height:0; border:0; background:#ffffff;"></iframe>',
        "    </div>",
        "  </foreignObject>",
        "</svg>",
        "",
    ])


def main(argv: list[str]) -> int:
    check_only = "--check" in argv[1:]
    stale = []

    targets: list[tuple[Path, str]] = []
    for html_name, svg_name, script_name, description in INLINE_PAGES:
        content, script = inline_svg(html_name, svg_name, script_name, description)
        targets.append((SVG_DIR / svg_name, content))
        if script is not None:
            targets.append((SVG_DIR / script_name, script))

    for html_name, svg_name, title in APP_PAGES:
        targets.append((SVG_DIR / svg_name, app_svg(html_name, svg_name, title)))

    for path, content in targets:
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if current == content:
            continue
        stale.append(path.name)
        if not check_only:
            path.write_text(content, encoding="utf-8")

    if check_only:
        if stale:
            print("out of date: " + ", ".join(stale))
            return 1
        print("all SVG pages are up to date")
        return 0

    if stale:
        print("updated: " + ", ".join(stale))
    else:
        print("nothing to do")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
