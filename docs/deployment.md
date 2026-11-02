# 部署说明

本文记录 Sable 在一台单机 Linux 上的完整部署方式。示例基于 Ubuntu 24.04 + Caddy 反代，
总内存 2 GB 起步，实际部署时建议 4 GB 以上（Chrome 截图和后端并行时内存吃紧）。

## 1. 环境要求

| 组件 | 版本 | 用途 |
|---|---|---|
| Go | 1.22+ | 编译后端 |
| Node.js | 20+ | 构建 / 运行控制台 |
| PostgreSQL | 16 | 主数据库（独立实例，端口 5433） |
| Chrome / Chromium | 任意近期版本 | 截图与浏览器类漏洞验证 |
| Python | 3.10+ | Word 导出、数据分析脚本 |
| python-docx | 1.x | `.docx` 生成 |

实测版本：

```
go 1.26.3     node v22.23.3     PostgreSQL 16.15
Chrome 156    python-docx 1.1.0
```

## 2. 目录布局

```
/opt/sable
├── bin/sable              后端可执行文件
├── src/                   后端源码（git 工作区）
├── web/                   前端（源码 + .next 产物 + node_modules）
├── tools/                 辅助脚本
│   ├── dataset_profile.py 批量数据的构成分析
│   ├── docx/md2docx.py    Markdown → Word
│   └── shot/shot.js       headless 截图（puppeteer-core）
├── pgdata/                PostgreSQL 数据目录
├── data/                  运行数据（任务、截图、抓包、会话）
├── logs/                  日志
└── run/                   PostgreSQL unix socket
```

## 3. 安装依赖

```bash
# 基础
sudo apt-get update
sudo apt-get install -y postgresql-16 caddy curl git

# 前端 / 后端工具链（按需，也可用系统包管理器之外的方式安装）
# Go 与 Node 建议装到 /opt/sable/go、系统 node 即可

# 截图与文档导出
sudo apt-get install -y google-chrome-stable python3-docx

# 截图脚本的依赖（只装库，不下载 Chromium）
cd /opt/sable/tools/shot && npm ci
```

## 4. 数据库

独立实例，避免与系统自带 PostgreSQL 冲突：

```bash
sudo -u postgres /usr/lib/postgresql/16/bin/initdb -D /opt/sable/pgdata
# 改端口与 socket 目录
sed -i "s|^#port = 5432|port = 5433|" /opt/sable/pgdata/postgresql.conf
sed -i "s|^#unix_socket_directories = .*|unix_socket_directories = '/opt/sable/run'|" /opt/sable/pgdata/postgresql.conf
```

创建数据库与账号（首次）：

```bash
sudo -u postgres /usr/lib/postgresql/16/bin/pg_ctl -D /opt/sable/pgdata start
sudo -u postgres psql -p 5433 -c "CREATE ROLE artex LOGIN SUPERUSER"
sudo -u postgres psql -p 5433 -c "CREATE DATABASE artex OWNER artex"
```

连接串（后端通过环境变量读取）：

```
ARTEX_PG_DSN=postgres://artex@127.0.0.1:5433/artex?sslmode=disable
```

> 表结构由后端启动时自动迁移，不需要手工执行 SQL。

## 5. 后端

```bash
cd /opt/sable/src
go build -trimpath -ldflags "-s -w" -o /opt/sable/bin/sable ./cmd/artex
```

启动参数：

| 参数 | 说明 |
|---|---|
| `-addr 127.0.0.1:8787` | HTTP API 监听地址 |
| `-data /opt/sable/data` | 运行数据根目录（必须绝对路径） |
| `-proxy 127.0.0.1:8888` | 录制代理监听地址；传空字符串即关闭抓包 |

systemd 单元 `/etc/systemd/system/sable-backend.service`：

```ini
[Unit]
Description=Sable backend
After=network.target sable-pg.service
Requires=sable-pg.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/sable
Environment=ARTEX_PG_DSN=postgres://artex@127.0.0.1:5433/artex?sslmode=disable
ExecStart=/opt/sable/bin/sable -addr 127.0.0.1:8787 -data /opt/sable/data -proxy 127.0.0.1:8888
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

## 6. 前端

```bash
cd /opt/sable/web
npm ci
npm run build
```

`next.config.mjs` 里必须配置 `basePath`，且要与反代前缀一致：

```js
basePath: "/sable",
```

systemd 单元 `/etc/systemd/system/sable-web.service`：

```ini
[Unit]
Description=Sable web console (Next.js on :8080)
After=network.target sable-backend.service
Wants=sable-backend.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/sable/web
Environment=AUTOPENTEST_API=http://127.0.0.1:8787
Environment=NODE_OPTIONS=--max-old-space-size=768
Environment=NEXT_TELEMETRY_DISABLED=1
ExecStart=/usr/bin/npx next start -H 0.0.0.0 -p 8080
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> `NODE_OPTIONS` 的堆上限很重要：2 GB 内存的机器上不限制会让 Node 把剩余内存吃光，
> 触发 OOM。768 MB 是 2 GB 机器上的经验值。

## 7. 反向代理（Caddy）

```caddyfile
:80 {
    encode gzip

    # 控制台：basePath 必须原样透传，不能 strip 前缀
    handle /sable* {
        reverse_proxy 127.0.0.1:8080
    }

    # 后端 API（前端走 /sable/api，由 Next 转发；这里给外部调用留口子）
    handle /api/* {
        reverse_proxy 127.0.0.1:8787
    }
}
```

```bash
sudo systemctl reload caddy
```

## 8. 可选组件

### 8.1 页面截图

截图脚本依赖系统 Chrome，只需要把路径写死到 `server/evidence_shot.go` 的 `chromeBin`：

```go
const chromeBin = "/usr/bin/google-chrome"
```

脚本入口：`/opt/sable/tools/shot/shot.js`（由后端以子进程方式调用）。
需要 `tools/shot/node_modules` 存在（`npm ci` 装一次）。

### 8.2 Word 导出

```bash
python3 -c "import docx; print('ok')"   # 必须能导入
```

后端通过 `server/finding_docx.go` 调用 `/opt/sable/tools/docx/md2docx.py`。
截图会在 Word 里插到报告出现 `![...](/sable/api/shots/...)` 的那个位置。

### 8.3 流量录制

默认开启（`-proxy 127.0.0.1:8888` 且 `settings.traffic_capture = true`）。
关闭方式：

```bash
# 临时：把启动参数改成 -proxy ""
# 或运行时：UPDATE settings SET value='false' WHERE key='traffic_capture';
```

开启后 worker 子进程会继承：

```
HTTP_PROXY / HTTPS_PROXY / ALL_PROXY = http://127.0.0.1:8888
SSL_CERT_FILE / CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE = <data>/traffic/_ca/mitmproxy-ca-cert.pem
```

## 9. 首次启动行为

1. 自动建表 / 迁移
2. 写入默认管理员账号（见 `server/auth.go` 的 `defaultUsername`）
3. 生成录制代理的 CA 证书（`data/traffic/_ca/`）
4. 注册内置工具与 agent 的默认 prompt
5. 启动截图扫描器、流量清理器、队列执行器

## 10. 升级

```bash
cd /opt/sable/src && git pull
go build -trimpath -ldflags "-s -w" -o /tmp/sable.new ./cmd/artex
sudo systemctl stop sable-backend
sudo mv /tmp/sable.new /opt/sable/bin/sable && sudo chmod +x /opt/sable/bin/sable
sudo systemctl start sable-backend

# 前端有改动时
cd /opt/sable/web && npm ci && npm run build && sudo systemctl restart sable-web
```

回滚：`git checkout <previous-commit>` 后重复上面的构建步骤。

## 11. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `sable-pg` 起不来，日志提示 socket 目录不存在 | `postgresql.conf` 里的 `unix_socket_directories` 指向了旧路径 | 改成 `/opt/sable/run` 并确保目录属主为运行用户 |
| 页面 404，但容器里 `curl 127.0.0.1:8080` 正常 | `basePath` 与反代前缀不一致 | 两者必须同为 `/sable` |
| 页面能开但接口全 404 | 前端产物里仍是旧前缀 | 改完 `next.config.mjs` 必须重新 `npm run build` |
| 截图步骤出现但图片是 0 字节 | 目标是纯 JSON 接口，Chrome 当成文件下载 | 属预期；该类型走文本证据 |
| 截图超时 | 目标站点资源多，Chrome 加载超过 90 秒 | 已知限制，会记录失败原因 |
| 内存持续上涨 | Node 堆未限制 / Chrome 并发 | 设 `NODE_OPTIONS=--max-old-space-size=768`；截图队列本身是串行的 |
| 抓包表为空 | 启动参数是 `-proxy ""` | 改成真实地址并重启 |
| 磁盘被日志/抓包吃满 | 长任务产生的流量 | 任务结束后未绑定的流量会自动清理；日志按需 `journalctl --vacuum` |

## 12. 安全建议

- 控制台默认只监听内网，对外请加 TLS（Caddy 自动证书）与访问控制
- 默认管理员口令仅用于首次登录，务必立即修改
- `data/` 目录包含客户证据（截图、响应体），权限收紧到运行用户
- 录制代理的 CA 私钥在 `data/traffic/_ca/`，泄露等同于中间人能力，不要提交到仓库
