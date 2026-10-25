# AeroAtlas · 全球机场图鉴

一个 Volanta 风格的全球机场地图网页：全屏暗色航图、全球机场点阵、ICAO 四字码搜索、收藏与金色星标高亮。

![AeroAtlas 首页](shots/preview-home.png)

## 功能

- **全球机场地图**：收录 22,135 座拥有 ICAO 四字码的机场（241 个国家 / 地区），按大型 / 中型 / 小型 / 水上基地 / 直升机场分层渲染。全球视图先显示大型 / 中型机场，放大到 Z3 后自动加入全部机场；支持缩放、拖拽与全球视图。
- **ICAO 搜索**：输入四字码即时匹配，支持前缀（如 `EG` 列出伦敦机场群）；同时支持机场名称、城市和 IATA 代码。`Enter` 直接打开最佳结果。
- **机场详情**：大号 ICAO、IATA、城市/国家、经纬度、海拔、定期航班状态，以及跑道长度与道面；地图同步绘制所选机场的真实跑道。
- **收藏系统**：机场卡片或搜索结果右侧的星标即可收藏；游客模式下写入浏览器 `localStorage`，登录后写入当前账号的本地账号文件。
- **账号系统**：本地登录 / 注册界面，收藏夹与账号绑定；账号、密码哈希和收藏保存在 `storage/accounts.json`。
- **收藏备份**：侧栏收藏标题右侧的「备份」菜单可一键导出 / 导入 JSON 文件，导入会与现有收藏合并，适合换电脑或清理浏览器前留档。
- **地图特殊显示**：收藏机场以**金色星标 + 呼吸脉冲光环**显示，高缩放时附带 ICAO 标签；「仅显示收藏」会把地图聚焦到全部收藏。
- **收藏夹面板**：收藏列表、最近查看、热门机场、一键定位收藏。
- **响应式**：桌面为左侧控制台 + 右侧机场卡片；移动端自动变为底部抽屉与底部卡片。
- **可分享链接**：`?icao=KJFK` 直接打开机场；`?fav=KJFK,EGLL&favonly=1` 分享收藏视图。
- **离线兜底**：底图瓦片不可达时自动切换为本地 Natural Earth 海岸线底图，机场数据与搜索始终可用。

## 运行

### 本地账号版（推荐）

双击 **`start.bat`**。它会用内置的 Python 运行时在后台启动本地服务，等接口就绪后自动打开：

```text
http://127.0.0.1:8000/
```

如果浏览器显示 `ERR_CONNECTION_REFUSED`，说明后台服务没有运行：再双击一次 `start.bat`，等 1-2 秒后刷新页面即可。

停止服务：双击 **`stop-server.bat`**。浏览器可以随时关闭，服务在后台继续运行；下次双击 `start.bat` 会复用已运行的服务。

![账号登录界面](shots/preview-account.png)

登录后，侧栏会显示当前账号和收藏同步状态：

![登录后的账号收藏](shots/preview-account-logged.png)

账号功能需要这个本地服务。服务自动把账号和收藏写入：

```text
storage/accounts.json
storage/sessions.json
```

### 游客模式

直接双击 `index.html` 仍是游客模式：地图、搜索、收藏、备份都能用，但登录/注册会提示需要本地服务，收藏只保存在当前浏览器。

> 公开的 GitHub Pages 是纯静态托管，无法运行本地文件后端，因此公开站点的登录/注册不可用；账号版请在自己电脑上通过 `start.bat` 使用。若想在公网提供账号，需要额外的云后端。

> 底图瓦片、字体与图标来自 OpenFreeMap（在线），因此首次打开需要联网；机场索引、搜索和收藏完全本地化。

## 账号与本地服务

- `server.py` 提供静态页面、注册、登录、会话和收藏同步接口；前端通过 `/api/*` 调用。
- 密码使用 **PBKDF2-HMAC-SHA256**（210,000 次迭代）加盐哈希，`storage/accounts.json` 中不保存明文密码。
- 会话使用 HttpOnly Cookie，有效期 7 天；服务重启后登录状态仍可通过 `storage/sessions.json` 恢复。
- 注册时会把当前游客收藏归入新账号；登录后会切换到该账号的收藏，退出后恢复游客收藏。
- 账号文件是本机文件，**换电脑时复制 `storage/` 或使用「备份 → 导出收藏」迁移**；不要把 `storage/` 上传到公开仓库。
- 如果希望局域网内其他电脑使用账号版，可在项目目录执行：
  ```bash
  runtime\python.exe server.py --host 0.0.0.0
  ```
  然后让其他电脑访问 `http://<这台电脑的局域网IP>:8000/`。账号文件仍只保存在这台电脑上。
- 本地目录里的 `runtime/` 是内置的 Windows Python 3.12 运行时，体积较大，已在 `.gitignore` 中排除；GitHub 仓库不包含它。从仓库下载后，如电脑没有 Python，请安装 Python 3.10+，或直接把本地的 `runtime/` 目录一起复制过去；`start.ps1` 会自动尝试 `runtime\python.exe` 或系统 `python`。

## 操作

| 操作 | 说明 |
| --- | --- |
| `/` 或 `Ctrl/Cmd + K` | 聚焦搜索框 |
| `↑` / `↓` | 切换搜索结果 |
| `Enter` | 打开当前结果 |
| `Esc` | 关闭搜索面板 / 机场卡片 |
| `F` | 收藏或取消收藏当前机场 |
| 点击地图空白 | 关闭机场卡片 |
| 点击星标 | 打开对应收藏机场 |

## 数据

- 机场、跑道、国家： [OurAirports](https://ourairports.com/data/)（公共领域），构建快照 2026-10-25。
- 底图：[OpenFreeMap](https://openfreemap.org/) / [OpenMapTiles](https://openmaptiles.org/) / [OpenStreetMap](https://www.openstreetmap.org/copyright)。
- 离线海岸线：[Natural Earth](https://www.naturalearthdata.com/)（公共领域）。
- 仅纳入 `gps_code` 或 `ident` 为合法四字母 ICAO 代码、且未关闭的机场。

## 收藏数据与备份

收藏保存在浏览器的 **localStorage** 中，键名为 `aeroatlas.favorites.v2`；最近查看的键名为 `aeroatlas.recent.v1`。这些数据不在项目文件夹里，也不在 DSH 中，**关闭页面、浏览器或 DSH 都不会删除**；只要继续使用同一个浏览器配置文件和同样的打开地址，下次打开会自动恢复。

![收藏备份菜单](shots/preview-backup.png)

**推荐备份方式**：点击侧栏「收藏机场」右侧的「备份」→「导出收藏」，会下载一个 `aeroatlas-favorites-YYYY-MM-DD.json` 文件；需要恢复时点击「导入收藏」选择该文件。导入会与现有收藏合并，不会删除已有收藏。

### 内置的「机场24」收藏

本地副本内置了 `data/airports24-seed.js`：在 `file://`、`localhost` / `127.0.0.1` 或局域网地址首次打开时，会把 `机场24.docx` 中的 **82 座机场**合并进收藏（不覆盖原有收藏），之后即使删除某座也不会再自动加回。该预置只对本地 / 局域网地址生效，公开域名不会自动添加；部署到公开域名后如需这份收藏，点击「备份」→「导入收藏」，选择 `airports24-favorites.json` 即可。

![机场24 收藏效果](shots/preview-airports24.png)

需要注意，存储按来源（origin）隔离：

- `file:///.../index.html`
- `http://localhost:8000/`
- `http://127.0.0.1:8000/`

这是三个不同的来源，收藏互不相通；无痕/InPrivate 模式、清理“Cookie 及其他网站数据”、更换浏览器或配置文件，都会让收藏不可见。

Chromium 系浏览器的物理位置：

- Edge：`%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Local Storage\leveldb`
- Chrome：`%LOCALAPPDATA%\Google\Chrome\User Data\Default\Local Storage\leveldb`

控制台备用方式（在页面按 F12 打开控制台）：

```js
// 导出：把当前收藏 JSON 复制到剪贴板
copy(localStorage.getItem('aeroatlas.favorites.v2') || '[]')

// 恢复：粘贴备份的 JSON 并刷新
const v = prompt('粘贴收藏 JSON'); if (v) { localStorage.setItem('aeroatlas.favorites.v2', v); location.reload(); }
```

## 重新构建数据

```bash
python tools/fetch_data.py      # 下载 OurAirports CSV 与 Natural Earth 海岸线
python tools/build_data.py      # 生成 data/airports.js 与 data/basemap.js
python tools/prepare_basemap.py # 下载 OpenFreeMap 暗色样式并调成深蓝配色
```

`data/airports.js` 采用紧凑数组格式以压缩体积：

```
[icao, name, city, isoCountry, type, elevationFt, iata, lat, lon, scheduled, runways]
```

## 目录

```
index.html               页面结构
assets/style.css         视觉样式
assets/app.js            地图、搜索、收藏、账号逻辑
server.py                本地静态服务 + 账号 / 收藏 API
start.bat                启动本地账号版（调用 start.ps1）
start.ps1                后台启动服务、等待就绪并打开浏览器
stop-server.bat          停止本地账号服务
storage/                 运行后生成的账号、会话和启动日志（不要上传）
runtime/                 内置 Windows Python 3.12 运行时（不要上传）
data/airports.js         22,135 座机场 + 跑道索引
data/airports24-seed.js  机场24.docx 的 82 座本地预置收藏
data/basemap.js          离线海岸线兜底
data/basemap-style.js    调色后的 OpenFreeMap 暗色样式
airports24-favorites.json 机场24 收藏备份（可通过「备份」导入）
vendor/                  MapLibre GL JS
tools/                   数据抓取与构建脚本
shots/                   预览截图
```

## 性能优化

- 全球视图只渲染大型 / 中型机场（约 5 千座），缩放到 Z3 以上自动加入全部 22,135 座，避免低缩放时 2 万多个点拖慢帧率。
- 机场点合并为单个 GPU 图层；底图从 47 层精简到 27 层，移除建筑、铁路、道路文字等非必要图层。
- 关闭 MSAA，HiDPI 屏幕的内部渲染分辨率最高 1.5×；移除侧栏 / 卡片的实时背景模糊。
- 悬停查询与 HUD 更新做节流；缩放时不再逐帧写 DOM；没有收藏时不计算标记位置。
- 如需进一步提速，可把 `assets/app.js` 中的 DPR 上限 `1.5` 改为 `1.25`，或提高 `MINOR_AIRPORT_MIN_ZOOM` 的阈值。

## 说明

- 搜索索引包含 ICAO、IATA、英文机场名与城市；当前数据源的机场名为英文。
- 地图样式基于 OpenFreeMap Dark，并按 AeroAtlas 的深蓝 / 青色 / 金色配色重调。
- 本项目为 Volanta 风格的独立练习作品，与 Volanta 官方无关。
