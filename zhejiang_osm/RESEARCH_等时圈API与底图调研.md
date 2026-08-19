# 交通等时圈（Isochrone）分析 API 与底图调研

调研日期：2026-08-18。所有配额/价格信息来自各官方文档与公开资料，商用前请以官网最新条款为准。

## 一、等时圈（可达圈）API

### 1. 开源 / 免费方案（推荐起步）

| 服务 | 免费额度 | 需要 Key | 特点 |
|------|---------|---------|------|
| **OpenRouteService** (HeiGIT) | 500 次等时圈/天 | ✅ 免费注册 | 基于 OSM，支持 car/bike/foot/wheelchair，返回 GeoJSON 多边形，可直接 QGIS 插件调用；可自部署无限量 |
| **Valhalla** (自部署) | 完全免费 | ❌ | Mapbox 开源的 C++ 路由引擎，`/isochrone` 端点，基于 OSM，MIT 协议；FOSSGIS 有公共演示服务器（仅限测试）。浙江省数据可用 Geofabrik PBF 建图 |
| **OSMnx + NetworkX** (本地) | 完全免费 | ❌ | 用本次下载的浙江路网直接算：Dijkstra + `travel_time` 权重 → 等时圈多边形。无需网络，完全可控，但速度模型是静态估算（无限速时用道路等级回退值） |

**ORS 免费层关键限制**：等时圈 500 请求/天，且受每分钟速率限制（约 5 次/分，超限 429）。超出可自部署后端（Docker 一键起，喂 OSM PBF）。

### 2. 商业 / 国际方案

| 服务 | 免费额度 | 需要 Key | 说明 |
|------|---------|---------|------|
| **Google Maps Isochrones API** | 每月 $200 抵扣额度内按次计费 | ✅ GCP API Key + 计费账号 | 2025 年新推出 `GenerateIsochrone`，基于真实路网+实时路况，最长 60 分钟，返回 GeoJSON。**中国大陆数据在国内不可用** |
| **HERE Isoline Routing v8** | Freemium 25 万次事务/月（共享额度池） | ✅ | 多圈层、支持 traffic 参数；中国大陆 HERE 数据一般 |
| **Mapbox Isochrone API** | 100k 请求/月免费，超出 $5/千次 | ✅ | 支持 car/walk/cycle，最长 60 分钟；中国境内道路数据质量一般 |
| **Stadia Maps Isochrones** | 免费层 20 万 credits/月 | ✅ | 基于 Valhalla，有 `auto_traffic` 实时路况档（需付费档）；免费档禁商用 |
| **TravelTime** | 无免费自助档，商务报价（固定月费无限量） | ✅ | 企业级，10 万行程时间 <150ms；适合大规模选址分析 |
| **Targomo** | 有免费试用 | ✅ | 支持公交+多模式，欧洲覆盖好 |
| **Geoapify Isoline API** | 免费层 3,000 credits/天（等时圈每 5 分钟 1 credit） | ✅ | **已实测可用**（2026-08-18）：`GET /v1/isoline?lat=&lon=&type=time&mode=drive&range=秒&apiKey=`，返回 GeoJSON MultiPolygon。免费层等时圈上限 15 分钟、等距 10km；付费后解除。同一 key 还可调地理编码（`/v1/geocode/search`）与底图瓦片（`maps.geoapify.com/v1/tile/...`，0.25 credit/瓦片） |

### 3. 国内方案（中国数据首选）

| 服务 | 可用性 | 需要 Key | 说明 |
|------|--------|---------|------|
| **高德 企业智图 可达圈** | ⚠️ 企业级产品 | ✅ | `https://restapi.amap.com/rest/me/isochrone`，支持步行/驾车/骑行/公交，驾车最长 120min/100km。属于"企业智图"产品线，**个人开发者不可直接开通**，需商务对接 |
| **腾讯位置服务 等时等距可达圈** | ⚠️ 高级付费 | ✅ | WebService API POST 接口，驾车/骑行/步行/公交，节假日/工作日路况分开算。**高级付费服务，需商务申请试用** |
| **百度地图 等时圈** | ⚠️ 商务开放 | ✅ AK | 驾车/步行/骑行等时等距圈，**不向普通个人开发者开放**，需联系商务合作（lbs-contact@baidu.com）开通 |
| **高德/百度 批量算路（曲线方案）** | ✅ 个人可用 | ✅ | 无直达等时圈 API 时的替代：用路径规划/批量算路 API 计算网格各点到中心的耗时，再插值成等值面。高德个人认证 5,000 次/日驾车路径规划；百度批量算路免费档有限 |
| **高德 Web服务 普通 API** | ✅ | ✅ | 个人认证开发者：驾车路径规划 5,000 次/日，QPS 3。免费档仅用于"非商业目的"；商用需企业认证+付费配额 |

**结论**：
- **要中国实时路况精度** → 高德/百度/腾讯的可达圈是正解，但都锁在企业/商务渠道，个人开发者拿不到等时圈原生接口。
- **个人/研究用途** → 推荐 OpenRouteService（免费 key，500 次/天）或自部署 Valhalla/OSRM（喂浙江省 PBF），再叠加高德批量算路做局部校准。
- **本地可控** → 直接用本次下载的 `zhejiang_edges.csv` 跑 OSMnx/networkx Dijkstra，零成本、无配额。

### 4. 自部署引擎对比（用浙江 PBF 建图）

| 引擎 | 语言 | 等时圈能力 | 建图工具 |
|------|------|-----------|---------|
| **Valhalla** | C++ | ✅ `/isochrone`，支持多圈层、时间相关 | `valhalla_build_tiles` |
| **OSRM** | C++ | ⚠️ 无原生等时圈端点，需结合 R 包 `opentripplanner`/第三方；table 服务可做矩阵 | `osrm-extract` |
| **GraphHopper** | Java | ✅ 有 isochrone 模块 | 直接读 PBF |
| **OpenRouteService** | Java | ✅ 官方等时圈 | Docker + PBF |

## 二、底图（Basemap）

### 1. 完全免 Key、免费

| 底图 | URL / 说明 | 特点 |
|------|-----------|------|
| **OpenFreeMap** | `https://tiles.openfreemap.org/...`，Liberty/Bright/Positron 等样式 | 公共实例无限量、无注册、无 key、无 cookie；开源可自部署；OSM 数据 |
| **CARTO Basemaps** | `basemaps.cartocdn.com` Positron(浅色)/Dark Matter/Voyager | 研究/低流量免费（需署名 "© CARTO © OpenStreetMap"）；商用/高流量需注册 |
| **OpenTopoMap** | `https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png` | 地形图风格，免费，限速，适合山区可视化（浙江多山适用） |
| **OSM 标准瓦片** | `tile.openstreetmap.org` | 仅限开发测试，生产禁用（OSMF 政策） |

### 2. 需免费 Key

| 底图 | Key | 免费额度 |
|------|-----|---------|
| **MapTiler** | ✅ | 免费档有限额（个人/非商用），矢量+栅格 |
| **Stadia Maps** | ✅ | 免费档 20 万 credits/月，禁商用 |
| **Geoapify Tiles** | ✅ | **已实测**：`https://maps.geoapify.com/v1/tile/osm-bright/{z}/{x}/{y}.png?apiKey=`，0.25 credit/瓦片（4 瓦片=1 credit），免费 3,000 credits/天≈1.2 万瓦片/天；多套样式（osm-bright/klokantech-basic/dark 等），需署名 |
| **天地图** (国家测绘局) | ✅ `tk` 免费申请 | 矢量/影像/地形 WMTS，**中国官方数据、合规性最好**，GCJ-02 偏移需注意 |
| **高德/腾讯/百度瓦片** | ⚠️ 无官方开放 XYZ | 网上流传 `webrd0x.is.autonavi.com` 等非官方 URL 可用，但无授权保证，商用风险 |
| **Esri World Imagery** | ❌ 免 key 直接访问 | `server.arcgisonline.com/.../World_Imagery/...`，卫星影像，个人研究可用 |

### 3. 推荐组合（浙江项目）

- **QGIS 分析**：OpenFreeMap 或 CARTO Positron 底图 + 浙江路网叠加；山区看地形用 OpenTopoMap；要合规卫星底图用天地图影像（申请 tk）。
- **Web 展示**：MapLibre GL + OpenFreeMap 样式（零 key）；国内访问考虑天地图。
- **论文/报告出图**：CARTO Voyager + matplotlib/geopandas 渲染。

## 三、与本次数据的关系

已下载 `zhejiang-latest.osm.pbf`（Geofabrik，2026-08-17 更新，89.5 MB）并提取：
- `zhejiang_roads.geojson` — 全部 highway 道路（含属性）
- `zhejiang_nodes.csv` — 道路节点坐标
- `zhejiang_edges.csv` — 可路由边表（长度、限速、通行时间、单行标记）

可直接用途：
1. OSMnx/networkx 本地等时圈计算（无需任何 API）；
2. 喂 Valhalla/OpenRouteService 自部署实例（需完整 PBF，已在文件夹内）；
3. QGIS/GeoPandas 可视化叠加任意上述底图。
