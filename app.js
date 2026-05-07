/* global kakao */
const SERVICE_KEY = "59564443627a786a3131374a6853794c";
const API_HTTP  = `http://openapi.seoul.go.kr:8088/${SERVICE_KEY}/json/GetParkingInfo/{a}/{b}/`;
const API_HTTPS = `https://openapi.seoul.go.kr:8088/${SERVICE_KEY}/json/GetParkingInfo/{a}/{b}/`;
// 좌표 전용 API (GetParkInfo) - LAT/LOT 필드 포함
const COORD_API_HTTP  = `http://openapi.seoul.go.kr:8088/${SERVICE_KEY}/json/GetParkInfo/{a}/{b}/`;
const COORD_API_HTTPS = `https://openapi.seoul.go.kr:8088/${SERVICE_KEY}/json/GetParkInfo/{a}/{b}/`;
// 경기도 API (openapigits.gg.go.kr)
const GG_API = `https://openapigits.gg.go.kr/api/rest/getParkingPlaceInfoList?serviceKey={KEY}&pageNo={a}&numOfRows={b}&type=json`;
// 인천 API (data.go.kr)
const IC_API = `https://apis.data.go.kr/6280000/ICParking/getIcParkingList?serviceKey={KEY}&pageNo={a}&numOfRows={b}&type=json`;
const SUBWAY_CSV =
  "https://gist.githubusercontent.com/yoon-gu/902efb6d5bd345e3837e035a3c0642b8/raw/station_latlen.csv";
const STATION_KM = 1.35;
const EXPLORE_M = 800;
const PAGE_SIZE = 1000;
const FAV_KEY = "assistantSeoulParking.favorites.final";
const OVERPASS_URLS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

const $ = (id) => document.getElementById(id);
let toastTimer = 0;
let fetchBusy = false;

/** @type {any | null} */
let map = null;
/** @type {any[]} */
let overlayObjs = [];
/** @type {Map<string, any>} */
const parkingDots = new Map();
/** @type {any[]} */
let parkingObjs = [];
/** @type {any | null} */
let userDot = null;
/** @type {any | null} */
let pivotDot = null;
/** @type {any | null} */
let pickRing = null;
/** @type {any | null} */
let infoWin = null;

const state = {
  lots: [],
  filt: [],
  stations: [],
  pivot: /** @type {{ nameKr: string; slug: string; lat: number; lon: number } | null} */ (null),
  nmSlug: "",
  me: /** @type {{ lat: number; lon: number } | null} */ (null),
  pick: /** @type {string | null} */ (null),
  fav: new Set(),
  updated: /** @type {Date | null} */ (null),
  tab: /** @type {"food" | "fuel" | "sight"} */ ("food"),
  ex: new Map(),
  exAb: /** @type {AbortController | null} */ (null),
  filterLight: false,
  filterEv: false,
};

function paintMapProviderPill() {
  const el = $("mapProviderPill");
  if (!(el instanceof HTMLElement)) return;
  const hasKey = Boolean(getKakaoJsKey());
  el.textContent = hasKey ? "지도: 카카오맵 JS SDK" : "지도: 카카오맵 JS SDK (JavaScript 키 필요)";
}

document.addEventListener("DOMContentLoaded", () => {
  favLoad();
  paintMapProviderPill();
  void initMap().then(() => {
    redraw();
  });
  wire();
  void loadSubwayCsv();
  void loadParking(false);
});

function slugify(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\s·•・]+/g, "")
    .replace(/^서울/, "")
    .replace(/역+$/u, "")
    .replace(/[^0-9a-z가-힣ㄱ-ㅎ]/gu, "");
}

function nz(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function uniqByCode(rows) {
  const m = new Map();
  for (const row of rows) if (row.code) m.set(row.code, row);
  return [...m.values()];
}

function findLot(code) {
  return state.lots.find((r) => r.code === code);
}

function havM(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const q =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(q)));
}

function geoPill(t) {
  const g = $("geoStatusPill");
  if (g) g.textContent = t;
}

function banner(m) {
  const er = $("errorArea");
  if (!er) return;
  er.hidden = false;
  er.textContent = m;
}

function bannerHide() {
  const er = $("errorArea");
  if (!er) return;
  er.hidden = true;
  er.textContent = "";
}

function toast(text) {
  const t = $("toast");
  if (!(t instanceof HTMLElement)) return;
  window.clearTimeout(toastTimer);
  t.style.display = "block";
  t.textContent = text;
  toastTimer = window.setTimeout(() => {
    t.style.display = "none";
  }, 2100);
}

function favLoad() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    state.fav = new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
  } catch {
    state.fav = new Set();
  }
}

function saveFavs() {
  localStorage.setItem(FAV_KEY, JSON.stringify([...state.fav]));
}

function favToggle(code) {
  if (state.fav.has(code)) state.fav.delete(code);
  else state.fav.add(code);
  saveFavs();
}

function decodeTxt(text) {
  return String(text ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .trim();
}

function escHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pickCoord(raw, keys, lo, hi) {
  for (const k of keys) {
    const v = Number(raw[k]);
    if (!Number.isFinite(v)) continue;
    if (v >= lo && v <= hi) return v;
  }
  return null;
}

function parseBoolOrNum(val) {
  if (val == null || val === "") return { yn: null, n: null };
  const s = String(val).trim().toUpperCase();
  if (["Y", "YES", "1", "TRUE", "O"].includes(s)) return { yn: true, n: null };
  if (["N", "NO", "0", "FALSE", "X"].includes(s)) return { yn: false, n: null };
  const nn = Number(val);
  return { yn: null, n: Number.isFinite(nn) ? nz(nn) : null };
}

function sniffMeta(entry) {
  let light = null;
  let ev = null;
  let h24 = null;
  for (const [k0, vv] of Object.entries(entry)) {
    const ku = String(k0).toUpperCase();
    const { yn, n } = parseBoolOrNum(vv);
    if (/LIGH|LPV|경차|CMPCT|SML|SMALL|소형|경량/.test(ku) && n != null) light = light == null ? n : light;
    if (/ELEC|ELCT|EV|충전|CHR|CHG|전기/.test(ku)) {
      if (n != null && n > 0) ev = (ev ?? 0) + n;
      else if (yn === true && ev == null) ev = 1;
    }
    if (/24|ALLDAY|전일|TOT_OPS|HDRY|야간/.test(ku) && yn != null) h24 = h24 ?? yn;
  }
  return { lightDutySpots: light, evCharges: ev, operates24Hours: h24 };
}

// 경기도 API row → 공통 포맷
function normGGRow(raw) {
  const code = String(raw.pkplcId ?? "").trim();
  const name = String(raw.pkplcNm ?? "").trim();
  if (!code || !name) return null;
  const total = nz(raw.pklotCnt ?? raw.prkplcCnt);
  const parked = nz(raw.nowPrkVhclCnt ?? 0);
  const remaining = Math.max(0, total - parked);
  const lat = pickCoord(raw, ["latCrdn", "lat", "LAT"], 33, 39);
  const lon = pickCoord(raw, ["lonCrdn", "lon", "LON", "LOT"], 124, 132);
  return { code: `GG_${code}`, name: `[경기] ${name}`, total, remaining, lat, lon, raw, region: "경기", ...sniffMeta(raw) };
}

// 인천 API row → 공통 포맷
function normICRow(raw) {
  const code = String(raw.pkltCd ?? raw.prkplcId ?? "").trim();
  const name = String(raw.pkltNm ?? raw.prkplcNm ?? "").trim();
  if (!code || !name) return null;
  const total = nz(raw.tpkct ?? raw.pklotCnt ?? 0);
  const parked = nz(raw.nowPrkVhclCnt ?? 0);
  const remaining = Math.max(0, total - parked);
  const lat = pickCoord(raw, ["lat", "LAT", "latCrdn", "ypos"], 33, 39);
  const lon = pickCoord(raw, ["lot", "LOT", "lon", "LON", "lonCrdn", "xpos"], 124, 132);
  return { code: `IC_${code}`, name: `[인천] ${name}`, total, remaining, lat, lon, raw, region: "인천", ...sniffMeta(raw) };
}

function normRow(raw) {
  const code = String(raw.PKLT_CD ?? "").trim();
  const name = String(raw.PKLT_NM ?? "").trim();
  if (!code || !name) return null;
  const total = nz(raw.TPKCT);
  const parked = nz(raw.NOW_PRK_VHCL_CNT);
  const remaining = Math.max(0, total - parked);
  const lat = pickCoord(
    raw,
    ["LAT", "WGS84_LAT", "GPS_LAT", "Y_WGS84", "Y", "YCRDNT", "YCOORD"],
    -90,
    90
  );
  const lon = pickCoord(
    raw,
    ["LON", "LNG", "LOT", "WGS84_LON", "GPS_LON", "X", "XCRDNT", "XCOORD"],
    -180,
    180
  );
  // 요금 정보
  const payFree = String(raw.PAY_YN ?? "").toUpperCase() === "N";
  const bscCrg  = raw.BSC_PRK_CRG != null ? nz(raw.BSC_PRK_CRG) : null;
  const bscMin  = raw.BSC_PRK_HR  != null ? nz(raw.BSC_PRK_HR)  : null;
  const addCrg  = raw.ADD_PRK_CRG != null ? nz(raw.ADD_PRK_CRG) : null;
  const addMin  = raw.ADD_PRK_HR  != null ? nz(raw.ADD_PRK_HR)  : null;
  const dayMax  = raw.DAY_MAX_CRG != null ? nz(raw.DAY_MAX_CRG) : null;
  return { code, name, total, remaining, lat, lon, raw, payFree, bscCrg, bscMin, addCrg, addMin, dayMax, ...sniffMeta(raw) };
}

async function fetchJsonAny(makers) {
  let last = /** @type {Error|null} */ (null);
  for (const mk of makers) {
    try {
      const res = await fetch(mk(), { headers: { Accept: "application/json,text/plain,*/*" } });
      if (!res.ok) last = new Error(String(res.status));
      else return await res.json();
    } catch (e) {
      last = /** @type {Error} */ (e);
    }
  }
  throw last ?? new Error("네트워크 요청 실패");
}

async function loadGGRows(key) {
  const rows = [];
  let page = 1;
  for (;;) {
    const target = GG_API.replace("{KEY}", encodeURIComponent(key))
      .replace("{a}", String(page)).replace("{b}", "1000");
    // 로컬 프록시 서버 경유 (proxy.js, 포트 5174)
    // 로컬이면 local proxy(5174), 배포 환경이면 Vercel 서버리스 /api/proxy 사용
    const proxyBase = location.hostname === "localhost" || location.hostname === "127.0.0.1"
      ? `http://localhost:5174/`
      : `/api/proxy`;
    const proxied = `${proxyBase}?url=${encodeURIComponent(target)}`;
    try {
      const res = await fetch(proxied);
      if (!res.ok) { console.log("[경기 API] 응답 오류:", res.status); break; }
      const text = await res.text();
      if (page === 1) console.log("[경기 API] 응답 미리보기:", text.slice(0, 400));
      let js;
      try { js = JSON.parse(text); } catch { console.log("[경기 API] JSON 파싱 실패 - XML?"); break; }
      const items = js?.getParkingPlaceInfoList?.item
        ?? js?.response?.body?.items?.item
        ?? js?.items?.item
        ?? js?.item
        ?? [];
      const arr = Array.isArray(items) ? items : items ? [items] : [];
      if (!arr.length) break;
      rows.push(...arr);
      if (arr.length < 1000) break;
      page++;
    } catch { break; }
  }
  console.log(`[경기 API] ${rows.length}개 로드`);
  return rows;
}

async function loadICRows(key) {
  const rows = [];
  let page = 1;
  for (;;) {
    const url = IC_API.replace("{KEY}", encodeURIComponent(key))
      .replace("{a}", String(page)).replace("{b}", "1000");
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      const js = await res.json();
      const items = js?.response?.body?.items?.item ?? js?.items?.item ?? [];
      const arr = Array.isArray(items) ? items : items ? [items] : [];
      if (!arr.length) break;
      rows.push(...arr);
      if (arr.length < 1000) break;
      page++;
    } catch { break; }
  }
  console.log(`[인천 API] ${rows.length}개 로드`);
  return rows;
}

async function fetchAllPages(apiHttp, apiHttps, rootKey) {
  const acc = [];
  let start = 1;
  for (;;) {
    const end = start + PAGE_SIZE - 1;
    const js = await fetchJsonAny([
      () => apiHttp.replace("{a}", String(start)).replace("{b}", String(end)),
      () => apiHttps.replace("{a}", String(start)).replace("{b}", String(end)),
    ]);
    const root = js[rootKey] || js[rootKey.toUpperCase()] || {};
    const rows = Array.isArray(root.row) ? root.row : Array.isArray(root.ROW) ? root.ROW : [];
    if (!rows.length) break;
    acc.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }
  return acc;
}

async function loadParking(showToast) {
  if (fetchBusy) return;
  fetchBusy = true;
  const bt = $("btnRefresh");
  const lb = $("btnRefreshLabel");
  bt?.setAttribute("disabled", "true");
  if (lb) lb.textContent = "불러오는 중…";
  bannerHide();
  try {
    // 1) 좌표 API (GetParkInfo) 에서 PKLT_CD → {lat, lon} 맵 생성
    const coordRows = await fetchAllPages(COORD_API_HTTP, COORD_API_HTTPS, "GetParkInfo");
    /** @type {Map<string, {lat: number, lon: number}>} */
    const coordMap = new Map();
    /** @type {Map<string, {lat:number,lon:number,light:number|null,ev:number|null}>} */
    for (const r of coordRows) {
      const code = String(r.PKLT_CD ?? "").trim();
      const lat = pickCoord(r, ["LAT", "WGS84_LAT", "Y", "YCRDNT"], 33, 39);
      const lon = pickCoord(r, ["LOT", "LON", "LNG", "WGS84_LON", "X", "XCRDNT"], 124, 132);
      if (code && lat != null && lon != null) {
        // 경차/전기차 대수도 GetParkInfo에서 추출
        const light = r.LGHT_VHCL_PKLT_CNT != null ? nz(r.LGHT_VHCL_PKLT_CNT) :
                      r.SMALL_CAR_PKLT_CNT  != null ? nz(r.SMALL_CAR_PKLT_CNT)  : null;
        const ev    = r.ELEC_VHCL_CHRG_CNT  != null ? nz(r.ELEC_VHCL_CHRG_CNT)  :
                      r.EV_CHRG_CNT          != null ? nz(r.EV_CHRG_CNT)          : null;
        coordMap.set(code, { lat, lon, light, ev });
      }
    }
    console.log(`[좌표 API] ${coordMap.size}개 주차장 좌표 로드`);

    // 2) 실시간 잔여 API (GetParkingInfo) + 경기/인천 병렬 로드
    const ggKey = getLsKey("GG_PARKING_KEY", "ggKey");
    const icKey = getLsKey("IC_PARKING_KEY", "icKey");

    const [parkRows, ggRows, icRows] = await Promise.all([
      fetchAllPages(API_HTTP, API_HTTPS, "GetParkingInfo"),
      ggKey ? loadGGRows(ggKey) : Promise.resolve([]),
      icKey ? loadICRows(icKey) : Promise.resolve([]),
    ]);

    const acc = [];
    // 서울
    for (const r of parkRows) {
      const row = normRow(r);
      if (!row) continue;
      const coord = coordMap.get(row.code);
      if (coord) {
        row.lat = coord.lat; row.lon = coord.lon;
        if (coord.light != null) row.lightDutySpots = coord.light;
        if (coord.ev    != null) row.evCharges      = coord.ev;
      }
      acc.push(row);
    }
    // 경기
    for (const r of ggRows) {
      const row = normGGRow(r);
      if (row) acc.push(row);
    }
    // 인천
    for (const r of icRows) {
      const row = normICRow(r);
      if (row) acc.push(row);
    }

    state.lots = uniqByCode(acc);
    state.updated = new Date();
    redraw();
    if (showToast) toast(`주차장 ${state.lots.length.toLocaleString("ko-KR")}곳 로드 (서울+경기+인천)`);
  } catch (e) {
    banner(String(/** @type {Error} */ (e)?.message ?? e));
  } finally {
    fetchBusy = false;
    bt?.removeAttribute("disabled");
    if (lb) lb.textContent = "새로고침";
  }
}

function applyFilterSort() {
  let xs = [...state.lots];
  if (state.nmSlug) xs = xs.filter((p) => slugify(p.name).includes(state.nmSlug));
  // 경차 필터: lightDutySpots > 0 확인된 곳만
  if (state.filterLight) xs = xs.filter((p) => p.lightDutySpots != null && p.lightDutySpots > 0);
  // 전기차 필터: evCharges > 0 확인된 곳만
  if (state.filterEv) xs = xs.filter((p) => p.evCharges != null && p.evCharges > 0);
  if (state.pivot) {
    const maxM = STATION_KM * 1000;
    xs = xs.filter((p) => {
      if (p.lat == null || p.lon == null) return false;
      return havM(state.pivot.lat, state.pivot.lon, p.lat, p.lon) <= maxM;
    });
    xs.sort((a, b) => {
      const da = havM(state.pivot.lat, state.pivot.lon, a.lat, a.lon);
      const db = havM(state.pivot.lat, state.pivot.lon, b.lat, b.lon);
      return da - db || b.remaining - a.remaining;
    });
  } else {
    xs.sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name, "ko"));
  }
  state.filt = xs;
}

function getLsKey(lsName, urlParam) {
  try {
    const qp = new URLSearchParams(location.search);
    const fromUrl = qp.get(urlParam);
    if (fromUrl) return fromUrl.trim();
    return (localStorage.getItem(lsName) ?? "").trim();
  } catch { return ""; }
}
function setLsKey(lsName, val) {
  try { localStorage.setItem(lsName, val); } catch {}
}

function getKakaoRestKey() {
  return getLsKey("KAKAO_REST_KEY", "kakaoRestKey");
}

function getKakaoJsKey() {
  const qp = new URLSearchParams(location.search);
  const fromUrl = qp.get("kakaoJsKey");
  if (fromUrl) return fromUrl.trim();
  try {
    const v = localStorage.getItem("KAKAO_MAPS_JS_KEY");
    return (v ?? "").trim();
  } catch {
    return "";
  }
}

function showKakaoSetup(msg) {
  const modal = $("settingsModal");
  if (modal) modal.hidden = false;
  const hint = $("kakaoSetupHint");
  if (hint) hint.textContent = msg ?? "";
  const jsInp = $("kakaoJsKeyInput");
  if (jsInp instanceof HTMLInputElement && !jsInp.value) jsInp.value = getKakaoJsKey();
  const restInp = $("kakaoRestKeyInput");
  if (restInp instanceof HTMLInputElement && !restInp.value) restInp.value = getKakaoRestKey();
  const ggInp = $("ggKeyInputModal");
  if (ggInp instanceof HTMLInputElement && !ggInp.value) ggInp.value = getLsKey("GG_PARKING_KEY", "ggKey");
  const icInp = $("icKeyInputModal");
  if (icInp instanceof HTMLInputElement && !icInp.value) icInp.value = getLsKey("IC_PARKING_KEY", "icKey");
}

function hideKakaoSetup() {
  const modal = $("settingsModal");
  if (modal) modal.hidden = true;
  const hint = $("kakaoSetupHint");
  if (hint) hint.textContent = "";
}

function ensureKakaoMapsLoaded() {
  if (window.kakao?.maps?.load) return Promise.resolve();
  const key = getKakaoJsKey();
  if (!key) {
    showKakaoSetup("JavaScript 키가 비어있습니다. 위 입력칸에 카카오 JavaScript 키를 저장해 주세요.");
    banner("카카오맵 JavaScript 키가 필요합니다.");
    return Promise.reject(new Error("missing kakao js key"));
  }
  paintMapProviderPill();
  hideKakaoSetup();
  bannerHide();
  return new Promise((resolve, reject) => {
    const already = document.querySelector('script[data-kakao-maps="1"]');
    if (already) {
      const tick = () => (window.kakao?.maps?.load ? resolve() : setTimeout(tick, 60));
      tick();
      return;
    }
    const s = document.createElement("script");
    s.defer = true;
    s.async = true;
    s.dataset.kakaoMaps = "1";
    // autoload=false so we can call kakao.maps.load after script is ready
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
    s.onload = () => {
      if (!window.kakao?.maps?.load) {
        showKakaoSetup("카카오맵 SDK는 로드됐는데 초기화(load)가 없습니다. 키/네트워크를 확인해 주세요.");
        reject(new Error("kakao maps load missing"));
        return;
      }
      window.kakao.maps.load(() => resolve());
    };
    s.onerror = () => {
      showKakaoSetup("카카오맵 스크립트 로드에 실패했습니다. (네트워크/방화벽 차단 또는 키/도메인 설정 문제)");
      reject(new Error("kakao maps script error"));
    };
    document.head.appendChild(s);
  });
}

function clearOverlays() {
  for (const o of overlayObjs) try { o.setMap(null); } catch {}
  overlayObjs = [];
  userDot = null;
  pivotDot = null;
  pickRing = null;
}

function clearParking() {
  for (const o of parkingObjs) try { o.setMap(null); } catch {}
  parkingObjs = [];
  parkingDots.clear();
}

function renderNearest() {
  const wrap = $("nearestTop3");
  if (!wrap) return;
  // pivot(검색 위치) 기준 TOP3
  const ref = state.pivot;
  if (!ref) {
    wrap.innerHTML = "";
    return;
  }
  const lots = state.filterLight || state.filterEv ? state.filt : state.lots;
  const top = lots
    .filter((p) => p.lat != null && p.lon != null)
    .map((p) => ({ p, d: havM(ref.lat, ref.lon, p.lat, p.lon) }))
    .sort((a, b) => a.d - b.d || b.p.remaining - a.p.remaining)
    .slice(0, 3);
  if (!top.length) {
    wrap.innerHTML = `<div class="miniCard"><div class="miniMetric muted">근처 주차장 없음</div></div>`;
    return;
  }
  wrap.innerHTML = top
    .map(
      ({ p, d }, i) =>
        `<div class="miniCard${p.remaining < 5 ? " low" : p.remaining >= 10 ? " good" : ""}" data-nearest-code="${escHtml(p.code)}">
          <div class="miniTitle">TOP ${i + 1} · ${escHtml(p.name)}</div>
          <div class="miniMetric">${(d / 1000).toFixed(2)} km · 잔여 ${p.remaining}
            ${p.lightDutySpots ? ` · 경차 ${p.lightDutySpots}` : ""}
            ${p.evCharges ? ` · EV ${p.evCharges}` : ""}
          </div>
        </div>`
    )
    .join("");
}

function paintUser() {
  if (!map || !state.me || !window.kakao?.maps) return;
  const ll = new kakao.maps.LatLng(state.me.lat, state.me.lon);
  if (!userDot) {
    userDot = new kakao.maps.CustomOverlay({
      position: ll,
      content:
        '<div style="width:14px;height:14px;border-radius:999px;background:#274bff;border:2px solid #ffffff;box-shadow:0 2px 10px rgba(0,0,0,.18)"></div>',
      zIndex: 1000,
    });
    userDot.setMap(map);
    overlayObjs.push(userDot);
    return;
  }
  userDot.setPosition(ll);
}

function paintLots() {
  if (!map || !window.kakao?.maps) return;
  clearParking();
  for (const lot of state.filt) {
    if (lot.lat == null || lot.lon == null) continue;
    const col    = lot.remaining < 5 ? "#ef4444" : lot.remaining >= 10 ? "#22c55e" : "#2563eb";
    const shadow = lot.remaining < 5 ? "rgba(239,68,68,.35)" : lot.remaining >= 10 ? "rgba(34,197,94,.35)" : "rgba(37,99,235,.35)";

    // 가격 라벨 (기본요금만 짧게)
    let priceLabel = "";
    if (lot.payFree) {
      priceLabel = "무료";
    } else if (lot.bscCrg != null && lot.bscCrg > 0) {
      priceLabel = `${lot.bscCrg.toLocaleString()}원~`;
    }

    const codeKey = `lot_${lot.code.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    // 전역 클릭 핸들러에 등록
    window.__lotClickHandlers = window.__lotClickHandlers || {};
    window.__lotClickHandlers[codeKey] = () => selectLot(lot.code);

    const content = document.createElement("div");
    content.style.cssText = "display:flex;flex-direction:column;align-items:center;cursor:pointer;user-select:none";
    content.innerHTML = `
      <div style="width:28px;height:28px;border-radius:50%;background:${col};border:2.5px solid #fff;box-shadow:0 2px 8px ${shadow};display:flex;align-items:center;justify-content:center;font:800 12px/1 Arial,sans-serif;color:#fff">P</div>
      <div style="margin-top:2px;background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.1);border-radius:6px;padding:1px 5px;font:600 10px/1.4 SUIT,system-ui,sans-serif;color:#1e293b;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
        <span style="color:${col};font-weight:800">${lot.remaining}</span>${priceLabel ? ` · ${escHtml(priceLabel)}` : ""}
      </div>`;
    content.addEventListener("click", (e) => {
      e.stopPropagation();
      selectLot(lot.code);
      // InfoWindow 팝업
      try {
        if (infoWin) infoWin.close();
        const light  = lot.lightDutySpots != null ? `🚗 경차 ${lot.lightDutySpots}` : "";
        const ev     = lot.evCharges      != null ? `⚡ EV ${lot.evCharges}`         : "";
        const extra  = [light, ev].filter(Boolean).join(" &nbsp;·&nbsp; ");
        const feeStr = fmtFee(lot);
        infoWin = new kakao.maps.InfoWindow({
          position: new kakao.maps.LatLng(lot.lat, lot.lon),
          content: `<div style="padding:10px 14px;border-radius:14px;background:#fff;border:1px solid rgba(8,30,80,0.14);box-shadow:0 10px 26px rgba(0,0,0,0.14);font:600 13px/1.5 SUIT,system-ui;min-width:160px">
            <div style="font-weight:900;margin-bottom:4px">${escHtml(lot.name)}</div>
            <div style="color:rgba(8,30,80,0.75)">🅿️ 잔여 <strong style="color:${col}">${lot.remaining}</strong> / ${lot.total}</div>
            ${extra  ? `<div style="color:rgba(8,30,80,0.65);font-size:12px;margin-top:3px">${extra}</div>`  : ""}
            ${feeStr ? `<div style="color:rgba(8,30,80,0.65);font-size:12px;margin-top:3px">💰 ${feeStr}</div>` : ""}
          </div>`,
          removable: true,
        });
        infoWin.open(map);
      } catch {}
    });

    const overlay = new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(lot.lat, lot.lon),
      content,
      yAnchor: 0,
      zIndex: 10,
    });
    overlay.setMap(map);

    parkingObjs.push(overlay);
    parkingDots.set(lot.code, overlay);
  }
}

function paintPick(lot) {
  if (!map || !window.kakao?.maps) {
    pickRing = null;
    return;
  }
  if (!lot || lot.lat == null || lot.lon == null) {
    if (pickRing) try { pickRing.setMap(null); } catch {}
    pickRing = null;
    return;
  }
  if (pickRing) try { pickRing.setMap(null); } catch {}
  pickRing = new kakao.maps.CustomOverlay({
    position: new kakao.maps.LatLng(lot.lat, lot.lon),
    content:
      '<div style="width:34px;height:34px;border-radius:999px;border:3px solid #f59e0b;background:transparent;box-shadow:0 8px 20px rgba(245,158,11,0.22)"></div>',
    zIndex: 900,
  });
  pickRing.setMap(map);
  overlayObjs.push(pickRing);
}

function pills() {
  const c = $("countPill");
  if (c) c.textContent = `표시 ${state.filt.length}/${state.lots.length}`;
  const u = $("updatedAtPill");
  if (u && state.updated) u.textContent = `마지막 갱신: ${state.updated.toLocaleString("ko-KR")}`;
}

function renderList() {
  const grid = $("lotListGrid");
  if (!grid) return;
  grid.innerHTML = state.filt
    .map((lot) => {
      const tier = lot.remaining < 5 ? " is-low" : lot.remaining >= 10 ? " is-good" : "";
      const on = lot.code === state.pick ? " is-selected" : "";
      return `<article class="lotCard${tier}${on}" data-code="${escHtml(lot.code)}">
        <div class="lotName">${escHtml(lot.name)}</div>
        <div class="lotFacts"><span>잔여 ${lot.remaining}</span><span>총 ${lot.total}</span></div>
      </article>`;
    })
    .join("");
}

function renderDetail() {
  const el = $("detailPanel");
  if (!el) return;
  const lot = findLot(state.pick);
  if (!lot) {
    el.className = "detailEmpty";
    el.textContent = "지도 또는 리스트에서 주차장을 선택해 주세요.";
    return;
  }
  el.className = "";
  const fav = state.fav.has(lot.code);
  const y24 =
    lot.operates24Hours == null ? "확인 필요" : lot.operates24Hours ? "가능 추정" : "제한/확인";
  const feeStr = fmtFee(lot);
  el.innerHTML = `<div class="detailCard">
    <div class="detailHeader"><h3 class="detailTitle">${escHtml(lot.name)}</h3></div>
    <div class="detailMetaRow">
      <span class="statChip">🅿️ 잔여 <strong>${lot.remaining}</strong> / ${lot.total}</span>
      <span class="statChip">⚡ EV <strong>${lot.evCharges ?? "—"}</strong></span>
      <span class="statChip">🕐 24h <strong>${escHtml(y24)}</strong></span>
    </div>
    ${feeStr ? `<div class="feeRow"><span class="feeChip">💰 ${escHtml(feeStr)}</span></div>` : ""}
    <div class="actionRow">
      <button type="button" class="btn secondary icon" data-action="nav" data-code="${escHtml(lot.code)}">길안내</button>
      <button type="button" class="btn secondary icon" data-action="rv" data-code="${escHtml(lot.code)}">로드뷰</button>
      <button type="button" class="btn secondary icon" data-action="share" data-code="${escHtml(lot.code)}">공유</button>
      <button type="button" class="btn ghost icon star${
        fav ? " is-active" : ""
      }" data-action="star" data-code="${escHtml(lot.code)}">즐겨찾기</button>
    </div></div>`;
}

function fmtFee(lot) {
  if (!lot) return "";
  if (lot.payFree) return "무료";
  if (lot.bscCrg == null && lot.addCrg == null) return lot.payFree === false ? "유료 (요금 미제공)" : "";
  const parts = [];
  if (lot.bscCrg != null && lot.bscMin != null)
    parts.push(`기본 ${lot.bscMin}분 ${lot.bscCrg.toLocaleString()}원`);
  else if (lot.bscCrg != null)
    parts.push(`기본 ${lot.bscCrg.toLocaleString()}원`);
  if (lot.addCrg != null && lot.addMin != null)
    parts.push(`추가 ${lot.addMin}분당 ${lot.addCrg.toLocaleString()}원`);
  if (lot.dayMax != null && lot.dayMax > 0)
    parts.push(`일 최대 ${lot.dayMax.toLocaleString()}원`);
  return parts.join(" · ");
}

async function kakaoLocalSearch(mode, lat, lon, signal) {
  const key = getKakaoRestKey() || getKakaoJsKey();
  if (!key) throw new Error("카카오 키 없음");

  let url;
  if (mode === "food") {
    // 키워드 검색: 맛집 기준 (카카오맵 리뷰/인기 기반 정렬)
    url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=맛집&x=${lon}&y=${lat}&radius=${EXPLORE_M}&size=10&sort=accuracy`;
  } else if (mode === "fuel") {
    // 카테고리 검색: 주유소
    url = `https://dapi.kakao.com/v2/local/search/category.json?category_group_code=OL7&x=${lon}&y=${lat}&radius=${EXPLORE_M}&size=10&sort=distance`;
  } else {
    url = `https://dapi.kakao.com/v2/local/search/category.json?category_group_code=AT4&x=${lon}&y=${lat}&radius=${EXPLORE_M}&size=10&sort=distance`;
  }

  const res = await fetch(url, {
    headers: { Authorization: `KakaoAK ${key}` },
    signal,
  });
  if (!res.ok) throw new Error(`카카오 로컬 ${res.status}`);
  const js = await res.json();
  return (js.documents ?? []).map((d) => ({
    name: d.place_name,
    distanceM: Number(d.distance) || 0,
    address: d.road_address_name || d.address_name || "",
    url: d.place_url || "",
    id: d.id || "",
    category: d.category_name || "",
  }));
}

async function ovFetch(q, signal) {
  const body = new URLSearchParams();
  body.set("data", q);
  let last = /** @type {Error|null} */ (null);
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, { method: "POST", body, signal });
      if (res.status === 429 || res.status === 503) {
        // 서버 과부하/제한 → 다음 서버로 넘어가기 전 짧은 대기
        await new Promise((r) => setTimeout(r, 600));
        last = new Error(String(res.status));
        continue;
      }
      if (!res.ok) { last = new Error(String(res.status)); continue; }
      return await res.json();
    } catch (e) {
      last = /** @type {Error} */ (e);
    }
  }
  throw last ?? new Error("Overpass 실패");
}

function ovParse(js, plat, plon) {
  const xs = [];
  for (const el of js.elements || []) {
    let la = el.lat;
    let lo = el.lon;
    if (la == null && el.center) {
      la = el.center.lat;
      lo = el.center.lon;
    }
    if (la == null || lo == null) continue;
    const tags = el.tags || {};
    const name = tags.name || tags["name:ko"] || tags["name:en"] || "이름 없음";
    xs.push({
      name: String(name),
      lat: la,
      lon: lo,
      distanceM: havM(plat, plon, la, lo),
    });
  }
  xs.sort((a, b) => a.distanceM - b.distanceM);
  return xs.slice(0, 10);
}

function foodEmoji(category) {
  const c = category || "";
  if (/카페|커피|디저트|베이커리|제과/.test(c)) return "☕";
  if (/치킨|닭/.test(c)) return "🍗";
  if (/피자/.test(c)) return "🍕";
  if (/일식|스시|초밥|라멘|우동/.test(c)) return "🍣";
  if (/중식|중국|짜장|짬뽕/.test(c)) return "🥢";
  if (/분식|떡볶이|순대/.test(c)) return "🍢";
  if (/고기|삼겹|갈비|스테이크|육류/.test(c)) return "🥩";
  if (/해산물|횟집|조개|굴/.test(c)) return "🦞";
  if (/샌드위치|버거|패스트/.test(c)) return "🍔";
  if (/주유|오일/.test(c)) return "⛽";
  return "🍽️";
}

function renderExplore(xs) {
  const box = $("exploreResults");
  if (!box) return;
  if (!xs.length) {
    box.innerHTML = `<div class="pill muted">근처 결과 없음</div>`;
    return;
  }
  box.innerHTML = xs
    .map((row) => {
      const dist = Math.round(row.distanceM);
      const addr = row.address ? `<span class="exploreAddr">${escHtml(row.address)}</span>` : "";
      const placeUrl = row.url || "";
      // 카카오 Place 썸네일 (place id 기반)
      const tag = placeUrl ? `a href="${escHtml(placeUrl)}" target="_blank" rel="noopener"` : `div`;
      const tagClose = placeUrl ? "a" : "div";
      return `<${tag} class="exploreCard">
        <div class="exploreCardBody">
          <div class="exploreCardName">${escHtml(row.name)}</div>
          <div class="exploreCardMeta">${dist} m${addr ? " · " : ""}${addr}</div>
        </div>
      </${tagClose}>`;
    })
    .join("");
}

async function exploreRun() {
  const wrap = $("exploreResults");
  const lot = findLot(state.pick);
  if (!lot || lot.lat == null || lot.lon == null) {
    if (wrap) wrap.innerHTML = `<div class="pill muted">주차장을 선택하면 주변 장소가 표시됩니다</div>`;
    return;
  }
  const key = `${lot.code}|${state.tab}`;
  if (state.ex.has(key)) return renderExplore(state.ex.get(key));
  state.exAb?.abort();
  state.exAb = new AbortController();
  if (wrap) wrap.innerHTML = `<div class="pill muted">불러오는 중…</div>`;
  try {
    // 카카오 로컬 API 우선 사용 (더 안정적)
    const xs = await kakaoLocalSearch(state.tab, lot.lat, lot.lon, state.exAb.signal);
    state.ex.set(key, xs);
    renderExplore(xs);
  } catch {
    // 카카오 실패 시 Overpass 폴백
    try {
      const js = await ovFetch(ovQuery(state.tab, lot.lat, lot.lon), state.exAb.signal);
      const xs = ovParse(js, lot.lat, lot.lon);
      state.ex.set(key, xs);
      renderExplore(xs);
    } catch {
      if (wrap) wrap.innerHTML = `<div class="pill muted">주변 검색 실패 · 잠시 후 다시 시도해주세요</div>`;
    }
  }
}

function redraw() {
  applyFilterSort();
  renderNearest();
  paintLots();
  pills();
  renderList();
  renderDetail();
  paintPick(findLot(state.pick));
  void exploreRun();
}

function selectLot(code) {
  state.pick = code;
  const lot = findLot(code);
  if (lot && lot.lat != null && lot.lon != null && map && window.kakao?.maps) {
    // Kakao: smaller level => closer zoom
    map.setLevel(4);
    map.panTo(new kakao.maps.LatLng(lot.lat, lot.lon));
  }
  redraw();
}

async function initMap() {
  try {
    await ensureKakaoMapsLoaded();
  } catch {
    return;
  }
  if (!window.kakao?.maps) {
    banner("카카오맵 API를 불러오지 못했습니다.");
    return;
  }
  const el = $("map");
  if (!el) return;
  map = new kakao.maps.Map(el, {
    center: new kakao.maps.LatLng(37.5665, 126.978),
    level: 8,
  });
  infoWin = new kakao.maps.InfoWindow({ removable: false });
  redraw();
}

function watchGeo() {
  // GPS 추적 비활성화 — 검색 위치 기준으로 TOP3 표시
}

async function loadSubwayCsv() {
  const hi = $("stationHint");
  try {
    const res = await fetch(SUBWAY_CSV, { cache: "force-cache" });
    const txt = await res.text();
    state.stations = txt
      .split(/\r?\n/)
      .slice(1)
      .flatMap((line) => {
        if (!line.trim()) return [];
        const [la, lo, nmRaw] = line.split(",");
        const lat = Number(la);
        const lon = Number(lo);
        const nameKr = decodeTxt(String(nmRaw ?? "").trim());
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !nameKr) return [];
        return [{ nameKr, slug: slugify(nameKr), lat, lon }];
      });
    if (hi) hi.textContent = `역 ${state.stations.length}개 로드 완료`;
  } catch {
    if (hi) hi.textContent = "역 CSV 로드 실패";
    state.stations = [];
  }
  redraw();
}

function stationTyping() {
  const inp = $("stationInput");
  const hi = $("stationHint");
  const val = inp instanceof HTMLInputElement ? inp.value.trim() : "";
  const slug = slugify(val);
  if (!slug) {
    state.pivot = null;
    if (hi) hi.textContent = "";
    if (pivotDot) try { pivotDot.setMap(null); } catch {}
    pivotDot = null;
    redraw();
    return;
  }
  if (!state.stations.length) {
    if (hi) hi.textContent = "역 좌표 로딩 중…";
    redraw();
    return;
  }
  const hits = state.stations.filter((s) => s.slug.includes(slug)).slice(0, 24);
  if (!hits.length) {
    state.pivot = null;
    if (hi) hi.textContent = "역을 찾지 못했습니다.";
    if (pivotDot) try { pivotDot.setMap(null); } catch {}
    pivotDot = null;
    redraw();
    return;
  }
  hits.sort((a, b) => a.nameKr.length - b.nameKr.length);
  const best = hits[0];
  state.pivot = best;
  if (hi) hi.textContent = `${best.nameKr} · 반경 ${STATION_KM}km`;
  if (map && window.kakao?.maps) {
    map.setLevel(6);
    map.panTo(new kakao.maps.LatLng(best.lat, best.lon));
  }
  if (map && window.kakao?.maps) {
    if (pivotDot) try { pivotDot.setMap(null); } catch {}
    pivotDot = new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(best.lat, best.lon),
      content:
        '<div style="width:14px;height:14px;border-radius:999px;background:#c4b5fd;border:2px solid #7c3aed;box-shadow:0 2px 10px rgba(0,0,0,.18)"></div>',
      zIndex: 950,
    });
    pivotDot.setMap(map);
    overlayObjs.push(pivotDot);
  }
  redraw();
}

function stationClear() {
  const inp = $("stationInput");
  if (inp instanceof HTMLInputElement) inp.value = "";
  state.pivot = null;
  const hi = $("stationHint");
  if (hi) hi.textContent = "";
  if (pivotDot) try { pivotDot.setMap(null); } catch {}
  pivotDot = null;
  redraw();
}

function openNav(lot) {
  if (lot.lat == null || lot.lon == null) return toast("좌표 없음");

  const name = encodeURIComponent(lot.name);
  const lat  = lot.lat;
  const lon  = lot.lon;

  // 앱 선택 팝업
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:99999;
    display:flex;align-items:flex-end;justify-content:center;padding-bottom:32px;
  `;
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px 20px 16px 16px;padding:20px 16px 12px;width:320px;max-width:95vw;box-shadow:0 -4px 30px rgba(0,0,0,.18)">
      <div style="font:800 15px/1 SUIT,system-ui;color:#1e293b;margin-bottom:16px;text-align:center">길안내 앱 선택</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <a href="kakaomap://route?ep=${lat},${lon}&by=CAR"
           onclick="setTimeout(()=>document.body.removeChild(this.closest('[data-nav-overlay]')),300)"
           style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;background:#FEE500;color:#3C1E1E;font:700 14px SUIT,system-ui;text-decoration:none">
          <span style="font-size:20px">🗺️</span> 카카오내비 앱으로 열기
        </a>
        <a href="tmap://route?goalname=${name}&goaly=${lat}&goalx=${lon}"
           onclick="setTimeout(()=>document.body.removeChild(this.closest('[data-nav-overlay]')),300)"
           style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;background:#1a61ff;color:#fff;font:700 14px SUIT,system-ui;text-decoration:none">
          <span style="font-size:20px">🧭</span> 티맵 앱으로 열기
        </a>
        <a href="https://map.kakao.com/link/to/${name},${lat},${lon}" target="_blank" rel="noopener"
           style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;background:#f1f5f9;color:#1e293b;font:700 14px SUIT,system-ui;text-decoration:none">
          <span style="font-size:20px">🌐</span> 카카오맵 웹으로 열기
        </a>
        <button style="margin-top:4px;padding:10px;border:none;background:none;color:#94a3b8;font:600 13px SUIT,system-ui;cursor:pointer;width:100%" id="navCancelBtn">취소</button>
      </div>
    </div>`;
  overlay.dataset.navOverlay = "1";
  overlay.querySelector("#navCancelBtn")?.addEventListener("click", () => document.body.removeChild(overlay));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
  // fix onclick selector
  overlay.querySelectorAll("a").forEach(a => a.addEventListener("click", () => setTimeout(() => { if (document.body.contains(overlay)) document.body.removeChild(overlay); }, 300)));
  document.body.appendChild(overlay);
}

function openRv(lot) {
  if (lot.lat == null || lot.lon == null) return toast("좌표 없음");
  window.open(`https://map.kakao.com/link/roadview/${lot.lat},${lot.lon}`, "_blank", "noopener,noreferrer");
}

function shareIt(lot) {
  if (lot.lat == null || lot.lon == null) return toast("좌표 없음");
  const mapUrl = `https://map.kakao.com/link/map/${encodeURIComponent(lot.name)},${lot.lat},${lot.lon}`;
  const text   = `📍 ${lot.name}\n잔여 ${lot.remaining}/${lot.total}석\n${mapUrl}`;

  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:99999;
    display:flex;align-items:flex-end;justify-content:center;padding-bottom:32px;
  `;
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px 20px 16px 16px;padding:20px 16px 12px;width:320px;max-width:95vw;box-shadow:0 -4px 30px rgba(0,0,0,.18)">
      <div style="font:800 15px/1 SUIT,system-ui;color:#1e293b;margin-bottom:16px;text-align:center">공유하기</div>
      <div style="display:flex;flex-direction:column;gap:10px">

        <a href="kakaotalk://send?text=${encodeURIComponent(text)}"
           style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;background:#FEE500;color:#3C1E1E;font:700 14px SUIT,system-ui;text-decoration:none">
          <span style="font-size:20px">💬</span> 카카오톡으로 공유
        </a>

        <a href="sms:?body=${encodeURIComponent(text)}"
           style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;background:#34c759;color:#fff;font:700 14px SUIT,system-ui;text-decoration:none">
          <span style="font-size:20px">💌</span> 문자(SMS)로 보내기
        </a>

        <button id="shareCopyBtn"
           style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;background:#f1f5f9;color:#1e293b;font:700 14px SUIT,system-ui;border:none;cursor:pointer;width:100%">
          <span style="font-size:20px">📋</span> 링크 복사
        </button>

        <button style="margin-top:4px;padding:10px;border:none;background:none;color:#94a3b8;font:600 13px SUIT,system-ui;cursor:pointer;width:100%" id="shareCancelBtn">취소</button>
      </div>
    </div>`;

  overlay.querySelector("#shareCopyBtn")?.addEventListener("click", async () => {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(mapUrl);
      else if (navigator.share) await navigator.share({ title: lot.name, url: mapUrl });
    } catch { /* ignore */ }
    toast("링크가 클립보드에 복사됐습니다");
    document.body.removeChild(overlay);
  });
  overlay.querySelector("#shareCancelBtn")?.addEventListener("click", () => document.body.removeChild(overlay));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
  overlay.querySelectorAll("a").forEach(a => a.addEventListener("click", () => setTimeout(() => { if (document.body.contains(overlay)) document.body.removeChild(overlay); }, 300)));
  document.body.appendChild(overlay);
}

function wire() {
  $("btnRefresh")?.addEventListener("click", () => void loadParking(true));

  // 경차 / 전기차 필터 버튼
  function toggleFilter(key, btnId, label) {
    state[key] = !state[key];
    const btn = $(btnId);
    if (btn) btn.classList.toggle("is-active", state[key]);
    redraw();
    if (state[key]) {
      if (state.filt.length === 0) {
        toast(`${label} 충전/주차 데이터가 있는 주차장이 없습니다 (API 미제공 지역)`);
      } else {
        toast(`${label} 필터 ON · ${state.filt.length}개 주차장`);
      }
    } else {
      toast(`${label} 필터 OFF`);
    }
  }
  $("btnFilterEv")?.addEventListener("click", () => toggleFilter("filterEv", "btnFilterEv", "⚡ 전기차"));

  // 설정 모달 열기/닫기
  function openSettingsModal() {
    const modal = $("settingsModal");
    if (!modal) return;
    modal.hidden = false;
    // 저장된 값 채우기
    const jsInp = $("kakaoJsKeyInput");
    if (jsInp instanceof HTMLInputElement) jsInp.value = getKakaoJsKey();
    const restInp = $("kakaoRestKeyInput");
    if (restInp instanceof HTMLInputElement) restInp.value = getKakaoRestKey();
    const ggInp = $("ggKeyInputModal");
    if (ggInp instanceof HTMLInputElement) ggInp.value = getLsKey("GG_PARKING_KEY", "ggKey");
    const icInp = $("icKeyInputModal");
    if (icInp instanceof HTMLInputElement) icInp.value = getLsKey("IC_PARKING_KEY", "icKey");
  }
  function closeSettingsModal() {
    const modal = $("settingsModal");
    if (modal) modal.hidden = true;
  }

  $("btnOpenSettings")?.addEventListener("click", openSettingsModal);
  $("btnCloseSettings")?.addEventListener("click", closeSettingsModal);
  $("settingsModal")?.addEventListener("click", (e) => {
    if (e.target === $("settingsModal")) closeSettingsModal();
  });

  $("btnSaveKakaoJsKey")?.addEventListener("click", () => {
    const inp = $("kakaoJsKeyInput");
    const v = inp instanceof HTMLInputElement ? inp.value.trim() : "";
    if (!v) {
      const hint = $("kakaoSetupHint");
      if (hint) hint.textContent = "JavaScript 키를 입력해 주세요.";
      return;
    }
    try { localStorage.setItem("KAKAO_MAPS_JS_KEY", v); } catch { /* ignore */ }
    const rInp = $("kakaoRestKeyInput");
    const rv = rInp instanceof HTMLInputElement ? rInp.value.trim() : "";
    if (rv) { try { localStorage.setItem("KAKAO_REST_KEY", rv); } catch {} }
    const ggInp = $("ggKeyInputModal");
    const ggv = ggInp instanceof HTMLInputElement ? ggInp.value.trim() : "";
    if (ggv) { try { setLsKey("GG_PARKING_KEY", ggv); } catch {} }
    const icInp = $("icKeyInputModal");
    const icv = icInp instanceof HTMLInputElement ? icInp.value.trim() : "";
    if (icv) { try { setLsKey("IC_PARKING_KEY", icv); } catch {} }
    paintMapProviderPill();
    const hint = $("kakaoSetupHint");
    if (hint) hint.textContent = "저장 완료! 새로고침합니다…";
    setTimeout(() => location.reload(), 400);
  });

  // 기존 키 상태 힌트
  const ggKey = getLsKey("GG_PARKING_KEY", "ggKey");
  const icKey = getLsKey("IC_PARKING_KEY", "icKey");
  const hint = $("regionSetupHint");
  if (hint && (ggKey || icKey)) {
    hint.textContent = `저장된 키: ${ggKey ? "경기도 ✓" : "경기도 ✗"}  ${icKey ? "인천 ✓" : "인천 ✗"}`;
  }

  $("btnClearStation")?.addEventListener("click", () => {
    stationClear();
    toast("역 필터 초기화");
  });
  $("btnResetAll")?.addEventListener("click", () => {
    const li = $("lotSearchInput");
    if (li instanceof HTMLInputElement) li.value = "";
    state.nmSlug = "";
    stationClear();
    toast("모두 초기화");
  });
  $("lotSearchInput")?.addEventListener("input", () => {
    const li = $("lotSearchInput");
    state.nmSlug = slugify(li instanceof HTMLInputElement ? li.value : "");
    redraw();
  });
  $("stationInput")?.addEventListener("input", () => stationTyping());

  document.querySelectorAll("[data-explore-tab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-explore-tab]").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
        if (b instanceof HTMLElement) b.setAttribute("aria-selected", String(b === btn));
      });
      state.tab = /** @type {"food"|"fuel"|"sight"} */ (btn.getAttribute("data-explore-tab") || "food");
      void exploreRun();
    })
  );

  $("nearestTop3")?.addEventListener("click", (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target).closest("[data-nearest-code]");
    const code = t instanceof HTMLElement ? t.dataset.nearestCode : "";
    if (code) selectLot(code);
  });
  $("lotListGrid")?.addEventListener("click", (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target).closest("[data-code]");
    const code = t instanceof HTMLElement ? t.dataset.code : "";
    if (code) selectLot(code);
  });
  $("detailPanel")?.addEventListener("click", (ev) => {
    const b = /** @type {HTMLElement} */ (ev.target).closest("[data-action]");
    if (!(b instanceof HTMLElement)) return;
    const code = b.dataset.code;
    const act = b.dataset.action;
    if (!code || !act) return;
    const lot = findLot(code);
    if (!lot) return;
    if (act === "nav") openNav(lot);
    else if (act === "rv") openRv(lot);
    else if (act === "share") void shareIt(lot);
    else if (act === "star") {
      favToggle(code);
      renderDetail();
      renderList();
      toast(state.fav.has(code) ? "즐겨찾기 저장" : "즐겨찾기 해제");
    }
  });
}
