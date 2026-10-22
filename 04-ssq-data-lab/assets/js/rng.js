// 可重现的伪随机数发生器（PRNG）
//
// Math.random() 没法控制种子，无法做"同一种子下结果一致"的复现，
// 也无法在测试里断言任何数值结果。我们换成：
//
//   1. xmur3：把任意字符串 → 32-bit 种子（hash function）
//   2. mulberry32：32-bit 状态的 PRNG，周期 2^32，速度快、质量足够
//      （TestU01 SmallCrush 通过；用于 MCMC/采样足够，不能用于密码学）
//
// 顺带提供 autoSeed()：优先 crypto.getRandomValues，回退 Date.now() ⊕ Math.random()。

/** xmur3：返回一个 32-bit 整数 hash 函数。 */
export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** Mulberry32：32-bit 状态 PRNG，返回 [0,1) 浮点。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用任意 string/number 构造 PRNG，返回 {next: ()=>[0,1), seed}。 */
export function createRng(seedInput) {
  const seedStr = String(seedInput ?? autoSeedString());
  const intSeed = xmur3(seedStr)();
  const next = mulberry32(intSeed);
  return { next, seed: seedStr, intSeed };
}

/** 系统熵 → 字符串种子。 */
export function autoSeedString() {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    const buf = new Uint32Array(2);
    globalThis.crypto.getRandomValues(buf);
    return `${buf[0].toString(36)}-${buf[1].toString(36)}`;
  }
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** 标准正态 N(0,1)：Box-Muller，单次返回一个值；缓存另一半。 */
export function makeGaussian(rng = Math.random) {
  let cached = null;
  return function gauss() {
    if (cached !== null) {
      const v = cached;
      cached = null;
      return v;
    }
    let u1 = 0, u2 = 0;
    while (u1 < 1e-12) u1 = rng();
    u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    cached = r * Math.sin(theta);
    return r * Math.cos(theta);
  };
}

/**
 * Gamma(shape, 1) 分布采样，Marsaglia-Tsang method（shape ≥ 1）。
 * shape < 1 用 boost trick：Gamma(α) = Gamma(α+1) × U^(1/α)。
 * Beta(α, β) 可由 X/(X+Y) 构造，X~Gamma(α)、Y~Gamma(β)。
 */
export function makeGammaSampler(rng = Math.random) {
  const gauss = makeGaussian(rng);
  function gamma(shape) {
    if (shape < 1) {
      const u = rng();
      return gamma(shape + 1) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x, v;
      do {
        x = gauss();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = rng();
      const xx = x * x;
      if (u < 1 - 0.0331 * xx * xx) return d * v;
      if (Math.log(u) < 0.5 * xx + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  return gamma;
}

/** 直接采 Beta(α, β)。 */
export function makeBetaSampler(rng = Math.random) {
  const gamma = makeGammaSampler(rng);
  return function beta(alpha, beta_) {
    const x = gamma(alpha);
    const y = gamma(beta_);
    return x / (x + y);
  };
}
