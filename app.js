"use strict";

const STORAGE_KEY = "nhip-hoc-static-v1";
const DAY = 86400000;
const GRADES = ["again", "hard", "good", "easy"];
const $ = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const normalize = text => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
const localDay = time => new Date(time).toLocaleDateString("en-CA");
let state, saving = false, session = null, toastTimeout, completedTimer = 0;

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

// === LỚP LƯU TRỮ: Google Drive (thư mục ẩn appDataFolder) ===
const DRIVE = {
  clientId: "805509803185-3q3mv8h0fuengvkugdocff1fipl82jel.apps.googleusercontent.com",
  email: "nguyenhoanghieutrung0510200398@gmail.com", // chỉ để Google chọn sẵn tài khoản; không hạn chế ai được dùng
  scope: "https://www.googleapis.com/auth/drive.appdata",
  fileName: "nhip-hoc-du-lieu.json",
  linkedKey: "nhip-hoc-drive-linked", // chỉ là cờ "đã từng kết nối"; không chứa dữ liệu hay token
  api: "https://www.googleapis.com/drive/v3",
  upload: "https://www.googleapis.com/upload/drive/v3"
};
// Token chỉ nằm trong bộ nhớ, không ghi ra đĩa.
let accessToken = "", tokenExpiresAt = 0, tokenClient = null, tokenWaiter = null, tokenPromise = null, googleScript = null, driveFileId = "";

const hasValidToken = () => !!accessToken && Date.now() < tokenExpiresAt;
const makeError = (message, code, status) => Object.assign(new Error(message), { code, status });
const isLinked = () => { try { return localStorage.getItem(DRIVE.linkedKey) === "1"; } catch { return false; } };
const setLinked = on => { try { on ? localStorage.setItem(DRIVE.linkedKey, "1") : localStorage.removeItem(DRIVE.linkedKey); } catch { /* bỏ qua */ } };

function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE.clientId,
    scope: DRIVE.scope,
    hint: DRIVE.email,
    callback: response => {
      const waiter = tokenWaiter; tokenWaiter = null;
      if (response.error) return waiter?.reject(makeError(`Không đăng nhập được: ${response.error_description || response.error}`, "AUTH"));
      if (!google.accounts.oauth2.hasGrantedAllScopes(response, DRIVE.scope)) return waiter?.reject(makeError("Bạn chưa cấp quyền truy cập Google Drive cho Nhịp Học.", "AUTH"));
      accessToken = response.access_token;
      tokenExpiresAt = Date.now() + (Number(response.expires_in) - 60) * 1000;
      waiter?.resolve();
    },
    error_callback: error => {
      const waiter = tokenWaiter; tokenWaiter = null;
      const message = error.type === "popup_closed" ? "Bạn đã đóng cửa sổ đăng nhập Google."
        : error.type === "popup_failed_to_open" ? "Trình duyệt đã chặn cửa sổ đăng nhập. Hãy cho phép popup rồi thử lại."
        : `Không đăng nhập được (${error.type || "lỗi không rõ"}).`;
      waiter?.reject(makeError(message, "AUTH"));
    }
  });
}

// Nạp Google Identity Services đúng một lần; thất bại thì cho phép thử lại.
function setupGoogle() {
  googleScript ??= new Promise((resolve, reject) => {
    const ready = () => { initTokenClient(); resolve(); };
    if (window.google?.accounts?.oauth2) return ready();
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = ready;
    script.onerror = () => {
      googleScript = null; script.remove();
      reject(makeError("Không tải được thư viện đăng nhập của Google. Kiểm tra mạng hoặc trình chặn quảng cáo.", "NETWORK"));
    };
    document.head.append(script);
  });
  return googleScript;
}

// Xin token mới nếu cần. Nếu trình duyệt chặn popup (không có thao tác bấm), lỗi AUTH sẽ hiện nút kết nối lại.
function ensureToken() {
  if (hasValidToken()) return Promise.resolve();
  if (!tokenClient) return Promise.reject(makeError("Chưa khởi tạo đăng nhập Google.", "AUTH"));
  tokenPromise ??= new Promise((resolve, reject) => {
    tokenWaiter = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: "" });
  }).finally(() => { tokenPromise = null; });
  return tokenPromise;
}

async function readError(response) {
  let reason = "", detail = "";
  try {
    const body = (await response.json()).error;
    reason = body?.errors?.[0]?.reason || "";
    detail = body?.message || "";
  } catch { /* phản hồi không phải JSON */ }
  const code = response.status === 401 || reason === "insufficientPermissions" ? "AUTH" : reason === "storageQuotaExceeded" ? "QUOTA" : "";
  const error = makeError(`Google Drive báo lỗi ${response.status}${detail ? `: ${detail}` : ""}`, code, response.status);
  error.reason = reason;
  return error;
}

// fetch có kèm token; tự xin lại token khi 401 và tự thử lại khi bị giới hạn tốc độ hoặc lỗi máy chủ tạm thời.
async function driveFetch(url, options = {}) {
  for (let attempt = 0; ; attempt++) {
    await ensureToken();
    let response;
    try {
      response = await fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${accessToken}` } });
    } catch {
      throw makeError("Không kết nối được tới Google Drive. Kiểm tra mạng rồi thử lại.", "NETWORK");
    }
    if (response.ok) return response;
    const error = await readError(response);
    if (error.code === "AUTH" && attempt < 1) { accessToken = ""; continue; }
    const transient = [429, 500, 502, 503, 504].includes(response.status) || ["rateLimitExceeded", "userRateLimitExceeded"].includes(error.reason);
    if (transient && attempt < 3) { await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 600)); continue; }
    throw error;
  }
}

// Tìm tệp dữ liệu (nếu lỡ có hai tệp do hai thiết bị cùng tạo lần đầu thì luôn chọn tệp cũ nhất).
async function findFile() {
  if (driveFileId) return driveFileId;
  const params = new URLSearchParams({
    spaces: "appDataFolder", q: `name='${DRIVE.fileName}' and trashed=false`,
    orderBy: "createdTime", pageSize: "1", fields: "files(id)"
  });
  const { files } = await (await driveFetch(`${DRIVE.api}/files?${params}`)).json();
  return driveFileId = files[0]?.id || "";
}

async function downloadFile(id) {
  return (await driveFetch(`${DRIVE.api}/files/${id}?alt=media`)).text();
}

// Số revision trên Drive, đọc từ metadata (nhẹ, không phải tải cả tệp).
async function remoteRevision(id) {
  if (!id) return 0;
  try {
    const meta = await (await driveFetch(`${DRIVE.api}/files/${id}?fields=appProperties`)).json();
    const value = meta.appProperties?.revision;
    return value === undefined ? validateData(JSON.parse(await downloadFile(id))).revision : Number(value);
  } catch (error) {
    if (error.status === 404) { driveFileId = ""; return 0; } // tệp đã bị xóa ở nơi khác
    throw error;
  }
}

async function loadData() {
  const id = await findFile();
  if (!id) return null;
  try {
    return validateData(JSON.parse(await downloadFile(id)));
  } catch (error) {
    if (error.status === 404) { driveFileId = ""; return null; }
    throw error;
  }
}

async function uploadFile(method, url, metadata, content) {
  const boundary = `nhip${uid().replace(/-/g, "")}`;
  const part = body => ["Content-Type: application/json; charset=UTF-8", "", body, ""].join("\r\n");
  const body = `--${boundary}\r\n${part(JSON.stringify(metadata))}--${boundary}\r\n${part(content)}--${boundary}--`;
  const response = await driveFetch(`${url}?uploadType=multipart&fields=id`, {
    method, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body
  });
  return response.json();
}

// Drive không có "ghi nếu chưa đổi" nguyên tử, nên ta đọc revision ngay trước khi ghi.
// Cách này bắt được xung đột giữa các thiết bị; chỉ còn khe hở rất nhỏ nếu hai nơi lưu cùng lúc.
async function saveData(next, expectedRevision) {
  const write = async () => {
    validateData(next);
    const remote = await remoteRevision(await findFile());
    if (remote !== expectedRevision) {
      const error = new Error("Dữ liệu đã đổi ở thiết bị hoặc tab khác. Hãy mở lại thao tác sau khi tải lại dữ liệu.");
      error.code = "CONFLICT";
      throw error;
    }
    const metadata = { appProperties: { revision: String(next.revision) } };
    const content = JSON.stringify(next);
    if (driveFileId) await uploadFile("PATCH", `${DRIVE.upload}/files/${driveFileId}`, metadata, content);
    else {
      const created = await uploadFile("POST", `${DRIVE.upload}/files`, { ...metadata, name: DRIVE.fileName, parents: ["appDataFolder"], mimeType: "application/json" }, content);
      driveFileId = created.id;
    }
  };
  // Khóa ghi giữa các tab trên trình duyệt có hỗ trợ Web Locks.
  if (navigator.locks?.request) await navigator.locks.request(STORAGE_KEY, write);
  else await write();
}
// === HẾT LỚP LƯU TRỮ ===

// === KẾT NỐI GOOGLE DRIVE: giao diện ===
// Hộp thoại kết nối được tạo bằng JS nên không cần sửa index.html.
function showGate(message = "") {
  $("loading").hidden = true;
  let gate = $("driveGate");
  if (!gate) {
    gate = document.createElement("dialog");
    gate.id = "driveGate";
    const connect = element("button", "Kết nối Google Drive", "primary");
    connect.id = "driveConnect";
    connect.type = "button";
    connect.addEventListener("click", connectDrive);
    const note = element("p", "", "hint");
    note.id = "driveGateMessage";
    note.setAttribute("role", "status");
    const heading = element("div", "", "section-heading");
    heading.append(element("h2", "Kết nối Google Drive"));
    const actions = element("div", "", "actions end");
    actions.append(connect);
    gate.append(
      heading,
      element("p", "Nhịp Học lưu thẻ và lịch ôn trong một tệp riêng của ứng dụng trên Google Drive của bạn. Ứng dụng không xem được các tệp khác."),
      note, actions
    );
    gate.addEventListener("cancel", event => { if (!state) event.preventDefault(); });
    document.body.append(gate);
  }
  $("driveGateMessage").textContent = message;
  if (!gate.open) gate.showModal();
}

async function connectDrive() {
  const button = $("driveConnect");
  button.disabled = true;
  try {
    await setupGoogle();
    await ensureToken();
    setLinked(true);
    if (state) {
      $("driveGate").close();
      notify("Đã kết nối lại Google Drive. Hãy thử lại thao tác vừa rồi.");
      void checkRemote();
    } else await initialize();
  } catch (error) { $("driveGateMessage").textContent = error.message; }
  finally { button.disabled = false; }
}

function disconnectDrive() {
  if (saving || !confirm("Ngắt kết nối Google Drive trên trình duyệt này? Dữ liệu trên Drive vẫn được giữ nguyên.")) return;
  if (accessToken) google.accounts.oauth2.revoke(accessToken);
  accessToken = ""; tokenExpiresAt = 0; driveFileId = "";
  state = null; session = null;
  setLinked(false);
  document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  $("app").hidden = true;
  showGate("Đã ngắt kết nối Google Drive.");
}

// Lỗi tạm thời (mạng, đăng nhập, máy chủ) -> cho thử lại. Lỗi dữ liệu -> màn hình khôi phục.
function handleLoadError(error) {
  if (["AUTH", "NETWORK"].includes(error.code) || error.status === 429 || error.status >= 500) showGate(error.code === "AUTH" ? "Cần kết nối lại Google Drive để tiếp tục." : error.message);
  else showRecovery(error);
}

// Lần đầu dùng Drive: nếu trình duyệt còn dữ liệu localStorage của bản cũ thì đề nghị chuyển lên.
async function migrateLegacy() {
  let raw, legacy;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    legacy = raw === null ? null : validateData(JSON.parse(raw));
  } catch { return null; }
  if (!legacy?.cards.length || !confirm(`Tìm thấy ${legacy.cards.length} thẻ đang lưu trong trình duyệt này. Chuyển chúng lên Google Drive?`)) return null;
  const migrated = { ...legacy, revision: 1 };
  await saveData(migrated, 0);
  // Giữ một bản sao dưới tên khác thay vì xóa hẳn, để còn đường lui.
  try { localStorage.setItem(`${STORAGE_KEY}-da-chuyen`, raw); localStorage.removeItem(STORAGE_KEY); } catch { /* giữ nguyên bản cũ */ }
  notify("Đã chuyển dữ liệu cũ lên Google Drive.");
  return migrated;
}

// Thay cho sự kiện "storage" của localStorage: định kỳ so revision trên Drive với bản đang mở.
// Chỉ chạy khi không có hộp thoại mở và đã có token (không bao giờ tự bật popup đăng nhập).
async function checkRemote() {
  const quiet = () => state && !saving && !document.hidden && !document.querySelector("dialog[open]");
  if (!quiet() || !hasValidToken()) return;
  try {
    const remote = await remoteRevision(await findFile());
    if (quiet() && remote !== state.revision) await reloadExternal();
  } catch { /* kiểm tra nền lỗi thì bỏ qua; lần lưu kế tiếp sẽ báo nếu có vấn đề */ }
}
// === HẾT PHẦN KẾT NỐI GOOGLE DRIVE ===

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
    $("saveStatus").textContent = `Đã lưu lên Google Drive lúc ${new Date().toLocaleTimeString("vi-VN")}`;
    return true;
  } catch (error) {
    if (error.code === "CONFLICT") await reloadExternal();
    if (error.code === "AUTH") showGate("Phiên Google Drive đã hết hạn nên thay đổi vừa rồi chưa được lưu. Hãy kết nối lại rồi thử lại.");
    else notify(error.code === "QUOTA" ? "Google Drive đã hết dung lượng. Thay đổi chưa được lưu; hãy giải phóng dung lượng hoặc xuất JSON để sao lưu." : `Chưa lưu được: ${error.message}`);
    return false;
  } finally {
    saving = false;
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
        Object.assign(card, fields); // Giữ nguyên SRS khi sửa nội dung.
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
    if (ok) notify("Đã nhập dữ liệu.");
  } catch (error) { notify(`Không nhập được: ${error.message}`); }
  finally { $("importFile").value = ""; }
}

async function reloadExternal() {
  try {
    state = await loadData() || emptyData();
    session = null;
    ["editorDialog", "reviewDialog"].forEach(id => { if ($(id).open) $(id).close(); });
    render();
    notify("Đã tải thay đổi từ thiết bị hoặc tab khác. Hãy mở lại thẻ nếu đang chỉnh sửa.");
  } catch (error) { handleLoadError(error); }
}

function showRecovery(error) {
  state = null;
  document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  $("loading").hidden = true;
  $("app").hidden = true;
  $("recovery").hidden = false;
  $("recoveryMessage").textContent = `Không đọc được dữ liệu trên Google Drive: ${error.message}`;
}

async function initialize() {
  try {
    await setupGoogle();
    // Lần đầu chưa có quyền: cần một lần bấm của người dùng để trình duyệt không chặn popup.
    if (!hasValidToken() && !isLinked()) return showGate();
    state = await loadData() || await migrateLegacy() || emptyData();
    render();
    $("loading").hidden = true;
    $("recovery").hidden = true;
    $("app").hidden = false;
    if ($("driveGate")?.open) $("driveGate").close();
  } catch (error) { handleLoadError(error); }
}

$("newCard").addEventListener("click", () => openEditor());
$("cardForm").addEventListener("submit", submitCard);
$("search").addEventListener("input", renderCards);
["folderFilter", "tagFilter", "includeChildren", "reviewMode"].forEach(id => $(id).addEventListener("change", renderCards));
$("startReview").addEventListener("click", startReview);
$("revealButton").addEventListener("click", reveal);
$("undoReview").addEventListener("click", undoReview);
document.querySelectorAll("[data-grade]").forEach(button => button.addEventListener("click", () => gradeCard(button.dataset.grade)));
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => { if (!saving) $(button.dataset.close).close(); }));
$("reviewDialog").addEventListener("close", () => { session = null; });
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
document.addEventListener("visibilitychange", () => { if (!document.hidden) void checkRemote(); });
setInterval(() => void checkRemote(), 60000);
$("disconnectButton").addEventListener("click", disconnectDrive);
$("downloadRaw").addEventListener("click", async () => {
  try {
    const id = await findFile();
    if (!id) throw new Error("Chưa có tệp dữ liệu nào trên Google Drive.");
    download("nhip-hoc-du-lieu-goc.json", await downloadFile(id));
  } catch (error) { notify(error.message); }
});
$("resetStorage").addEventListener("click", async () => {
  if (!confirm("Xóa dữ liệu Nhịp Học trên Google Drive? Mọi thiết bị dùng chung tài khoản này đều mất dữ liệu và không thể hoàn tác. Hãy tải dữ liệu đang lưu trước.")) return;
  try {
    const id = await findFile();
    if (id) await driveFetch(`${DRIVE.api}/files/${id}`, { method: "DELETE" });
    driveFileId = "";
    await initialize();
  } catch (error) { handleLoadError(error); }
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
