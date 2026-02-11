// Paint Manager (no build) - IndexedDB local storage + PWA

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

const nowISO = () => new Date().toISOString();

const normalizeTags = (s) =>
  (s || "")
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);

const statusLabel = (s) => ({
  owned: "持ってる",
  empty: "空/買い足し",
  wishlist: "買う予定",
}[s] || s);

const typeLabel = (t) => ({
  watercolor: "水彩",
  acrylic: "アクリル",
  gouache: "ガッシュ",
  oil: "油彩",
  ink: "インク",
  other: "その他",
}[t] || t);

function normalizeHex(input) {
  const s = (input || "").trim();
  if (!s) return "";
  const t = s.startsWith("#") ? s.slice(1) : s;
  if (!/^[0-9a-fA-F]{6}$/.test(t)) return "__INVALID__";
  return ("#" + t.toUpperCase());
}

function setHexPreview(hex) {
  const el = $("hexPreview");
  if (!el) return;
  if (!hex || hex === "__INVALID__") {
    el.style.background = "rgba(255,255,255,.06)";
    el.style.borderColor = "var(--line)";
    return;
  }
  el.style.background = hex;
  el.style.borderColor = "rgba(255,255,255,.22)";
}

async function fileToResizedDataURL(file, { maxSize = 900, quality = 0.82 } = {}) {
  // 画像を読み込み
  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    im.src = url;
  });

  // 端末向けに縮小（長辺 maxSize）
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = nw;
  canvas.height = nh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, nw, nh);

  // JPEGにして容量を抑える（バックアップにも入れやすい）
  return canvas.toDataURL("image/jpeg", quality);
}

function setPhotoPreview(dataUrl) {
  const img = $("photoPreview");
  const btnRemove = $("btnRemovePhoto");

  if (!dataUrl) {
    img.hidden = true;
    img.src = "";
    btnRemove.hidden = true;
    return;
  }
  img.hidden = false;
  img.src = dataUrl;
  btnRemove.hidden = false;
}

function setPhotoName(name) {
  const el = $("photoName");
  if (!el) return;

  const v = (name || "").trim();
  if (!v) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = v;
}

// ---------- IndexedDB ----------
const DB_NAME = "paint-manager-db";
const DB_VERSION = 1;
const STORE = "paints";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
        store.createIndex("name", "name", { unique: false });
        store.createIndex("brand", "brand", { unique: false });
        store.createIndex("status", "status", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const out = fn(store);

    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getAllPaints() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function addPaint(paint) {
  paint.createdAt = paint.createdAt || nowISO();
  paint.updatedAt = nowISO();
  await withStore("readwrite", (store) => store.add(paint));
}

async function updatePaint(id, patch) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const cur = getReq.result;
      if (!cur) return resolve(false);

      const next = { ...cur, ...patch, id, updatedAt: nowISO() };
      const putReq = store.put(next);

      putReq.onsuccess = () => resolve(true);
      putReq.onerror = () => reject(putReq.error);
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

async function deletePaint(id) {
  await withStore("readwrite", (store) => store.delete(id));
}

async function clearAll() {
  await withStore("readwrite", (store) => store.clear());
}

// ---------- UI state ----------
let paints = [];
let editingId = null;
let currentPhotoDataUrl = "";
let currentPhotoName = "";

// ---------- render ----------
function matchesQuery(p, q) {
  if (!q) return true;
  const hay = [
    p.brand, p.line, p.name, p.code, p.type, p.status,
    ...(p.tags || []),
    p.notes
  ].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q.toLowerCase());
}

function applyFilters(list) {
  const q = $("q").value.trim();
  const st = $("filterStatus").value;
  let out = list.filter(p => matchesQuery(p, q));
  if (st !== "all") out = out.filter(p => p.status === st);

  const sortBy = $("sortBy").value;
  const cmp = {
    updatedDesc: (a,b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""),
    createdDesc: (a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""),
    nameAsc: (a,b) => (a.name || "").localeCompare(b.name || "", "ja"),
    brandAsc: (a,b) => (a.brand || "").localeCompare(b.brand || "", "ja"),
  }[sortBy] || ((a,b)=>0);

  out.sort(cmp);
  return out;
}

function renderStats(list) {
  const owned = list.filter(p => p.status === "owned").length;
  const empty = list.filter(p => p.status === "empty").length;
  const wish = list.filter(p => p.status === "wishlist").length;

  $("stats").textContent = `全 ${list.length} | 持ってる ${owned} | 空/買い足し ${empty} | 買う予定 ${wish}`;
}

function render() {
  const filtered = applyFilters(paints);
  renderStats(filtered);

  const ul = $("list");
  ul.innerHTML = "";

  $("emptyState").hidden = filtered.length !== 0;

  for (const p of filtered) {
    const li = document.createElement("li");
    li.className = "card";

    const badgeClass = p.status === "owned"
      ? "badge--owned"
      : p.status === "empty"
      ? "badge--empty"
      : "badge--wishlist";

    li.innerHTML = `
      <div class="card__top">
        <div>
          <div class="titleRow">
            ${p.photoDataUrl ? `<img class="photoPreview" src="${p.photoDataUrl}" alt="swatch" />` : ""}
            ${p.hex ? `<span class="swatch" style="background:${escapeHtml(p.hex)}"></span>` : ""}
            
            <div class="cardTitleRow">
              ${
                p.photoDataUrl
                  ? `<img class="cardThumb" src="${p.photoDataUrl}" alt="swatch" />`
                  : (p.hex
                      ? `<span class="swatch" style="background:${escapeHtml(p.hex)}"></span>`
                      : `<span class="swatch"></span>`
                    )
              }
              <div>
                <h3 class="card__title">${escapeHtml(p.name || "")}</h3>
                <div class="card__meta">
                  <span>${escapeHtml(p.brand || "メーカー未設定")}</span>
                  ${p.code ? `<span>#${escapeHtml(p.code)}</span>` : ""}
                  <span>${escapeHtml(typeLabel(p.type))}</span>
                  ${p.photoName ? `<span>📷 ${escapeHtml(p.photoName)}</span>` : ""}
                </div>
              </div>
            </div>
            
          </div>
            
          </h3>
          
        </div>
        <span class="badge ${badgeClass}">${escapeHtml(statusLabel(p.status))}</span>
      </div>

      ${p.notes ? `<div class="card__notes">${escapeHtml(p.notes)}</div>` : ""}

      ${p.tags && p.tags.length
        ? `<div class="card__tags">${p.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>`
        : ""
      }

      <div class="card__actions">
        <button class="btn btn--ghost" data-act="edit" data-id="${p.id}">編集</button>
        <button class="btn btn--danger" data-act="del" data-id="${p.id}">削除</button>
      </div>
    `;

    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- form ----------
function resetForm() {
  editingId = null;
  $("paintId").value = "";
  $("brand").value = "";
  $("line").value = "";
  $("name").value = "";
  $("code").value = "";
  $("type").value = "watercolor";
  $("status").value = "owned";
  $("tags").value = "";
  $("notes").value = "";

  $("btnCancelEdit").hidden = true;
  $("btnSave").textContent = "保存";
  $("hex").value = "";
  setHexPreview("");
  currentPhotoDataUrl = "";
  setPhotoPreview("");
  
  currentPhotoName = "";
  setPhotoName("");
}

function fillForm(p) {
  editingId = p.id;
  $("paintId").value = p.id;
  $("brand").value = p.brand || "";
  $("line").value = p.line || "";
  $("name").value = p.name || "";
  $("code").value = p.code || "";
  $("type").value = p.type || "watercolor";
  $("status").value = p.status || "owned";
  $("tags").value = (p.tags || []).join(", ");
  $("notes").value = p.notes || "";

  $("btnCancelEdit").hidden = false;
  $("btnSave").textContent = "更新";
  window.scrollTo({ top: 0, behavior: "smooth" });
  $("hex").value = p.hex || "";
  setHexPreview(p.hex || "");
  currentPhotoDataUrl = p.photoDataUrl || "";
  setPhotoPreview(currentPhotoDataUrl);
  
  currentPhotoName = p.photoName || "";
  setPhotoName(currentPhotoName);
}

function readForm() {
  return {
    brand: $("brand").value.trim(),
    line: $("line").value.trim(),
    name: $("name").value.trim(),
    code: $("code").value.trim(),
    type: $("type").value,
    status: $("status").value,
    tags: normalizeTags($("tags").value),
    notes: $("notes").value.trim(),
    hex: normalizeHex($("hex").value),
    photoDataUrl: currentPhotoDataUrl || "",
    photoName: currentPhotoName || "",
  };
}

// ---------- backup ----------
async function exportJSON() {
  const data = {
    version: 1,
    exportedAt: nowISO(),
    paints: await getAllPaints(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `paint-manager-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importJSON(file, mode) {
  // mode: "merge" | "replace"
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    alert("JSONが壊れてるみたい。ファイルを確認してね。");
    return;
  }

  const incoming = Array.isArray(parsed?.paints) ? parsed.paints : null;
  if (!incoming) {
    alert("このバックアップ形式は読めなかった。");
    return;
  }

  if (mode === "replace") {
    const ok = confirm("今のデータを全部消して、バックアップで置き換えるよ。OK？");
    if (!ok) return;
    await clearAll();
  }

  // merge behavior:
  // - if record has id, try put (update/insert)
  // - if no id, add
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);

    for (const p of incoming) {
      const clean = {
        id: p.id, // may be undefined
        brand: p.brand || "",
        line: p.line || "",
        name: p.name || "",
        code: p.code || "",
        type: p.type || "watercolor",
        status: p.status || "owned",
        tags: Array.isArray(p.tags) ? p.tags : [],
        notes: p.notes || "",
        createdAt: p.createdAt || nowISO(),
        updatedAt: p.updatedAt || nowISO(),
        hex: (normalizeHex(p.hex) === "__INVALID__") ? "" : (normalizeHex(p.hex) || ""),
        photoDataUrl: typeof p.photoDataUrl === "string" ? p.photoDataUrl : "",
        photoName: typeof p.photoName === "string" ? p.photoName : "",
      };

      if (typeof clean.id === "number") {
        store.put(clean);
      } else {
        delete clean.id;
        store.add(clean);
      }
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  await reload();
  alert("復元できたよ！");
}

// ---------- load ----------
async function reload() {
  paints = await getAllPaints();
  render();
}

// ---------- event wiring ----------
document.addEventListener("DOMContentLoaded", async () => {
  // Service Worker
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    } catch (e) {
      // SW失敗しても動作自体は続ける
      console.warn("SW register failed:", e);
    }
  }

  await reload();

  $("paintForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = readForm();
    if (data.hex === "__INVALID__") {
    alert("HEXは #RRGGBB（例: #1A2B3C）の形式で入力してね。");
    return;
    }
    if (!data.name) return;

    if (editingId) {
      await updatePaint(editingId, data);
    } else {
      await addPaint(data);
    }

    await reload();
    resetForm();
     $("hex").value = "";
     setHexPreview("");
    
  });

  $("btnCancelEdit").addEventListener("click", () => resetForm());

  $("q").addEventListener("input", render);
  $("filterStatus").addEventListener("change", render);
  $("sortBy").addEventListener("change", render);

  $("list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    const act = btn.dataset.act;
    const id = Number(btn.dataset.id);
    const p = paints.find(x => x.id === id);

    if (act === "edit" && p) {
      fillForm(p);
    }

    if (act === "del") {
      const ok = confirm(`「${p?.name || "この絵の具"}」を削除する？`);
      if (!ok) return;
      await deletePaint(id);
      await reload();
      if (editingId === id) resetForm();
    }
  });

  $("btnExport").addEventListener("click", exportJSON);

  $("fileImportMerge").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await importJSON(file, "merge");
  });

  $("fileImportReplace").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await importJSON(file, "replace");
  });
  
  $("hex").addEventListener("input", () => {
    const h = normalizeHex($("hex").value);
    setHexPreview(h);
    
  $("btnTakePhoto").addEventListener("click", () => {
  $("photoInput").click();
  });

  // --- Photo pickers (camera / library) ---
  async function handlePickedPhoto(file) {
    if (!file) return;

    const dataUrl = await fileToResizedDataURL(file, { maxSize: 900, quality: 0.82 });
    currentPhotoDataUrl = dataUrl;

    // iOSだと汎用名のこともあるけど、取れる範囲で表示
    currentPhotoName = file.name || "";

    setPhotoPreview(currentPhotoDataUrl);
    setPhotoName(currentPhotoName);
  }

  const cam = $("photoInputCamera");
  const lib = $("photoInputLibrary");
  const btnRemove = $("btnRemovePhoto");

  if (cam) {
    cam.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // 同じ写真を選び直せるように必ずリセット
      try { await handlePickedPhoto(file); } catch (err) {
        console.warn(err);
        alert("画像の読み込みに失敗したかも。別の写真で試してね。");
      }
    });
  }

  if (lib) {
    lib.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      try { await handlePickedPhoto(file); } catch (err) {
        console.warn(err);
        alert("画像の読み込みに失敗したかも。別の写真で試してね。");
      }
    });
  }

  if (btnRemove) {
    btnRemove.addEventListener("click", () => {
      const ok = confirm("塗り見本の写真を削除する？");
      if (!ok) return;

      currentPhotoDataUrl = "";
      currentPhotoName = "";
      setPhotoPreview("");
      setPhotoName("");

      if (cam) cam.value = "";
      if (lib) lib.value = "";
    });
  }
  });
});