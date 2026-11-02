#!/usr/bin/env python3
"""Profile an exported dataset so a report states what is actually sensitive.

Why this exists: a bulk-export finding usually quotes the server's own `total` (say
"10,919 records leaked"). That number is almost never the harm — in practice most of it
is seeded test data. This splits total from sensitive and prints a Markdown block the
reporter can paste into 二、影响范围.

Usage:
    dataset_profile.py <file> [--md] [--top N]

Accepts .jsonl, .json (array / wrapper object) and .csv. Pure stdlib.
"""
import csv
import json
import os
import sys
from collections import Counter

SENSITIVE_HINTS = {
    "email": ("email", "mail"),
    "phone": ("phone", "mobile", "tel", "cellphone", "dingding"),
    "name": ("name", "realname", "cn", "fullname"),
    "id": ("idcard", "id_card", "personid", "employeeid", "staffno"),
    "address": ("address", "addr", "street", "city"),
    "credential": ("token", "password", "passwd", "secret", "apikey", "session"),
    "payroll": ("salary", "amount", "price", "order", "bank", "card"),
}
TEST_HINTS = ("test", "demo", "sample", "dummy", "mock", "qa", "dev", "stage", "sandbox")

# Dimensions worth grouping by are categorical columns: department, status, type, org.
GROUP_NAME_HINTS = ("dept", "department", "org", "team", "group", "category", "type",
                    "status", "source", "channel", "region", "role", "kind", "tenant")
MAX_GROUPS = 120      # department lists can be long; 120 still filters out ids/hashes
ID_HINTS = ("id", "hash", "uuid", "key", "token", "time", "date", "at")



def deepest_list(obj, depth=0):
    """Find the longest list anywhere in a JSON object.

    Export endpoints usually wrap rows ("result": {"list": [...]}), so looking only at
    the top level counts the whole document as one row and reports "1 record".
    """
    best: list = []
    if depth > 5:
        return best
    if isinstance(obj, list):
        if len(obj) > len(best) and obj and isinstance(obj[0], dict):
            best = obj
        for v in obj[:30]:
            cand = deepest_list(v, depth + 1)
            if len(cand) > len(best):
                best = cand
    elif isinstance(obj, dict):
        for v in obj.values():
            cand = deepest_list(v, depth + 1)
            if len(cand) > len(best):
                best = cand
    return best

def load(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".csv":
        with open(path, encoding="utf-8", errors="replace", newline="") as f:
            return list(csv.DictReader(f))
    if ext in (".jsonl", ".ndjson"):
        rows = []
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    v = json.loads(line)
                    if isinstance(v, dict):
                        rows.append(v)
                except Exception:
                    continue
        return rows
    with open(path, encoding="utf-8", errors="replace") as f:
        v = json.load(f)
    if isinstance(v, list):
        return [x for x in v if isinstance(x, dict)]
    if isinstance(v, dict):
        rows = deepest_list(v)
        if rows:
            return [x for x in rows if isinstance(x, dict)]
        return [v]
    return []


def classify(key):
    k = key.lower()
    for label, hints in SENSITIVE_HINTS.items():
        if any(h in k for h in hints):
            return label
    return None


def is_scalar(v):
    return isinstance(v, (str, int, float, bool)) or v is None


def profile(rows, top_n=8):
    n = len(rows)
    out = {"total": n, "fields": {}, "groups": {}, "sensitive": {}}
    if not n:
        return out

    keys = set()
    for r in rows[: min(n, 3000)]:
        keys.update(r.keys())

    for k in sorted(keys):
        vals = [r.get(k) for r in rows]
        present = sum(1 for v in vals if v not in (None, "", []))
        # A column holding objects/arrays is not a usable grouping dimension.
        scalar = all(is_scalar(v) for v in vals[: min(n, 500)] if v not in (None, "", []))
        distinct = len({str(v) for v in vals if v not in (None, "", [])})
        out["fields"][k] = {"present": present, "distinct": distinct, "scalar": scalar}
        label = classify(k)
        if label:
            out["sensitive"][k] = {"label": label, "present": present, "distinct": distinct}

    for k, meta in out["fields"].items():
        if not meta["scalar"] or classify(k):
            continue
        if not (1 < meta["distinct"] <= MAX_GROUPS):
            continue
        if meta["present"] < n * 0.3:
            continue
        low = k.lower()
        if any(h in low for h in ID_HINTS) and not any(h in low for h in GROUP_NAME_HINTS):
            continue
        counter = Counter(str(r.get(k) or "(empty)") for r in rows)
        out["groups"][k] = counter.most_common(top_n)
    return out


def pick_bulk(groups, total, top_n=8):
    """Every concentrated bucket whose value reads as test/demo/qa, not just the biggest.

    A dataset like cloud-test(9,237) + testData(1,525) + cloudtest(16) has to be excluded
    in full — subtracting only the largest bucket would still overstate the sensitive
    remainder by an order of magnitude.
    """
    buckets = []
    for field, items in groups.items():
        for value, count in items:
            if value == "(empty)" or count < total * 0.001:
                continue
            if any(h in value.lower() for h in TEST_HINTS):
                buckets.append((field, value, count))
    buckets.sort(key=lambda x: -x[2])
    return buckets


def rows_outside(rows, buckets):
    """Rows that match none of the test buckets."""
    if not buckets:
        return list(rows)
    def is_test(r):
        return any(str(r.get(f) or "") == v for f, v, _ in buckets)
    return [r for r in rows if not is_test(r)]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    path = args[0]
    as_md = "--md" in sys.argv
    rows = load(path)
    p = profile(rows)
    n = p["total"]
    if not n:
        print("no rows parsed")
        return 1

    buckets = pick_bulk(p["groups"], n)
    rest = rows_outside(rows, buckets)

    lines = []
    if as_md:
        lines.append("| 指标 | 数值 | 口径 |")
        lines.append("|---|---|---|")
        lines.append(f"| 导出记录总数 | **{n}** | 文件行数 |")
        if buckets:
            total_test = n - len(rest)
            top = buckets[0]
            desc = ", ".join(f"`{v[:24]}`={c}" for f, v, c in buckets[:4])
            lines.append(f"| 主要批量来源 | **{total_test} 条（{total_test/n*100:.1f}%）** | 测试/生成数据桶：{desc} |")
            lines.append(f"| 排除该来源后的记录 | **{len(rest)} 条（{len(rest)/n*100:.1f}%）** | 需人工确认这部分才是真实数据 |")
        else:
            lines.append("| 主要批量来源 | 未识别到占 ≥10% 的测试桶 | 全部记录都可能是真实数据，需人工抽查 |")
        for k, meta in sorted(p["sensitive"].items(), key=lambda kv: -kv[1]["present"])[:8]:
            lines.append(f"| 含 `{k}`（{meta['label']}） | {meta['present']} / {n}（{meta['present']/n*100:.1f}%） | 有值记录数 |")
        if p["groups"]:
            lines.append("")
            lines.append("按维度分布：")
            for field, items in list(p["groups"].items())[:4]:
                shown = ", ".join(f"`{v[:32]}`={c}" for v, c in items[:6])
                lines.append(f"- `{field}`：{shown}")
    else:
        lines.append(f"total rows: {n}")
        if buckets:
            total_test = n - len(rest)
            lines.append(f"test buckets: {', '.join(f'{f}={v[:24]}({c})' for f,v,c in buckets[:4])}")
            lines.append(f"test rows: {total_test} ({total_test/n*100:.1f}%) | outside: {len(rest)} ({len(rest)/n*100:.1f}%)")
        else:
            lines.append("bulk bucket: none found (>=10% test-looking)")
        lines.append("sensitive fields:")
        for k, meta in sorted(p["sensitive"].items(), key=lambda kv: -kv[1]["present"])[:10]:
            lines.append(f"  {k} ({meta['label']}): {meta['present']}/{n}")
        lines.append("grouping:")
        for field, items in list(p["groups"].items())[:4]:
            lines.append(f"  {field}: " + ", ".join(f"{v[:30]}={c}" for v, c in items[:5]))

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
