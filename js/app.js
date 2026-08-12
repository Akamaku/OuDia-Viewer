/**
 * app.js
 * ------------------------------------------------------------
 * oud/manifest.json に列挙された .oud ファイルを読み込み、
 * 発車案内表示機(リアルタイム / 時刻表ブラウザ)として表示する。
 * ------------------------------------------------------------
 */

const state = {
  manifest: [],
  currentFile: null,
  timetable: null, // parseOuDiaによる結果
  diaIndex: 0,
  stationIndex: 0,
  directionFilter: 'all', // 'all' | 'Kudari' | 'Nobori'
  viewMode: 'realtime', // 'realtime' | 'browser'
  useNow: true,
  manualClock: null, // {hour, minute}
  typeFilter: '', // 時刻表ブラウザ用の種別絞り込み
  destFilter: '', // 時刻表ブラウザ用の行先絞り込み
};

const FLAP_ROW_COUNT = 3; // 発車案内の表示段数

/**
 * パタパタ(反転フラップ)式表示機は、実機同様1コマ=1文字のリールを模している。
 * 「時」「分」は0〜9+空欄の11コマ、「種別」「行先」は文字位置ごとに実際に登場する文字だけを積む。
 * リールは一方向にしか回らないため、値が変わるときは目的のコマまで1つずつ順番にめくれる。
 * 実際の車両・路線に合わせて自由に編集してください。
 */
const FLAP_TYPES = [
  '普通', '急行', '特急', '通勤急行', 'ライナー', '回送',
  '通過', '臨時', '団体', '試運転', '区間急行', '船渡川から普通 特急',
];
const FLAP_DESTINATIONS = [
  '青波中央', '茶志内', '船渡川', '高輪平', '朝日ヶ丘', '港が丘', '新森町', '花咲野',
];
const FLAP_MAX_HOUR = 28; // 時のコマは00〜28まで(深夜帯対応)。それ以外は無表示

/** 時刻の1桁ぶんのリール(実機同様、コマは1つにつき1文字)。0〜9の10コマ+空欄1コマの11コマ構成。 */
const DIGIT_SLOTS = 11;
function buildDigitReel() {
  return Array.from({ length: DIGIT_SLOTS }, (_, i) => (i < 10 ? String(i) : ''));
}

/** 種別・行先は単語ごと1枚のコマとして扱う(あらかじめ用意した単語一覧+空欄1コマ) */
function buildWordReel(words) {
  return [...words, ''];
}

const FLAP_REEL = {
  hourTens: buildDigitReel(),
  hourOnes: buildDigitReel(),
  minuteTens: buildDigitReel(),
  minuteOnes: buildDigitReel(),
  type: buildWordReel(FLAP_TYPES),
  dest: buildWordReel(FLAP_DESTINATIONS),
};

/** リール上でその値が最初に現れるコマ番号。無ければ最初の空欄コマへ。 */
function flapReelIndexFor(reel, value) {
  const idx = reel.indexOf(value);
  if (idx >= 0) return idx;
  const blankIdx = reel.indexOf('');
  return blankIdx >= 0 ? blankIdx : 0;
}

/**
 * 運休(unkyu)など、そもそも運行されない/旅客案内として意味を持たない種別のみ非表示にする。
 * 回送・通過・臨時・団体・試運転は実際の板でも表示されることがあるため、パタパタでは表示対象に含める。
 */
const HIDDEN_TYPES = ['unkyu', '運休'];

/** 表記ゆれの統合。「通急」は「通勤急行」と同じものとして色・コマ・表示名を揃える。 */
const TYPE_ALIASES = { '通急': '通勤急行' };
function typeKey(train) {
  return TYPE_ALIASES[train.typeName] || train.typeName;
}

// 指定した種別名は色を固定。それ以外はファイルの色設定(無ければデフォルト)を使う。
// パタパタの種別コマの色にも同じ配色を使う(実物の種別板が色分けされているのを再現)。
const TYPE_COLOR_OVERRIDES = {
  '普通': '#1c6fe0', // 青
  '急行': '#f97316', // オレンジ
  '通勤急行': '#f97316', // オレンジ
  '区間急行': '#16a34a', // 緑
  '特急': '#dc2626', // 赤
  '船渡川から普通 特急': '#dc2626', // 赤(特急と同じ色)
  'ライナー': '#92400e', // 茶
};
const DEFAULT_TYPE_COLOR = '#0891b2';

function getTypeColor(train) {
  return TYPE_COLOR_OVERRIDES[typeKey(train)] || train.typeColor || DEFAULT_TYPE_COLOR;
}

/** パタパタの種別コマは全種別とも白字・黒背景で統一する(色分けはしない) */
function getFlapTypeStyle() {
  return '';
}

/**
 * 「船渡川から普通特急」のような "〜からXY" 形式の種別は、
 * 「〜から」「X」を左に小さく2段、"Y"(既知の種別名に一致する末尾)を右に大きく表示する。
 * 一致しない場合は普通にそのまま表示する。
 */
const KNOWN_TYPE_SUFFIXES = ['区間急行', '通勤急行', '通勤快速', '特急', '急行', '快速', 'ライナー', '準急', '普通'];

function isCompoundType(value) {
  return typeof value === 'string' && value.includes('から');
}

function renderTypeFace(value) {
  if (!isCompoundType(value)) return escapeHtml(value || '');
  const cutIdx = value.indexOf('から') + 2;
  const prefix = value.slice(0, cutIdx); // 例: "船渡川から"
  const rest = value.slice(cutIdx).trim(); // 例: "普通 特急" -> 前後の空白は除く
  let large = rest;
  let smallSecond = '';
  for (const cand of KNOWN_TYPE_SUFFIXES) {
    if (rest.endsWith(cand) && rest.length > cand.length) {
      smallSecond = rest.slice(0, rest.length - cand.length).trim();
      large = cand;
      break;
    }
  }
  return `<span class="type-compound"><span class="type-compound-small"><span>${escapeHtml(prefix)}</span>${smallSecond ? `<span>${escapeHtml(smallSecond)}</span>` : ''}</span><span class="type-compound-large">${escapeHtml(large)}</span></span>`;
}

const els = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheElements();
  bindEvents();
  tickClock();
  setInterval(tickClock, 1000);

  try {
    const manifest = await loadManifest();
    state.manifest = manifest;
    populateFileSelect(manifest);
    if (manifest.length > 0) {
      await loadOudFile(manifest[0].file);
    } else {
      showStatus('oud/manifest.json にファイルが登録されていません。', 'warn');
    }
  } catch (err) {
    console.error(err);
    showStatus(friendlyFetchError(err), 'error');
  }
}

/**
 * fetch失敗時の原因を分かりやすく案内する。
 * 最も多い原因は index.html を file:// で直接開いていること
 * (ブラウザがローカルファイルへの fetch をブロックするため)。
 */
function friendlyFetchError(err) {
  if (location.protocol === 'file:') {
    return 'このページを file:// で直接開いているため読み込めません。'
      + ' 簡易サーバー(例: ターミナルでこのフォルダに移動して `python3 -m http.server` を実行し、'
      + ' http://localhost:8000 を開く / VSCodeの「Live Server」拡張 等)を使って開いてください。';
  }
  if (err && err.httpStatus === 404) {
    return `${err.path} が404で見つかりません。manifest.jsonのファイル名と実ファイル名が一致しているか、`
      + '特に日本語ファイル名の場合はGit/OS間での文字コード正規化(NFC/NFD)ずれで一致しないことがあるため、'
      + 'ファイル名を半角英数字にリネームするのを推奨します(表示名はmanifest.jsonのlabelで日本語にできます)。';
  }
  return `読み込みエラー: ${err.message}`;
}

function cacheElements() {
  els.clock = document.getElementById('header-clock');
  els.fileSelect = document.getElementById('file-select');
  els.diaSelect = document.getElementById('dia-select');
  els.stationSelect = document.getElementById('station-select');
  els.directionButtons = document.querySelectorAll('[data-direction]');
  els.viewButtons = document.querySelectorAll('[data-view]');
  els.board = document.getElementById('board');
  els.status = document.getElementById('status-line');
  els.statusBar = document.getElementById('status-bar');
  els.useNowToggle = document.getElementById('use-now-toggle');
  els.manualClockInput = document.getElementById('manual-clock');
  els.manualClockWrap = document.getElementById('manual-clock-wrap');
  els.emptyState = document.getElementById('empty-state');
  els.modalOverlay = document.getElementById('train-modal-overlay');
  els.modalPanel = document.getElementById('train-modal-panel');
  els.filterControls = document.getElementById('filter-controls');
  els.typeFilter = document.getElementById('type-filter');
  els.destFilter = document.getElementById('dest-filter');
}

function bindEvents() {
  els.fileSelect.addEventListener('change', (e) => loadOudFile(e.target.value));
  els.diaSelect.addEventListener('change', (e) => {
    state.diaIndex = parseInt(e.target.value, 10);
    state.typeFilter = '';
    state.destFilter = '';
    renderBoard();
  });
  els.stationSelect.addEventListener('change', (e) => {
    state.stationIndex = parseInt(e.target.value, 10);
    state.typeFilter = '';
    state.destFilter = '';
    renderBoard();
  });
  els.directionButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.directionFilter = btn.dataset.direction;
      els.directionButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      renderBoard();
    });
  });
  els.viewButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.view;
      els.viewButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      document.body.classList.toggle('mode-browser', state.viewMode === 'browser');
      els.filterControls.classList.toggle('is-hidden', state.viewMode !== 'browser');
      renderBoard();
    });
  });
  els.useNowToggle.addEventListener('change', (e) => {
    state.useNow = e.target.checked;
    els.manualClockWrap.classList.toggle('is-hidden', state.useNow);
    if (!state.useNow && !state.manualClock) {
      const [h, m] = els.manualClockInput.value.split(':').map((v) => parseInt(v, 10));
      const SERVICE_DAY_START = 4;
      const adjHour = (!Number.isNaN(h) ? h : 8) < SERVICE_DAY_START ? (h || 0) + 24 : (h || 8);
      state.manualClock = { baseMinutes: adjHour * 60 + (Number.isNaN(m) ? 0 : m), setAtMs: Date.now() };
    }
    renderBoard();
  });
  els.manualClockInput.addEventListener('input', (e) => {
    const [h, m] = e.target.value.split(':').map((v) => parseInt(v, 10));
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      const SERVICE_DAY_START = 4;
      const adjHour = h < SERVICE_DAY_START ? h + 24 : h;
      state.manualClock = { baseMinutes: adjHour * 60 + m, setAtMs: Date.now() };
      renderBoard();
    }
  });
  els.typeFilter.addEventListener('change', (e) => {
    state.typeFilter = e.target.value;
    renderBoard();
  });
  els.destFilter.addEventListener('change', (e) => {
    state.destFilter = e.target.value;
    renderBoard();
  });

  // 発車案内の行クリックで、その列車単体の時刻表を開く
  els.board.addEventListener('click', (e) => {
    const row = e.target.closest('[data-train-key]');
    if (!row) return;
    const train = findTrainByKey(row.dataset.trainKey);
    if (train) openTrainModal(train);
  });
  els.modalOverlay.addEventListener('click', (e) => {
    if (e.target === els.modalOverlay || e.target.closest('.modal-close')) closeTrainModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTrainModal();
  });
}

function findTrainByKey(key) {
  const dia = state.timetable && state.timetable.dias[state.diaIndex];
  if (!dia) return null;
  return dia.kudari.find((t) => t.key === key) || dia.nobori.find((t) => t.key === key) || null;
}

function openTrainModal(train) {
  const stations = state.timetable.stations;
  const dirLabel = train.direction === 'Kudari' ? '下り' : '上り';
  const typeColor = getTypeColor(train);

  // この列車が実際に走行している駅の範囲(最初〜最後に停車/通過情報がある駅)
  let firstIdx = null;
  let lastIdx = null;
  train.stops.forEach((s, i) => {
    if (s) {
      if (firstIdx === null) firstIdx = i;
      lastIdx = i;
    }
  });

  const rows = stations.map((st, i) => {
    if (firstIdx === null || i < firstIdx || i > lastIdx) {
      return `<tr class="row-outside"><td class="col-eki">${escapeHtml(st.name)}</td><td class="col-dash">−</td></tr>`;
    }
    const stop = train.stops[i];
    if (!stop || stop.flag === '2') {
      return `<tr><td class="col-eki">${escapeHtml(st.name)}</td><td class="col-pass">レ(通過)</td></tr>`;
    }
    // 到着・発車の両方がある場合は発車時刻のみ表示する(終着駅など発車が無い場合は到着時刻を表示)
    const timeText = stop.dep ? stop.dep.label : (stop.arr ? stop.arr.label : '');
    return `
      <tr class="${i === firstIdx || i === lastIdx ? 'row-terminal' : ''}">
        <td class="col-eki">${escapeHtml(st.name)}</td>
        <td class="col-time mono">${timeText}</td>
      </tr>
    `;
  }).join('');

  els.modalPanel.innerHTML = `
    <div class="modal-head">
      <span class="dep-badge dep-badge-inline" style="--chip-color:${typeColor}">${escapeHtml(typeKey(train) || '普通')}</span>
      <h2 class="modal-title">${escapeHtml(train.destinationName || '-')}<span class="train-number">${train.number ? ' ' + escapeHtml(train.number) : ''}</span></h2>
      <span class="dir-badge dir-${train.direction}">${dirLabel}</span>
      <button type="button" class="modal-close" aria-label="閉じる">×</button>
    </div>
    <table class="modal-table">
      <thead><tr><th class="col-eki">駅</th><th class="col-time">発車</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  els.modalOverlay.classList.remove('is-hidden');
}

function closeTrainModal() {
  els.modalOverlay.classList.add('is-hidden');
}

function tickClock() {
  const t = getSimulatedNow();
  const hh = String(t.hour).padStart(2, '0');
  const mm = String(t.minute).padStart(2, '0');
  const ss = String(t.second).padStart(2, '0');
  els.clock.textContent = `${hh}:${mm}:${ss}`;
  if (state.viewMode === 'realtime' && state.timetable) {
    renderBoard();
  }
}

/** 現在時刻(useNow)または手動設定時刻(経過時間ぶん進み続ける)を { hour, minute, second } で返す(0-23に正規化した表示用) */
function getSimulatedNow() {
  if (state.useNow || !state.manualClock) {
    const now = new Date();
    return { hour: now.getHours(), minute: now.getMinutes(), second: now.getSeconds() };
  }
  const elapsedSec = Math.floor((Date.now() - state.manualClock.setAtMs) / 1000);
  const totalSec = state.manualClock.baseMinutes * 60 + elapsedSec;
  const wrapped = ((totalSec % 86400) + 86400) % 86400;
  return {
    hour: Math.floor(wrapped / 3600),
    minute: Math.floor((wrapped % 3600) / 60),
    second: wrapped % 60,
  };
}

async function loadManifest() {
  const res = await fetch('oud/manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('oud/manifest.json を取得できませんでした');
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('manifest.json の形式が不正です(配列である必要があります)');
  return json;
}

function populateFileSelect(manifest) {
  els.fileSelect.innerHTML = '';
  for (const entry of manifest) {
    const opt = document.createElement('option');
    opt.value = entry.file;
    opt.textContent = entry.label || entry.file;
    els.fileSelect.appendChild(opt);
  }
}

/** .oudファイルをバイト列で取得し、文字コードを判定してデコードする */
async function fetchOudText(path) {
  const res = await fetch(encodeURI(path), { cache: 'no-store' });
  if (!res.ok) {
    const err = new Error(`${path} を取得できませんでした (HTTP ${res.status})`);
    err.httpStatus = res.status;
    err.path = path;
    throw err;
  }
  const buf = await res.arrayBuffer();

  // OuDia純正アプリの出力はShift_JISが多い。まずShift_JISを試し、
  // 文字化け(置換文字)が多ければUTF-8として読み直す。
  const sjisText = safeDecode(buf, 'shift_jis');
  const utf8Text = safeDecode(buf, 'utf-8');

  const sjisBad = countReplacementChars(sjisText);
  const utf8Bad = countReplacementChars(utf8Text);

  return utf8Bad <= sjisBad ? utf8Text : sjisText;
}

function safeDecode(buf, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buf);
  } catch (e) {
    return '';
  }
}

function countReplacementChars(text) {
  let count = 0;
  for (const ch of text) if (ch === '\uFFFD') count++;
  return count;
}

async function loadOudFile(path) {
  showStatus('読み込み中…', 'info');
  els.fileSelect.value = path;
  try {
    const text = await fetchOudText(path);
    const timetable = window.OuDiaParser.parseOuDia(text);
    state.currentFile = path;
    state.timetable = timetable;
    state.diaIndex = 0;
    state.stationIndex = 0;

    populateDiaSelect(timetable.dias);
    populateStationSelect(timetable.stations);

    renderBoard();
  } catch (err) {
    console.error(err);
    state.timetable = null;
    showStatus(friendlyFetchError(err), 'error');
    els.board.innerHTML = '';
    els.emptyState.classList.remove('is-hidden');
  }
}

function populateDiaSelect(dias) {
  els.diaSelect.innerHTML = '';
  dias.forEach((dia, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = dia.name;
    els.diaSelect.appendChild(opt);
  });
}

function populateStationSelect(stations) {
  els.stationSelect.innerHTML = '';
  stations.forEach((st) => {
    const opt = document.createElement('option');
    opt.value = st.index;
    opt.textContent = st.name;
    els.stationSelect.appendChild(opt);
  });
}

function showStatus(msg, level) {
  els.status.textContent = msg;
  els.status.dataset.level = level || 'info';
  const visible = level === 'warn' || level === 'error';
  els.statusBar.classList.toggle('is-hidden', !visible);
}

/** 現在の基準時刻を「サービス日 0:00起点の分数」で返す(4時始発想定・深夜帯対応)。手動時刻は経過分ぶん進み続ける */
function getNowServiceMinutes() {
  const SERVICE_DAY_START = 4; // 4:00未満はサービス日的には「前日深夜」として扱う
  if (state.useNow || !state.manualClock) {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const adjHour = hour < SERVICE_DAY_START ? hour + 24 : hour;
    return adjHour * 60 + minute;
  }
  const elapsedMin = (Date.now() - state.manualClock.setAtMs) / 60000;
  return state.manualClock.baseMinutes + elapsedMin;
}

function renderBoard() {
  if (!state.timetable) return;
  els.emptyState.classList.add('is-hidden');

  if (state.viewMode === 'realtime') {
    renderRealtimeBoard();
  } else {
    renderTimetableBrowser();
  }
}

function collectStationDepartures() {
  const dia = state.timetable.dias[state.diaIndex];
  if (!dia) return [];
  const stIndex = state.stationIndex;
  const trains = [];

  const pools = [];
  if (state.directionFilter === 'all' || state.directionFilter === 'Kudari') pools.push(...dia.kudari);
  if (state.directionFilter === 'all' || state.directionFilter === 'Nobori') pools.push(...dia.nobori);

  for (const train of pools) {
    if (HIDDEN_TYPES.includes(train.typeName)) continue;
    const stop = train.stops[stIndex];
    if (!stop) continue;
    if (stop.flag === '2') continue; // 通過(停車しない)駅では乗車できないため案内しない
    if (!stop.dep) continue; // 発車が無い(到着のみ = 終着・降車専用)駅はここでは案内しない
    const dep = stop.dep;
    if (state.typeFilter && typeKey(train) !== state.typeFilter) continue;
    if (state.destFilter && train.destinationName !== state.destFilter) continue;
    trains.push({
      train,
      stop,
      departMinutes: dep.totalMinutes,
      departLabel: dep.label,
    });
  }

  trains.sort((a, b) => a.departMinutes - b.departMinutes);
  return trains;
}

/** 種別・行先フィルターのプルダウンを、現在の駅・ダイヤ・方向における実際の値で埋める */
function populateFilterOptions() {
  const savedType = state.typeFilter;
  const savedDest = state.destFilter;
  const prevTypeFilter = state.typeFilter;
  const prevDestFilter = state.destFilter;
  state.typeFilter = '';
  state.destFilter = '';
  const base = collectStationDepartures();
  state.typeFilter = prevTypeFilter;
  state.destFilter = prevDestFilter;

  const types = [...new Set(base.map((d) => typeKey(d.train)).filter(Boolean))].sort();
  const dests = [...new Set(base.map((d) => d.train.destinationName).filter(Boolean))].sort();

  els.typeFilter.innerHTML = '<option value="">すべての種別</option>'
    + types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  els.destFilter.innerHTML = '<option value="">すべての行先</option>'
    + dests.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');

  els.typeFilter.value = types.includes(savedType) ? savedType : '';
  els.destFilter.value = dests.includes(savedDest) ? savedDest : '';
  state.typeFilter = els.typeFilter.value;
  state.destFilter = els.destFilter.value;
}

function renderRealtimeBoard() {
  const stationName = state.timetable.stations[state.stationIndex]?.name || '';
  const nowMin = getNowServiceMinutes();
  const all = collectStationDepartures();

  if (all.length === 0) {
    els.board.innerHTML = '';
    els.emptyState.classList.remove('is-hidden');
    els.emptyState.textContent = `${stationName} — 時刻データがありません`;
    return;
  }

  // 直近3本のみを表示する(発車時刻に基づく本当の並びのみで、無関係なローテーションはしない)
  const upcoming = all
    .map((d) => ({ ...d, diff: d.departMinutes - nowMin }))
    .filter((d) => d.diff >= -1)
    .sort((a, b) => a.diff - b.diff)
    .slice(0, FLAP_ROW_COUNT);

  // 3枠は常に確保し、以降の列車が無い枠は空欄コマとして表示する
  const slots = [0, 1, 2].map((i) => upcoming[i] || null);

  updateFlapSign(slots);
}

/** パタパタ(反転フラップ)式サイン: 列車接近の案内はせず、既定コマの範囲のみ表示する */
function flapSignHtml(slots) {
  return `
    <div class="flap-sign">
      <div class="flap-sign-header">
        <span class="flap-h">時刻</span><span class="flap-h">種別</span><span class="flap-h">行先</span>
      </div>
      <div class="flap-sign-body">
        ${slots.map((d) => flapRowHtml(d)).join('')}
      </div>
    </div>
  `;
}

/** この行が目指すべき、各リールの目標コマ番号。dが無い(空枠)場合は全て空欄コマを目指す。 */
function flapTargetIndices(d) {
  if (!d) {
    return {
      hourTens: flapReelIndexFor(FLAP_REEL.hourTens, ''),
      hourOnes: flapReelIndexFor(FLAP_REEL.hourOnes, ''),
      minuteTens: flapReelIndexFor(FLAP_REEL.minuteTens, ''),
      minuteOnes: flapReelIndexFor(FLAP_REEL.minuteOnes, ''),
      type: flapReelIndexFor(FLAP_REEL.type, ''),
      dest: flapReelIndexFor(FLAP_REEL.dest, ''),
    };
  }
  const { train, stop } = d;
  const dep = stop.dep; // 発車時刻のみを使う(到着時刻は表示しない)
  const hourStr = dep && dep.hour <= FLAP_MAX_HOUR ? String(dep.hour).padStart(2, '0') : '';
  const minStr = dep ? String(dep.minute).padStart(2, '0') : '';
  return {
    hourTens: flapReelIndexFor(FLAP_REEL.hourTens, hourStr ? hourStr[0] : ''),
    hourOnes: flapReelIndexFor(FLAP_REEL.hourOnes, hourStr ? hourStr[1] : ''),
    minuteTens: flapReelIndexFor(FLAP_REEL.minuteTens, minStr ? minStr[0] : ''),
    minuteOnes: flapReelIndexFor(FLAP_REEL.minuteOnes, minStr ? minStr[1] : ''),
    type: flapReelIndexFor(FLAP_REEL.type, typeKey(train)),
    dest: flapReelIndexFor(FLAP_REEL.dest, train.destinationName),
  };
}

/** 初期表示用の静的コマ(アニメーションなし、目標コマの文字をそのまま印字) */
function flapTile(className, reelKey, idx, styleOverride) {
  const value = FLAP_REEL[reelKey][idx] || '';
  const style = styleOverride || '';
  return `<span class="flap-tile ${className}" data-reel="${reelKey}" data-idx="${idx}"${style ? ` style="${style}"` : ''}>${tileContentHtml(value)}</span>`;
}

/** コマの中身のHTML。複合種別だけは上下分割せず、ひとつのまとまりとして表示する。 */
function tileContentHtml(value) {
  if (isCompoundType(value)) {
    return `<span class="flap-compound-face">${renderTypeFace(value)}</span>`;
  }
  return halvesHtml(value);
}

/** 上下2分割の静的な面(実機のコマそのもの)のHTML断片を作る */
function halvesHtml(value) {
  const escaped = escapeHtml(value);
  return `<span class="flap-static flap-static-top"><span class="flap-static-inner">${escaped}</span></span>`
    + `<span class="flap-static flap-static-bottom"><span class="flap-static-inner">${escaped}</span></span>`;
}

function flapRowHtml(d) {
  const t = flapTargetIndices(d);
  const isEmpty = !d;
  const typeColorStyle = d ? getFlapTypeStyle(typeKey(d.train)) : '';
  return `
    <div class="flap-row ${isEmpty ? 'is-empty' : ''}" data-train-key="${d ? d.train.key : ''}" tabindex="0">
      <div class="flap-time">
        <div class="flap-hour-box">${flapTile('flap-digit flap-h-tens', 'hourTens', t.hourTens)}${flapTile('flap-digit flap-h-ones', 'hourOnes', t.hourOnes)}</div>
        <span class="flap-colon">:</span>
        <div class="flap-minute-box">${flapTile('flap-digit flap-m-tens', 'minuteTens', t.minuteTens)}${flapTile('flap-digit flap-m-ones', 'minuteOnes', t.minuteOnes)}</div>
      </div>
      ${flapTile('flap-type', 'type', t.type, typeColorStyle)}
      ${flapTile('flap-dest', 'dest', t.dest)}
    </div>
  `;
}

/** パタパタサインを差分更新し、コマがズレているリールだけ目標コマまで1つずつめくる */
function updateFlapSign(slots) {
  if (!els.board.querySelector('.flap-sign')) {
    els.board.innerHTML = flapSignHtml(slots);
    return;
  }
  const rows = els.board.querySelectorAll('.flap-row');
  slots.forEach((d, i) => {
    const rowEl = rows[i];
    if (!rowEl) return;
    rowEl.classList.toggle('is-empty', !d);
    rowEl.dataset.trainKey = d ? d.train.key : '';
    const t = flapTargetIndices(d);
    flipReelTo(rowEl.querySelector('.flap-h-tens'), t.hourTens);
    flipReelTo(rowEl.querySelector('.flap-h-ones'), t.hourOnes);
    flipReelTo(rowEl.querySelector('.flap-m-tens'), t.minuteTens);
    flipReelTo(rowEl.querySelector('.flap-m-ones'), t.minuteOnes);

    const typeTile = rowEl.querySelector('.flap-type');
    if (typeTile) typeTile.style.cssText = d ? getFlapTypeStyle(typeKey(d.train)) : '';
    flipReelTo(typeTile, t.type);
    flipReelTo(rowEl.querySelector('.flap-dest'), t.dest);
  });
}

const FLAP_STEP_MS = 150; // 1コマあたりのめくり間隔
const FLAP_LEAF_ANIM_MS = 130; // 葉が中央の水平線を軸に倒れ込むアニメーションの長さ

/**
 * 指定コマまで、リールの並び順(0→1→2→…→59→0)通りに1コマずつめくっていく。
 * 実機同様、コマは上下2分割になっていて、めくる瞬間は「上半分」の板が中央の水平線を軸に
 * 手前に倒れ込む(0°→-180°)。倒れ込んだ板の表には古い値の上半分、裏には次の値の下半分が
 * 印字されており、倒れ切ると裏面(次の値の下半分)が下側にぴったり重なって見える。
 * 同時に、板が退いた上側には(先に切り替えておいた)次の値の上半分が現れる。
 * これを1コマずつ、目的のコマに着くまで繰り返す。
 */
function flipReelTo(el, targetIdx) {
  if (!el) return;
  const reel = FLAP_REEL[el.dataset.reel];
  const curIdx = parseInt(el.dataset.idx, 10);
  if (curIdx === targetIdx) return; // 既に目的のコマ

  el._flipToken = (el._flipToken || 0) + 1;
  const token = el._flipToken;
  let idx = curIdx;

  const step = () => {
    if (el._flipToken !== token) return; // 途中で別の目標に切り替わった
    const fromVal = reel[idx];
    idx = (idx + 1) % reel.length;
    const toVal = reel[idx];
    const isFinal = idx === targetIdx; // これが目的のコマに着く最後の1枚かどうか

    el.classList.remove('flap-flip');
    void el.offsetWidth; // 衝撃フラッシュ再始動のための強制リフロー
    el.classList.add('flap-flip');

    if (isCompoundType(fromVal) || isCompoundType(toVal)) {
      // 複合種別が絡む場合だけは上下分割せず、まるごと差し替える(レアケースの簡略化)
      el.innerHTML = tileContentHtml(toVal);
      el.dataset.idx = idx;
      if (!isFinal) window.setTimeout(step, FLAP_STEP_MS);
      return;
    }

    // 上半分の板が中央の水平線を軸に手前へ倒れ込む。
    // 板は1枚だけで、真横になった瞬間(中間地点)に中身を「古い値の上半分」→「次の値の下半分」に
    // JS側で差し替える(回転の基準点を1つに統一し、裏返り方の計算をシンプルかつ確実にするため)。
    if (el._activeLeaf) el._activeLeaf.remove(); // 前のコマの葉が残っていれば即座に片付ける
    const leaf = document.createElement('span');
    leaf.className = 'flap-leaf';
    leaf.innerHTML = `<span class="flap-static-inner flap-leaf-inner">${escapeHtml(fromVal)}</span>`;
    el.appendChild(leaf);
    el._activeLeaf = leaf;
    void leaf.offsetWidth; // アニメーション開始のための強制リフロー
    leaf.classList.add('is-flipping');

    const leafInner = leaf.querySelector('.flap-leaf-inner');
    window.setTimeout(() => {
      // 真横になって見えなくなった瞬間: 上半分クリップ→下半分クリップに切り替え、中身も次の値にする
      if (leafInner) {
        leafInner.textContent = toVal;
        leafInner.classList.add('is-bottom-half');
      }
    }, FLAP_LEAF_ANIM_MS / 2);

    window.setTimeout(() => {
      if (el._activeLeaf === leaf) el._activeLeaf = null;
      leaf.remove();
      if (isFinal) {
        // 目的のコマに着地した瞬間だけ、ほんの少し跳ねて静止する
        el.classList.remove('flap-settle');
        void el.offsetWidth;
        el.classList.add('flap-settle');
      }
    }, FLAP_LEAF_ANIM_MS + 30);

    // 葉(板)の下で待っている土台は、先に新しい値へ切り替えておく
    // (上側は板が退いた瞬間に、下側は板の裏面と入れ替わる瞬間に、それぞれ同じ絵になって繋がる)
    const topInner = el.querySelector('.flap-static-top .flap-static-inner');
    const bottomInner = el.querySelector('.flap-static-bottom .flap-static-inner');
    if (topInner) topInner.textContent = toVal;
    if (bottomInner) bottomInner.textContent = toVal;

    el.dataset.idx = idx;

    if (!isFinal) {
      window.setTimeout(step, FLAP_STEP_MS);
    }
  };
  // 複数コマが同時に動き出すとき、完全に同時ではなく少しだけズレて始まるようにする
  window.setTimeout(step, Math.random() * 35);
}

function renderTimetableBrowser() {
  const stationName = state.timetable.stations[state.stationIndex]?.name || '';
  populateFilterOptions();
  const all = collectStationDepartures();

  if (all.length === 0) {
    els.board.innerHTML = '';
    els.emptyState.classList.remove('is-hidden');
    els.emptyState.textContent = `${stationName} — 条件に合う時刻データがありません`;
    return;
  }

  els.board.innerHTML = `
    <div class="browser-card">
      <div class="board-caption">${escapeHtml(stationName)} 時刻表 <span class="board-caption-hint">(行をクリックでその列車の時刻表)</span></div>
      <table class="board-table browser-table">
        <thead>
          <tr>
            <th class="col-type"></th>
            <th class="col-dest">行先</th>
            <th class="col-time">発車</th>
            <th class="col-dir">方向</th>
          </tr>
        </thead>
        <tbody>
          ${all.map((d) => `
            <tr data-train-key="${d.train.key}" tabindex="0">
              <td class="col-type"><span class="dep-badge dep-badge-inline" style="--chip-color:${getTypeColor(d.train)}">${escapeHtml(typeKey(d.train) || '普通')}</span></td>
              <td class="col-dest"><span class="dep-dest-inline">${escapeHtml(d.train.destinationName || '-')}</span><span class="train-number">${d.train.number ? ' ' + escapeHtml(d.train.number) : ''}</span></td>
              <td class="col-time"><span class="dep-time-inline">${d.departLabel}</span></td>
              <td class="col-dir"><span class="dir-badge dir-${d.train.direction}">${d.train.direction === 'Kudari' ? '下り' : '上り'}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
