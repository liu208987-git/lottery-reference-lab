// LSTM 训练 Web Worker
//
// 主线程发：
//   { cmd: "trainSsq" | "trainDlt", samplesData, modelOpts, trainOpts, seed }
//   { cmd: "stop" }
// Worker 发：
//   { type: "epoch", ... }       每个 epoch 完成
//   { type: "batch", ... }       每 N 个 batch
//   { type: "done", model, history, calibration }
//   { type: "error", message }
//
// 设计要点：
//   1. samples 已经在主线程编码完，传过来时只需要把 Float32Array 重组回
//      { rows, cols, data } 形式即可
//   2. Web Worker 跑训练循环，主线程随便切 tab、停止响应即时
//   3. trainSamples 包很大（200 期 × seq=12 × 49 维 × 4 字节 ≈ 1MB），
//      用 Transferable ArrayBuffer 避免拷贝
//
// 限制：worker 不能 import 浏览器 DOM 模块；DOM 操作（如 toast）仍在主线程

import { createModel, deserializeModel, serializeModel } from "./nn-ssq-model.js";
import { trainModel } from "./nn-trainer.js";
import { trainEnsemble } from "./nn-ensemble.js";

import { createDltModel, deserializeDltModel, serializeDltModel } from "./dlt-nn-model.js";
import { trainDltModel } from "./dlt-nn-trainer.js";
import { trainDltEnsemble } from "./dlt-nn-ensemble.js";

import { createRng } from "./rng.js";

let _shouldStop = false;

self.addEventListener("message", async (e) => {
  const { cmd } = e.data;
  if (cmd === "stop") {
    _shouldStop = true;
    return;
  }
  _shouldStop = false;
  if (cmd === "trainSsq" || cmd === "trainDlt") {
    try {
      const result = await runTraining(cmd, e.data);
      self.postMessage({ type: "done", payload: result });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message || String(err) });
    }
  }
});

async function runTraining(cmd, msg) {
  const { samplesData, valSamplesData, modelOpts, trainOpts, seed, ensembleK } = msg;

  // 把序列化的 samples 还原
  const samples = samplesData.map(reviveSample);
  const valSamples = valSamplesData.map(reviveSample);

  const memberRng = createRng(seed).next;
  const trainOptsHooked = {
    ...trainOpts,
    rng: memberRng,
    onEpoch: (ev) => self.postMessage({ type: "epoch", payload: ev }),
    onBatch: (ev) => self.postMessage({ type: "batch", payload: ev }),
    shouldStop: () => _shouldStop,
  };

  if (cmd === "trainSsq") {
    if (ensembleK > 1) {
      const r = await trainEnsemble(samples, valSamples, {
        K: ensembleK,
        seedBase: seed,
        modelOpts,
        trainOpts: trainOptsHooked,
        shouldStop: () => _shouldStop,
      });
      return {
        type: "ensemble",
        members: r.members.map(serializeModel),
        histories: r.histories,
      };
    } else {
      const model = createModel({ ...modelOpts, rng: memberRng });
      const r = await trainModel(model, samples, valSamples, trainOptsHooked);
      return {
        type: "single",
        model: serializeModel(r.model),
        history: r.history,
        calibration: r.calibration,
      };
    }
  } else {
    if (ensembleK > 1) {
      const r = await trainDltEnsemble(samples, valSamples, {
        K: ensembleK,
        seedBase: seed,
        modelOpts,
        trainOpts: trainOptsHooked,
        shouldStop: () => _shouldStop,
      });
      return {
        type: "ensemble",
        members: r.members.map(serializeDltModel),
        histories: r.histories,
      };
    } else {
      const model = createDltModel({ ...modelOpts, rng: memberRng });
      const r = await trainDltModel(model, samples, valSamples, trainOptsHooked);
      return {
        type: "single",
        model: serializeDltModel(r.model),
        history: r.history,
        calibration: r.calibration,
      };
    }
  }
}

function reviveMat(obj) {
  return { rows: obj.rows, cols: obj.cols, data: obj.data instanceof Float32Array ? obj.data : new Float32Array(obj.data) };
}
function reviveSample(s) {
  return {
    issue: s.issue,
    sequence: s.sequence.map(reviveMat),
    target: {
      // SSQ: { red, blue }; DLT: { front, back }
      ...(s.target.red ? { red: reviveMat(s.target.red), blue: reviveMat(s.target.blue) } : {}),
      ...(s.target.front ? { front: reviveMat(s.target.front), back: reviveMat(s.target.back) } : {}),
    },
    raw: s.raw,
  };
}
