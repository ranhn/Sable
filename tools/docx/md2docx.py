#!/usr/bin/env python3
"""Convert a finding report (Markdown) into a Word document.

The report is what the customer reads, so the layout follows the two reference
reports: title, meta table, numbered sections, code blocks with the real
request/response, evidence tables, and inline screenshots.

Images referenced as ![alt](/ning/api/shots/<path>) resolve against the data dir,
so a screenshot pasted into the report appears in the exact step it belongs to —
that is where the worker put the markdown link.
"""
import os
import re
import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

SHOTS_ROOT = os.environ.get("SHOTS_ROOT", "/opt/sable/data/shots")
CJK = "Microsoft YaHei"
MONO = "Consolas"


def set_cjk(run, font=CJK, size=None, bold=None, color=None):
    run.font.name = font
    run._element.rPr.rFonts.set(qn("w:eastAsia"), font)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color:
        run.font.color.rgb = RGBColor(*color)


def shade(paragraph, hex_fill="F4F5F7"):
    pPr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    pPr.append(shd)


def add_inline(paragraph, text, base_size=10.5):
    for part in re.split(r"(\*\*[^*]+\*\*|`[^`]+`)", text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            set_cjk(paragraph.add_run(part[2:-2]), size=base_size, bold=True)
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            set_cjk(paragraph.add_run(part[1:-1]), font=MONO, size=base_size - 0.5, color=(0x8B, 0x1A, 0x1A))
        else:
            set_cjk(paragraph.add_run(part), size=base_size)


def resolve_image(url):
    m = re.search(r"/api/shots/(.+)$", url.strip())
    if not m:
        return None
    path = os.path.join(SHOTS_ROOT, m.group(1))
    return path if os.path.isfile(path) else None


def add_table(doc, rows):
    cols = max(len(r) for r in rows)
    table = doc.add_table(rows=0, cols=cols)
    table.style = "Table Grid"
    # A short label column must not be squeezed to one character per line in Word:
    # pin its width and stop the auto-layout from re-balancing it.
    table.autofit = False
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, row in enumerate(rows):
        cells = table.add_row().cells
        for j in range(cols):
            text = row[j] if j < len(row) else ""
            p = cells[j].paragraphs[0]
            p.paragraph_format.space_before = Pt(1)
            p.paragraph_format.space_after = Pt(1)
            add_inline(p, text, base_size=8.5 if cols >= 5 else 9)
            if j == 0 and cols > 1:
                cells[j].width = Inches(1.55)
            if i == 0:
                for r in p.runs:
                    r.bold = True
    doc.add_paragraph()


def convert(md_path, out_path):
    lines = open(md_path, encoding="utf-8").read().split("\n")
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = CJK
    style.font.size = Pt(10.5)
    style.element.rPr.rFonts.set(qn("w:eastAsia"), CJK)

    i = 0
    in_code = False
    code_buf = []
    table_buf = []

    def flush_table():
        nonlocal table_buf
        if table_buf:
            add_table(doc, table_buf)
            table_buf = []

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("```"):
            if in_code:
                p = doc.add_paragraph()
                p.paragraph_format.space_before = Pt(3)
                p.paragraph_format.space_after = Pt(6)
                shade(p)
                set_cjk(p.add_run("\n".join(code_buf)), font=MONO, size=8.5)
                code_buf = []
                in_code = False
            else:
                flush_table()
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(line)
            i += 1
            continue

        if stripped.startswith("|") and stripped.endswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if cells and all(set(c) <= set("-: ") for c in cells):
                i += 1
                continue
            table_buf.append(cells)
            i += 1
            continue
        flush_table()

        m = re.match(r"!\[[^\]]*\]\(([^)]+)\)", stripped)
        if m:
            path = resolve_image(m.group(1))
            if path:
                doc.add_picture(path, width=Inches(6.2))
                doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
            else:
                add_inline(doc.add_paragraph(), f"[截图缺失: {m.group(1)}]", base_size=9)
            i += 1
            continue

        if not stripped:
            i += 1
            continue

        if stripped.startswith("# "):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(6)
            p.paragraph_format.space_after = Pt(8)
            add_inline(p, stripped[2:], base_size=16)
            for r in p.runs:
                r.bold = True
            i += 1
            continue
        if stripped.startswith("## "):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(12)
            p.paragraph_format.space_after = Pt(4)
            add_inline(p, stripped[3:], base_size=13)
            for r in p.runs:
                r.bold = True
            i += 1
            continue
        if stripped.startswith("### "):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(8)
            p.paragraph_format.space_after = Pt(3)
            add_inline(p, stripped[4:], base_size=11.5)
            for r in p.runs:
                r.bold = True
            i += 1
            continue
        if stripped == "---":
            p = doc.add_paragraph()
            pPr = p._p.get_or_add_pPr()
            pbdr = OxmlElement("w:pBdr")
            bottom = OxmlElement("w:bottom")
            bottom.set(qn("w:val"), "single")
            bottom.set(qn("w:sz"), "6")
            bottom.set(qn("w:color"), "DDDDDD")
            pbdr.append(bottom)
            pPr.append(pbdr)
            i += 1
            continue

        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(4)
        m = re.match(r"^(\d+)\.\s+(.*)$", stripped)
        if m:
            add_inline(p, f"{m.group(1)}. {m.group(2)}")
        elif stripped.startswith(("- ", "* ")):
            add_inline(p, "• " + stripped[2:])
        else:
            add_inline(p, stripped)
        i += 1

    flush_table()
    doc.save(out_path)
    return out_path


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: md2docx.py <in.md> <out.docx>")
        sys.exit(2)
    convert(sys.argv[1], sys.argv[2])
    print(f"ok: {sys.argv[2]} ({os.path.getsize(sys.argv[2])} bytes)")
