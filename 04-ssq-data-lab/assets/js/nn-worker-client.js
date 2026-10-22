// Web Worker 训练客户端
//
// 主线程调用：
//   const { stop, done } = trainInWorker({
//     cmd: "trainSsq",
//     samples, valSamples,
//     modelOpts, trainOpts, seed, ensembleK,
//     onEpoch, onBatch,
//   });
//   await done;       // 训练完成
//   stop();           // 中止训练（异步生效）
//
// 容错：浏览器不支持 Worker / module worker 时，回退到主线程同步训练（caller 看不到差别）。

let _worker = null;

function ensureWorker() {
  if (!_worker) {
    try {
      _worker = new Worker(new URL("./nn-trainer-worker.js", import.meta.url), { type: "module" });
    } catch (e) {
      _worker = null;
    }
  }
  return _worker;
}

/** 是否支持后台 worker。 */
export function isWorkerAvailable() {
  if (typeof Worker === "undefined") return false;
  try {
    // module worker 在 Safari < 15 不支持，但我们至少在 Chrome / Firefox / 现代 Safari 上能用
    return true;
  } catch {
    return false;
  }
}

/**
 * 主入口。返回 { done: Promise, stop: () => void }
 */
export function trainInWorker(opts) {
  const w = ensureWorker();
  if (!w) {
    // 容错：直接报错，让 caller 回退
    return {
      done: Promise.reject(new Error("Web Worker not available")),
      stop: () => {},
    };
  }

  const {
    cmd,
    samples, valSamples,
    modelOpts, trainOpts,
    seed, ensembleK = 1,
    onEpoch, onBatch,
  } = opts;

  // 序列化 samples（Float32Array 直接传 transferable）
  const samplesData = samples.map(serializeSample);
  const valSamplesData = valSamples.map(serializeSample);

  const done = new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const { type, payload, message } = e.data;
      if (type === "epoch") onEpoch?.(payload);
      else if (type === "batch") onBatch?.(payload);
      else if (type === "done") {
        cleanup();
        resolve(payload);
      } else if (type === "error") {
        cleanup();
        reject(new Error(message));
      }
    };
    const onErr = (e) => {
      cleanup();
      reject(new Error(e.message || "worker error"));
    };
    function cleanup() {
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onErr);
    }
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    w.postMessage({
      cmd,
      samplesData,
      valSamplesData,
      modelOpts,
      // 不要传 onEpoch/onBatch（function 不能 postMessage）
      trainOpts: { ...trainOpts, onEpoch: undefined, onBatch: undefined, shouldStop: undefined, rng: undefined },
      seed,
      ensembleK,
    });
  });

  return {
    done,
    stop: () => w.postMessage({ cmd: "stop" }),
  };
}

function serializeSample(s) {
  return {
    issue: s.issue,
    sequence: s.sequence.map(stripMat),
    target: {
      ...(s.target.red ? { red: stripMat(s.target.red), blue: stripMat(s.target.blue) } : {}),
      ...(s.target.front ? { front: stripMat(s.target.front), back: stripMat(s.target.back) } : {}),
    },
    raw: s.raw,
  };
}
function stripMat(m) {
  return { rows: m.rows, cols: m.cols, data: m.data };
}
