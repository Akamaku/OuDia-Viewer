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
  signStyle: 'flap', // 'flap' | 'lcd' (リアルタイム表示のサインの種類)
  useNow: true,
  manualClock: null, // {hour, minute}
  // 種別・行先の絞り込み(チェックボックス式)。チェックが入っている値だけを表示する。
  // 初めて登場した値はデフォルトでチェック済みにする(typeFiltersKnown/destFiltersKnownで既知かどうかを管理)。
  typeFiltersChecked: new Set(),
  typeFiltersKnown: new Set(),
  destFiltersChecked: new Set(),
  destFiltersKnown: new Set(),
};

const FLAP_ROW_COUNT = 3; // 発車案内の表示段数

/**
 * パタパタ(反転フラップ)式表示機は、実機同様1コマ=1文字(または1つの値)のリールを模している。
 * 「時」「分」はそれぞれ60コマのリール(時は00〜28のみ値があり、それ以降は空欄)、
 * 「種別」「行先」はあらかじめ用意した単語一覧を1枚のコマとして積む。
 * リールは一方向にしか回らないため、値が変わるときは目的のコマまで1つずつ順番にめくれる。
 * 実際の車両・路線に合わせて自由に編集してください。
 */
/** 終着駅で行先の代わりに表示する文言(路線の両端以外の駅で終着になる場合に使う) */
const TERMINAL_HERE_LABEL = '当駅止まり';
const FLAP_TYPES = [
  '普通', '急行', '特急', '通勤急行', 'ライナー', '回送',
  '通過', '臨時', '団体', '試運転', '区間急行', '船渡川から普通 特急',
];
const FLAP_DESTINATIONS = [
  '青波中央', '茶志内', '船渡川', '高輪平', '朝日ヶ丘', '港が丘', '新森町', '花咲野', TERMINAL_HERE_LABEL,
];
const FLAP_MAX_HOUR = 28; // 時のコマは00〜28まで(深夜帯対応)。それ以外は無表示
const FLAP_SLOTS = 60; // 時・分のリールはどちらも60コマ

/** index(0〜59) → そのコマに印字されている文字列、を返すリールを1本組み立てる */
function buildFlapReel(mapFn) {
  return Array.from({ length: FLAP_SLOTS }, (_, i) => mapFn(i));
}

/** 種別・行先は単語ごと1枚のコマとして扱う(あらかじめ用意した単語一覧+空欄1コマ) */
function buildWordReel(words) {
  return [...words, ''];
}

const FLAP_REEL = {
  hour: buildFlapReel((i) => (i <= FLAP_MAX_HOUR ? String(i).padStart(2, '0') : '')),
  // 分は0〜59すべてに値があるため、末尾に空欄コマを1つ追加しておく(非営業列車などで時刻を非表示にする用)
  minute: [...buildFlapReel((i) => String(i).padStart(2, '0')), ''],
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
  loadRomajiOverrides(); // 任意の駅名ローマ字追加ファイル(無くても動作する)
  document.addEventListener('click', unlockAudioOnce);
  document.addEventListener('touchstart', unlockAudioOnce);
  document.addEventListener('keydown', unlockAudioOnce);

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
  els.signStyleField = document.getElementById('sign-style-field');
  els.signStyleButtons = document.querySelectorAll('[data-sign-style]');
}

function bindEvents() {
  els.fileSelect.addEventListener('change', (e) => loadOudFile(e.target.value));
  els.diaSelect.addEventListener('change', (e) => {
    state.diaIndex = parseInt(e.target.value, 10);
    populateFilterOptions();
    renderBoard();
  });
  els.stationSelect.addEventListener('change', (e) => {
    state.stationIndex = parseInt(e.target.value, 10);
    populateFilterOptions();
    renderBoard();
  });
  els.directionButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.directionFilter = btn.dataset.direction;
      els.directionButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      populateFilterOptions();
      renderBoard();
    });
  });
  els.viewButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.view;
      els.viewButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      document.body.classList.toggle('mode-browser', state.viewMode === 'browser');
      els.filterControls.classList.toggle('is-hidden', state.viewMode === 'realtime');
      els.signStyleField.classList.toggle('is-hidden', state.viewMode !== 'realtime');
      renderBoard();
    });
  });
  els.signStyleButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.signStyle = btn.dataset.signStyle;
      els.signStyleButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
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

  // 上り列車は、下りと同じ並び(駅番号が小さい順)ではなく、
  // 実際に進む向き(終着駅が上)に合わせて駅の並びを逆にする。
  const order = train.direction === 'Nobori'
    ? stations.map((_, i) => i).reverse()
    : stations.map((_, i) => i);

  const rows = order.map((i) => {
    const st = stations[i];
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
  if (state.timetable) checkAutoAnnouncements();
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
    state.typeFiltersChecked = new Set();
    state.typeFiltersKnown = new Set();
    state.destFiltersChecked = new Set();
    state.destFiltersKnown = new Set();

    populateDiaSelect(timetable.dias);
    populateStationSelect(timetable.stations);
    populateFilterOptions(); // 種別・行先チェックボックスの初期値(全チェック)を用意しておく

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

/** 現在の基準時刻を「サービス日 0:00起点の秒数」で返す(4時始発想定・深夜帯対応、パタパタ/LCDの切り替えと放送の秒単位トリガーの両方で使う)。手動時刻は経過秒ぶん進み続ける */
function getNowServiceSeconds() {
  const SERVICE_DAY_START = 4;
  if (state.useNow || !state.manualClock) {
    const now = new Date();
    const hour = now.getHours();
    const adjHour = hour < SERVICE_DAY_START ? hour + 24 : hour;
    return adjHour * 3600 + now.getMinutes() * 60 + now.getSeconds();
  }
  const elapsedSec = (Date.now() - state.manualClock.setAtMs) / 1000;
  return state.manualClock.baseMinutes * 60 + elapsedSec;
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

/** 終着駅でも「当駅止まり」ではなく通常の行先名で表示する駅(=路線の両端。終点であることが当たり前なため) */
const TERMINAL_STATIONS_SHOW_NORMAL_NAME = ['青波中央', '茶志内'];

function collectStationDepartures(opts) {
  const ignoreFilters = !!(opts && opts.ignoreFilters);
  const dia = state.timetable.dias[state.diaIndex];
  if (!dia) return [];
  const stIndex = state.stationIndex;
  const stationName = state.timetable.stations[stIndex]?.name || '';
  const trains = [];

  const pools = [];
  if (state.directionFilter === 'all' || state.directionFilter === 'Kudari') pools.push(...dia.kudari);
  if (state.directionFilter === 'all' || state.directionFilter === 'Nobori') pools.push(...dia.nobori);

  for (const train of pools) {
    if (HIDDEN_TYPES.includes(train.typeName)) continue;
    const stop = train.stops[stIndex];
    if (!stop) continue;
    if (stop.flag === '2') continue; // 通過(停車しない)駅では乗車できないため案内しない

    let timeInfo;
    let displayDest;
    let isTerminalHere = false;
    if (stop.dep) {
      timeInfo = stop.dep;
      displayDest = train.destinationName;
    } else if (stop.arr && train.destinationIndex === stIndex) {
      // ここが終着駅。発車は無いが、到着時刻で案内する。
      // 路線の両端(青波中央・茶志内)は通常の行先名、それ以外の駅では「当駅止まり」と表示する。
      timeInfo = stop.arr;
      isTerminalHere = true;
      displayDest = TERMINAL_STATIONS_SHOW_NORMAL_NAME.includes(stationName) ? train.destinationName : TERMINAL_HERE_LABEL;
    } else {
      continue; // 発車も終着も無い駅ではここでは案内しない
    }

    const displayType = displayTypeForStation(train, stationName);
    if (!ignoreFilters && !state.typeFiltersChecked.has(displayType)) continue;
    if (!ignoreFilters && !state.destFiltersChecked.has(displayDest)) continue;
    const isNonBoarding = !!ANNOUNCE_NONBOARDING_TYPE_FILES[displayType]; // 非営業・一般人が乗れない列車は時刻を表示しない
    trains.push({
      train,
      stop,
      departMinutes: timeInfo.totalMinutes,
      departSeconds: timeInfo.totalSeconds,
      departLabel: isNonBoarding ? '' : timeInfo.label,
      displayType,
      displayDest,
      isTerminalHere,
      isNonBoarding,
    });
  }

  trains.sort((a, b) => a.departMinutes - b.departMinutes);
  return trains;
}

/** 初めて登場した値をデフォルトでチェック済みにする */
function ensureFilterDefaults(knownSet, checkedSet, values) {
  values.forEach((v) => {
    if (!knownSet.has(v)) {
      knownSet.add(v);
      checkedSet.add(v);
    }
  });
}

/** 種別・行先フィルターのチェックボックスを、現在の駅・ダイヤ・方向における実際の値で埋める */
function populateFilterOptions() {
  const base = collectStationDepartures({ ignoreFilters: true });
  const types = [...new Set(base.map((d) => d.displayType).filter(Boolean))].sort();
  const dests = [...new Set(base.map((d) => d.displayDest).filter(Boolean))].sort();

  ensureFilterDefaults(state.typeFiltersKnown, state.typeFiltersChecked, types);
  ensureFilterDefaults(state.destFiltersKnown, state.destFiltersChecked, dests);

  renderCheckboxGroup(els.typeFilter, types, state.typeFiltersChecked, (value, checked) => {
    if (checked) state.typeFiltersChecked.add(value); else state.typeFiltersChecked.delete(value);
    renderBoard();
  });
  renderCheckboxGroup(els.destFilter, dests, state.destFiltersChecked, (value, checked) => {
    if (checked) state.destFiltersChecked.add(value); else state.destFiltersChecked.delete(value);
    renderBoard();
  });
}

/** チェックボックス群を描画する(共通ヘルパー) */
function renderCheckboxGroup(container, values, checkedSet, onChange) {
  if (!container) return;
  container.innerHTML = values.map((v, i) => {
    const id = `${container.id}-${i}`;
    const isChecked = checkedSet.has(v);
    return `<label class="checkbox-item" for="${id}"><input type="checkbox" id="${id}" value="${escapeHtml(v)}"${isChecked ? ' checked' : ''}><span>${escapeHtml(v)}</span></label>`;
  }).join('');
  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      onChange(input.value, input.checked);
    });
  });
}

function renderRealtimeBoard() {
  const stationName = state.timetable.stations[state.stationIndex]?.name || '';
  const nowSec = getNowServiceSeconds();
  const all = collectStationDepartures();

  if (all.length === 0) {
    els.board.innerHTML = '';
    els.emptyState.classList.remove('is-hidden');
    els.emptyState.textContent = `${stationName} — 時刻データがありません`;
    return;
  }

  // 直近3本のみを表示する(発車時刻(秒単位)を過ぎた瞬間に切り替わる)
  const upcoming = all
    .map((d) => ({ ...d, diff: d.departSeconds - nowSec }))
    .filter((d) => d.diff >= 0)
    .sort((a, b) => a.diff - b.diff)
    .slice(0, FLAP_ROW_COUNT);

  // 3枠は常に確保し、以降の列車が無い枠は空欄コマとして表示する
  const slots = [0, 1, 2].map((i) => upcoming[i] || null);

  if (state.signStyle === 'lcd') {
    renderLcdSign(slots, stationName);
  } else {
    updateFlapSign(slots, stationName);
  }
}

/**
 * LCD式サイン: 種別ごとに色分けしたバッジで発車時刻・行先を表示する。
 * (パタパタは実機再現のため種別は白黒統一だが、LCDはこちらで色分けする)
 */
const LCD_TYPE_STYLES = {
  '普通': 'background:#1c6fe0;color:#fff;border-color:#1c6fe0;',
  '区間急行': 'background:#a3e635;color:#1a2e05;border-color:#a3e635;',
  '急行': 'background:#f97316;color:#fff;border-color:#f97316;',
  '通勤急行': 'background:#fff;color:#f97316;border:2px solid #f97316;',
  'ライナー': 'background:#7b1128;color:#fff;border-color:#7b1128;', // ワインレッド
  '特急': 'background:#dc2626;color:#fff;border-color:#dc2626;',
};
function lcdTypeStyle(typeName) {
  return LCD_TYPE_STYLES[typeName] || 'background:#374151;color:#fff;border-color:#374151;';
}

/**
 * 種別名の英語表記(ローマ字ではなく英訳)。指定の無い種別(臨時・団体など)は表示しない。
 */
const TYPE_ENGLISH = {
  '普通': 'Local',
  '急行': 'Express',
  '特急': 'Limited Express',
  '通勤急行': 'Commuter Express',
  '区間急行': 'Suburban Express',
  'ライナー': 'Liner',
  '回送': 'Out of service',
  '試運転': 'Out of service',
  '船渡川から普通 特急': 'Lim.Express +Minamigaoka.',
  // 臨時・団体は英語表記なし(意図的に未登録)
};

/**
 * 駅名のヘボン式ローマ字(既知の駅だけ内蔵。それ以外は oud/romaji.json があればそこから補う)。
 * 漢字だけからは正しい読みを機械的に決められないため、自動変換はしていない。
 */
const STATION_ROMAJI = {
  '青波中央': 'Aonami-chuo',
  '青波西': 'Aonami-nishi',
  '港が丘': 'Minato-ga-oka',
  '潮見台': 'Shiomidai',
  '波越': 'Namikoshi',
  '朝日ヶ丘': 'Asahi-ga-oka',
  '桜木町': 'Sakuragicho',
  '新森町': 'Shinmorimachi',
  '高輪平': 'Takanawadaira',
  '峯川': 'Minegawa',
  '花咲野': 'Hanasakino',
  '緑ヶ丘': 'Midori-ga-oka',
  '船渡川': 'Funatogawa',
  '南ヶ丘': 'Minami-ga-oka',
  '茶志内': 'Chashinai',
  '青波駅前': 'Aonami-ekimae',
  '波止場通': 'Hatobadori',
  '柳町': 'Yanagimachi',
  '茶志内駅': 'Chashinai-eki',
};

/** oud/romaji.json (任意)を読み込み、STATION_ROMAJI に追加する。無ければ何もしない。 */
async function loadRomajiOverrides() {
  try {
    const res = await fetch('oud/romaji.json', { cache: 'no-store' });
    if (res.ok) Object.assign(STATION_ROMAJI, await res.json());
  } catch (e) { /* ファイルが無ければ静かに無視 */ }
}

function romajiSpan(text) {
  return text ? `<span class="lcd-romaji">${escapeHtml(text)}</span>` : '';
}

function renderLcdSign(slots, stationName) {
  els.board.innerHTML = `
    <div class="lcd-sign">
      <div class="lcd-sign-header">
        <span class="lcd-h">発車時刻</span><span class="lcd-h">種別</span><span class="lcd-h">行先</span>
      </div>
      <div class="lcd-sign-body">
        ${slots.map((d) => lcdRowHtml(d, stationName)).join('')}
      </div>
    </div>
  `;
}

function lcdRowHtml(d, stationName) {
  if (!d) {
    return `<div class="lcd-row is-empty" tabindex="-1"><span class="lcd-time"></span><span class="lcd-badge"></span><span class="lcd-dest"></span></div>`;
  }
  const { train, stop } = d;
  // 非営業・一般人が乗れない列車(回送・試運転)は時刻を表示しない
  const timeInfo = d.isNonBoarding ? null : (stop.dep || stop.arr);
  const displayType = displayTypeForStation(train, stationName);
  const destName = d.displayDest || train.destinationName;
  // 複合種別(「船渡川から普通 特急」等)はパタパタと同じ、上下2段の分割表示にする
  const badgeContent = isCompoundType(displayType)
    ? `<span class="lcd-badge-compound">${renderTypeFace(displayType)}</span>`
    : `<span class="lcd-badge-main">${escapeHtml(displayType)}</span>${romajiSpan(TYPE_ENGLISH[displayType])}`;
  return `
    <div class="lcd-row" data-train-key="${train.key}" tabindex="0">
      <span class="lcd-time">${timeInfo ? timeInfo.label : ''}</span>
      <span class="lcd-badge" style="${lcdTypeStyle(displayType)}">${badgeContent}</span>
      <span class="lcd-dest">
        <span class="lcd-dest-main">${escapeHtml(destName)}</span>${romajiSpan(STATION_ROMAJI[destName])}
      </span>
    </div>
  `;
}

/** パタパタ(反転フラップ)式サイン: 列車接近の案内はせず、既定コマの範囲のみ表示する */
function flapSignHtml(slots, stationName) {
  return `
    <div class="flap-sign">
      <div class="flap-sign-header">
        <span class="flap-h">時刻</span><span class="flap-h">種別</span><span class="flap-h">行先</span>
      </div>
      <div class="flap-sign-body">
        ${slots.map((d) => flapRowHtml(d, stationName)).join('')}
      </div>
    </div>
  `;
}

/**
 * 「船渡川から普通 特急」のように種別が区間によって変わる列車は、
 * 指定した駅ではその区間での実際の種別(例: 普通)として表示する。
 */
const TYPE_STATION_OVERRIDES = {
  '船渡川から普通 特急': { stations: ['船渡川', '南ヶ丘', '茶志内'], showAs: '普通' },
};

function displayTypeForStation(train, stationName) {
  const base = typeKey(train);
  const override = TYPE_STATION_OVERRIDES[base];
  if (override && stationName && override.stations.includes(stationName)) {
    return override.showAs;
  }
  return base;
}

/** この行が目指すべき、各リールの目標コマ番号。dが無い(空枠)場合は全て空欄コマを目指す。 */
function flapTargetIndices(d, stationName) {
  if (!d) {
    return {
      hour: flapReelIndexFor(FLAP_REEL.hour, ''),
      minute: flapReelIndexFor(FLAP_REEL.minute, ''),
      type: flapReelIndexFor(FLAP_REEL.type, ''),
      dest: flapReelIndexFor(FLAP_REEL.dest, ''),
    };
  }
  const { train, stop } = d;
  // 非営業・一般人が乗れない列車(回送・試運転)は時刻を表示しない
  const timeInfo = d.isNonBoarding ? null : (stop.dep || stop.arr);
  const hourStr = timeInfo && timeInfo.hour <= FLAP_MAX_HOUR ? String(timeInfo.hour).padStart(2, '0') : '';
  const minStr = timeInfo ? String(timeInfo.minute).padStart(2, '0') : '';
  return {
    hour: flapReelIndexFor(FLAP_REEL.hour, hourStr),
    minute: flapReelIndexFor(FLAP_REEL.minute, minStr),
    type: flapReelIndexFor(FLAP_REEL.type, displayTypeForStation(train, stationName)),
    dest: flapReelIndexFor(FLAP_REEL.dest, d.displayDest || train.destinationName),
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

function flapRowHtml(d, stationName) {
  const t = flapTargetIndices(d, stationName);
  const isEmpty = !d;
  const typeColorStyle = d ? getFlapTypeStyle(displayTypeForStation(d.train, stationName)) : '';
  return `
    <div class="flap-row ${isEmpty ? 'is-empty' : ''}" data-train-key="${d ? d.train.key : ''}" tabindex="0">
      <div class="flap-time">
        <div class="flap-hour-box">${flapTile('flap-digit flap-hour', 'hour', t.hour)}</div>
        <span class="flap-colon">:</span>
        <div class="flap-minute-box">${flapTile('flap-digit flap-minute', 'minute', t.minute)}</div>
      </div>
      ${flapTile('flap-type', 'type', t.type, typeColorStyle)}
      ${flapTile('flap-dest', 'dest', t.dest)}
    </div>
  `;
}

/** パタパタサインを差分更新し、コマがズレているリールだけ目標コマまで1つずつめくる */
function updateFlapSign(slots, stationName) {
  if (!els.board.querySelector('.flap-sign')) {
    els.board.innerHTML = flapSignHtml(slots, stationName);
    return;
  }
  const rows = els.board.querySelectorAll('.flap-row');
  slots.forEach((d, i) => {
    const rowEl = rows[i];
    if (!rowEl) return;
    rowEl.classList.toggle('is-empty', !d);
    rowEl.dataset.trainKey = d ? d.train.key : '';
    const t = flapTargetIndices(d, stationName);
    flipReelTo(rowEl.querySelector('.flap-hour'), t.hour);
    flipReelTo(rowEl.querySelector('.flap-minute'), t.minute);

    const typeTile = rowEl.querySelector('.flap-type');
    if (typeTile) typeTile.style.cssText = d ? getFlapTypeStyle(displayTypeForStation(d.train, stationName)) : '';
    flipReelTo(typeTile, t.type);
    flipReelTo(rowEl.querySelector('.flap-dest'), t.dest);
  });
}

const FLAP_STEP_MS = 110; // 1コマあたりのめくり間隔(動画を参考に高速化)
const FLAP_LEAF_ANIM_MS = 80; // 葉が中央の水平線を軸に倒れ込むアニメーションの長さ(動画を参考に高速化)

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
          ${all.map((d) => {
            const displayType = displayTypeForStation(d.train, stationName);
            const chipColor = TYPE_COLOR_OVERRIDES[displayType] || d.train.typeColor || DEFAULT_TYPE_COLOR;
            return `
            <tr data-train-key="${d.train.key}" tabindex="0">
              <td class="col-type"><span class="dep-badge dep-badge-inline" style="--chip-color:${chipColor}">${escapeHtml(displayType || '普通')}</span></td>
              <td class="col-dest"><span class="dep-dest-inline">${escapeHtml(d.displayDest || '-')}</span><span class="train-number">${d.train.number ? ' ' + escapeHtml(d.train.number) : ''}</span></td>
              <td class="col-time"><span class="dep-time-inline">${d.departLabel}</span></td>
              <td class="col-dir"><span class="dir-badge dir-${d.train.direction}">${d.train.direction === 'Kudari' ? '下り' : '上り'}</span></td>
            </tr>
          `;
          }).join('')}
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

/* ============================================================
 * 放送(音声案内)
 * audio/ フォルダに指定のファイル名のwavを置くと再生される。
 * ファイルが無い場合は静かにスキップする(他の機能には影響しない)。
 *
 * ・到着放送: 到着(秒単位)の25秒前から自動再生
 * ・発車放送: 発車(秒単位)の20秒前から自動再生
 * ・当駅止まりの場合は、到着放送(専用の台本)のみで発車放送は無く、
 *   代わりに「この電車にはご乗車いただけません」を続けて再生する
 * ・🔊ボタンでも同じ放送を手動再生できる
 * ============================================================ */
const ANNOUNCE_AUDIO_BASE = 'audio/';
const ANNOUNCE_ARRIVAL_LEAD_SEC = 25; // 到着何秒前から流すか
const ANNOUNCE_DEPARTURE_LEAD_SEC = 18; // 発車何秒前から流すか
const ANNOUNCE_GAP_MS = 50; // 放送ファイルの継ぎ目の間隔(全て統一)
const ANNOUNCE_GAP_MS_TIGHT = 50; // 継ぎ目の間隔は全て上と同じに統一

function announceHourFile(hour) {
  let h = hour;
  if (h > 28) h %= 24;
  h = Math.max(0, Math.min(28, h));
  return `${String(h).padStart(3, '0')}-Aonami-Kosoku.wav`;
}
function announceMinuteFile(minute) {
  const idx = minute === 0 ? 29 : 29 + minute; // 029=ちょうど発, 030〜088=1分発〜59分発
  return `${String(idx).padStart(3, '0')}-Aonami-Kosoku.wav`;
}

// 種別名 -> 音声ファイル(行先と組み合わせて読み上げる、一般の営業種別)
const ANNOUNCE_TYPE_FILES = {
  '普通': '089-Aonami-Kosoku.wav',
  '急行': '090-Aonami-Kosoku.wav',
  '特急': '091-Aonami-Kosoku.wav',
  '通勤急行': '092-Aonami-Kosoku.wav',
  '区間急行': '093-Aonami-Kosoku.wav',
  'ライナー': '094-Aonami-Kosoku.wav',
  '船渡川から普通 特急': '095-Aonami-Kosoku.wav',
  '臨時': '098-Aonami-Kosoku.wav',
  '団体': '099-Aonami-Kosoku.wav',
};
// 種別名 -> 音声ファイル(お客様が乗車できない種別。行先とは組み合わせない)
const ANNOUNCE_NONBOARDING_TYPE_FILES = {
  '回送': '096-Aonami-Kosoku.wav',
  '試運転': '097-Aonami-Kosoku.wav',
};
const ANNOUNCE_TERMINAL_HERE_FILE = '100-Aonami-Kosoku.wav'; // 当駅止まりの列車
// 行先(駅名) -> 音声ファイル(「〜行き」)
const ANNOUNCE_DEST_FILES = {
  '青波中央': '101-Aonami-Kosoku.wav',
  '港が丘': '102-Aonami-Kosoku.wav',
  '朝日ヶ丘': '103-Aonami-Kosoku.wav',
  '新森町': '104-Aonami-Kosoku.wav',
  '高輪平': '105-Aonami-Kosoku.wav',
  '花咲野': '106-Aonami-Kosoku.wav',
  '船渡川': '107-Aonami-Kosoku.wav',
  '茶志内': '108-Aonami-Kosoku.wav',
};
const ANNOUNCE_PHRASE = {
  gaMairimasu: '109-Aonami-Kosoku.wav', // がまいります
  safety: '110-Aonami-Kosoku.wav', // 危ないですから黄色の点字ブロックの内側へお下がりください
  cannotBoard: '111-Aonami-Kosoku.wav', // この電車にはご乗車いただけません
  omatase: '112-Aonami-Kosoku.wav', // お待たせいたしました
  mamonaku: '113-Aonami-Kosoku.wav', // まもなく
  gaHassha: '114-Aonami-Kosoku.wav', // が発車します。
  doorClosing: '115-Aonami-Kosoku.wav', // ドアが締まります。ご注意ください。
  turnBackPrefix: '116-Aonami-Kosoku.wav', // この電車は折り返し、
  turnBackSuffix: '117-Aonami-Kosoku.wav', // になります
  towardTakanawadairaChashinai: '118-Aonami-Kosoku.wav', // 高輪平・茶志内方面行き
  lastTrainPrefix: '119-Aonami-Kosoku.wav', // この電車は、
  lastTrainSuffix: '120-Aonami-Kosoku.wav', // の最終電車です。お乗り遅れの内容にご注意ください。
  turnBackWord: '121-Aonami-Kosoku.wav', // 折り返し
};

/**
 * 当駅止まりの列車のうち、指定した駅ではこの案内(「この電車は折り返し、〜行きになります」)を
 * 通常の「当駅止まりの列車がまいります」の代わりに流す。
 */
const ANNOUNCE_TURNBACK_STATIONS = {
  '高輪平': '青波中央',
};

/**
 * 単一時刻(スラッシュ無し)の駅は arr と dep に同じ値が入るだけで、本当の「到着」ではない
 * (始発駅など)。到着・発車が別の値のとき、または発車が無い(終着)ときだけ本当の到着とみなす。
 */
function hasGenuineArrival(stop) {
  if (!stop.arr) return false;
  if (!stop.dep) return true; // 終着(到着のみ)
  return stop.arr.totalSeconds !== stop.dep.totalSeconds; // 停車時間のある本当の到着
}

/** キューに1件積む。gapAfterを指定すると、そのクリップの直後だけ既定と違う継ぎ目間隔にできる。 */
function announceItem(file, gapAfter) {
  return { file, gapAfter };
}

/** 到着放送の台本(発車時刻・分は読み上げず、「まもなく〜がまいります」形式)。
 *  到着時刻が無い(始発駅の)場合はそもそも呼び出されない(checkAutoAnnouncements側で判定)。
 *  種別(または「当駅止まりの列車」/折り返し案内)・行先から「がまいります」に入る直前だけ継ぎ目を詰める。 */
function buildArrivalAnnouncement(d) {
  const { displayType, displayDest, isTerminalHere } = d;
  if (ANNOUNCE_NONBOARDING_TYPE_FILES[displayType]) {
    // 回送・試運転はそもそも到着放送の対象にしない(発車放送側でご案内)
    return [];
  }
  const queue = [announceItem(ANNOUNCE_PHRASE.mamonaku)];
  if (isTerminalHere) {
    const stationName = state.timetable?.stations[state.stationIndex]?.name;
    const turnBackDest = ANNOUNCE_TURNBACK_STATIONS[stationName];
    if (turnBackDest && ANNOUNCE_DEST_FILES[turnBackDest]) {
      // 例:「まもなく…この電車は折り返し、青波中央行きになります」
      queue.push(
        announceItem(ANNOUNCE_PHRASE.turnBackPrefix, ANNOUNCE_GAP_MS_TIGHT),
        announceItem(ANNOUNCE_DEST_FILES[turnBackDest], ANNOUNCE_GAP_MS_TIGHT),
        announceItem(ANNOUNCE_PHRASE.turnBackSuffix),
      );
      return queue;
    }
    queue.push(
      announceItem(ANNOUNCE_TERMINAL_HERE_FILE, ANNOUNCE_GAP_MS_TIGHT),
      announceItem(ANNOUNCE_PHRASE.gaMairimasu),
      announceItem(ANNOUNCE_PHRASE.safety),
      announceItem(ANNOUNCE_PHRASE.cannotBoard),
    );
    return queue;
  }
  if (ANNOUNCE_TYPE_FILES[displayType]) queue.push(announceItem(ANNOUNCE_TYPE_FILES[displayType], ANNOUNCE_GAP_MS_TIGHT));
  if (ANNOUNCE_DEST_FILES[displayDest]) queue.push(announceItem(ANNOUNCE_DEST_FILES[displayDest], ANNOUNCE_GAP_MS_TIGHT));
  queue.push(announceItem(ANNOUNCE_PHRASE.gaMairimasu), announceItem(ANNOUNCE_PHRASE.safety));
  return queue;
}

/** 発車放送の台本(「まもなく[時][分]発、[種別][行先]行きが発車します。ドアが締まります。」形式) */
function buildDepartureAnnouncement(d) {
  const { stop, displayType, displayDest } = d;
  if (ANNOUNCE_NONBOARDING_TYPE_FILES[displayType]) {
    return [announceItem(ANNOUNCE_NONBOARDING_TYPE_FILES[displayType]), announceItem(ANNOUNCE_PHRASE.cannotBoard)];
  }
  if (!stop.dep) return []; // 当駅止まり(発車が無い)には発車放送は無い
  const queue = [
    announceItem(ANNOUNCE_PHRASE.mamonaku),
    announceItem(announceHourFile(stop.dep.hour)),
    announceItem(announceMinuteFile(stop.dep.minute)),
  ];
  if (ANNOUNCE_TYPE_FILES[displayType]) queue.push(announceItem(ANNOUNCE_TYPE_FILES[displayType]));
  if (ANNOUNCE_DEST_FILES[displayDest]) queue.push(announceItem(ANNOUNCE_DEST_FILES[displayDest]));
  queue.push(announceItem(ANNOUNCE_PHRASE.gaHassha), announceItem(ANNOUNCE_PHRASE.doorClosing));
  return queue;
}

/**
 * 放送プレイヤー: 2つのAudio要素を交互に使い、片方を再生している間にもう片方へ
 * 次のファイルを先読みしておくことで、ファイルの継ぎ目の無音区間をできるだけ短くする。
 * 複数の放送が重なった場合は割り込まず、キューに積んで順番に流す。
 */
const announcePlayer = {
  audios: (typeof Audio !== 'undefined') ? [new Audio(), new Audio()] : null,
  active: 0,
  queue: [],
  playing: false,
};
if (announcePlayer.audios) {
  announcePlayer.audios.forEach((a) => { a.preload = 'auto'; });

  const preloadInto = (idx, file) => {
    const a = announcePlayer.audios[idx];
    if (a.dataset.pendingFile === file) return; // 既に先読み済み
    a.src = ANNOUNCE_AUDIO_BASE + file;
    a.dataset.pendingFile = file;
    a.load();
  };

  const playCurrent = () => {
    if (announcePlayer.queue.length === 0) { announcePlayer.playing = false; return; }
    announcePlayer.playing = true;
    const item = announcePlayer.queue.shift();
    const file = item.file;
    announcePlayer.currentGapAfter = item.gapAfter || ANNOUNCE_GAP_MS;
    const idx = announcePlayer.active;
    const audio = announcePlayer.audios[idx];
    const onPlayFail = (err) => {
      if (err && err.name === 'NotAllowedError') {
        // 自動再生がブラウザにブロックされている場合、キューを空で消費し続けず打ち切る
        // (次のユーザー操作でunlockAudioOnceが成功すれば、以降の放送は正常に鳴るようになる)
        announcePlayer.queue = [];
        announcePlayer.playing = false;
      } else {
        advance(); // ファイルが無い等、他の理由の失敗は、そのファイルだけ諦めて次へ
      }
    };
    try {
      if (audio.dataset.pendingFile !== file) {
        audio.src = ANNOUNCE_AUDIO_BASE + file;
        audio.dataset.pendingFile = file;
      }
      // 注意: src変更直後にcurrentTimeを触るとメタデータ未読込でエラーになるブラウザがあるため触らない
      audio.play().then(() => { audioUnlocked = true; }).catch(onPlayFail);
    } catch (e) {
      onPlayFail(e);
      return;
    }
    // 再生中に、次のファイルをもう片方の要素へ先読みしておく
    const nextItem = announcePlayer.queue[0];
    if (nextItem) preloadInto(1 - idx, nextItem.file);
  };
  function advance() {
    announcePlayer.active = 1 - announcePlayer.active;
    playCurrent();
  }
  function advanceWithGap() {
    window.setTimeout(advance, announcePlayer.currentGapAfter || ANNOUNCE_GAP_MS);
  }
  announcePlayer.audios.forEach((a) => {
    a.addEventListener('ended', advanceWithGap);
    a.addEventListener('error', advance); // 再生エラー時は間を空けずすぐ次へ
  });
  announcePlayer._playCurrent = playCurrent;
}
/** 放送キューに追加する(再生中なら続けて、空いていればすぐに再生)。ファイルが無ければ静かにスキップして次へ進む。 */
function playAnnouncementQueue(items) {
  if (!items || !items.length || !announcePlayer.audios) return;
  announcePlayer.queue.push(...items);
  if (!announcePlayer.playing) announcePlayer._playCurrent();
}

// 一部のブラウザは、ページ内で一度も(再生に有効な)操作が無いと音声の自動再生を拒否する。
// 最初のユーザー操作で解除を試み、失敗した場合は次の操作でも再試行する
// (直前の実装は最初の1回で成功したかどうかに関わらず「解除済み」にしてしまっており、
//  ブラウザが拒否した場合そのまま放送が二度と鳴らなくなるバグがあったため修正)。
let audioUnlocked = false;
function unlockAudioOnce() {
  if (audioUnlocked || !announcePlayer.audios) return;
  announcePlayer.audios.forEach((a) => {
    a.muted = true;
    a.play().then(() => {
      audioUnlocked = true; // 実際に再生できたときだけ「解除済み」にする
      a.pause();
      a.muted = false;
    }).catch(() => { a.muted = false; }); // 失敗時は解除済みにしない → 次の操作でまた試す
  });
}

/**
 * 毎秒呼び出し、選択中の駅で「到着25秒前」「発車18秒前」に当たる列車があれば自動で放送する。
 * 到着時刻が無い駅(始発駅)では到着放送は流さない(発車放送のみ)。
 * 同じ列車・同じ種類(到着/発車)の放送を何度も鳴らさないよう、announcedKeys に記録しておく。
 */
const announcedKeys = new Set();
function checkAutoAnnouncements() {
  if (!state.timetable) return;
  const nowSec = getNowServiceSeconds();
  const all = collectStationDepartures();
  all.forEach((d) => {
    const { stop, train } = d;
    if (hasGenuineArrival(stop)) {
      const key = `${train.key}-arr`;
      const diff = stop.arr.totalSeconds - nowSec;
      if (!announcedKeys.has(key) && diff <= ANNOUNCE_ARRIVAL_LEAD_SEC && diff > ANNOUNCE_ARRIVAL_LEAD_SEC - 3) {
        announcedKeys.add(key);
        playAnnouncementQueue(buildArrivalAnnouncement(d));
      }
    }
    if (stop.dep) {
      const key = `${train.key}-dep`;
      const diff = stop.dep.totalSeconds - nowSec;
      if (!announcedKeys.has(key) && diff <= ANNOUNCE_DEPARTURE_LEAD_SEC && diff > ANNOUNCE_DEPARTURE_LEAD_SEC - 3) {
        announcedKeys.add(key);
        playAnnouncementQueue(buildDepartureAnnouncement(d));
      }
    }
  });
}
