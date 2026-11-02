#!/usr/bin/env python3
import os, re, subprocess, sys

PSQL = "/usr/lib/postgresql/16/bin/psql"
BK = "/opt/sable/data/report_backup/v6"

def dsn():
    return subprocess.check_output(["bash", "-lc",
        "sed -n 's/^Environment=ARTEX_PG_DSN=//p' /etc/systemd/system/ning-backend.service | head -1 | tr -d '\"'"]).decode().strip()

DSN = dsn()

def q(sql):
    r = subprocess.run([PSQL, DSN, "-tAq", "-c", sql], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[:300])
    return r.stdout

RE_TASK = re.compile(r'/opt/(?:ning|artex)/data/tasks/\d+/([^\s)"\'）]+)')
RE_ANY  = re.compile(r'(?:/opt|/home|/usr/local|/root)/[^\s)"\'）]+')
RE_PROJ = re.compile(r'(?i)\b(?:artex|ning)\b')

def scrub(text):
    text = RE_TASK.sub(r'\1', text)  # i579/ev_login.txt
    text = RE_ANY.sub('（受控目录）', text)
    text = RE_PROJ.sub('测试平台', text)
    return text

os.makedirs(BK, exist_ok=True)
ids = [int(x) for x in q("SELECT id FROM findings ORDER BY id").split() if x.strip()]
changed = 0
for fid in ids:
    cur = q(f"SELECT COALESCE(report,'') FROM findings WHERE id={fid}")
    new = scrub(cur)
    if new == cur:
        continue
    hits = len(RE_TASK.findall(cur)) + len(RE_ANY.findall(cur)) + len(RE_PROJ.findall(cur))
    open(f"{BK}/{fid}.md", "w", encoding="utf-8").write(cur)
    open("/tmp/sc.sql", "w", encoding="utf-8").write(f"UPDATE findings SET report=$r${new}$r$ WHERE id={fid};")
    subprocess.run([PSQL, DSN, "-q", "-f", "/tmp/sc.sql"], check=True)
    print(f"[{fid}] scrubbed {hits} occurrence(s), {len(cur)} -> {len(new)} chars", flush=True)
    changed += 1

left = q("SELECT count(*) FILTER (WHERE report ~* '(artex|ning)'), count(*) FILTER (WHERE report LIKE '%/opt/%') FROM findings").strip()
print(f"DONE scrubbed={changed}  remaining_name_or_path={left}", flush=True)
