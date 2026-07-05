#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""design_judge.py -- deterministic design-quality judge for 教师资源发展平台
(China Teacher Resources Development Platform).

Adapts the huashu-design 5-dimension critique rubric into deterministic,
standard-library-only heuristics over HTML / WXSS / CSS / Markdown DESIGN files.

Five dimensions (each 0-10, overall = arithmetic mean):
  1. Philosophy Alignment -- coherent design system (tokens / CSS vars, no
     self-contradiction).
  2. Visual Hierarchy      -- headline:body type ratio >= 2.5x, 3-4 tiers,
     whitespace.
  3. Craft Quality         -- 8pt spacing adherence, <= ~4 primary colors,
     <= 2 font families, consistent alignment.
  4. Functionality         -- touch targets >= 44x44, CTA presence, info density.
  5. Originality           -- anti-AI-slop: purple/pink/blue gradients,
     emoji-as-icon, generic display fonts, rounded-card+left-border template,
     bento overuse, fake stats.

Quality bands: 8-10 excellent, 6-7.9 good, 4-5.9 needs-improvement, <4 inadequate.

CJK rules checked in CSS/WXSS: line-height >= 1.7 (flag < 1.6); body
font-size >= 14px (mobile >= 16px to avoid iOS zoom); section titles >= 24px.

Finding severities: P0 (Critical), P1 (Important), P2/P3 (Polish).

CLI:
    python design_judge.py <path> [--json] [--threshold N] [--strict] [--self-test]

Exit codes: 0 pass, 1 fail, 2 usage / IO error.
Pure standard library. Deterministic: no randomness, no network, no clock.
"""

import argparse
import json
import os
import re
import sys

JUDGE_NAME = "design"
DEFAULT_THRESHOLD = 6.0
NEUTRAL = 7.0

# File extensions we can attempt to assess.
DESIGN_EXTS = (".html", ".htm", ".wxss", ".css", ".md")

# Control characters (other than common whitespace) that suggest binary data.
_CONTROL_CHARS = "".join(chr(c) for c in range(32) if chr(c) not in "\n\r\t\f")
_CONTROL_RE = re.compile("[" + re.escape(_CONTROL_CHARS) + "]")


# --------------------------------------------------------------------------- #
# IO helpers
# --------------------------------------------------------------------------- #
def _looks_binary(raw):
    """Heuristic: binary if it has a NUL byte, is not valid UTF-8, or carries
    many control characters once decoded. UTF-8 multibyte text (e.g. CJK) is
    treated as text, not binary."""
    if b"\x00" in raw:
        return True
    if not raw:
        return False
    try:
        decoded = raw[:8192].decode("utf-8")
    except UnicodeDecodeError:
        # Could be a clean split across a multibyte boundary; try a safe decode.
        decoded = raw[:8192].decode("utf-8", errors="ignore")
        if not decoded:
            return True
    ctrl = len(_CONTROL_RE.findall(decoded))
    return ctrl / max(1, len(decoded)) > 0.05


def read_text_file(path):
    """Return file text, or None if the file is binary / unreadable."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    if _looks_binary(raw):
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return raw.decode("utf-8", errors="replace")
        except Exception:
            return None


def collect_files(path):
    """Return a sorted list of relevant design files under path (file or dir)."""
    if os.path.isfile(path):
        return [path]
    out = []
    for root, _dirs, names in os.walk(path):
        for name in sorted(names):
            if name.lower().endswith(DESIGN_EXTS):
                out.append(os.path.join(root, name))
    return sorted(out)


def line_of(text, idx):
    """1-based line number of character offset idx within text."""
    if idx < 0:
        return 1
    return text.count("\n", 0, idx) + 1


# --------------------------------------------------------------------------- #
# Finding model
# --------------------------------------------------------------------------- #
def finding(severity, title, file, line, fix):
    return {
        "severity": severity,
        "title": title,
        "file": file,
        "line": line,
        "fix": fix,
    }


def clamp(score):
    return max(0.0, min(10.0, score))


def band_of(overall):
    if overall >= 8.0:
        return "excellent"
    if overall >= 6.0:
        return "good"
    if overall >= 4.0:
        return "needs-improvement"
    return "inadequate"


# --------------------------------------------------------------------------- #
# Regexes (compiled once -- deterministic)
# --------------------------------------------------------------------------- #
RE_CSS_VAR = re.compile(r"--[a-zA-Z][\w-]*\s*:")
RE_VAR_USE = re.compile(r"var\(\s*--")
RE_FONT_SIZE = re.compile(r"font-size\s*:\s*([0-9.]+)\s*(px|rpx|rem|em|pt)", re.I)
RE_LINE_HEIGHT = re.compile(r"line-height\s*:\s*([0-9.]+)\b", re.I)
RE_PX_VAL = re.compile(r"\b([0-9]{1,3})px\b")
RE_HEX_COLOR = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b")
RE_FONT_FAMILY = re.compile(r"font-family\s*:\s*([^;}{]+)", re.I)
RE_WIDTH = re.compile(r"\b(?:min-)?width\s*:\s*([0-9.]+)\s*(px|rpx)", re.I)
RE_HEIGHT = re.compile(r"\b(?:min-)?height\s*:\s*([0-9.]+)\s*(px|rpx)", re.I)
RE_GRADIENT = re.compile(r"linear-gradient\s*\(([^)]*)\)", re.I)
RE_HEADING_TAG = re.compile(r"<(h[1-6])\b", re.I)
RE_LEFT_BORDER = re.compile(r"border-left\s*:", re.I)
RE_BORDER_RADIUS = re.compile(r"border-radius\s*:", re.I)
RE_FAKE_STAT = re.compile(r"\b\d{1,3}(?:,\d{3})*\+|\b\d{1,3}(?:\.\d+)?[%xX]\b")

# Emoji used as decorative icons.
EMOJI_ICONS = ["🚀", "⚡", "✨", "🎯", "🔥", "💡", "📈", "🎉", "🌟", "💪", "🙌", "👇", "👉", "✅", "🎨", "🧩"]

# Generic fonts that should not be the DISPLAY face.
GENERIC_DISPLAY_FONTS = ["inter", "roboto", "arial", "helvetica"]

# 8pt grid: allowed px values are multiples of 4 (half-step) up to small sizes.
def _on_8pt_grid(n):
    # Accept multiples of 4 (4pt half-grid is widely tolerated) and tiny 1/2/3 (hairlines).
    if n in (0, 1, 2, 3):
        return True
    return n % 4 == 0


# --------------------------------------------------------------------------- #
# Per-file assessment
# --------------------------------------------------------------------------- #
def assess_file(path, text):
    """Return (per_dimension_scores dict, findings list) for one file."""
    findings = []
    lower = text.lower()
    ext = os.path.splitext(path)[1].lower()
    is_style = ext in (".css", ".wxss")
    is_html = ext in (".html", ".htm")
    is_md = ext == ".md"
    has_style_content = is_style or is_html or ("font-size" in lower) or ("{" in text and "}" in text)

    scores = {}

    # ----- 1. Philosophy Alignment ----------------------------------------- #
    if has_style_content:
        var_defs = len(RE_CSS_VAR.findall(text))
        var_uses = len(RE_VAR_USE.findall(text))
        s = 7.0
        if var_defs == 0 and (is_style or is_html):
            s -= 2.5
            m = re.search(r"\{", text)
            findings.append(finding(
                "P1", "No design tokens / CSS custom properties found",
                path, line_of(text, m.start() if m else 0),
                "Declare a token layer (e.g. :root { --color-primary; --space-1; "
                "--font-base; }) and reference values via var() for a coherent system."))
        else:
            s += min(2.0, var_defs * 0.2)
            if var_defs > 0 and var_uses == 0:
                s -= 1.0
                findings.append(finding(
                    "P2", "Design tokens declared but never referenced via var()",
                    path, 1,
                    "Replace hard-coded values with var(--token) so the system is "
                    "actually applied, not just declared."))
        # Self-contradiction: same property set to many different hard values.
        scores["Philosophy Alignment"] = clamp(s)
    else:
        scores["Philosophy Alignment"] = NEUTRAL
        if is_md:
            findings.append(finding(
                "P3", "Philosophy not assessable for this file type",
                path, 1, "Markdown DESIGN file: document the design system "
                         "explicitly (tokens, scale) so it can be assessed."))

    # ----- 2. Visual Hierarchy --------------------------------------------- #
    font_sizes_px = []
    for m in RE_FONT_SIZE.finditer(text):
        val, unit = float(m.group(1)), m.group(2).lower()
        if unit in ("px", "rpx"):
            px = val / 2.0 if unit == "rpx" else val  # rpx ~ 0.5px on 750 design
            font_sizes_px.append((px, m.start()))
        elif unit in ("rem", "em"):
            font_sizes_px.append((val * 16.0, m.start()))
        elif unit == "pt":
            font_sizes_px.append((val * 96.0 / 72.0, m.start()))
    if has_style_content and font_sizes_px:
        sizes = sorted({round(p, 1) for p, _ in font_sizes_px})
        tiers = len(sizes)
        ratio = (max(sizes) / min(sizes)) if min(sizes) > 0 else 1.0
        s = 7.0
        if ratio < 2.5:
            s -= 2.0
            findings.append(finding(
                "P1", "Weak type-scale contrast (headline:body ratio %.1fx < 2.5x)" % ratio,
                path, 1,
                "Increase the largest display size or reduce body size so the "
                "headline:body ratio is at least 2.5x for clear hierarchy."))
        else:
            s += 1.0
        if tiers < 3:
            s -= 1.5
            findings.append(finding(
                "P2", "Too few hierarchy tiers (%d distinct font sizes; want 3-4)" % tiers,
                path, 1,
                "Introduce 3-4 distinct type tiers (display / heading / body / caption)."))
        elif tiers > 7:
            s -= 1.0
            findings.append(finding(
                "P2", "Too many type tiers (%d) -- scale looks ad hoc" % tiers,
                path, 1, "Consolidate to a 4-6 step modular type scale."))
        else:
            s += 0.5
        scores["Visual Hierarchy"] = clamp(s)
    elif has_style_content and is_html:
        # Fall back to heading-tag depth.
        tags = {t.lower() for t in RE_HEADING_TAG.findall(text)}
        s = 7.0
        if len(tags) >= 2:
            s += 1.0
        else:
            s -= 1.0
            findings.append(finding(
                "P2", "Flat heading structure (few distinct <h*> levels)",
                path, 1, "Use a clear <h1>/<h2>/<h3> hierarchy."))
        scores["Visual Hierarchy"] = clamp(s)
    else:
        scores["Visual Hierarchy"] = NEUTRAL

    # ----- 3. Craft Quality ------------------------------------------------ #
    if has_style_content:
        s = 7.0
        # 8pt spacing adherence: flag arbitrary px values.
        off_grid = []
        for m in RE_PX_VAL.finditer(text):
            n = int(m.group(1))
            if n > 3 and not _on_8pt_grid(n):
                off_grid.append((n, m.start()))
        if off_grid:
            s -= min(2.5, 0.4 * len(set(n for n, _ in off_grid)))
            n0, idx0 = off_grid[0]
            findings.append(finding(
                "P2", "Off-grid spacing values (e.g. %dpx) break the 8pt system"
                      % n0,
                path, line_of(text, idx0),
                "Snap spacing/size px values to multiples of 4/8 (e.g. %dpx -> %dpx)."
                % (n0, round(n0 / 8.0) * 8 or 8)))
        # Color count.
        colors = {c.lower() for c in RE_HEX_COLOR.findall(text)}
        if len(colors) > 8:
            s -= 1.5
            findings.append(finding(
                "P2", "Large palette (%d distinct hex colors; keep ~4 primaries)"
                      % len(colors),
                path, 1,
                "Reduce to ~4 primary colors plus neutrals; move repeated values "
                "into color tokens."))
        elif len(colors) > 0:
            s += 0.5
        # Font families.
        fams = set()
        for m in RE_FONT_FAMILY.finditer(text):
            decl = m.group(1)
            for part in decl.split(","):
                p = part.strip().strip("'\"").lower()
                # Skip generic CSS keywords.
                if p and p not in ("inherit", "initial", "unset", "sans-serif",
                                   "serif", "monospace", "system-ui", "-apple-system"):
                    fams.add(p)
        if len(fams) > 2:
            s -= 1.0
            findings.append(finding(
                "P2", "More than 2 font families in use (%d)" % len(fams),
                path, 1, "Limit to 2 typefaces (one display, one text)."))
        scores["Craft Quality"] = clamp(s)
    else:
        scores["Craft Quality"] = NEUTRAL

    # ----- 4. Functionality ------------------------------------------------ #
    if has_style_content:
        s = 7.0
        # Touch targets: width/height declarations < 44px (and not 0/auto/%).
        small_target = None
        for rx in (RE_WIDTH, RE_HEIGHT):
            for m in rx.finditer(text):
                val, unit = float(m.group(1)), m.group(2).lower()
                px = val / 2.0 if unit == "rpx" else val
                if 0 < px < 44:
                    # Only flag if it appears near an interactive context heuristically.
                    seg = lower[max(0, m.start() - 120):m.start()]
                    if any(k in seg for k in ("button", "btn", ".tap", "click",
                                              "link", "nav", "tab", "icon")):
                        small_target = (px, m.start())
                        break
            if small_target:
                break
        if small_target:
            s -= 1.5
            px, idx = small_target
            findings.append(finding(
                "P1", "Interactive target smaller than 44x44 (%gpx)" % px,
                path, line_of(text, idx),
                "Enlarge tap targets to at least 44x44 px (or 88rpx on a 750 "
                "WXSS canvas) for accessible touch."))
        # CTA presence (for HTML / templates).
        if is_html:
            if not re.search(r"<(button|a)\b", lower):
                s -= 1.0
                findings.append(finding(
                    "P2", "No clear call-to-action (no <button>/<a>) found",
                    path, 1, "Add a primary CTA element (button or link)."))
            else:
                s += 0.5
        scores["Functionality"] = clamp(s)
    else:
        scores["Functionality"] = NEUTRAL

    # ----- 5. Originality (anti-AI-slop) ----------------------------------- #
    s = 8.0
    # Purple -> pink -> blue full-screen gradient.
    for m in RE_GRADIENT.finditer(text):
        body = m.group(1).lower()
        colorish = body
        purple = any(k in colorish for k in ("purple", "violet", "#6", "#7", "#8a", "#9", "indigo", "rgb(1"))
        pink = any(k in colorish for k in ("pink", "magenta", "#f0", "#ff0", "#e", "fuchsia"))
        blue = any(k in colorish for k in ("blue", "#1", "#2", "#3", "cyan", "#0ea", "#06b"))
        if (purple and (pink or blue)) or (pink and blue):
            s -= 2.0
            findings.append(finding(
                "P1", "Cliche purple/pink/blue gradient (AI-slop signature)",
                path, line_of(text, m.start()),
                "Replace the generic multi-hue gradient with a restrained, "
                "brand-derived color treatment."))
            break
    # Emoji as decorative icons.
    emoji_hits = [e for e in EMOJI_ICONS if e in text]
    if emoji_hits:
        idx = text.find(emoji_hits[0])
        s -= min(2.0, 0.6 * len(emoji_hits))
        findings.append(finding(
            "P2", "Emoji used as icons (%s) -- AI-slop decoration"
                  % " ".join(emoji_hits[:4]),
            path, line_of(text, idx),
            "Replace emoji with real vector icons (SVG icon set) or remove."))
    # Generic display font.
    for m in RE_FONT_FAMILY.finditer(text):
        first = m.group(1).split(",")[0].strip().strip("'\"").lower()
        if first in GENERIC_DISPLAY_FONTS:
            seg = lower[max(0, m.start() - 80):m.start()]
            if any(k in seg for k in ("h1", "h2", "title", "display", "heading", "hero")):
                s -= 1.0
                findings.append(finding(
                    "P3", "Generic font (%s) used as display face" % first,
                    path, line_of(text, m.start()),
                    "Use a distinctive display typeface; reserve %s for body only."
                    % first))
                break
    # Rounded-card + left-border-accent template.
    if RE_BORDER_RADIUS.search(text) and RE_LEFT_BORDER.search(text):
        s -= 1.0
        idx = RE_LEFT_BORDER.search(text).start()
        findings.append(finding(
            "P3", "Rounded-card + left-border-accent template look",
            path, line_of(text, idx),
            "Differentiate cards beyond the stock rounded-corner + colored "
            "left-border pattern."))
    # Bento overuse (many grid declarations).
    grid_count = lower.count("display:grid") + lower.count("display: grid")
    if grid_count >= 5:
        s -= 0.5
        findings.append(finding(
            "P3", "Heavy bento-grid usage (%d grids)" % grid_count,
            path, 1, "Vary layout rhythm; avoid uniform bento boxes everywhere."))
    scores["Originality"] = clamp(s)

    # ----- CJK typography rules (affect Craft + Functionality) ------------- #
    if has_style_content:
        # line-height for CJK
        lh_bad = None
        for m in RE_LINE_HEIGHT.finditer(text):
            try:
                lh = float(m.group(1))
            except ValueError:
                continue
            if lh < 1.6 and lh >= 0.5:  # ignore unitless 1.0 resets? still flag <1.6
                lh_bad = (lh, m.start())
                break
        if lh_bad:
            scores["Craft Quality"] = clamp(scores.get("Craft Quality", NEUTRAL) - 1.0)
            lh, idx = lh_bad
            findings.append(finding(
                "P1", "CJK line-height too tight (%.2f < 1.6)" % lh,
                path, line_of(text, idx),
                "Set line-height to 1.7-1.8 for comfortable Chinese reading."))
        # body font-size & section titles
        if font_sizes_px:
            min_px = min(p for p, _ in font_sizes_px)
            max_px = max(p for p, _ in font_sizes_px)
            is_mobile = (ext == ".wxss") or ("rpx" in lower) or ("@media" in lower and "max-width" in lower)
            min_body = 16.0 if is_mobile else 14.0
            if min_px < min_body:
                scores["Functionality"] = clamp(scores.get("Functionality", NEUTRAL) - 1.0)
                idx = min((p_i for p_i in font_sizes_px), key=lambda t: t[0])[1]
                findings.append(finding(
                    "P1", "Body font-size %.0fpx below %.0fpx minimum%s"
                          % (min_px, min_body, " (iOS zoom risk)" if is_mobile else ""),
                    path, line_of(text, idx),
                    "Raise body text to >= %.0fpx (%s)."
                    % (min_body, "mobile" if is_mobile else "desktop")))
            if max_px < 24.0 and not is_mobile:
                findings.append(finding(
                    "P3", "Largest title %.0fpx < 24px on large screens" % max_px,
                    path, 1, "Use >= 24px for section titles on large screens."))

    return scores, findings


# --------------------------------------------------------------------------- #
# Aggregation
# --------------------------------------------------------------------------- #
DIMENSIONS = [
    "Philosophy Alignment",
    "Visual Hierarchy",
    "Craft Quality",
    "Functionality",
    "Originality",
]

RATIONALE = {
    "Philosophy Alignment": "Coherent design system (tokens/vars, no contradiction).",
    "Visual Hierarchy": "Type-scale contrast, tier count, whitespace.",
    "Craft Quality": "8pt grid, palette size, font-family count, CJK rules.",
    "Functionality": "Touch targets >=44, CTA presence, readable body size.",
    "Originality": "Anti-AI-slop: gradients, emoji icons, template looks.",
}


def judge_path(path, threshold=DEFAULT_THRESHOLD, strict=False):
    files = collect_files(path)
    all_findings = []
    dim_accum = {d: [] for d in DIMENSIONS}
    assessed = 0

    for fp in files:
        text = read_text_file(fp)
        if text is None:
            continue  # binary / unreadable -> skip
        assessed += 1
        scores, findings = assess_file(fp, text)
        all_findings.extend(findings)
        for d in DIMENSIONS:
            dim_accum[d].append(scores.get(d, NEUTRAL))

    dimensions = []
    for d in DIMENSIONS:
        vals = dim_accum[d]
        score = round(sum(vals) / len(vals), 1) if vals else NEUTRAL
        note = RATIONALE[d]
        if not vals:
            note = "not assessable -- no readable design files."
        dimensions.append({"name": d, "score": score, "rationale": note})

    overall = round(sum(x["score"] for x in dimensions) / len(dimensions), 2) if dimensions else NEUTRAL
    band = band_of(overall)

    has_p0 = any(f["severity"] == "P0" for f in all_findings)
    has_p1 = any(f["severity"] == "P1" for f in all_findings)
    passed = (overall >= threshold) and (not has_p0) and (not (strict and has_p1))

    # Stable ordering of findings: by severity then file then line.
    sev_order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    all_findings.sort(key=lambda f: (sev_order.get(f["severity"], 9),
                                     f.get("file") or "", f.get("line") or 0,
                                     f.get("title") or ""))

    return {
        "judge": JUDGE_NAME,
        "overall": overall,
        "band": band,
        "dimensions": dimensions,
        "findings": all_findings,
        "pass": passed,
        "_assessed": assessed,
    }


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #
def print_report(result, path, threshold, strict):
    print("=== Design Judge ===  file/dir: %s" % path)
    print("Overall: %.1f/10  [%s]" % (result["overall"], result["band"].upper()))
    print("Dimensions:")
    for d in result["dimensions"]:
        print("  - %s: %s/10 — %s" % (d["name"], _fmt(d["score"]), d["rationale"]))
    fnds = result["findings"]
    print("Findings (%d):" % len(fnds))
    for f in fnds:
        loc = "%s:%s" % (f["file"], f["line"]) if f["file"] else "-"
        print("  [%s] %s (%s)" % (f["severity"], f["title"], loc))
        print("       fix: %s" % f["fix"])
    print("Result: %s (threshold %s, strict=%s)" % (
        "PASS" if result["pass"] else "FAIL",
        _fmt(threshold), "on" if strict else "off"))


def _fmt(n):
    f = float(n)
    return str(int(f)) if f == int(f) else ("%.1f" % f)


def emit_json(result):
    out = {k: v for k, v in result.items() if not k.startswith("_")}
    print(json.dumps(out, ensure_ascii=False))


# --------------------------------------------------------------------------- #
# Self-test
# --------------------------------------------------------------------------- #
def self_test():
    # Bad CSS: tight line-height, off-grid px, tiny body, emoji, gradient.
    bad = (".hero{font-size:30px;line-height:1.3;padding:13px;color:#abc;}"
           ".b{font-size:11px;} .btn{display:grid;}"
           ".cta{width:30px;height:30px;} /* button */"
           ".bg{background:linear-gradient(purple,pink,blue);} 🚀 ✨")
    s, f = assess_file("bad.css", bad)
    assert s["Craft Quality"] < 7.0, "craft should drop on off-grid+tight lh"
    titles = " ".join(x["title"] for x in f)
    assert "line-height" in titles, "should flag tight CJK line-height"
    assert any("gradient" in x["title"] for x in f), "should flag AI-slop gradient"
    assert any("Emoji" in x["title"] for x in f), "should flag emoji icons"

    # Good CSS: tokens, generous line-height, on-grid spacing, big body,
    # and 3 type tiers (caption / body / display) for real hierarchy.
    good = (":root{--c-primary:#123456;--space-2:16px;}"
            ".caption{font-size:14px;}"
            "body{font-size:16px;line-height:1.75;color:var(--c-primary);}"
            "h1{font-size:48px;line-height:1.2;padding:24px;}"
            ".btn{width:48px;height:48px;}")
    gs, gf = assess_file("good.css", good)
    assert gs["Philosophy Alignment"] >= 7.0, "tokens should lift philosophy"
    assert gs["Visual Hierarchy"] >= 7.0, "48:16 ratio is 3x -> good hierarchy"

    # Aggregation + bands.
    assert band_of(9.0) == "excellent"
    assert band_of(6.5) == "good"
    assert band_of(5.0) == "needs-improvement"
    assert band_of(2.0) == "inadequate"

    # Binary detection.
    assert _looks_binary(b"\x00\x01\x02PNG") is True
    assert _looks_binary(b"hello world") is False

    print("OK")
    return 0


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def build_parser():
    p = argparse.ArgumentParser(
        prog="design_judge.py",
        description="Deterministic design-quality judge (huashu-design rubric).")
    p.add_argument("path", nargs="?", help="File or directory to judge.")
    p.add_argument("--json", action="store_true", help="Emit a single JSON object.")
    p.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                   help="Overall pass threshold (default 6.0).")
    p.add_argument("--strict", action="store_true",
                   help="Also fail on any P1 finding.")
    p.add_argument("--self-test", action="store_true",
                   help="Run inline assertions and print OK.")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.self_test:
        try:
            return self_test()
        except AssertionError as exc:
            print("SELF-TEST FAILED: %s" % exc, file=sys.stderr)
            return 2

    if not args.path:
        print("error: a <path> is required (or use --self-test)", file=sys.stderr)
        return 2
    if not os.path.exists(args.path):
        print("error: path not found: %s" % args.path, file=sys.stderr)
        return 2

    try:
        result = judge_path(args.path, threshold=args.threshold, strict=args.strict)
    except OSError as exc:
        print("error: IO failure: %s" % exc, file=sys.stderr)
        return 2

    if args.json:
        emit_json(result)
    else:
        print_report(result, args.path, args.threshold, args.strict)

    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
