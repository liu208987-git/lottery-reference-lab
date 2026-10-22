const DATA_URL = "./data/draws.json";

function normalise(json) {
  const meta = json?.meta || {};
  const draws = (json?.draws || []).filter((d) => d && Array.isArray(d.reds) && d.reds.length === 6 && d.blue);
  draws.sort((a, b) => String(a.issue).localeCompare(String(b.issue)));
  return { meta, draws };
}

export async function fetchRemote(noCache = false) {
  const url = noCache ? `${DATA_URL}?t=${Date.now()}` : DATA_URL;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalise(await res.json());
}

export function readEmbedded() {
  if (typeof window === "undefined") return null;
  if (window.__SSQ_DATA__ && Array.isArray(window.__SSQ_DATA__.draws)) {
    return normalise(window.__SSQ_DATA__);
  }
  return null;
}

export async function loadDraws({ noCache = false } = {}) {
  try {
    return { ...(await fetchRemote(noCache)), source: "remote" };
  } catch (err) {
    const embedded = readEmbedded();
    if (embedded) return { ...embedded, source: "embedded", fetchError: err };
    throw err;
  }
}
