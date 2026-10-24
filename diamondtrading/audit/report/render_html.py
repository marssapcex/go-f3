#!/usr/bin/env python3
"""Render audit/report/WHITEPAPER.md into a single self-contained, styled HTML file.

Needs: pip install markdown pygments   (run in any venv; output is plain HTML, no network needed)
Usage:  python3 audit/report/render_html.py
Output: audit/report/WHITEPAPER.html  (open in a browser; no external assets)
"""
import pathlib
import re

import markdown
from pygments.formatters import HtmlFormatter

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "WHITEPAPER.md"
OUT = HERE / "WHITEPAPER.html"

SEV = {"Critical": "crit", "High": "high", "Medium": "med", "Low": "low"}

CSS = """
:root { --ink:#1f2328; --muted:#59636e; --line:#d1d9e0; --soft:#f6f8fa; --accent:#0969da;
        --crit:#8e1519; --high:#cf222e; --med:#bf8700; --low:#1a7f37; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin:0; font: 16px/1.65 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
       color:var(--ink); background:#fff; }
.layout { display:grid; grid-template-columns: 290px minmax(0, 1fr); min-height:100vh; }
nav.toc { position:sticky; top:0; align-self:start; height:100vh; overflow:auto; padding:28px 20px;
          background:var(--soft); border-right:1px solid var(--line); font-size:14px; }
nav.toc .brand { font-weight:700; font-size:15px; margin-bottom:4px; }
nav.toc .sub { color:var(--muted); font-size:12px; margin-bottom:18px; }
nav.toc ul { list-style:none; padding:0; margin:0; }
nav.toc li { margin:3px 0; }
nav.toc li ul { padding-left:12px; border-left:2px solid var(--line); margin:4px 0 8px 4px; }
nav.toc a { color:var(--ink); text-decoration:none; display:block; padding:3px 6px; border-radius:6px; }
nav.toc a:hover { background:#eaeef2; color:var(--accent); }
main { padding:48px min(6vw,72px) 96px; max-width:980px; }
h1 { font-size:34px; line-height:1.2; margin:0 0 8px; letter-spacing:-0.5px; }
h2 { font-size:26px; margin:56px 0 14px; padding-bottom:8px; border-bottom:1px solid var(--line); }
h3 { font-size:20px; margin:40px 0 10px; color:#0b3d7a; }
h4 { font-size:16px; margin:26px 0 8px; text-transform:none; color:var(--ink); }
p, li { margin:8px 0; }
a { color:var(--accent); }
hr { border:none; border-top:1px solid var(--line); margin:36px 0; }
blockquote { margin:18px 0; padding:12px 18px; background:#fff8e6; border-left:4px solid var(--med);
             color:#4a3a00; border-radius:0 8px 8px 0; }
blockquote p { margin:4px 0; }
code { font: 13.5px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#eef1f4;
       padding:1px 5px; border-radius:5px; }
pre { background:#f6f8fa; border:1px solid var(--line); border-radius:10px; padding:14px 16px;
      overflow:auto; font-size:13px; line-height:1.5; margin:12px 0 18px; }
pre code { background:none; padding:0; font-size:inherit; }
table { border-collapse:separate; border-spacing:0; width:100%; margin:14px 0 22px; font-size:14px;
        border:1px solid var(--line); border-radius:10px; overflow:hidden; }
th { background:#eef3f8; text-align:left; font-weight:600; padding:9px 12px; border-bottom:1px solid var(--line); }
td { padding:9px 12px; border-bottom:1px solid #eaeef2; vertical-align:top; }
tr:last-child td { border-bottom:none; }
tbody tr:nth-child(even) td { background:#fbfcfd; }
td code, th code { font-size:12.5px; }
.sev { display:inline-block; font-size:12px; font-weight:700; padding:2px 9px; border-radius:999px;
       color:#fff; letter-spacing:.2px; white-space:nowrap; }
.sev-crit { background:var(--crit); } .sev-high { background:var(--high); }
.sev-med { background:var(--med); } .sev-low { background:var(--low); }
.cover { border:1px solid var(--line); border-radius:14px; padding:26px 28px; margin:22px 0 10px;
         background:linear-gradient(180deg,#f8fbff,#ffffff); }
.hl-note { color:var(--muted); font-size:14px; }
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  nav.toc { position:static; height:auto; border-right:none; border-bottom:1px solid var(--line); }
  main { padding:28px 20px 60px; }
}
@media print {
  nav.toc { display:none; } .layout { display:block; } main { max-width:none; padding:0; }
  h2 { break-before: page; } pre, table { break-inside: avoid; }
}
""" + HtmlFormatter(style="default").get_style_defs(".codehilite")


def build_toc(html):
    """Build a two-level nav from the h2/h3 headings the markdown toc extension created."""
    items = re.findall(r'<h([23]) id="([^"]+)">(.*?)</h\1>', html, flags=re.S)
    out, open_sub = [], False
    for level, anchor, title in items:
        title = re.sub(r"<[^>]+>", "", title).strip()
        if level == "2":
            if open_sub:
                out.append("</ul></li>")
                open_sub = False
            out.append(f'<li><a href="#{anchor}">{title}</a>')
            out.append("<ul>")
            open_sub = True
        else:
            out.append(f'<li><a href="#{anchor}">{title}</a></li>')
    if open_sub:
        out.append("</ul></li>")
    return "<ul>" + "".join(out) + "</ul>"


def badge_severity(html):
    """Colour the severity word that starts a table cell (e.g. '<td>High (phụ thuộc owner)')."""
    def repl(m):
        word = m.group(2)
        return f'{m.group(1)}<span class="sev sev-{SEV[word]}">{word}</span>{m.group(3)}'
    return re.sub(r"(<td[^>]*>)(Critical|High|Medium|Low)(\b[^<]*)", repl, html)


def main():
    text = SRC.read_text(encoding="utf-8")
    md = markdown.Markdown(extensions=["toc", "tables", "fenced_code", "codehilite", "sane_lists"],
                           extension_configs={"codehilite": {"guess_lang": False, "css_class": "codehilite"},
                                              "toc": {"permalink": False}})
    body = md.convert(text)
    toc = build_toc(body)
    body = badge_severity(body)
    title = "WHITEPAPER — Audit bảo mật diamondtrading (go-f3)"
    html = f"""<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{CSS}</style></head>
<body>
<div class="layout">
<nav class="toc">
  <div class="brand">Audit · diamondtrading</div>
  <div class="sub">go-f3 · commit gốc 3cb964b · 2026-10-24</div>
  {toc}
</nav>
<main>
{body}
</main>
</div>
</body></html>
"""
    OUT.write_text(html, encoding="utf-8")
    print(f"[render] wrote {OUT.name} ({len(html)//1024} KB)")


if __name__ == "__main__":
    main()
