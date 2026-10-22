// 模型持久化：IndexedDB + 文件下载/上传
//
// 为什么不用 localStorage：
//   - 配额仅 5MB（LSTM 序列化 1-3MB 接近上限，多 ensemble 必爆）
//   - 完全字符串化，存大对象慢且占内存
//   - 浏览器一些"清理空间"行为会优先清 localStorage
//   - 跨域/隐私模式不可靠
//
// IndexedDB 优势：
//   - 容量 ≥ 几百 MB（一般是磁盘剩余的 20-60%）
//   - 原生支持 ArrayBuffer，存 Float32Array 不用字符串化
//   - 事务、索引齐全
//
// API 设计：
//   await modelStorage.save(key, payload)
//   await modelStorage.load(key)
//   await modelStorage.list()
//   await modelStorage.delete(key)
//   modelStorage.exportToFile(payload, filename)
//   modelStorage.importFromFile(file) → payload
//
// 兼容：自动迁移 localStorage 里的旧 key（ssq-lstm-model-v2 / dlt-lstm-model-v1）

const DB_NAME = "lottery-lab-models";
const DB_VERSION = 1;
const STORE = "models";

let _dbPromise = null;
function getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("savedAt", "savedAt", { unique: false });
        store.createIndex("type", "type", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return _dbPromise;
}

/** 保存。payload 必须含 type / 任意其它字段。会自动注入 savedAt + key。 */
export async function save(key, payload) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put({
      key,
      ...payload,
      savedAt: new Date().toISOString(),
    });
  });
}

/** 加载。不存在返回 null。 */
export async function load(key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      const v = req.result;
      if (v) {
        // 不返回 keyPath 字段
        const { key: _k, ...rest } = v;
        resolve(rest);
      } else resolve(null);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 列出所有保存。返回 [{ key, type, savedAt, ...metadata }]。 */
export async function list() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const items = req.result.map((v) => {
        // 仅返回元信息，不复制大 buffer
        const { key, type, savedAt, hiddenDim, numLayers, lottery, members } = v;
        return {
          key, type, savedAt,
          hiddenDim, numLayers,
          lottery,
          memberCount: members?.length,
        };
      });
      items.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function remove(key) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).delete(key);
  });
}

/* ============================================================
 * 文件导出 / 导入：跨设备最稳的方案
 * ============================================================ */

export function exportToFile(payload, filename) {
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `model-${Date.now()}.lottery.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function importFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch (e) {
        reject(new Error(`无法解析 JSON: ${e.message}`));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/* ============================================================
 * 配额检查：让 UI 能告诉用户"还有多少空间"
 * ============================================================ */

export async function getQuota() {
  if (!navigator.storage?.estimate) return null;
  try {
    const e = await navigator.storage.estimate();
    return {
      usage: e.usage,
      quota: e.quota,
      usagePercent: e.quota > 0 ? (e.usage / e.quota) * 100 : 0,
    };
  } catch {
    return null;
  }
}

/* ============================================================
 * 从老 localStorage 迁移
 * ============================================================ */

/**
 * 检查老 localStorage key，存在则迁移到 IndexedDB（保留 localStorage 备份直到下次保存覆盖）。
 * @param oldKey 例如 "ssq-lstm-model-v2"
 * @param newKey 例如 "ssq-lstm-default"
 */
export async function migrateFromLocalStorage(oldKey, newKey) {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(oldKey);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    await save(newKey, payload);
    // 不立即删除 localStorage，保留一份备份
    return payload;
  } catch {
    return null;
  }
}

/** 申请持久化存储权限（防止浏览器主动清理）。 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** 是否已被授予持久化权限（读取，不申请）。 */
export async function isPersisted() {
  if (!navigator.storage?.persisted) return false;
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}
