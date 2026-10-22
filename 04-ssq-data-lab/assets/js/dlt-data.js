// 大乐透数据加载器
//
// 数据格式：
//   { meta: { source, count, generatedAt },
//     draws: [ { issue: "26054", year: 2026, date: "2026-05-21",
//                front: [3, 11, 15, 22, 30], back: [4, 9] }, ... ] }
//   draws 按 issue 升序。

const DATA_URL = "./data/dlt-draws.json";

function normalise(json) {
  const meta = json?.meta || {};
  const draws = (json?.draws || []).filter(
    (d) => d && Array.isArray(d.front) && d.front.length === 5
        && Array.isArray(d.back) && d.back.length === 2
  );
  draws.sort((a, b) => String(a.issue).localeCompare(String(b.issue)));
  return { meta, draws };
}

export async function fetchDltRemote(noCache = false) {
  const url = noCache ? `${DATA_URL}?t=${Date.now()}` : DATA_URL;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalise(await res.json());
}

export function readDltEmbedded() {
  if (typeof window === "undefined") return null;
  if (window.__DLT_DATA__ && Array.isArray(window.__DLT_DATA__.draws)) {
    return normalise(window.__DLT_DATA__);
  }
  return null;
}

export async function loadDltDraws({ noCache = false } = {}) {
  try {
    return { ...(await fetchDltRemote(noCache)), source: "remote" };
  } catch (err) {
    const embedded = readDltEmbedded();
    if (embedded) return { ...embedded, source: "embedded", fetchError: err };
    throw err;
  }
}
