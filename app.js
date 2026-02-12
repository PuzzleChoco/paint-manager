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

async function getAllPalettes() {
  return await getAllFrom(STORE_PALETTES);
}

async function addPalette({ name, slots }) {
  const p = { name: name || "新しいパレット", slots: Math.max(1, Number(slots) || 13), createdAt: nowISO(), updatedAt: nowISO() };
  return await withStoreName(STORE_PALETTES, "readwrite", (store) => store.add(p));
}

async function updatePalette(id, patch) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PALETTES, "readwrite");
    const store = tx.objectStore(STORE_PALETTES);
    const req = store.get(id);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(false);
      const next = { ...cur, ...patch, id, updatedAt: nowISO() };
      store.put(next);
      resolve(true);
    };
    req.onerror = () => reject(req.error);
  });
}

async function deletePalette(id) {
  // delete palette
  await withStoreName(STORE_PALETTES, "readwrite", (store) => store.delete(id));
  // delete its slots
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SLOTS, "readwrite");
    const store = tx.objectStore(STORE_SLOTS);
    const idx = store.index("paletteId");
    const range = IDBKeyRange.only(id);
    const cursorReq = idx.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve();
      cursor.delete();
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

async function getSlotsForPalette(paletteId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SLOTS, "readonly");
    const store = tx.objectStore(STORE_SLOTS);
    const idx = store.index("paletteId");
    const req = idx.getAll(IDBKeyRange.only(paletteId));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function setSlotPaint(paletteId, index, paintId) {
  const rec = { paletteId, index, paintId: paintId ?? null, updatedAt: nowISO() };
  await withStoreName(STORE_SLOTS, "readwrite", (store) => store.put(rec));
}

async function clearSlot(paletteId, index) {
  await setSlotPaint(paletteId, index, null);
}

async function trimSlotsBeyond(paletteId, maxSlots) {
  // remove records where index >= maxSlots
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SLOTS, "readwrite");
    const store = tx.objectStore(STORE_SLOTS);
    const idx = store.index("paletteId");
    const cursorReq = idx.openCursor(IDBKeyRange.only(paletteId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve();
      const rec = cursor.value;
      if (rec.index >= maxSlots) cursor.delete();
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

// ---------- IndexedDB ----------
const DB_NAME = "paint-manager-db";

const DB_VERSION = 2; // ★ 1 → 2 に

const STORE = "paints";
const STORE_PALETTES = "palettes";
const STORE_SLOTS = "paletteSlots";

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
      
      // palettes
      if (!db.objectStoreNames.contains(STORE_PALETTES)) {
        const ps = db.createObjectStore(STORE_PALETTES, { keyPath: "id", autoIncrement: true });
        ps.createIndex("updatedAt", "updatedAt", { unique: false });
        ps.createIndex("createdAt", "createdAt", { unique: false });
      }

      // paletteSlots: composite key [paletteId, index]
      if (!db.objectStoreNames.contains(STORE_SLOTS)) {
        const ss = db.createObjectStore(STORE_SLOTS, { keyPath: ["paletteId", "index"] });
        ss.createIndex("paletteId", "paletteId", { unique: false });
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

async function withStoreName(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const out = fn(store);
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getAllFrom(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
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
let palettes = [];
let activePaletteId = null;
let activePaletteSlots = []; // records from paletteSlots
let pickingSlotIndex = null;

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

function getActivePalette() {
  return palettes.find(p => p.id === activePaletteId) || null;
}

function slotPaintId(index) {
  const rec = activePaletteSlots.find(s => s.index === index);
  return rec ? rec.paintId : null;
}

function paintById(id) {
  return paints.find(p => p.id === id) || null;
}

function renderPalettesUI() {
  const tabs = $("paletteTabs");
  const grid = $("paletteGrid");
  const empty = $("paletteEmpty");
  const controls = $("paletteControls");

  tabs.innerHTML = "";

  if (!palettes.length) {
    empty.hidden = false;
    controls.hidden = true;
    grid.hidden = true;
    return;
  }

  empty.hidden = true;

  for (const p of palettes) {
    const el = document.createElement("div");
    el.className = "paletteTab" + (p.id === activePaletteId ? " paletteTab--active" : "");
    el.textContent = `${p.name || "パレット"} (${p.slots})`;
    el.addEventListener("click", async () => {
      activePaletteId = p.id;
      activePaletteSlots = await getSlotsForPalette(activePaletteId);
      renderPalettesUI();
    });
    tabs.appendChild(el);
  }

  const ap = getActivePalette();
  if (!ap) return;

  controls.hidden = false;
  grid.hidden = false;

  // Controls values
  $("paletteName").value = ap.name || "";
  $("paletteSlots").value = String(ap.slots ?? 13);

  // Grid
  grid.innerHTML = "";
  for (let i = 0; i < ap.slots; i++) {
    const pid = slotPaintId(i);
    const p = pid ? paintById(pid) : null;

    const slot = document.createElement("div");
    slot.className = "slot";

    const swatch =
      p?.photoDataUrl
        ? `<img class="slotSwatch" src="${p.photoDataUrl}" alt="swatch" />`
        : (p?.hex && p.hex !== "__INVALID__"
            ? `<div class="slotSwatch" style="background:${escapeHtml(p.hex)}"></div>`
            : `<div class="slotSwatch"></div>`
          );

    slot.innerHTML = `
      <div class="slotIndex">${i + 1}</div>
      ${swatch}
      <div class="slotName">${p ? escapeHtml(p.name || "") : "＋ 追加"}</div>
      <div class="slotMeta">${p ? escapeHtml(p.brand || "") : ""}</div>
    `;

    slot.addEventListener("click", () => openPicker(i));
    grid.appendChild(slot);
  }
}

function openPicker(index) {
  pickingSlotIndex = index;
  $("pickerQuery").value = "";
  $("pickerBackdrop").hidden = false;
  renderPickerList();
}

function closePicker() {
  $("pickerBackdrop").hidden = true;
  pickingSlotIndex = null;
}

function renderPickerList() {
  const q = $("pickerQuery").value.trim().toLowerCase();
  const list = $("pickerList");
  list.innerHTML = "";

  const filtered = paints.filter(p => matchesQuery(p, q)); // 既存の matchesQuery を流用

  for (const p of filtered) {
    const item = document.createElement("div");
    item.className = "pickerItem";

    const thumb = p.photoDataUrl
      ? `<img class="pickerSwatch" src="${p.photoDataUrl}" alt="swatch" />`
      : (p.hex ? `<div class="pickerSwatch" style="background:${escapeHtml(p.hex)}"></div>` : `<div class="pickerSwatch"></div>`);

    item.innerHTML = `
      ${thumb}
      <div>
        <div class="pickerTitle">${escapeHtml(p.name || "")}</div>
        <div class="pickerMeta">${escapeHtml(p.brand || "メーカー未設定")} / ${escapeHtml(typeLabel(p.type))}</div>
      </div>
    `;

    item.addEventListener("click", async () => {
      const ap = getActivePalette();
      if (!ap || pickingSlotIndex == null) return;
      await setSlotPaint(ap.id, pickingSlotIndex, p.id);
      activePaletteSlots = await getSlotsForPalette(ap.id);
      renderPalettesUI();
      closePicker();
    });

    list.appendChild(item);
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

async function reloadPalettes() {
  palettes = await getAllPalettes();
  // 初回：パレットがないなら初期パレット（13マス）を作る
  if (palettes.length === 0) {
    await addPalette({ name: "水彩パレット", slots: 13 });
    palettes = await getAllPalettes();
  }
  if (!activePaletteId) activePaletteId = palettes[0]?.id ?? null;

  // active palette slots
  if (activePaletteId != null) {
    activePaletteSlots = await getSlotsForPalette(activePaletteId);
  } else {
    activePaletteSlots = [];
  }

  renderPalettesUI();
}

async function reload() {
  paints = await getAllPaints();
  render();           // 既存の一覧
  await reloadPalettes(); // ★追加
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
  });

  // --- Photo pickers (camera / library) ---
  async function handlePickedPhoto(file) {
    if (!file) return;

    const dataUrl = await fileToResizedDataURL(file, { maxSize: 900, quality: 0.82 });
    currentPhotoDataUrl = dataUrl;
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
      e.target.value = "";
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
  
  // Palette events
  $("btnAddPalette").addEventListener("click", async () => {
    const name = prompt("パレット名は？", "新しいパレット");
    if (name == null) return;
    await addPalette({ name: name.trim() || "新しいパレット", slots: 13 });
    palettes = await getAllPalettes();
    activePaletteId = palettes[palettes.length - 1]?.id ?? activePaletteId;
    await reloadPalettes();
  });

  $("paletteName").addEventListener("change", async () => {
    const ap = getActivePalette();
    if (!ap) return;
    await updatePalette(ap.id, { name: $("paletteName").value.trim() || "パレット" });
    await reloadPalettes();
  });

  function setSlotsCount(next) {
    const ap = getActivePalette();
    if (!ap) return;
    const v = Math.max(1, Number(next) || 1);
    $("paletteSlots").value = String(v);
  }

  $("btnSlotsMinus").addEventListener("click", async () => {
    const ap = getActivePalette();
    if (!ap) return;
    const next = Math.max(1, (Number($("paletteSlots").value) || ap.slots || 13) - 1);
    setSlotsCount(next);
    await updatePalette(ap.id, { slots: next });
    await trimSlotsBeyond(ap.id, next);
    await reloadPalettes();
  });

  $("btnSlotsPlus").addEventListener("click", async () => {
    const ap = getActivePalette();
    if (!ap) return;
    const next = Math.max(1, (Number($("paletteSlots").value) || ap.slots || 13) + 1);
    setSlotsCount(next);
    await updatePalette(ap.id, { slots: next });
    await reloadPalettes();
  });

  // "細かく変更"：数値入力で任意のマス数に
  $("paletteSlots").addEventListener("change", async () => {
    const ap = getActivePalette();
    if (!ap) return;
    const next = Math.max(1, Number($("paletteSlots").value) || ap.slots || 13);
    setSlotsCount(next);
    await updatePalette(ap.id, { slots: next });
    await trimSlotsBeyond(ap.id, next);
    await reloadPalettes();
  });

  $("btnDeletePalette").addEventListener("click", async () => {
    const ap = getActivePalette();
    if (!ap) return;
    const ok = confirm(`「${ap.name || "パレット"}」を削除する？`);
    if (!ok) return;
    await deletePalette(ap.id);
    palettes = await getAllPalettes();
    activePaletteId = palettes[0]?.id ?? null;
    await reloadPalettes();
  });

  // Picker events
  $("btnClosePicker").addEventListener("click", closePicker);
  $("pickerBackdrop").addEventListener("click", (e) => {
    if (e.target === $("pickerBackdrop")) closePicker();
  });
  $("pickerQuery").addEventListener("input", renderPickerList);

  $("btnClearSlot").addEventListener("click", async () => {
    const ap = getActivePalette();
    if (!ap || pickingSlotIndex == null) return;
    await clearSlot(ap.id, pickingSlotIndex);
    activePaletteSlots = await getSlotsForPalette(ap.id);
    renderPalettesUI();
    closePicker();
  });
  
});