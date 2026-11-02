#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
import time

PSQL = "/usr/lib/postgresql/16/bin/psql"
BACKUP = "/opt/sable/data/report_backup"

def dsn():
    out = subprocess.check_output(["bash", "-lc",
        "sed -n 's/^Environment=ARTEX_PG_DSN=//p' /etc/systemd/system/ning-backend.service | head -1 | tr -d '\"'"])
    return out.decode().strip()

DSN = dsn()

def q(sql):
    r = subprocess.run([PSQL, DSN, "-tAq", "-c", sql], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[:300])
    return r.stdout

def save(pid, text):
    path = "/tmp/rw_payload.json"
    body = json.dumps({"model": "deepseek-flash", "temperature": 0.2,
        "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": text}]}, ensure_ascii=False)
    open(path, "w", encoding="utf-8").write(body)
    key, base = q("SELECT api_key||'|'||base_url FROM llm_profiles WHERE id=2").strip().split("|")
    r = subprocess.run(["curl", "-s", "-m", "280", base.rstrip("/") + "/chat/completions",
        "-H", "Content-Type: application/json", "-H", f"Authorization: Bearer {key}",
        "--data-binary", "@" + path], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)["choices"][0]["message"]["content"]
    except Exception as e:
        return None

SYS = ("你是资深渗透测试报告编辑。把给定的漏洞材料**重组**为指定模板的中文报告。\n"
  "硬性规则：只允许使用材料里已有的数字、URL、字段名、响应片段；模板要求但材料没有的项，"
  "写「未测得」并一句话说明原因，绝不估算、绝不编造。"
  "CVSS 只能根据材料描述的利用条件推导，并在分数后标注「依据：…」；CWE 不确定就写「未分类」。"
  "必须完整输出九个章节（一、漏洞概述 … 九、数据处理说明），不能省略任何一节。"
  "只输出 Markdown 报告本身。")

def main():
    tpl = q("SELECT template_text FROM agent_prompts p JOIN agents a ON a.current_prompt_id=p.id WHERE a.key='reporter'").strip()
    i = tpl.find("━━ Report structure"); j = tpl.find("━━ Discipline")
    struct = tpl[i:j] if i >= 0 and j > i else tpl

    rows = q("SELECT id FROM findings WHERE length(COALESCE(report,'')) > 200 ORDER BY id").split()
    ids = [int(x) for x in rows if x.strip()]
    print(f"total findings: {len(ids)}", flush=True)

    ok, skipped, failed = 0, 0, 0
    for fid in ids:
        row = q(f"SELECT COALESCE(report,'')||'\\n<<<EVIDENCE>>>\\n'||COALESCE(evidence,'')||'\\n<<<META>>>\\n'"
                f"||COALESCE(severity,'')||'|'||COALESCE(vulnclass,'')||'|'||COALESCE(name,'')||'|'||COALESCE(task_id::text,'0') "
                f"FROM findings WHERE id={fid}")
        body, meta = row.split("<<<META>>>", 1)
        sev, vclass, name, tid = (meta.strip().split("|", 3) + ["", "", "", ""])[:4]

        cur = q(f"SELECT COALESCE(report,'') FROM findings WHERE id={fid}")
        if "## 九、数据处理说明" in cur:
            print(f"[{fid}] already new template, skip", flush=True)
            skipped += 1
            continue

        open(f"{BACKUP}/{fid}.md", "w", encoding="utf-8").write(cur)
        user = f"【模板要求】\n{struct}\n\n【已有材料】（finding #{fid}，task #{tid}，severity={sev}，class={vclass}，name={name}）\n{body}"
        print(f"[{fid}] rewriting {len(body)} chars ...", flush=True)
        out = save(fid, user)
        if not out:
            print(f"[{fid}] LLM call failed", flush=True); failed += 1; continue

        out = re.sub(r"^```(?:markdown|md)?\s*\n", "", out.strip())
        out = re.sub(r"\n```\s*$", "", out)
        missing = [s for s in ["## 一、漏洞概述", "## 二、影响范围", "## 三、复现步骤", "## 四、根因分析",
                               "## 五、证据", "## 六、危害说明", "## 七、修复建议", "## 八、参考资料",
                               "## 九、数据处理说明"] if s not in out]
        if missing or len(out) < 3000:
            print(f"[{fid}] REJECTED (missing={missing}, len={len(out)})", flush=True); failed += 1; continue

        open(f"/tmp/rw_{fid}.md", "w", encoding="utf-8").write(out)
        sql = f"UPDATE findings SET report=$rep${out}$rep$ WHERE id={fid};"
        open("/tmp/rw.sql", "w", encoding="utf-8").write(sql)
        r = subprocess.run([PSQL, DSN, "-q", "-f", "/tmp/rw.sql"], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[{fid}] SQL failed: {r.stderr[:160]}", flush=True); failed += 1; continue
        print(f"[{fid}] ok -> {len(out)} chars", flush=True)
        ok += 1
        time.sleep(1)

    print(f"DONE ok={ok} skipped={skipped} failed={failed}", flush=True)

if __name__ == "__main__":
    main()
