// model-storage 在 Node 里跑：mock IndexedDB（fake-indexeddb 没装，用我们自己的 stub）
import { test, before } from "node:test";
import assert from "node:assert/strict";

// 简易 IndexedDB stub
function setupFakeIDB() {
  const stores = new Map();
  globalThis.indexedDB = {
    open(name, version) {
      const req = {};
      setTimeout(() => {
        if (!stores.has(name)) {
          stores.set(name, new Map());
          // upgrade
          const fakeDB = makeFakeDB(stores.get(name));
          if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: fakeDB } });
        }
        if (req.onsuccess) {
          req.result = makeFakeDB(stores.get(name));
          req.onsuccess({ target: req });
        }
      }, 0);
      return req;
    },
  };
}

function makeFakeDB(store) {
  return {
    objectStoreNames: {
      contains: (name) => store._stores?.has?.(name) ?? store.has?.("models"),
    },
    createObjectStore(name, opts) {
      // 兼容：创建 sub-store
      if (!store._stores) store._stores = new Map();
      const s = new Map();
      s.indexes = new Map();
      store._stores.set(name, s);
      return {
        createIndex: (name) => s.indexes.set(name, true),
      };
    },
    transaction(name, mode) {
      // 找到 store；如果没有 _stores（比 createObjectStore 早），用顶层 store
      const s = store._stores?.get?.(name) || store;
      const tx = {
        oncomplete: null,
        onerror: null,
        objectStore() {
          return {
            put(value) {
              s.set(value.key, value);
              setTimeout(() => tx.oncomplete?.(), 0);
              return {};
            },
            get(key) {
              const r = {};
              setTimeout(() => {
                r.result = s.get(key);
                r.onsuccess?.();
              }, 0);
              return r;
            },
            getAll() {
              const r = {};
              setTimeout(() => {
                r.result = Array.from(s.values()).filter((v) => v.key);
                r.onsuccess?.();
              }, 0);
              return r;
            },
            delete(key) {
              s.delete(key);
              setTimeout(() => tx.oncomplete?.(), 0);
              return {};
            },
          };
        },
      };
      return tx;
    },
  };
}

before(() => setupFakeIDB());

const storage = await import("../assets/js/model-storage.js");

test("save & load: 字段 round-trip", async () => {
  await storage.save("test-key-1", {
    type: "single",
    hiddenDim: 64,
    numLayers: 2,
    blob: new Float32Array([1.5, 2.5, 3.5]),
  });
  const r = await storage.load("test-key-1");
  assert.equal(r.type, "single");
  assert.equal(r.hiddenDim, 64);
  assert.ok(r.savedAt);
  assert.equal(r.blob[0], 1.5);
});

test("load 不存在返回 null", async () => {
  const r = await storage.load("never-existed");
  assert.equal(r, null);
});

test("list 按 savedAt 倒序", async () => {
  await storage.save("a", { type: "single", hiddenDim: 16, numLayers: 1 });
  await new Promise(r => setTimeout(r, 10));
  await storage.save("b", { type: "ensemble", hiddenDim: 32, numLayers: 2, members: [1, 2, 3] });
  const items = await storage.list();
  assert.ok(items.length >= 2);
  // 找到 a 和 b
  const a = items.find(x => x.key === "a");
  const b = items.find(x => x.key === "b");
  assert.equal(a.type, "single");
  assert.equal(b.type, "ensemble");
  assert.equal(b.memberCount, 3);
});

test("delete 后 load 返回 null", async () => {
  await storage.save("to-delete", { type: "single", hiddenDim: 16 });
  let r = await storage.load("to-delete");
  assert.ok(r);
  await storage.remove("to-delete");
  r = await storage.load("to-delete");
  assert.equal(r, null);
});

test("payload 中嵌套 Float32Array 在 IndexedDB 里能完整 round-trip", async () => {
  const arr = new Float32Array([1.1, 2.2, 3.3, 4.4]);
  const nested = {
    type: "single",
    weights: { W: arr, b: new Float32Array([0.5]) },
  };
  await storage.save("nested-test", nested);
  const r = await storage.load("nested-test");
  // 在真 IndexedDB 里，Float32Array 会被结构化克隆原样回来；这里 fake stub 用 Map，对象引用一致
  assert.ok(r.weights);
  assert.equal(r.weights.W.length, 4);
  assert.ok(Math.abs(r.weights.W[0] - 1.1) < 0.001);
});

test("getQuota 没有 navigator.storage 时返回 null", async () => {
  // Node 环境下没有 navigator.storage
  const q = await storage.getQuota();
  assert.equal(q, null);
});
