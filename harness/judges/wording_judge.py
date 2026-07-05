#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wording_judge.py -- deterministic documentation-copy judge for 教师资源发展平台
(China Teacher Resources Development Platform).

Judges Markdown documentation copy quality and bilingual (EN / 简体中文)
consistency with standard-library-only heuristics.

Five dimensions (each 0-10, overall = arithmetic mean):
  1. Clarity              -- long sentences (EN > 40 words; 中文 > 80 字),
     passive-voice density, hedging words (just/really/basically/simply/very).
  2. Bilingual parallelism-- for docs that should be bilingual (filename with
     .zh-CN, or EN+中文 sections), check both languages exist with comparable
     structure (similar heading count). Flag missing translation.
  3. Terminology          -- load glossary from
     docs/glossary.json (schema {"terms":[{"id","zh","en","variants_forbidden"}]}).
     Flag forbidden variants; flag wrong casing of an English term.
     If glossary missing, skip with neutral 7 + note.
  4. Punctuation/format   -- in 中文 text flag half-width ,.!?() where full-width
     ，。！？（） expected; flag mixed full/half; flag trailing whitespace; tabs.
  5. Tone/house-style     -- marketing fluff / AI-slop ("revolutionary",
     "seamless", "cutting-edge", "game-changing", "在当今...时代", "赋能" overuse),
     emoji in body prose.

Quality bands: 8-10 excellent, 6-7.9 good, 4-5.9 needs-improvement, <4 inadequate.
Severities: forbidden-term P1, half-width CJK punctuation P2, fluff P3, etc.

CLI:
    python wording_judge.py <path> [--json] [--threshold N] [--strict] [--self-test]

Exit codes: 0 pass, 1 fail, 2 usage / IO error.
Pure standard library. Deterministic: no randomness, no network, no clock.
"""

import argparse
import json
import os
import re
import sys

JUDGE_NAME = "wording"
DEFAULT_THRESHOLD = 6.0
NEUTRAL = 7.0

DOC_EXTS = (".md", ".markdown")

GLOSSARY_PATH = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "docs", "glossary.json"))

_CONTROL_CHARS = "".join(chr(c) for c in range(32) if chr(c) not in "\n\r\t\f")
_CONTROL_RE = re.compile("[" + re.escape(_CONTROL_CHARS) + "]")

# Hedging / weak words (English).
HEDGE_WORDS = ["just", "really", "basically", "simply", "very", "actually",
               "literally", "kind of", "sort of", "quite"]

# Marketing fluff / AI-slop (English).
FLUFF_EN = ["revolutionary", "seamless", "cutting-edge", "cutting edge",
            "game-changing", "game changing", "next-generation", "world-class",
            "state-of-the-art", "unparalleled", "best-in-class", "synergy",
            "leverage", "paradigm shift", "robust and scalable"]

# Marketing fluff / AI-slop (中文).
FLUFF_ZH = ["赋能", "颠覆", "无缝", "革命性", "极致", "打造", "助力", "一站式",
            "全方位", "深度赋能"]

# Emoji range check.
EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F0FF←-⇿⬀-⯿]")

# Passive voice (English): be-verb + past participle (heuristic).
PASSIVE_RE = re.compile(
    r"\b(is|are|was|were|be|been|being)\s+(\w+ed|done|made|built|shown|given|"
    r"taken|seen|written|held|kept|set|put|sent|found|known)\b", re.I)

# Half-width punctuation that should be full-width inside CJK text.
HALF_TO_FULL = {",": "，", ".": "。", "!": "！", "?": "？", "(": "（", ")": "）",
                ":": "：", ";": "；"}

CJK_RE = re.compile(r"[一-鿿]")


# --------------------------------------------------------------------------- #
# IO helpers
# --------------------------------------------------------------------------- #
def _looks_binary(raw):
    """Binary if NUL byte, invalid UTF-8, or many control chars. UTF-8
    multibyte text (e.g. CJK) is treated as text, not binary."""
    if b"\x00" in raw:
        return True
    if not raw:
        return False
    try:
        decoded = raw[:8192].decode("utf-8")
    except UnicodeDecodeError:
        decoded = raw[:8192].decode("utf-8", errors="ignore")
        if not decoded:
            return True
    ctrl = len(_CONTROL_RE.findall(decoded))
    return ctrl / max(1, len(decoded)) > 0.05


def read_text_file(path):
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
        return raw.decode("utf-8", errors="replace")


def collect_files(path):
    if os.path.isfile(path):
        return [path]
    out = []
    for root, _dirs, names in os.walk(path):
        for name in sorted(names):
            if name.lower().endswith(DOC_EXTS):
                out.append(os.path.join(root, name))
    return sorted(out)


def load_glossary(explicit=None):
    """Return glossary dict or None if absent / invalid."""
    candidates = [explicit] if explicit else [GLOSSARY_PATH]
    for p in candidates:
        if p and os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                if isinstance(data, dict) and isinstance(data.get("terms"), list):
                    return data
            except (OSError, ValueError):
                return None
    return None


def line_of(text, idx):
    if idx < 0:
        return 1
    return text.count("\n", 0, idx) + 1


# --------------------------------------------------------------------------- #
# Finding model
# --------------------------------------------------------------------------- #
def finding(severity, title, file, line, fix):
    return {"severity": severity, "title": title, "file": file,
            "line": line, "fix": fix}


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
# Text utilities
# --------------------------------------------------------------------------- #
def strip_code_blocks(text):
    """Remove fenced and inline code so we don't lint code samples."""
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    text = re.sub(r"`[^`\n]*`", "", text)
    return text


def is_cjk_line(line):
    return CJK_RE.search(line) is not None


def split_en_sentences(text):
    """Split English prose into sentences with their start offsets."""
    out = []
    start = 0
    for m in re.finditer(r"[.!?](?:\s|$)", text):
        seg = text[start:m.end()].strip()
        if seg:
            out.append((seg, start))
        start = m.end()
    tail = text[start:].strip()
    if tail:
        out.append((tail, start))
    return out


def split_zh_sentences(text):
    """Split Chinese prose into sentences with start offsets (full-width enders)."""
    out = []
    start = 0
    for m in re.finditer(r"[。！？；]", text):
        seg = text[start:m.end()]
        if seg.strip():
            out.append((seg, start))
        start = m.end()
    tail = text[start:]
    if tail.strip():
        out.append((tail, start))
    return out


def count_headings(text):
    return len(re.findall(r"^#{1,6}\s+\S", text, flags=re.M))


# --------------------------------------------------------------------------- #
# Per-file assessment
# --------------------------------------------------------------------------- #
def assess_file(path, text, glossary):
    findings = []
    scores = {}
    body = strip_code_blocks(text)
    name = os.path.basename(path).lower()

    has_cjk = CJK_RE.search(body) is not None
    has_en = re.search(r"[A-Za-z]{3,}", body) is not None

    # ----- 1. Clarity ------------------------------------------------------ #
    s = 8.0
    # English long sentences.
    en_long = 0
    for seg, off in split_en_sentences(re.sub(r"[一-鿿，。！？；：（）]+", " ", body)):
        words = re.findall(r"[A-Za-z][A-Za-z'-]*", seg)
        if len(words) > 40:
            en_long += 1
            if en_long <= 1:
                findings.append(finding(
                    "P2", "Overly long English sentence (%d words > 40)" % len(words),
                    path, line_of(text, off),
                    "Split into shorter sentences (aim <= 25-30 words)."))
    # Chinese long sentences.
    zh_long = 0
    for seg, off in split_zh_sentences(body):
        zh_chars = len(CJK_RE.findall(seg))
        if zh_chars > 80:
            zh_long += 1
            if zh_long <= 1:
                findings.append(finding(
                    "P2", "中文句子过长 (%d 字 > 80)" % zh_chars,
                    path, line_of(text, off),
                    "拆分为更短的句子（建议每句不超过 40-60 字）。"))
    s -= min(2.0, 0.5 * (en_long + zh_long))
    # Passive voice density.
    passives = len(PASSIVE_RE.findall(body))
    sentences = max(1, len(split_en_sentences(body)))
    if passives >= 3 and passives / sentences > 0.25:
        s -= 1.0
        m = PASSIVE_RE.search(body)
        findings.append(finding(
            "P3", "Passive-voice-heavy prose (%d passive constructions)" % passives,
            path, line_of(text, m.start() if m else 0),
            "Prefer active voice (subject does the action)."))
    # Hedging words.
    hedge_hits = []
    for w in HEDGE_WORDS:
        for m in re.finditer(r"\b" + re.escape(w) + r"\b", body, re.I):
            hedge_hits.append((w, m.start()))
    if hedge_hits:
        s -= min(1.5, 0.3 * len(hedge_hits))
        w0, idx0 = hedge_hits[0]
        findings.append(finding(
            "P3", "Hedging / filler words (%d, e.g. '%s')" % (len(hedge_hits), w0),
            path, line_of(text, idx0),
            "Remove filler words (just/really/basically/simply/very) for crisper copy."))
    scores["Clarity"] = clamp(s)

    # ----- 2. Bilingual parallelism --------------------------------------- #
    should_be_bilingual = (".zh-cn" in name or "zh-cn" in name or "zh_cn" in name
                           or (has_cjk and has_en))
    if should_be_bilingual:
        s = 8.0
        if not has_cjk:
            s -= 4.0
            findings.append(finding(
                "P1", "Missing 中文 translation in a bilingual doc",
                path, 1, "Add the 简体中文 section parallel to the English content."))
        elif not has_en:
            s -= 4.0
            findings.append(finding(
                "P1", "Missing English translation in a bilingual doc",
                path, 1, "Add the English section parallel to the Chinese content."))
        else:
            # Compare per-language heading counts where headings are clearly tagged.
            en_headings = len(re.findall(r"^#{1,6}\s+[^一-鿿\n]*[A-Za-z]",
                                         text, flags=re.M))
            zh_headings = len(re.findall(r"^#{1,6}\s+.*[一-鿿]",
                                         text, flags=re.M))
            if en_headings and zh_headings:
                hi, lo = max(en_headings, zh_headings), min(en_headings, zh_headings)
                if hi - lo >= 2 and lo / hi < 0.7:
                    s -= 2.0
                    findings.append(finding(
                        "P2", "Unbalanced bilingual structure (EN %d vs 中文 %d headings)"
                              % (en_headings, zh_headings),
                        path, 1,
                        "Mirror the heading structure across both languages."))
        scores["Bilingual parallelism"] = clamp(s)
    else:
        scores["Bilingual parallelism"] = NEUTRAL
        findings.append(finding(
            "P3", "Bilingual parallelism not assessable (monolingual doc)",
            path, 1, "If this doc should be bilingual, add a .zh-CN counterpart "
                     "or parallel sections."))

    # ----- 3. Terminology consistency ------------------------------------- #
    if glossary is None:
        scores["Terminology consistency"] = NEUTRAL
        findings.append(finding(
            "P3", "Terminology not assessable (glossary.json missing)",
            path, 1, "Add docs/glossary.json with {\"terms\":[{id,zh,en,"
                     "variants_forbidden}]} to enable term checks."))
    else:
        s = 9.0
        violations = 0
        for term in glossary.get("terms", []):
            if not isinstance(term, dict):
                continue
            tid = term.get("id", "?")
            for variant in term.get("variants_forbidden", []) or []:
                if not variant:
                    continue
                for m in re.finditer(re.escape(variant), body):
                    violations += 1
                    canon = term.get("en") or term.get("zh") or tid
                    findings.append(finding(
                        "P1", "Forbidden term variant '%s' (use '%s')" % (variant, canon),
                        path, line_of(text, m.start()),
                        "Replace '%s' with the canonical term '%s'." % (variant, canon)))
                    break  # one finding per variant per file
            # Wrong casing of an English term.
            en_term = term.get("en")
            if en_term and re.search(r"[A-Za-z]", en_term):
                for m in re.finditer(re.escape(en_term), body, re.I):
                    found = body[m.start():m.end()]
                    if found != en_term:
                        violations += 1
                        findings.append(finding(
                            "P2", "Inconsistent casing '%s' (expected '%s')"
                                  % (found, en_term),
                            path, line_of(text, m.start()),
                            "Use the exact casing '%s'." % en_term))
                        break
        s -= min(4.0, 1.0 * violations)
        scores["Terminology consistency"] = clamp(s)

    # ----- 4. Punctuation / format ---------------------------------------- #
    s = 9.0
    # Trailing whitespace & tabs (over raw text, line by line).
    trailing = 0
    tabs = 0
    for i, raw_line in enumerate(text.split("\n"), start=1):
        if raw_line != raw_line.rstrip() and raw_line.strip():
            trailing += 1
            if trailing == 1:
                findings.append(finding(
                    "P3", "Trailing whitespace", path, i,
                    "Strip trailing spaces/tabs at end of lines."))
        if "\t" in raw_line:
            tabs += 1
            if tabs == 1:
                findings.append(finding(
                    "P2", "Tab character in document", path, i,
                    "Replace tabs with spaces for consistent rendering."))
    if trailing:
        s -= min(1.0, 0.2 * trailing)
    if tabs:
        s -= min(1.0, 0.3 * tabs)
    # Half-width punctuation inside CJK lines.
    half_hits = 0
    for i, raw_line in enumerate(body.split("\n"), start=1):
        if not is_cjk_line(raw_line):
            continue
        for m in re.finditer(r"[一-鿿]\s*([,.!?;:()])", raw_line):
            ch = m.group(1)
            # Skip '.' inside obvious numbers/URLs.
            if ch == "." and re.search(r"\d\.\d", raw_line):
                continue
            half_hits += 1
            if half_hits <= 2:
                findings.append(finding(
                    "P2", "半角标点 '%s' 应使用全角 '%s'" % (ch, HALF_TO_FULL.get(ch, ch)),
                    path, i,
                    "在中文文本中使用全角标点（如 '%s' -> '%s'）。"
                    % (ch, HALF_TO_FULL.get(ch, ch))))
            break
    if half_hits:
        s -= min(2.5, 0.5 * half_hits)
    scores["Punctuation/format"] = clamp(s)

    # ----- 5. Tone / house-style ------------------------------------------ #
    s = 9.0
    fluff_hits = []
    for w in FLUFF_EN:
        for m in re.finditer(re.escape(w), body, re.I):
            fluff_hits.append((w, m.start()))
            break
    for w in FLUFF_ZH:
        # 赋能 overuse: count occurrences.
        occ = [mm.start() for mm in re.finditer(re.escape(w), body)]
        if w == "赋能" and len(occ) >= 2:
            fluff_hits.append((w + "(overuse)", occ[0]))
        elif occ:
            fluff_hits.append((w, occ[0]))
    # "在当今...时代" template opener.
    m_era = re.search(r"在当今[^。]{0,12}时代", body)
    if m_era:
        fluff_hits.append(("在当今…时代", m_era.start()))
    if fluff_hits:
        s -= min(3.0, 0.7 * len(fluff_hits))
        w0, idx0 = fluff_hits[0]
        findings.append(finding(
            "P3", "Marketing fluff / AI-slop phrasing (%d, e.g. '%s')"
                  % (len(fluff_hits), w0),
            path, line_of(text, idx0),
            "Replace vague hype with concrete, specific wording."))
    # Emoji in body prose.
    em = EMOJI_RE.search(body)
    if em:
        s -= 1.0
        findings.append(finding(
            "P3", "Emoji in body prose", path, line_of(text, em.start()),
            "Remove emoji from documentation prose; keep copy professional."))
    scores["Tone/house-style"] = clamp(s)

    return scores, findings


# --------------------------------------------------------------------------- #
# Aggregation
# --------------------------------------------------------------------------- #
DIMENSIONS = [
    "Clarity",
    "Bilingual parallelism",
    "Terminology consistency",
    "Punctuation/format",
    "Tone/house-style",
]

RATIONALE = {
    "Clarity": "Sentence length, passive voice, hedging.",
    "Bilingual parallelism": "EN + 简中 present and structurally comparable.",
    "Terminology consistency": "Glossary canonical terms / casing.",
    "Punctuation/format": "Full-width CJK punctuation, no tabs/trailing space.",
    "Tone/house-style": "No marketing fluff / AI-slop / emoji prose.",
}


def judge_path(path, threshold=DEFAULT_THRESHOLD, strict=False, glossary_path=None):
    files = collect_files(path)
    glossary = load_glossary(glossary_path)
    all_findings = []
    dim_accum = {d: [] for d in DIMENSIONS}
    assessed = 0

    for fp in files:
        text = read_text_file(fp)
        if text is None:
            continue
        assessed += 1
        scores, findings = assess_file(fp, text, glossary)
        all_findings.extend(findings)
        for d in DIMENSIONS:
            dim_accum[d].append(scores.get(d, NEUTRAL))

    dimensions = []
    for d in DIMENSIONS:
        vals = dim_accum[d]
        score = round(sum(vals) / len(vals), 1) if vals else NEUTRAL
        note = RATIONALE[d]
        if not vals:
            note = "not assessable -- no readable docs."
        dimensions.append({"name": d, "score": score, "rationale": note})

    overall = round(sum(x["score"] for x in dimensions) / len(dimensions), 2) if dimensions else NEUTRAL
    band = band_of(overall)

    has_p0 = any(f["severity"] == "P0" for f in all_findings)
    has_p1 = any(f["severity"] == "P1" for f in all_findings)
    passed = (overall >= threshold) and (not has_p0) and (not (strict and has_p1))

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
def _fmt(n):
    f = float(n)
    return str(int(f)) if f == int(f) else ("%.1f" % f)


def print_report(result, path, threshold, strict):
    print("=== Wording Judge ===  file/dir: %s" % path)
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


def emit_json(result):
    out = {k: v for k, v in result.items() if not k.startswith("_")}
    print(json.dumps(out, ensure_ascii=False))


# --------------------------------------------------------------------------- #
# Self-test
# --------------------------------------------------------------------------- #
def self_test():
    # Bad doc: half-width CJK punctuation, fluff, hedging, emoji, trailing ws.
    bad = ("# 标题\n"
           "这是一个测试,我们要赋能用户,赋能业务,在当今数字化时代很重要.\n"
           "This is just a really revolutionary seamless platform. \n"
           "更多内容 🚀\n")
    s, f = assess_file("bad.md", bad, None)
    titles = " ".join(x["title"] for x in f)
    assert any("半角" in x["title"] or "全角" in x["title"] for x in f), \
        "should flag half-width CJK punctuation"
    assert any("fluff" in x["title"].lower() for x in f), "should flag fluff"
    assert any("Hedging" in x["title"] for x in f), "should flag hedging"
    assert any("Emoji" in x["title"] for x in f), "should flag emoji"
    assert s["Tone/house-style"] < 9.0, "tone should drop on fluff/emoji"

    # Clean doc: full-width punctuation, no fluff.
    good = ("# 概述\n"
            "本文档介绍平台的核心功能。每一节都简明扼要。\n"
            "The platform supports parent notifications and class rosters.\n")
    gs, gf = assess_file("good.md", good, None)
    assert gs["Punctuation/format"] >= 8.0, "clean punctuation should score high"
    assert gs["Clarity"] >= 7.0, "short clear sentences score well"

    # Glossary terminology check.
    gloss = {"terms": [{"id": "kg", "zh": "知识图谱", "en": "Knowledge Graph",
                        "variants_forbidden": ["knowledge-graph", "KnowledgeGraph"]}]}
    tt = "We built a KnowledgeGraph for the school.\n"
    ts, tf = assess_file("term.md", tt, gloss)
    assert any("Forbidden term" in x["title"] for x in tf), \
        "should flag forbidden variant"
    assert ts["Terminology consistency"] < 9.0, "terminology should drop"

    # Missing-glossary -> neutral.
    ms, mf = assess_file("x.md", "Hello world.\n", None)
    assert ms["Terminology consistency"] == NEUTRAL, "neutral when no glossary"

    # Bilingual missing translation.
    bs, bf = assess_file("guide.zh-CN.md", "Only English here, no Chinese.\n", None)
    assert any("Missing 中文" in x["title"] for x in bf), \
        "should flag missing translation in .zh-CN doc"

    # Bands.
    assert band_of(9.0) == "excellent"
    assert band_of(6.5) == "good"
    assert band_of(5.0) == "needs-improvement"
    assert band_of(2.0) == "inadequate"

    # Binary detection.
    assert _looks_binary(b"\x00\x01PNG") is True
    assert _looks_binary(b"plain text here") is False

    print("OK")
    return 0


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def build_parser():
    p = argparse.ArgumentParser(
        prog="wording_judge.py",
        description="Deterministic documentation-copy + bilingual judge.")
    p.add_argument("path", nargs="?", help="File or directory to judge.")
    p.add_argument("--json", action="store_true", help="Emit a single JSON object.")
    p.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                   help="Overall pass threshold (default 6.0).")
    p.add_argument("--strict", action="store_true",
                   help="Also fail on any P1 finding.")
    p.add_argument("--glossary", default=None,
                   help="Override path to glossary.json.")
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
        result = judge_path(args.path, threshold=args.threshold,
                            strict=args.strict, glossary_path=args.glossary)
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
