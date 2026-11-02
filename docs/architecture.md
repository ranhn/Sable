# 架构说明

Sable 由四个进程组成：反向代理、Next.js 控制台、Go 后端、PostgreSQL。
其中 Go 后端进程内部还托管着录制代理（MITM）与截图队列。

## 1. 进程与端口

```
                    ┌─────────────────────────────────────────────┐
   浏览器  ──80──▶  │  Caddy                                      │
                    │    handle /sable*      → 127.0.0.1:8080     │
                    │    handle /api/*       → 127.0.0.1:3000     │
                    └───────────────┬─────────────────────────────┘
                                    │
                    ┌───────────────▼─────────────┐
                    │  sable-web  (Next.js)       │   basePath = /sable
                    │  127.0.0.1:8080             │   静态产物 + SSR
                    └───────────────┬─────────────┘
                                    │  AUTOPENTEST_API
                    ┌───────────────▼─────────────────────────────┐
                    │  sable-backend (Go)  127.0.0.1:8787         │
                    │                                             │
                    │  ┌──────────────┐   ┌───────────────────┐   │
                    │  │ Agent 运行时  │   │ HTTP API          │   │
                    │  │ planner      │   │ /api/*            │   │
                    │  │ worker × N   │   └───────────────────┘   │
                    │  │ reporter     │                           │
                    │  │ retester     │   ┌───────────────────┐   │
                    │  └──────┬───────┘   │ 录制代理 MITM      │   │
                    │         │           │ 127.0.0.1:8888    │   │
                    │         │           └─────────┬─────────┘   │
                    │         │                     │             │
                    │  ┌──────▼───────┐             │             │
                    │  │ 截图队列      │             │             │
                    │  │ (puppeteer)  │             │             │
                    │  └──────┬───────┘             │             │
                    └─────────┼─────────────────────┼─────────────┘
                              │                     │
                     ┌────────▼────────┐   ┌────────▼─────────┐
                     │ Chrome headless │   │ 扫描目标          │
                     │ 截图 / XSS 复现  │   │ (授权范围内)      │
                     └─────────────────┘   └──────────────────┘
                    ┌─────────────────────────────────────────────┐
                    │  sable-pg  PostgreSQL 16   127.0.0.1:5433   │
                    └─────────────────────────────────────────────┘
```

## 2. Agent 拓扑

Agent 不是一条直线流程，而是「规划—执行—收敛」的循环：

```
                    ┌──────────────┐
       目标/范围 ──▶ │   Planner    │  读 goal + facts + assets
                    │              │  产出 intent（意图）、判定 goal 是否达成
                    └──────┬───────┘
                           │  intent 入队
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ work#1   │ │ work#2   │ │ work#3   │   并行执行
        │ (Worker) │ │ (Worker) │ │ (Worker) │   Bash / 浏览器 / 工具链
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │            │            │  写 fact（结论/证据）
             └────────────┼────────────┘
                          ▼
                 ┌─────────────────┐
                 │ exploration_nodes│  intent / fact / goal / finding 节点图
                 └────────┬────────┘
                          │  worker 确认漏洞时调用 report_finding
                          ▼
                 ┌─────────────────┐        ┌──────────────┐
                 │    Reporter     │───────▶│  结构校验     │ 九节齐全 + 脱敏
                 │  (按 finding)    │        │  才允许入库   │
                 └─────────────────┘        └──────┬───────┘
                                                   ▼
                                            findings.report
                                                   │
                                    ┌──────────────┴────────────┐
                                    ▼                           ▼
                            详情页 / Word 导出            Retester 复测
```

关键点：

- **Planner 不以“挖到洞”为终点**，它以 goal 的达成条件为准。goal 里写了覆盖率要求，它就会安排覆盖率推进的 intent。
- **Worker 之间不共享上下文**，只通过 `facts` 交换结论；这样并行时不会互相污染。
- **Reporter 按 finding 独立触发**，一次报告一个漏洞，互不影响。

## 3. 请求与证据流

```
Worker 执行 curl / httpx / nuclei
        │
        │  子进程继承 HTTP_PROXY=127.0.0.1:8888
        ▼
   ┌─────────────┐   原始报文    ┌──────────────────┐
   │ MITM 代理    │ ───────────▶ │ traffic 索引      │  _index/index.sqlite
   │ (录制)       │              │  _blobs/（响应体） │
   └──────┬──────┘               └────────┬─────────┘
          │ 转发                           │
          ▼                                │
     目标资产                              │ finding 绑定时生成快照
                                           ▼
                                  traffic_evidence_snapshots
                                           │
                                           ▼
                                  finding_traffic_bindings
                                  （绑定后该流量不可再被清理）
```

- 任务结束后，**未被任何 finding 绑定的流量**会在宽限期后清除（`server/traffic_prune.go`）。
- 抓包是可选的：`-proxy ""` 关闭，`-proxy 127.0.0.1:8888` 开启；开关同时受 `settings.traffic_capture` 控制。

## 4. 截图流水线

只有「浏览器里看得见」的漏洞才截图，其他类型用文本证据：

```
finding 落库
   │
   ▼
分类器（每 20 秒扫一次）
   │  命中 xss / csrf / clickjacking / html injection
   │  或 evidence 里出现 <html / text/html / 渲染 / 弹窗
   ├─ 否 ─▶ 跳过（不产生空步骤）
   └─ 是 ─▶ 截图队列（串行，避免 Chrome 抢内存）
              │
              ├─ 注入 cookie（有测试账号时）
              ├─ 监听 CDP dialog（XSS 时记录弹窗 message）
              ▼
        /data/shots/<task>/finding-<id>-<ts>.png
              │
              ▼
        写 activity（tool=capture_screenshot）
              │
              ▼
        前端在该步骤输出下方渲染缩略图
        Word 导出时插到同样的位置
```

截图失败也会写一条记录并说明原因（JSON 响应、需要登录、超时），不会静默缺失。

## 5. 数据模型（核心表）

```
tasks                任务：目标范围、goal、状态、超时
 └ exploration_nodes 节点图：intent（意图）/ fact（事实）/ goal（目标）/ finding（漏洞）
     └ findings      漏洞：名称、等级、证据、报告、CVSS
         ├ finding_traffic_bindings   绑定的流量（证据）
         └ retests                    复测记录

activity             所有 agent 步骤（tool_use / tool_result / thinking / text）
conversations        agent 会话（reporter 每个 finding 一个）
chat_inputs          任务内对话的输入队列
chat_control         对话游标（revision / paused）
settings             运行时开关（traffic_capture、python 解释器等）
llm_usage            每次 LLM 调用的 token 明细
```

## 6. 报告产出链路

```
report_finding（worker 确认漏洞）
   → 触发 reporter（独立会话，并行度为 5）
   → reporter 读 evidence + 执行轨迹 + 同任务其他 finding
   → update_finding_report
        ├ 结构校验：九节齐全、>1500 字，否则拒绝并让 agent 重写
        ├ 脱敏：剥离 /opt/... 本地路径、平台名
        └ 写 findings.report
   → 详情页渲染（Markdown）
   → 导出 Word：md2docx.py 解析 ![](/sable/api/shots/...) 并按位置插图
```

## 7. 部署形态

```
/opt/sable
├── bin/sable          后端可执行文件
├── src/               后端源码（git 仓库）
├── web/               前端产物 + 源码（basePath=/sable）
├── tools/             辅助脚本（截图、docx、数据分析）
├── pgdata/            PostgreSQL 数据目录
├── data/              运行数据
│   ├── tasks/<id>/    每个任务的意图目录（命令输出、证据文件）
│   ├── shots/<id>/    截图
│   ├── traffic/       抓包索引与响应体
│   ├── sessions/      agent 会话工作目录
│   ├── transcripts/   步骤流水（jsonl）
│   └── report_backup/ 报告改写前的备份
├── logs/              服务日志
└── run/               PostgreSQL unix socket
```
