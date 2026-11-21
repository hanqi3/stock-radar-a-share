# iPhone App 使用与构建指南

StockRadar 现在有两种在手机上使用的方式，共用同一套账号和后端：

| 方式 | 需要什么 | 有效期 | 适合 |
| --- | --- | --- | --- |
| **PWA（加主屏幕）** | 一台能访问后端的 iPhone | 长期 | 立刻可用，先体验 |
| **Capacitor 原生壳 + 侧载** | 免费 Apple ID + 一台 Windows/Mac + 数据线 | 7 天，到期重签 | 想要桌面图标、全屏、离线启动页 |

原生壳只是把 `public/` 里的网页装进一个 iOS 容器，业务代码仍然只有一份。登录页、注册页、底部五个标签（主力资金 / 股票 / 新闻政策 / 我的自选 / 明日参考）在浏览器和 App 里完全一致。

---

## 1. 部署后端

账号体系是服务端的一部分，App 只是客户端，所以先把 `server.js` 跑在一台手机能访问的机器上。

```bash
# 在仓库根目录
HOST=0.0.0.0 PORT=5173 node server.js
```

- `HOST=0.0.0.0` 才会监听局域网/公网；默认只监听 `localhost`。
- 云主机记得在安全组放行端口，或用反向代理。
- 运行时不需要 `npm install`：服务端只用 Node 内置模块（`pinyin-pro` 仅用于生成拼音索引，不在运行时使用）。
- 数据在 `data/` 下：行情数据是只读的，账号文件 `users.json`、`sessions.json`、`watchlists/` 会自动创建，**不要提交到 git**（已在 `.gitignore` 中）。

### 强烈建议套一层 HTTPS

iOS 的 ATS 默认禁止 `http://`。构建流程里已经加了 `NSAllowsArbitraryLoads` 兜底，但正式使用还是建议用 Caddy/Nginx 配好证书，然后在 App 里填 `https://你的域名`。

Caddy 例子（自动申请证书）：

```
stock.example.com {
    reverse_proxy 127.0.0.1:5173
}
```

### 账号相关行为

- 注册：邮箱 + 8–128 位密码，昵称可选；同一 IP 每小时最多 8 次。
- 登录：同一 IP 每 15 分钟最多 12 次失败尝试。
- 会话：Bearer token，30 天有效；退出登录立即失效。
- 容量：单进程 JSON 存储，最多 5000 个账号，个人/家庭使用足够。
- 每个账号的自选股保存在 `data/watchlists/<用户 id>.json`，未登录时仍回落到旧的 `data/watchlist.json`（定时推送任务继续用它）。

跨域已经处理好：浏览器同源访问不需要配置；原生壳从 `capacitor://localhost` 访问时会带 CORS 头，预检请求返回 204。

---

## 2. 方式一：PWA，现在就能用

1. iPhone Safari 打开 `https://你的域名/`（或 `http://局域网IP:5173/`）。
2. 会先跳到登录页，注册或登录。
3. 点 Safari 底部分享按钮 → **添加到主屏幕**。
4. 从主屏幕图标启动，就是全屏、无地址栏的独立窗口。

这是最快看到效果的方式，不需要 Mac、不需要 Apple ID、不会过期。

---

## 3. 方式二：构建原生壳（GitHub Actions）

本机没有 macOS/Xcode 也能拿到 `.ipa`：仓库里的 `.github/workflows/ios-build.yml` 会在 GitHub 的 macOS 机器上完成打包。

触发方式：推送到 `main` 且改动涉及 `public/`、`capacitor.config.json`、`package.json`、`resources/`，或者手动在 **Actions → iOS build (unsigned) → Run workflow**。

产物有两个 artifact：

- `StockRadar-unsigned-ipa`：未签名安装包
- `ios-project`：完整的 Xcode 工程（想在 Mac 上改原生配置时用）

构建流程做了什么：

1. `npm install`，首次运行时 `npx cap add ios` 生成 `ios/` 工程；
2. `npx capacitor-assets generate --ios` 用 `resources/icon.png`、`resources/splash.png` 生成图标和启动图；
3. `npx cap sync ios` 把 `public/` 拷进壳里；
4. 给 `Info.plist` 加 ATS 例外和局域网权限说明；
5. `xcodebuild ... CODE_SIGNING_ALLOWED=NO` 编出未签名 `.app`，再压成 `Payload/StockRadar.app` 的 `.ipa`。

在 Mac 上手动构建（可选）：

```bash
npm install
npx cap add ios        # 只需第一次
npx capacitor-assets generate --ios
npx cap sync ios
npx cap open ios       # 打开 Xcode，选真机运行
```

`capacitor.config.json` 里已经固定：`appId com.hanqi.stockradar`、`webDir public`、`contentInset never`。

---

## 4. 侧载到 iPhone（免费 Apple ID）

未签名的 `.ipa` 不能直接安装，需要用 Sideloadly 这类工具用你自己的 Apple ID 签名。

1. Windows 装 [Sideloadly](https://sideloadly.io/) 和 iTunes（或 Apple Devices 应用，保证驱动可用）。
2. iPhone 用数据线连电脑，信任此电脑。
3. Sideloadly 选择 `StockRadar-unsigned.ipa`，Apple ID 填你的免费账号，点 Start。
4. 首次安装后，iPhone 设置 → 通用 → VPN 与设备管理 → 信任你的开发者证书。
5. 打开 App，登录页会**强制展开"服务器地址"**，填后端地址，例如：
   - 局域网：`http://192.168.1.10:5173`
   - 公网：`https://stock.example.com`
6. 注册/登录后进入主界面，底部就是五个标签。

免费账号的限制：

- 签名 **7 天**后失效，需要重新侧载一次（账号和自选都在服务器上，不会丢）。
- 同一时间最多 3 个自签 App。
- 不需要越狱。

---

## 5. App 内如何切换服务器

点右上角头像 → 账户面板，可以：

- 查看当前账号；
- 修改服务器地址（下次启动生效）；
- 退出登录（清掉本地 token，回到登录页）。

网页版把服务器地址留空即可（同源）；只有原生壳或前后端分开部署时才需要填。

---

## 6. 已知限制

- **没有 APNs 推送**。iOS 原生推送需要 Apple 开发者账号和推送证书，免费账号做不到；现有的提醒仍以 App 内提示/后端定时任务的形式工作。
- **未签名包必须自行签名**，CI 不保存任何证书；签名在 Sideloadly/AltStore 本地完成。
- 免费账号 7 天过期是苹果的限制，不是 App 的问题。
- 服务端是单进程 JSON 存储，不适合多实例横向扩展；个人使用没问题，后面要扩容可以换 SQLite/Postgres。
- 局域网 `http://` 依赖 CI 里加的 ATS 例外；如果自己去掉了这个例外，就必须用 HTTPS。

---

## 7. 常见问题

**打开 App 白屏 / 一直停在加载**

- 先确认登录页能出现；白屏通常是 token 失效后又被接口 401 送回登录页，重新登录即可。
- 服务器地址不要带结尾斜杠，也不要带 `/api`。

**提示"无法连接服务器"**

- 手机和服务器不在同一网络，或云主机安全组没放行端口。
- 用了 `https://` 但证书无效时，Safari/WebView 会直接拒绝。
- 服务端是否用 `HOST=0.0.0.0` 启动。

**登录后马上又跳回登录页**

- 服务端时间不对导致 token 立即过期，或 `data/sessions.json` 被清空。重新登录即可。

**表格在手机上太宽**

- 表格区域本身可以左右滑动，这是刻意保留的；页面整体不会横向溢出。
