"use strict";

// === CẤU HÌNH GOOGLE DRIVE ===
// Dán mã Client ID bạn lấy từ Google Cloud Console vào giữa dấu ngoặc kép bên dưới:
const GOOGLE_CLIENT_ID = "805509803185-3q3mv8h0fuengvkugdocff1fipl82jel.apps.googleusercontent.com";
const DRIVE_FILE_NAME = "nhip-hoc-static-v1.json";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_AUTH_KEY = "nhip-hoc-drive-auth";

const STORAGE_KEY = "nhip-hoc-static-v1";
const DAY = 86400000;
const GRADES = ["again", "hard", "good", "easy"];
const $ = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const normalize = text => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
const localDay = time => new Date(time).toLocaleDateString("en-CA");
let state, saving = false, session = null, toastTimeout, completedTimer = 0;

// Biến trạng thái kết nối Google Drive
let tokenClient = null;
let driveAccessToken = null;
let driveTokenExpiresAt = 0;
let driveFileId = null;
let driveSyncing = false;

function freshSrs(now = Date.now()) {
  return { dueAt: now, interval: 0, ease: 2.5, repetitions: 0, reviews: 0, lapses: 0 };
}

function emptyData() {
  return {
    app: "nhip-hoc-static", version: 1, revision: 0,
    cards: [], reviews: [], theme: "light",
    timer: { duration: 1500, remaining: 1500, endsAt: 0 }
  };
}

function folderPath(value) {
  const parts = value.split("/").map(part => part.trim()).filter(Boolean);
  if (parts.length > 4) throw new Error("Thư mục chỉ được có tối đa 4 cấp.");
  return parts.join(" / ");
}

function parseTags(value) {
  return [...new Set(value.split(/[\s,;]+/).map(tag => tag.replace(/^#+/, "").toLowerCase()).filter(Boolean))];
}

// Kiểm tra trước khi đọc/nhập. Không tự thay dữ liệu hỏng bằng kho rỗng.
function validateData(data) {
  const number = (n, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  const string = (s, max) => typeof s === "string" && s.length <= max;
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  check(data && data.app === "nhip-hoc-static" && data.version === 1, "Cần bản JSON của Nhịp Học tĩnh, phiên bản 1.");
  check(Number.isSafeInteger(data.revision) && data.revision >= 0, "Phiên bản dữ liệu không hợp lệ.");
  check(Array.isArray(data.cards) && Array.isArray(data.reviews), "Thiếu danh sách thẻ hoặc lịch sử ôn.");
  check(["light", "dark"].includes(data.theme), "Cấu hình giao diện không hợp lệ.");
  const ids = new Set();
  for (const card of data.cards) {
    check(card && string(card.id, 200) && card.id && !ids.has(card.id), "Mã thẻ bị thiếu hoặc trùng.");
    ids.add(card.id);
    check(string(card.front, 20000) && card.front.trim() && string(card.back, 20000) && card.back.trim(), "Nội dung thẻ không hợp lệ.");
    check(string(card.folder, 240) && folderPath(card.folder) === card.folder, "Đường dẫn thư mục không hợp lệ.");
    check(Array.isArray(card.tags) && card.tags.every(tag => string(tag, 500) && tag), "Tags không hợp lệ.");
    check(typeof card.suspended === "boolean" && number(card.createdAt) && number(card.updatedAt), "Thông tin thẻ không hợp lệ.");
    const s = card.srs;
    check(s && number(s.dueAt, 0, 8640000000000000) && number(s.interval, 0, 36500) && number(s.ease, 1.3, 10), "Lịch ôn không hợp lệ.");
    check([s.repetitions, s.reviews, s.lapses].every(n => Number.isSafeInteger(n) && n >= 0), "Số lượt ôn không hợp lệ.");
  }
  const reviewIds = new Set();
  for (const review of data.reviews) {
    check(review && string(review.id, 200) && review.id && !reviewIds.has(review.id), "Mã lượt ôn bị thiếu hoặc trùng.");
    reviewIds.add(review.id);
    check(string(review.cardId, 200) && review.cardId && GRADES.includes(review.grade) && number(review.at), "Lịch sử ôn không hợp lệ.");
  }
  const t = data.timer;
  check(t && Number.isInteger(t.duration) && number(t.duration, 60, 10800) && number(t.remaining, 0, t.duration) && number(t.endsAt, 0, 8640000000000000), "Đồng hồ không hợp lệ.");
  return data;
}

// === LỚP LƯU TRỮ GOOGLE DRIVE + BỘ ĐỆM LOCALSTORAGE ===
function hasValidToken() {
  return Boolean(driveAccessToken && Date.now() < driveTokenExpiresAt - 30000);
}

function loadCachedAuth() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRIVE_AUTH_KEY) || "null");
    if (saved && saved.token && Date.now() < saved.expiresAt - 30000) {
      driveAccessToken = saved.token;
      driveTokenExpiresAt = saved.expiresAt;
      driveFileId = saved.fileId || null;
    }
  } catch { /* Bỏ qua nếu lỗi bộ nhớ đệm */ }
}

function saveCachedAuth() {
  try {
    localStorage.setItem(DRIVE_AUTH_KEY, JSON.stringify({
      token: driveAccessToken,
      expiresAt: driveTokenExpiresAt,
      fileId: driveFileId
    }));
  } catch { /* Bỏ qua */ }
}

function updateDriveButtonUI() {
  const btn = $("driveButton");
  if (!btn) return;
  if (driveSyncing) {
    btn.textContent = "Đang đồng bộ Drive...";
    btn.disabled = true;
  } else if (hasValidToken()) {
    btn.textContent = "Đồng bộ Drive";
    btn.disabled = false;
  } else {
    btn.textContent = "Kết nối Google Drive";
    btn.disabled = false;
  }
}

async function driveRequest(url, options = {}) {
  if (!hasValidToken()) throw new Error("Phiên Google Drive đã hết hạn. Hãy bấm 'Kết nối Google Drive'.");
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${driveAccessToken}`,
      ...(options.headers || {})
    }
  });
  if (response.status === 401 || response.status === 403) {
    driveAccessToken = null;
    driveTokenExpiresAt = 0;
    localStorage.removeItem(DRIVE_AUTH_KEY);
    updateDriveButtonUI();
    throw new Error("Phiên đăng nhập Google Drive đã hết hạn. Hãy bấm 'Kết nối Google Drive'.");
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Lỗi Google Drive (${response.status}): ${errText.slice(0, 120)}`);
  }
  return response;
}

async function findDriveFileId() {
  if (driveFileId) return driveFileId;
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const res = await driveRequest(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime)&pageSize=1`);
  const data = await res.json();
  if (data.files && data.files.length > 0) {
    driveFileId = data.files[0].id;
    saveCachedAuth();
    return driveFileId;
  }
  return null;
}

async function fetchFromDrive() {
  const fileId = await findDriveFileId();
  if (!fileId) return null;
  try {
    const res = await driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    const text = await res.text();
    if (!text.trim()) return null;
    return validateData(JSON.parse(text));
  } catch (error) {
    if (String(error.message).includes("404")) {
      driveFileId = null;
      saveCachedAuth();
      return null;
    }
    throw error;
  }
}

async function uploadToDrive(data) {
  validateData(data);
  const fileId = await findDriveFileId();
  const bodyContent = JSON.stringify(data);

  if (fileId) {
    await driveRequest(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: bodyContent
    });
  } else {
    const metadata = { name: DRIVE_FILE_NAME, mimeType: "application/json" };
    const boundary = "nhip_hoc_boundary_" + Date.now();
    const multipartBody =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${bodyContent}\r\n` +
      `--${boundary}--`;

    const res = await driveRequest("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipartBody
    });
    const created = await res.json();
    driveFileId = created.id;
    saveCachedAuth();
  }
}

async function loadData() {
  loadCachedAuth();
  const raw = localStorage.getItem(STORAGE_KEY);
  const localData = raw === null ? null : validateData(JSON.parse(raw));

  if (hasValidToken()) {
    try {
      const remoteData = await fetchFromDrive();
      if (remoteData) {
        if (!localData || remoteData.revision >= localData.revision) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(remoteData));
          return remoteData;
        } else {
          await uploadToDrive(localData);
          return localData;
        }
      } else if (localData) {
        await uploadToDrive(localData);
        return localData;
      }
    } catch (error) {
      setTimeout(() => notify(`Đang dùng bản lưu trên máy (${error.message})`), 500);
    }
  }
  return localData;
}

async function saveData(next, expectedRevision) {
  const writeLocal = () => {
    const raw = localStorage.getItem(STORAGE_KEY);
    const current = raw === null ? null : validateData(JSON.parse(raw));
    if (current && current.revision !== expectedRevision) {
      const error = new Error("Dữ liệu đã đổi ở tab khác. Hãy mở lại thao tác sau khi tải lại dữ liệu.");
      error.code = "CONFLICT";
      throw error;
    }
    validateData(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  if (navigator.locks?.request) await navigator.locks.request(STORAGE_KEY, writeLocal);
  else writeLocal();

  if (hasValidToken()) {
    await uploadToDrive(next);
  }
}

async function syncWithDrive(manual = false) {
  if (driveSyncing || saving) return;
  driveSyncing = true;
  updateDriveButtonUI();
  try {
    const remoteData = await fetchFromDrive();
    const current = state || emptyData();

    if (!remoteData) {
      await uploadToDrive(current);
      $("saveStatus").textContent = `Đã tạo tệp trên Drive lúc ${new Date().toLocaleTimeString("vi-VN")}`;
      if (manual) notify("Đã tải toàn bộ dữ liệu hiện tại lên Google Drive.");
    } else if (remoteData.revision > current.revision || (current.cards.length === 0 && remoteData.cards.length > 0)) {
      state = remoteData;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(remoteData));
      render();
      $("saveStatus").textContent = `Đã tải từ Drive lúc ${new Date().toLocaleTimeString("vi-VN")}`;
      if (manual) notify(`Đã đồng bộ ${remoteData.cards.length} thẻ từ Google Drive về máy.`);
    } else if (current.revision > remoteData.revision) {
      await uploadToDrive(current);
      $("saveStatus").textContent = `Đã đồng bộ Drive lúc ${new Date().toLocaleTimeString("vi-VN")}`;
      if (manual) notify("Đã cập nhật dữ liệu mới nhất lên Google Drive.");
    } else {
      $("saveStatus").textContent = `Drive đã đồng bộ lúc ${new Date().toLocaleTimeString("vi-VN")}`;
      if (manual) notify("Dữ liệu trên máy và Google Drive đã khớp nhau.");
    }
  } catch (error) {
    notify(`Không đồng bộ được Drive: ${error.message}`);
  } finally {
    driveSyncing = false;
    updateDriveButtonUI();
  }
}

function setupGoogleDriveAuth() {
  // Tự động chèn nút Kết nối Google Drive cạnh nút Xuất JSON
  const exportBtn = $("exportButton");
  if (exportBtn && !$("driveButton")) {
    const driveBtn = element("button", "Kết nối Google Drive");
    driveBtn.id = "driveButton";
    driveBtn.type = "button";
    exportBtn.parentNode.insertBefore(driveBtn, exportBtn);
    driveBtn.addEventListener("click", () => {
      if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.startsWith("DÁN_CLIENT_ID")) {
        return notify("Bạn chưa dán GOOGLE_CLIENT_ID vào dòng số 5 của tệp app.js.");
      }
      if (hasValidToken()) {
        void syncWithDrive(true);
      } else if (tokenClient) {
        tokenClient.requestAccessToken({ prompt: "" });
      } else {
        notify("Đang tải thư viện Google, vui lòng thử lại sau 2 giây.");
      }
    });
  }
  updateDriveButtonUI();

  // Tự động nạp thư viện Google Identity Services
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.defer = true;
  script.onload = () => {
    if (!window.google?.accounts?.oauth2 || GOOGLE_CLIENT_ID.startsWith("DÁN_CLIENT_ID")) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: async response => {
        if (response.error) {
          notify(`Lỗi đăng nhập Google: ${response.error}`);
          return;
        }
        driveAccessToken = response.access_token;
        driveTokenExpiresAt = Date.now() + Number(response.expires_in || 3599) * 1000;
        saveCachedAuth();
        updateDriveButtonUI();
        await syncWithDrive(true);
      }
    });
  };
  document.head.appendChild(script);
}
// === HẾT LỚP LƯU TRỮ GOOGLE DRIVE ===

async function changeData(edit) {
  if (saving || !state) return false;
  saving = true;
  try {
    const next = clone(state), previousRevision = state.revision;
    edit(next);
    next.revision = previousRevision + 1;
    await saveData(next, previousRevision);
    state = next;
    render();
    const statusPrefix = hasValidToken() ? "Đã lưu Drive lúc" : "Đã lưu trên máy lúc";
    $("saveStatus").textContent = `${statusPrefix} ${new Date().toLocaleTimeString("vi-VN")}`;
    return true;
  } catch (error) {
    if (error.code === "CONFLICT") await reloadExternal();
    notify(error.name === "QuotaExceededError" ? "Bộ nhớ đã đầy. Thay đổi chưa được lưu; hãy xuất JSON để sao lưu." : `Chưa lưu được: ${error.message}`);
    return false;
  } finally {
    saving = false;
    updateDriveButtonUI();
  }
}

// SRS thích nghi: Quên 1 phút; Khó 10 phút với thẻ mới;
// Tốt 1 ngày; Dễ 4 ngày. Các lần sau tăng theo interval và ease.
function scheduleReview(previous, grade, now = Date.now()) {
  if (!GRADES.includes(grade)) throw new Error("Mức đánh giá không hợp lệ.");
  const next = { ...previous, reviews: previous.reviews + 1 };
  const interval = previous.interval;
  if (grade === "again") {
    next.interval = 0;
    next.dueAt = now + 60000;
    next.ease -= 0.2;
    next.repetitions = 0;
    next.lapses++;
  } else if (grade === "hard") {
    next.interval = interval ? Math.max(1, Math.round(interval * 1.2)) : 0;
    next.ease -= 0.15;
    next.dueAt = now + (next.interval ? next.interval * DAY : 600000);
  } else {
    next.interval = grade === "easy"
      ? interval ? Math.max(interval + 1, Math.round(interval * previous.ease * 1.3)) : 4
      : interval ? Math.max(interval + 1, Math.round(interval * previous.ease)) : 1;
    if (grade === "easy") next.ease += 0.15;
    next.repetitions++;
    next.dueAt = now + next.interval * DAY;
  }
  next.interval = Math.min(36500, next.interval);
  next.dueAt = Math.min(next.dueAt, now + 36500 * DAY);
  next.ease = Math.round(Math.max(1.3, Math.min(10, next.ease)) * 100) / 100;
  return next;
}

function isDue(card, now = Date.now()) {
  return !card.suspended && card.srs.dueAt <= now;
}

function intervalLabel(srs) {
  const minutes = Math.max(1, Math.round((srs.dueAt - Date.now()) / 60000));
  return minutes < 60 ? `${minutes} phút` : minutes < 1440 ? `${Math.round(minutes / 60)} giờ` : `${Math.round(minutes / 1440)} ngày`;
}

function element(tag, text, className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function notify(message) {
  clearTimeout(toastTimeout);
  $("toast").textContent = message;
  $("toast").hidden = false;
  const dialog = [...document.querySelectorAll("dialog[open]")].at(-1);
  if (dialog) {
    let note = dialog.querySelector(".dialog-message");
    if (!note) { note = element("p", "", "hint dialog-message"); note.setAttribute("role", "status"); dialog.append(note); }
    note.textContent = message;
  }
  toastTimeout = setTimeout(() => { $("toast").hidden = true; }, 6500);
}

function rebuildSelect(select, options) {
  const previous = select.value;
  select.replaceChildren();
  for (const [value, label] of options) {
    const option = element("option", label);
    option.value = value;
    select.append(option);
  }
  select.value = options.some(([value]) => value === previous) ? previous : "";
}

function renderFilters() {
  const paths = new Set();
  for (const card of state.cards) {
    const parts = card.folder ? card.folder.split(" / ") : [];
    parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join(" / ")));
  }
  const sorted = [...paths].sort((a, b) => a.localeCompare(b, "vi"));
  rebuildSelect($("folderFilter"), [["", "Tất cả thư mục"], ["unfiled", "Chưa phân loại"], ...sorted.map(path => ["path:" + path, path])]);
  rebuildSelect($("tagFilter"), [["", "Tất cả tags"], ...[...new Set(state.cards.flatMap(card => card.tags))].sort().map(tag => [tag, "#" + tag])]);
  $("folderSuggestions").replaceChildren(...sorted.map(path => { const option = document.createElement("option"); option.value = path; return option; }));
}

function visibleCards() {
  const selected = $("folderFilter").value, tag = $("tagFilter").value;
  const path = selected.startsWith("path:") ? selected.slice(5) : "";
  const words = normalize($("search").value.trim()).split(/\s+/).filter(Boolean);
  return state.cards.filter(card => {
    const inFolder = !selected || (selected === "unfiled" ? !card.folder : card.folder === path || $("includeChildren").checked && card.folder.startsWith(path + " / "));
    const content = normalize([card.front, card.back, card.folder, ...card.tags].join(" "));
    return inFolder && (!tag || card.tags.includes(tag)) && words.every(word => content.includes(word.replace(/^#/, "")));
  }).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function reviewQueue() {
  return visibleCards().filter(card => !card.suspended && ($("reviewMode").value === "all" || isDue(card)));
}

function renderStats() {
  if (!state) return;
  $("totalCount").textContent = state.cards.length;
  $("dueCount").textContent = state.cards.filter(card => isDue(card)).length;
  $("todayCount").textContent = state.reviews.filter(review => localDay(review.at) === localDay(Date.now())).length;
  $("recallRate").textContent = state.reviews.length ? `${Math.round(100 * state.reviews.filter(review => review.grade !== "again").length / state.reviews.length)}%` : "—";
  const count = reviewQueue().length;
  $("scopeCount").textContent = `${count} thẻ có thể ôn trong nhóm này`;
  $("startReview").disabled = count === 0;
}

function renderCards() {
  const cards = visibleCards();
  $("cardList").replaceChildren();
  $("emptyState").hidden = cards.length > 0;
  for (const card of cards) {
    const article = element("article", "", "study-card");
    const tags = element("div", "", "tags");
    card.tags.forEach(tag => tags.append(element("span", "#" + tag, "tag")));
    const bottom = element("div", "", "card-bottom");
    const label = card.suspended ? "Tạm nghỉ" : isDue(card) ? "Đến hạn ôn" : "Ôn " + new Date(card.srs.dueAt).toLocaleDateString("vi-VN");
    bottom.append(element("span", `${label} · ${card.srs.reviews} lượt`, isDue(card) ? "due" : ""));
    const actions = element("div", "", "actions");
    for (const [action, label] of [["edit", "Sửa"], ["delete", "Xóa"]]) {
      const button = element("button", label, action === "delete" ? "danger" : "");
      button.dataset.action = action;
      button.dataset.id = card.id;
      button.setAttribute("aria-label", `${label} thẻ ${card.front.slice(0, 70)}`);
      actions.append(button);
    }
    bottom.append(actions);
    article.append(element("p", card.folder || "Chưa phân loại", "folder-path"), element("h3", card.front), tags, bottom);
    $("cardList").append(article);
  }
  renderStats();
}

function render() {
  document.documentElement.dataset.theme = state.theme;
  $("themeButton").textContent = state.theme === "dark" ? "Chế độ sáng" : "Chế độ tối";
  renderFilters();
  renderCards();
  renderTimer();
  updateDriveButtonUI();
}

function openEditor(id = "") {
  if (saving) return;
  const card = state.cards.find(item => item.id === id);
  $("cardForm").reset();
  $("cardId").value = card?.id || "";
  $("editorTitle").textContent = card ? "Chỉnh sửa thẻ" : "Tạo thẻ ghi nhớ";
  $("frontInput").value = card?.front || "";
  $("backInput").value = card?.back || "";
  $("folderInput").value = card?.folder ?? ($("folderFilter").value.startsWith("path:") ? $("folderFilter").value.slice(5) : "");
  $("tagsInput").value = card ? card.tags.join(", ") : $("tagFilter").value;
  $("suspendedInput").checked = card?.suspended || false;
  $("editorError").textContent = "";
  $("editorDialog").querySelector(".dialog-message")?.remove();
  $("editorDialog").showModal();
  $("frontInput").focus();
}

async function submitCard(event) {
  event.preventDefault();
  if (saving) return;
  try {
    const id = $("cardId").value, now = Date.now();
    const fields = {
      front: $("frontInput").value.trim(), back: $("backInput").value.trim(),
      folder: folderPath($("folderInput").value), tags: parseTags($("tagsInput").value),
      suspended: $("suspendedInput").checked, updatedAt: now
    };
    if (!fields.front || !fields.back) throw new Error("Hãy nhập đủ cả hai mặt thẻ.");
    const ok = await changeData(next => {
      if (id) {
        const card = next.cards.find(item => item.id === id);
        if (!card) throw new Error("Thẻ không còn tồn tại.");
        Object.assign(card, fields);
      } else next.cards.push({ id: uid(), ...fields, createdAt: now, srs: freshSrs(now) });
    });
    if (ok) { $("editorDialog").close(); notify("Đã lưu thẻ."); }
  } catch (error) { $("editorError").textContent = error.message; }
}

function startReview() {
  if (saving) return;
  const cards = reviewQueue();
  if (!cards.length) return notify("Chưa có thẻ phù hợp để ôn.");
  session = { queue: cards.map(card => card.id), history: [], revealed: false, reverse: $("reverseCards").checked, mode: $("reviewMode").value };
  $("reviewDialog").querySelector(".dialog-message")?.remove();
  renderReview();
  $("reviewDialog").showModal();
  $("revealButton").focus();
}

function renderReview() {
  if (!session) return;
  const card = state.cards.find(item => item.id === session.queue[0]);
  $("reviewProgress").textContent = `ĐÃ ÔN ${session.history.length} · CÒN ${session.queue.length} THẺ`;
  $("reviewTitle").textContent = card ? session.mode === "all" ? "Ôn tất cả từ đầu" : "Tự nhớ trước khi lật thẻ" : "Bạn đã hoàn thành lượt ôn";
  $("reviewMeta").textContent = card ? `${card.folder || "Chưa phân loại"} ${card.tags.map(tag => "#" + tag).join(" ")}` : "Các thẻ cần học lại sẽ xuất hiện trong nhóm đến hạn theo lịch mới.";
  $("question").textContent = card ? session.reverse ? card.back : card.front : `Đã ghi ${session.history.length} lượt ôn.`;
  $("answer").textContent = card ? session.reverse ? card.front : card.back : "";
  $("answer").hidden = !card || !session.revealed;
  $("revealButton").hidden = !card || session.revealed;
  $("gradeButtons").hidden = !card || !session.revealed;
  $("undoReview").disabled = !session.history.length;
  if (card) document.querySelectorAll("[data-grade]").forEach(button => { button.querySelector("small").textContent = intervalLabel(scheduleReview(card.srs, button.dataset.grade)); });
}

function reveal() {
  if (!session || !session.queue.length || saving) return;
  session.revealed = true;
  renderReview();
  document.querySelector('[data-grade="good"]').focus();
}

async function gradeCard(grade) {
  if (!session?.revealed || saving) return;
  const active = session, card = state.cards.find(item => item.id === active.queue[0]);
  if (!card) return;
  const before = clone(card), reviewId = uid(), at = Date.now();
  const ok = await changeData(next => {
    const target = next.cards.find(item => item.id === card.id);
    target.srs = scheduleReview(target.srs, grade, at);
    target.updatedAt = at;
    next.reviews.push({ id: reviewId, cardId: card.id, grade, at });
  });
  if (!ok || session !== active) return;
  active.history.push({ before, reviewId });
  active.queue.shift();
  active.revealed = false;
  renderReview();
  if (active.queue.length) $("revealButton").focus();
}

async function undoReview() {
  if (!session?.history.length || saving) return;
  const active = session, previous = active.history.at(-1);
  const ok = await changeData(next => {
    const index = next.cards.findIndex(card => card.id === previous.before.id);
    if (index < 0) throw new Error("Thẻ không còn tồn tại.");
    next.cards[index] = clone(previous.before);
    next.reviews = next.reviews.filter(review => review.id !== previous.reviewId);
  });
  if (!ok || session !== active) return;
  active.history.pop();
  active.queue.unshift(previous.before.id);
  active.revealed = false;
  renderReview();
}

function secondsRemaining(timer = state.timer) {
  return timer.endsAt ? Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000)) : timer.remaining;
}

function renderTimer() {
  if (!state) return;
  const seconds = secondsRemaining();
  const text = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  document.querySelectorAll("[data-clock]").forEach(clock => { clock.textContent = text; });
  document.querySelectorAll('[data-timer="toggle"]').forEach(button => { button.textContent = state.timer.endsAt ? "Tạm dừng" : seconds && seconds < state.timer.duration ? "Tiếp tục" : "Bắt đầu"; });
  $("focusMinutes").disabled = !!state.timer.endsAt;
  if (document.activeElement !== $("focusMinutes")) $("focusMinutes").value = state.timer.duration / 60;
}

async function toggleTimer() {
  await changeData(next => {
    const t = next.timer;
    if (t.endsAt) { t.remaining = secondsRemaining(t); t.endsAt = 0; }
    else { if (!t.remaining) t.remaining = t.duration; t.endsAt = Date.now() + t.remaining * 1000; }
  });
}

async function closeFocus() {
  if (document.fullscreenElement === $("focusDialog").querySelector(".focus-content")) {
    try { await document.exitFullscreen(); }
    catch { return notify("Dùng Esc hoặc nút quay lại để thoát toàn màn hình."); }
  }
  if ($("focusDialog").open) $("focusDialog").close();
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function importData(file) {
  if (!file || saving) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("Tệp JSON quá lớn (tối đa 10 MB).");
    const incoming = validateData(JSON.parse(await file.text()));
    if (!confirm(`Thay dữ liệu hiện tại bằng ${incoming.cards.length} thẻ và ${incoming.reviews.length} lượt ôn trong tệp? Hãy xuất bản sao trước nếu cần.`)) return;
    const ok = await changeData(next => {
      const revision = next.revision;
      Object.assign(next, clone(incoming), { revision });
    });
    if (ok) notify("Đã nhập dữ liệu và đồng bộ.");
  } catch (error) { notify(`Không nhập được: ${error.message}`); }
  finally { $("importFile").value = ""; }
}

async function reloadExternal() {
  try {
    state = await loadData() || emptyData();
    session = null;
    ["editorDialog", "reviewDialog"].forEach(id => { if ($(id).open)$(id).close(); });
    render();
    notify("Đã tải dữ liệu mới nhất.");
  } catch (error) { showRecovery(error); }
}

function showRecovery(error) {
  state = null;
  document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  $("loading").hidden = true;
  $("app").hidden = true;
  $("recovery").hidden = false;
  $("recoveryMessage").textContent = `Không truy cập hoặc đọc được dữ liệu: ${error.message}`;
}

async function initialize() {
  try {
    setupGoogleDriveAuth();
    state = await loadData() || emptyData();
    render();
    $("loading").hidden = true;
    $("recovery").hidden = true;
    $("app").hidden = false;
  } catch (error) { showRecovery(error); }
}

$("newCard").addEventListener("click", () => openEditor());
$("cardForm").addEventListener("submit", submitCard);
$("search").addEventListener("input", renderCards);
["folderFilter", "tagFilter", "includeChildren", "reviewMode"].forEach(id => $(id).addEventListener("change", renderCards));
$("startReview").addEventListener("click", startReview);
$("revealButton").addEventListener("click", reveal);
$("undoReview").addEventListener("click", undoReview);
document.querySelectorAll("[data-grade]").forEach(button => button.addEventListener("click", () => gradeCard(button.dataset.grade)));
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => { if (!saving) $(button.dataset.close).close(); }));$("reviewDialog").addEventListener("close", () => { session = null; });
["editorDialog", "reviewDialog"].forEach(id => $(id).addEventListener("cancel", event => { if (saving) event.preventDefault(); }));
$("cardList").addEventListener("click", async event => {
  const button = event.target.closest("button[data-id]");
  if (!button || saving) return;
  const card = state.cards.find(item => item.id === button.dataset.id);
  if (!card) return;
  if (button.dataset.action === "edit") return openEditor(card.id);
  if (confirm(`Xóa thẻ “${card.front.slice(0, 80)}”?`)) await changeData(next => { next.cards = next.cards.filter(item => item.id !== card.id); });
});
$("themeButton").addEventListener("click", () => changeData(next => { next.theme = next.theme === "dark" ? "light" : "dark"; }));
$("exportButton").addEventListener("click", () => download(`nhip-hoc-static-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)));
$("importButton").addEventListener("click", () => { if (!saving) $("importFile").click(); });
$("importFile").addEventListener("change", event => importData(event.target.files[0]));
document.querySelectorAll("[data-timer]").forEach(button => button.addEventListener("click", () => {
  if (button.dataset.timer === "toggle") void toggleTimer();
  else if (confirm("Đặt đồng hồ về thời lượng ban đầu?")) void changeData(next => { next.timer.remaining = next.timer.duration; next.timer.endsAt = 0; });
}));
$("focusMinutes").addEventListener("change", async event => {
  const minutes = Number(event.target.value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) { notify("Chọn thời lượng từ 1 đến 180 phút."); return renderTimer(); }
  await changeData(next => { if (!next.timer.endsAt) next.timer = { duration: minutes * 60, remaining: minutes * 60, endsAt: 0 }; });
});
let nativeFocus = false;
$("openFocus").addEventListener("click", () => {
  $("focusDialog").showModal();
  renderTimer();
  $("focusDialog").querySelector(".focus-content").requestFullscreen?.().catch(() => {});
});
$("closeFocus").addEventListener("click", closeFocus);
$("focusDialog").addEventListener("cancel", event => { event.preventDefault(); void closeFocus(); });
document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement === $("focusDialog").querySelector(".focus-content")) {
    nativeFocus = true;
    if (!$("focusDialog").open) void document.exitFullscreen().catch(() => {});
  } else if (nativeFocus) { nativeFocus = false; if ($("focusDialog").open) $("focusDialog").close(); }
});
document.addEventListener("keydown", event => {
  if (!$("reviewDialog").open || event.ctrlKey || event.metaKey || event.altKey || event.repeat || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  if (event.key === " ") { event.preventDefault(); reveal(); }
  if (/^[1-4]$/.test(event.key)) { event.preventDefault(); void gradeCard(GRADES[Number(event.key) - 1]); }
  if (event.key.toLowerCase() === "z") { event.preventDefault(); void undoReview(); }
});
window.addEventListener("storage", event => {
  if (event.key === STORAGE_KEY || event.key === null) void reloadExternal();
});
// Tự động kiểm tra bản mới trên Google Drive khi chuyển lại tab trên điện thoại/MacBook
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && hasValidToken() && !session) {
    void syncWithDrive(false);
  }
});
$("downloadRaw").addEventListener("click", () => {
  try { download("nhip-hoc-du-lieu-goc.json", localStorage.getItem(STORAGE_KEY) || "null"); }
  catch (error) { notify(error.message); }
});
$("resetStorage").addEventListener("click", async () => {
  if (!confirm("Xóa dữ liệu Nhịp Học trong trình duyệt này? Việc này không thể hoàn tác. Hãy tải dữ liệu đang lưu trước.")) return;
  try { localStorage.removeItem(STORAGE_KEY); await initialize(); }
  catch (error) { showRecovery(error); }
});
setInterval(() => {
  if (!state) return;
  renderTimer();
  renderStats();
  const end = state.timer.endsAt;
  if (end && secondsRemaining() === 0 && !saving && completedTimer !== end) {
    completedTimer = end;
    void changeData(next => { next.timer.endsAt = 0; next.timer.remaining = 0; }).then(ok => { if (ok) notify("Đã hết phiên tập trung. Nghỉ một chút nhé!"); });
  }
}, 1000);
void initialize();