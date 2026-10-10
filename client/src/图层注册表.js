/**
 * 临时图层注册表（阶段 0 · 修 X5）
 *
 * 问题：MapViewer 应用样式时走全量 `map.setStyle(style, { diff: false })`，
 * 这会清掉所有不在样式文件里的图层。而地图上有几类图层是"临时但需要留在
 * 画面上"的——OD 热力、等时圈、路径、测量/绘制，以及 Agent 的分析结果。
 * 它们不写进 style.json，于是每改一次样式就被清空。
 *
 * 做法：这些图层的绘制方（MapPanel / MapViewer）在画完之后，把"怎么再画一遍"
 * 登记到这里；MapViewer 在每次样式重载完成后统一调用，把画面恢复回来。
 *
 * 约定：
 *   - 用 map 实例做分组键（WeakMap，地图销毁后自动回收）。
 *   - key 相同的登记会覆盖上一个（同一类临时层只需保留最新一次绘制）。
 *   - replay 必须是幂等的：内部先清理自己的图层再重新添加，
 *     这样重复调用不会叠加，也不会因为图层已存在而抛错。
 *   - 单个 replay 失败不影响其它 replay（各自的绘制问题各自承担）。
 */

const replaysByMap = new WeakMap();

/** 登记/覆盖一个临时层的重放器。 */
export function registerLayerReplay(map, key, replay) {
  if (!map || !key || typeof replay !== "function") return false;
  let bucket = replaysByMap.get(map);
  if (!bucket) {
    bucket = new Map();
    replaysByMap.set(map, bucket);
  }
  bucket.set(String(key), replay);
  return true;
}

/** 取消登记（例如用户主动清除该临时层时）。 */
export function unregisterLayerReplay(map, key) {
  const bucket = map ? replaysByMap.get(map) : null;
  if (!bucket) return false;
  return bucket.delete(String(key));
}

/** 当前已登记的键（供调试与测试断言）。 */
export function listLayerReplayKeys(map) {
  const bucket = map ? replaysByMap.get(map) : null;
  return bucket ? [...bucket.keys()] : [];
}

/**
 * 重放全部已登记的临时层。由 MapViewer 在样式重载完成后调用。
 * 返回成功重放的条数，便于调试日志与测试断言。
 */
export function replayTemporaryLayers(map) {
  const bucket = map ? replaysByMap.get(map) : null;
  if (!bucket || !bucket.size) return 0;
  let done = 0;
  for (const [key, replay] of bucket) {
    try {
      replay(map);
      done += 1;
    } catch (error) {
      // 单条失败不能连累其它临时层；宁缺一层也不能整块地图空掉。
      console.warn(`[图层注册表] 临时层 ${key} 重放失败：`, error?.message || error);
    }
  }
  return done;
}

/** 清空某张地图的全部登记（地图销毁时调用，避免残留引用）。 */
export function clearLayerRegistry(map) {
  if (map) replaysByMap.delete(map);
}
