# 部署到公网

这个项目是「Node.js 后端 + 静态前端」的一体服务：`node server.js` 同时提供页面和 `/api/*`，所以不能只把 `public/` 丢到 GitHub Pages。下面按「有无域名 / 有无服务器」分三条路，选一条即可。

> 我第一次交付时这台电脑没有外网出口，也没有任何云平台或 GitHub 的登录凭证，所以**没法替你把网址开出来**。仓库里已经放好部署文件，你按下面任意一条执行，10 分钟内能拿到一个 HTTPS 地址。

## 方案对比

| 方案 | 需要什么 | 网址 | 持久化 | 适合 |
| --- | --- | --- | --- | --- |
| Cloudflare Quick Tunnel | 本机 + `cloudflared` | 临时 `https://xxx.trycloudflare.com` | 本机 `data/` | 先给手机试、演示 |
| 云服务器 + Caddy | VPS + 域名 | 自己的 `https://stockradar.你的域名` | 服务器磁盘 | 长期自用（推荐） |
| Render / Railway | GitHub 仓库 | 平台分配的 `https://*.onrender.com` | 免费档会丢；付费加盘 | 不想管服务器 |
| Docker + 反代 | 任意能跑容器的机器 | 取决于你 | 挂载卷 | 已有 NAS / 容器平台 |

---

## A. 最快：Cloudflare Quick Tunnel（不用域名，不用公网 IP）

这是**完整版**（登录、账号、全量 K 线、自选同步）上公网最省事的方式，适合自己用、发给朋友试用。

```bash
# 1. 本机先把服务跑起来（HOST 用默认 localhost 即可）
npm start

# 2. 另开一个终端，装 cloudflared 后执行
cloudflared tunnel --url http://localhost:5173
```

Windows 上可以直接双击仓库里的 `scripts\tunnel.cmd`：它会启动服务、再起隧道，把两件事合并成一步（要求 `tools\bin\cloudflared.exe` 存在）。

输出里会出现一行 `https://随机词.trycloudflare.com`，这就是公网 HTTPS 地址，手机、别人的电脑都能打开，登录页、注册页、游客登录、自选同步全都可用。

注意：

- 进程关掉网址就失效，重启会换新域名，只适合演示和临时试用；电脑休眠/关机，链接就断。
- 这条隧道把你本机的服务暴露到公网，**别把 demo 账号密码发给无关的人**；用完 Ctrl+C。
- 想要固定域名，用 Cloudflare 账号建一条 Named Tunnel 绑定自己的域名（命令变成 `cloudflared tunnel run stockradar`），配置和证书都由 Cloudflare 管。
- 国内网络访问 `trycloudflare.com` 不一定稳定，长期用还是建议 B 方案。

## B. 长期：云服务器 + 域名（推荐）

**要买什么**：任意一台 2 核 2G 的 Ubuntu 22.04 / 24.04 云主机就够。阿里云、腾讯云的轻量应用服务器最低档大约 ¥24–60/月，Oracle Cloud「Always Free」可以白嫖。40G 系统盘足够（`data/` 现在约 20 MB，历史 K 线缓存以后会涨到几百 MB）。

**三条命令上线**（服务器上装好 git 即可）：

```bash
sudo git clone https://github.com/hanqi3/stock-radar-a-share.git /opt/stockradar
cd /opt/stockradar
sudo ./deploy/install.sh stockradar.example.com
```

`install.sh` 会：装 Node 22（如果还没有）、建 `stockradar` 系统用户、把数据放到 `/var/lib/stockradar`、装 systemd 服务并开机自启、写 `/etc/cron.d/stockradar`（工作日 17:30 全量同步、12:30 只刷新闻），最后给了域名就顺手装 Caddy 配好 HTTPS。

DNS：把域名的 A 记录指到服务器公网 IP，等一分钟访问 `https://stockradar.example.com`。

**它每天自动做什么**

| 时间（北京时间） | 任务 |
| --- | --- |
| 工作日 12:30 | `sync-news.js`：拉 5 家来源的新闻 / 公告，刷新事件列表 |
| 工作日 17:30 | 全量：行情快照 → 校验 → 板块 → 历史 K 线 → 财务 → 新闻 → 宏观 → 资金流 |

涨跌、涨停、成交额来自行情快照；「利好 / 利空」是新闻按板块和个股关联后算出的证据表，跟着新闻一起更新。服务端热加载，同步完访客刷新就能看到，不用重启进程。

**怎么知道它没跑**：顶栏日期超过 4 天会显示橙色「数据待更新」角标；`/api/health` 会返回 `dataAgeDays` 和 `stale`；日志在 `/var/lib/stockradar/cron.log`。

### 不用脚本，手动装

```bash
# 1. 拉代码并先手动跑一次
sudo mkdir -p /opt/stockradar && sudo chown "$USER" /opt/stockradar
git clone https://github.com/hanqi3/stock-radar-a-share.git /opt/stockradar
cd /opt/stockradar
HOST=127.0.0.1 PORT=5173 DATA_DIR=/var/lib/stockradar node server.js
curl -s http://127.0.0.1:5173/api/health

# 2. 交给 systemd
sudo useradd --system --home /opt/stockradar --shell /usr/sbin/nologin stockradar
sudo mkdir -p /var/lib/stockradar && sudo chown stockradar:stockradar /var/lib/stockradar
sudo cp deploy/stockradar.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now stockradar

# 3. Caddy 反代（文件在仓库 deploy/Caddyfile）
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # 改成自己的域名
sudo systemctl reload caddy
```

`DATA_DIR` 指向 `/var/lib/stockradar`，账号、会话、每个人的自选都不会随代码目录更新而丢。

### Docker 版本

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

镜像里自带 busybox cron，同样的 17:30 / 12:30 两条任务（时区由 `TZ=Asia/Shanghai` 决定）。数据落在仓库的 `data/`，`.cache/` 存历史 K 线。前面的 Caddy 一样反代到 `127.0.0.1:5173`。

### 用 CI 构建好的镜像（推代码即上线）

`Publish container image` 工作流在每次 push 到 `main`（以及数据同步任务跑完）时，把镜像推到 GitHub Container Registry：

```
ghcr.io/hanqi3/stock-radar-a-share:latest
ghcr.io/hanqi3/stock-radar-a-share:sha-<短 sha>
```

两个架构都构建（`linux/amd64` + `linux/arm64`），Oracle 免费 ARM 机器也能直接跑。

服务器上只需要一个目录和一份 compose 文件，**不用 clone 代码、不用本地构建**：

```bash
mkdir -p /opt/stockradar && cd /opt/stockradar
curl -fsSLO https://raw.githubusercontent.com/hanqi3/stock-radar-a-share/main/deploy/docker-compose.prod.yml
docker compose -f docker-compose.prod.yml up -d
```

之后要更新，二选一：

```bash
# 手动：拉新镜像再起
docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d
```

或者让 CI 自己来——在仓库 **Settings → Secrets and variables → Actions** 里加：

| 类型 | 名字 | 值 |
| --- | --- | --- |
| Variable | `DEPLOY_ENABLED` | `true` |
| Secret | `SSH_HOST` | 服务器 IP / 域名 |
| Secret | `SSH_USER` | 登录用户（要能跑 docker） |
| Secret | `SSH_KEY` | 该用户的私钥 |
| Secret | `DEPLOY_PATH` | `/opt/stockradar`（可省） |
| Secret | `SSH_PORT` | `22`（可省） |

设好后每次镜像构建成功，`deploy` 任务就会 SSH 过去 `pull` + `up -d`，最后打一次 `/api/health`。登录用户要么在 `docker` 组里，要么配好免 sudo 的 docker 权限。

> 镜像默认是私有的。想让服务器免登录拉取，到 GitHub 的 Packages → `stock-radar-a-share` → Package settings 里把可见性改成 public；否则先 `docker login ghcr.io -u <用户名>`（密码用 PAT，勾 `read:packages`）。

## C. Render（不想碰服务器）

仓库里的 `render.yaml` 是 Render Blueprint：

1. 把仓库推到 GitHub，打开 Render → New → Blueprint → 选这个仓库。
2. Render 会读 `render.yaml`，创建 Web Service，命令是 `node server.js`，健康检查 `/api/health`。
3. 部署完成后拿到 `https://stockradar-xxxx.onrender.com`。

免费实例的限制：

- 15 分钟无访问会休眠，首次打开要等十几秒。
- **没有持久盘**：每次重新部署，`data/users.json`、`data/sessions.json`、`data/watchlists/` 都会清空，账号要重新注册。
- 要保留账号，把 plan 换成 Starter 并按 `render.yaml` 里注释打开 Disk（`DATA_DIR=/var/data`）。

Railway / Fly.io 用同样的思路：启动命令 `node server.js`，环境变量 `HOST=0.0.0.0`、`DATA_DIR=<挂载卷路径>`，健康检查 `/api/health`，挂一个卷到 `DATA_DIR`。

## 账号与数据

| 路径 | 内容 | 备份 |
| --- | --- | --- |
| `data/users.json` | 邮箱 + scrypt 哈希 + salt | 必须 |
| `data/sessions.json` | 30 天会话 token | 建议 |
| `data/watchlists/<id>.json` | 每个账号的自选 | 必须 |
| `data/watchlist.json` | 旧版全局自选，未登录时使用 | 可选 |
| 其余 `data/*.json` | 行情 / 板块 / 事件等快照 | 可重新同步 |

定时备份（cron，每天 03:10）：

```bash
10 3 * * * tar -czf /var/backups/stockradar-$(date +\%F).tgz -C /var/lib stockradar
```

这些文件已在 `.gitignore` 里，不要提交到公开仓库。

## 每日数据更新

页面顶部的「更新 2026/10/18 18:31:19」是 `data/meta.json` 里的快照时间，**服务本身不会自己去交易所拉数据**——仓库带的是最后一次同步的结果。行情要每天变，就得在收盘后跑同步脚本（需要外网）：

```bash
cd /opt/stockradar
npm run update     # 全量行情快照（all-a-shares.json + meta.json）
npm run enrich     # 板块 / 历史 K 线 / 财务快照 / 新闻 / 宏观 / 资金流
```

建议挂在 cron 上，交易日 16:30 之后跑一次：

```cron
30 17 * * 1-5 cd /opt/stockradar && npm run update >> /var/log/stockradar-sync.log 2>&1 && npm run enrich >> /var/log/stockradar-sync.log 2>&1
```

Windows 机器上用的是仓库里的 `scripts/daily-sync.cmd`（等价于上面两条命令，日志写 `data/sync.log`），用任务计划程序每个工作日 17:30 跑一次即可：

```powershell
$root = "D:\path\to\stock-radar-a-share"
$action   = New-ScheduledTaskAction -Execute "$root\scripts\daily-sync.cmd" -WorkingDirectory $root
$trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "17:30"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "StockRadar Daily Sync" -Action $action -Trigger $trigger -Settings $settings -Force
```

`-StartWhenAvailable` 表示机器在 17:30 关机/睡眠、之后开机时会补跑一次。想手动试跑：`Start-ScheduledTask -TaskName "StockRadar Daily Sync"`。

同步脚本会重写 `data/*.json`；服务检测到文件变化后会自己重建缓存（先把旧快照继续发给访客，新快照解析完再换上），不需要重启进程。如果发现顶部日期一直不动，多半是脚本没跑成功：看一眼日志，或者手动 `npm run check` 确认数据文件齐全。

## 拿到网址之后

1. 手机浏览器打开地址 → 注册 → 把服务加到主屏幕（Safari 分享 → 添加到主屏幕）。
2. iOS 原生壳首次启动，登录页展开「服务器地址」，填 `https://stockradar.example.com`（必须是 HTTPS），再登录。
3. 网页版和 App 用同一套账号，自选会在服务端同步。

## 安全清单

- **必须 HTTPS**：登录 token 走 `Authorization` 头，明文 HTTP 会被中间人拿走。
- 注册/登录已按 IP 限流（注册 8 次/小时、登录失败 12 次/15 分钟），别把 `/api/auth/*` 放到没有限流的总入口再转发。
- 密码只存 scrypt 哈希，登录失败对不存在的账号也跑一次哈希，避免时序探测。
- 不要把 `data/users.json`、`data/sessions.json` 提交或放进静态目录。
- 只想给自己用：在 Caddy 前面加一层 Cloudflare Access，或把注册接口临时关掉（注册完自己账号后）。

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 502 / Bad Gateway | Node 没起或端口不对 | `systemctl status stockradar`，`curl http://127.0.0.1:5173/api/health` |
| 页面打开但一直「加载市场数据中」 | API 跨域或反代只转发了 HTML | 确认反代把 `/api/*` 一起转给 Node（本项目同源，无需额外 CORS） |
| 登录后立刻回到登录页 | token 失效或服务器换了 `DATA_DIR` | 清浏览器 localStorage 的 `stockradar-token`，重新登录 |
| 证书报错 | DNS 没生效 / 80 端口被墙 | `dig +short 你的域名`，放行 80/443 |
| 原生 App 白屏 | 壳里没填服务器地址 | 登录页展开「服务器地址」填 HTTPS 地址 |
| 账号突然全没了 | 平台重新部署且没挂持久盘 | 换 B 方案或给平台加盘，用备份恢复 |
