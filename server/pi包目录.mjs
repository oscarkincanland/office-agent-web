import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR, LOCAL_PI_AGENT_DIR, loadNetworkSettings } from "./Pi配置管理.mjs";
import { createPiNetworkAdapter } from "./Pi网络代理.mjs";

const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";
const PAGE_SIZE = 20;
const MAX_PAGE = 25;
const CACHE_TTL_MS = 60_000;
const cache = new Map();

function validPackageName(name) {
  return typeof name === "string"
    && name.length <= 214
    && /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name);
}

function underPath(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function installedPackage(name) {
  if (!validPackageName(name)) return null;
  const nodeModules = path.join(LOCAL_PI_AGENT_DIR, "npm", "node_modules");
  try {
    const root = fs.realpathSync(nodeModules);
    const unresolved = path.join(nodeModules, ...name.split("/"));
    const resolved = fs.realpathSync(unresolved);
    if (!underPath(resolved, root)) return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(resolved, "package.json"), "utf8"));
    if (manifest.name !== name || !manifest.keywords?.includes("pi-package")) return null;
    return { name, path: resolved, version: String(manifest.version || ""), hasExtensions: Array.isArray(manifest.pi?.extensions) && manifest.pi.extensions.length > 0 };
  } catch {
    return null;
  }
}

function normalizeCatalogResult(row) {
  const pkg = row?.package || {};
  const name = String(pkg.name || "");
  if (!validPackageName(name) || !Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package")) return null;
  const installed = installedPackage(name);
  const repository = String(pkg.links?.repository || "");
  let repositoryUrl = "";
  try {
    const url = new URL(repository.replace(/^git\+/, ""));
    if (["https:", "http:"].includes(url.protocol)) repositoryUrl = url.href;
  } catch {}
  return {
    name,
    version: String(pkg.version || ""),
    description: String(pkg.description || "").slice(0, 700),
    keywords: pkg.keywords.slice(0, 16).map((item) => String(item).slice(0, 40)),
    publishedAt: String(pkg.date || ""),
    publisher: String(pkg.publisher?.username || pkg.publisher?.name || "").slice(0, 80),
    npmUrl: `https://www.npmjs.com/package/${encodeURIComponent(name)}`,
    galleryUrl: `https://pi.dev/packages/${encodeURIComponent(name)}`,
    repositoryUrl,
    installSource: `npm:${name}`,
    installed: Boolean(installed),
    installedVersion: installed?.version || "",
    hasExtensions: Boolean(installed?.hasExtensions),
  };
}

export async function searchPiPackageCatalog(query = "", page = 0) {
  const normalizedQuery = String(query || "").trim().slice(0, 100);
  const pageNumber = Math.max(0, Math.min(MAX_PAGE, Math.floor(Number(page) || 0)));
  const cacheKey = `${normalizedQuery.toLowerCase()}|${pageNumber}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const url = new URL(NPM_SEARCH_URL);
  url.searchParams.set("text", ["keywords:pi-package", normalizedQuery].filter(Boolean).join(" "));
  url.searchParams.set("size", String(PAGE_SIZE));
  url.searchParams.set("from", String(pageNumber * PAGE_SIZE));
  const network = createPiNetworkAdapter(loadNetworkSettings({ dir: AGENT_DIR }));
  try {
    const response = await network.fetch(url, {
      headers: { accept: "application/json", "user-agent": "OpenPlan-PiCatalog/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`npm 包目录暂不可用（HTTP ${response.status}）`);
    const data = await response.json();
    const items = (Array.isArray(data?.objects) ? data.objects : []).map(normalizeCatalogResult).filter(Boolean);
    const value = { query: normalizedQuery, page: pageNumber, pageSize: PAGE_SIZE, total: Number(data?.total || 0), items };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" ? "查询 Pi 官方包目录超时，请稍后重试。" : error?.message || "查询 Pi 包目录失败");
  } finally {
    network.close();
  }
}

export function resolveInstalledPiPackage(name) {
  const found = installedPackage(String(name || ""));
  if (!found) throw new Error("这个 Pi 包尚未安装在当前 Pi 包目录，未作任何下载或执行。");
  if (!found.hasExtensions) throw new Error("这个包未声明 Pi 扩展入口，不能登记为可执行扩展。");
  return found;
}
