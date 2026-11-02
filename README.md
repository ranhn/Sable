<div align="center">

# Sable

**AI 自主渗透测试平台**
Go 后端 · Next.js 控制台 · PostgreSQL

</div>

---

Sable 是一个自主渗透测试系统。给定目标范围后，它自行规划攻击阶段、调用工具、留存证据，
并把结果整理成可直接交付的漏洞报告。

## 核心能力

| 能力 | 说明 |
|---|---|
| **自主规划** | Planner 把目标拆成意图（intent），Worker 并行执行，按事实（fact）推进，不依赖固定剧本 |
| **工具链** | 内置 httpx / nuclei / ffuf / nmap / subfinder / katana，Bash 与浏览器 MCP 均可调用 |
| **流量录制** | 所有工具流量经 MITM 代理（默认 `127.0.0.1:8888`），可回放到单个请求 |
| **证据截图** | 页面类漏洞自动截图：匿名页直接抓取，登录页注入测试账号 cookie，XSS 用 CDP 捕获弹窗 |
| **报告生成** | 中文九节模板，结构校验后才入库；一键导出 Word（截图嵌在对应步骤） |
| **数据构成分析** | 批量导出类漏洞自动拆分「服务端自报总量」与「真实敏感记录数」 |
| **任务内对话** | 队列 / 打断 / 暂停 / 重排，长任务可中途介入 |

## 快速开始

### 依赖

```
Go 1.22+     Node.js 20+      PostgreSQL 16
Chrome/Chromium（截图与浏览器工具）    Python 3 + python-docx（Word 导出）
```

### 构建与运行

```bash
# 后端
go build -o bin/sable ./cmd/artex
./bin/sable -addr 127.0.0.1:8787 -data ./data -proxy 127.0.0.1:8888

# 前端
cd web && npm ci && npm run build && npx next start -p 8080
```

首次启动会写入默认管理员账号，并自动迁移数据库结构。

### 配置

复制 `config.example.json` 为 `config.json`，填入 LLM 端点与密钥；
数据库连接通过 `ARTEX_PG_DSN` 环境变量提供：

```bash
export ARTEX_PG_DSN='postgres://user@127.0.0.1:5433/sable?sslmode=disable'
```

## 目录结构

```
agent/        Agent 运行时（planner / worker / reporter / retester）
server/       HTTP API、任务编排、证据系统
db/           PostgreSQL 访问层与 schema
traffic/      MITM 录制与索引
evidence/     证据存储
report/       报告渲染
web/          Next.js 控制台
tools/        辅助脚本（截图、Word 转换、数据分析）
```

## 交付物形态

一条漏洞最终产出：

1. **报告**：九节结构（概述 / 影响范围 / 复现步骤 / 根因 / 证据 / 危害 / 修复 / 参考 / 数据处理）
2. **PoC**：复制即跑，参数完整、无掩码、无占位符
3. **截图**：页面类漏洞附实际渲染图
4. **流量**：原始请求/响应可回放

导出的 Word 文档保持同一顺序，截图出现在产生它的那个步骤下方。

## 许可与归属

Sable 基于 [Autumn-27/ARTEX](https://github.com/Autumn-27/ARTEX) 二次开发，遵循 Apache-2.0。
上游版权归原作者所有；本项目在其基础上的改动见提交历史。

> 仅用于**获得授权**的安全测试。使用者需自行确保目标在授权范围内。
