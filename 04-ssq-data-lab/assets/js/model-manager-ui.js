// 模型管理器对话框：
//   列出 IndexedDB 里所有模型 → 切换 / 删除 / 下载 / 重命名 / A vs B 对比
//
// 通过简单的 <dialog> 元素弹出，零依赖。
// 设计：键盘 ESC 关闭、点击 backdrop 关闭、复用现有 .btn 样式。

import * as modelStorage from "./model-storage.js";

let _dialogEl = null;
const _selected = new Set();   // 对比选中的 keys
let _onCompare = null;          // 当前注册的 compare 回调

/** 打开模型管理器。lottery="ssq"|"dlt"，过滤只显示该彩种的模型。 */
export async function openModelManager({
  lottery,
  currentKey,
  onSwitch,        // (newKey, payload) => void
  onCompare,       // (payloadA, payloadB) => void  可选：传了才显示对比 UI
  onClose,
}) {
  if (!_dialogEl) {
    _dialogEl = createDialog();
    document.body.appendChild(_dialogEl);
  }
  _selected.clear();
  _onCompare = onCompare || null;

  // 是否显示对比开关
  const cmpBar = _dialogEl.querySelector("#mmCompareBar");
  if (cmpBar) cmpBar.style.display = onCompare ? "" : "none";

  await refreshList(lottery, currentKey, onSwitch);
  updateCompareBar();

  if (typeof _dialogEl.showModal === "function") _dialogEl.showModal();
  else _dialogEl.setAttribute("open", "");

  const handleClose = () => {
    onClose?.();
    _dialogEl.removeEventListener("close", handleClose);
  };
  _dialogEl.addEventListener("close", handleClose);
}

function createDialog() {
  const dlg = document.createElement("dialog");
  dlg.className = "model-manager-dialog";
  dlg.innerHTML = `
    <div class="mm-head">
      <strong>模型管理</strong>
      <span class="muted fine" id="mmQuota">—</span>
      <button class="btn ghost btn-sm" id="mmClose" type="button">关闭</button>
    </div>
    <div class="mm-actions">
      <input type="text" id="mmRenameKey" placeholder="新模型 key（如 my-best-run-2026-05）" />
      <button class="btn ghost btn-sm" id="mmDuplicateCurrent" type="button">复制当前为新 key</button>
    </div>
    <div id="mmList" class="mm-list">加载中…</div>
    <div class="mm-compare-bar" id="mmCompareBar" style="display:none">
      <span class="fine muted" id="mmCompareHint">勾选 2 个模型进行 A/B 对比</span>
      <button class="btn primary btn-sm" id="mmCompareGo" type="button" disabled>开始对比 (0/2)</button>
    </div>
    <div class="mm-foot fine muted">
      存储在 IndexedDB（不会被清缓存抹掉）。删除前请先「下载备份」以防误删。
    </div>
  `;
  // 点击 backdrop 关闭
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.querySelector("#mmClose").addEventListener("click", () => dlg.close());

  // 对比按钮
  dlg.querySelector("#mmCompareGo").addEventListener("click", async () => {
    if (!_onCompare || _selected.size !== 2) return;
    const [keyA, keyB] = Array.from(_selected);
    const payloadA = await modelStorage.load(keyA);
    const payloadB = await modelStorage.load(keyB);
    if (!payloadA || !payloadB) {
      alert("无法加载所选模型");
      return;
    }
    // 把 key 注入回 payload（modelStorage.load 故意 strip 掉了）
    payloadA.key = keyA;
    payloadB.key = keyB;
    dlg.close();
    _onCompare(payloadA, payloadB, keyA, keyB);
  });

  return dlg;
}

async function refreshList(lottery, currentKey, onSwitch) {
  const listEl = _dialogEl.querySelector("#mmList");
  const quotaEl = _dialogEl.querySelector("#mmQuota");
  listEl.textContent = "加载中…";

  try {
    const items = await modelStorage.list();
    const filtered = lottery
      ? items.filter((it) => !it.lottery || it.lottery === lottery)
      : items;

    const showCompare = !!_onCompare;

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="fine muted" style="padding:14px">暂无保存的模型。训练完成后点「保存到本地」会出现在这里。</div>`;
    } else {
      listEl.innerHTML = filtered.map((it) => {
        const date = it.savedAt ? it.savedAt.slice(0, 19).replace("T", " ") : "—";
        const arch = `${it.hiddenDim ?? "?"}H × ${it.numLayers ?? "?"}L${it.memberCount > 1 ? ` × ${it.memberCount} ensemble` : ""}`;
        const isCurrent = it.key === currentKey;
        const cmpBox = showCompare
          ? `<label class="mm-cmp-check" title="勾选加入 A/B 对比">
               <input type="checkbox" data-cmp-key="${escapeAttr(it.key)}" />
             </label>`
          : "";
        return `
          <div class="mm-item ${isCurrent ? "is-current" : ""}" data-key="${escapeAttr(it.key)}">
            ${cmpBox}
            <div class="mm-meta">
              <strong class="mm-key">${escapeHtml(it.key)}${isCurrent ? `<span class="chip chip-ok" style="margin-left:8px">当前</span>` : ""}</strong>
              <span class="muted fine">${escapeHtml(it.type || "—")} · ${arch} · ${date}</span>
            </div>
            <div class="mm-row-actions">
              <button class="btn ghost btn-sm" data-act="switch">切换到此</button>
              <button class="btn ghost btn-sm" data-act="download">下载</button>
              <button class="btn ghost btn-sm" data-act="delete" style="color:var(--red-2)">删除</button>
            </div>
          </div>
        `;
      }).join("");

      // 绑定按钮
      listEl.querySelectorAll(".mm-item").forEach((row) => {
        const key = row.dataset.key;
        row.querySelector("[data-act='switch']").addEventListener("click", async () => {
          const payload = await modelStorage.load(key);
          if (payload && onSwitch) onSwitch(key, payload);
          _dialogEl.close();
        });
        row.querySelector("[data-act='download']").addEventListener("click", async () => {
          const payload = await modelStorage.load(key);
          if (payload) modelStorage.exportToFile(payload, `${key}.lottery.json`);
        });
        row.querySelector("[data-act='delete']").addEventListener("click", async () => {
          if (!confirm(`确定删除模型「${key}」？`)) return;
          await modelStorage.remove(key);
          _selected.delete(key);
          await refreshList(lottery, currentKey, onSwitch);
          updateCompareBar();
        });
      });

      // checkbox 事件
      if (showCompare) {
        listEl.querySelectorAll("[data-cmp-key]").forEach((cb) => {
          const key = cb.dataset.cmpKey;
          cb.checked = _selected.has(key);
          cb.addEventListener("change", () => {
            if (cb.checked) {
              if (_selected.size >= 2) {
                cb.checked = false;
                return;  // 最多 2 个
              }
              _selected.add(key);
            } else {
              _selected.delete(key);
            }
            updateCompareBar();
          });
        });
      }
    }

    // 配额
    const q = await modelStorage.getQuota();
    if (q) {
      const usedMB = (q.usage / 1024 / 1024).toFixed(1);
      const quotaMB = (q.quota / 1024 / 1024).toFixed(0);
      quotaEl.textContent = `已用 ${usedMB} / ${quotaMB} MB（${q.usagePercent.toFixed(2)}%）`;
    }

    // 复制当前 key
    _dialogEl.querySelector("#mmDuplicateCurrent").onclick = async () => {
      const newKey = (_dialogEl.querySelector("#mmRenameKey").value || "").trim();
      if (!newKey) {
        alert("请输入新 key");
        return;
      }
      if (!currentKey) {
        alert("没有当前模型可复制");
        return;
      }
      const payload = await modelStorage.load(currentKey);
      if (!payload) {
        alert("当前 key 没有数据");
        return;
      }
      await modelStorage.save(newKey, payload);
      _dialogEl.querySelector("#mmRenameKey").value = "";
      await refreshList(lottery, currentKey, onSwitch);
      updateCompareBar();
    };
  } catch (e) {
    listEl.innerHTML = `<div class="fine" style="color:var(--red-2);padding:14px">读取失败：${escapeHtml(e.message || String(e))}</div>`;
  }
}

function updateCompareBar() {
  if (!_dialogEl) return;
  const btn = _dialogEl.querySelector("#mmCompareGo");
  const hint = _dialogEl.querySelector("#mmCompareHint");
  if (!btn) return;
  const n = _selected.size;
  btn.disabled = n !== 2;
  btn.textContent = `开始对比 (${n}/2)`;
  if (hint) {
    if (n === 0) hint.textContent = "勾选 2 个模型进行 A/B 对比";
    else if (n === 1) hint.textContent = `已选 1 个，再选 1 个`;
    else hint.textContent = `已选 2 个：${Array.from(_selected).join(" vs ")}`;
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", "&#39;");
}
