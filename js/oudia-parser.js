/**
 * oudia-parser.js
 * ------------------------------------------------------------
 * OuDia / OuDiaSecond の路線ファイル(.oud / .oud2)を読み込むためのパーサー。
 *
 * OuDia形式の構文ルール:
 *   - 「Xxx.」で始まり、単独の「.」で終わるブロック構造(入れ子可)
 *   - ブロック内は「key=value」形式のプロパティ
 *   - 同じキーが複数回登場する可能性があるため、値は配列で保持する
 *
 * 例:
 *   Rosen.
 *   Rosenmei=〇〇線
 *   Eki.
 *   Ekimei=A駅
 *   .
 *   .
 * ------------------------------------------------------------
 */

/** テキストを木構造にパースする */
function parseOuDiaTree(text) {
  const root = { _type: 'root', _children: {}, _props: {}, _parent: null };
  let current = root;
  const lines = text.split(/\r\n|\r|\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line === '.') {
      // ブロックの終了。親に戻る(ファイル末尾などで親が無い場合は無視)
      if (current._parent) current = current._parent;
      continue;
    }

    if (line.endsWith('.')) {
      // 新しいブロックの開始
      const type = line.slice(0, -1);
      const node = { _type: type, _children: {}, _props: {}, _parent: current };
      if (!current._children[type]) current._children[type] = [];
      current._children[type].push(node);
      current = node;
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx >= 0) {
      const key = line.slice(0, eqIdx);
      const value = line.slice(eqIdx + 1);
      if (!current._props[key]) current._props[key] = [];
      current._props[key].push(value);
    }
  }

  return root;
}

/** ノードの子ブロック一覧を取得(無ければ空配列) */
function ouChildren(node, type) {
  return (node._children && node._children[type]) || [];
}

/** ノードのプロパティ値を取得(無ければ undefined) */
function ouProp(node, key, index = 0) {
  const arr = node._props && node._props[key];
  return arr ? arr[index] : undefined;
}

/**
 * 時刻数値を { hour, minute, second, totalMinutes, totalSeconds, label } に変換。
 *
 * OuDiaアプリが実際に出力する内部表現は「時+分(2桁)+秒(2桁)」を連結した数値で、
 * 秒が0の場合は末尾の2桁(秒)が省略される(=見かけ上「時+分」の3〜4桁になる)。
 *   例: "44530" -> 4時45分30秒 / "447" -> 4時47分00秒 / "1810" -> 18時10分00秒
 * 深夜帯は時が24以上までそのまま増加する(例: "2530" -> 25時30分)。
 * 実データ(数千件のEkiJikoku)を突き合わせて検証済みの解釈。
 */
function decodeOuDiaTime(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '' || !/^\d+$/.test(s)) return null;

  let hour, minute, second;
  if (s.length <= 4) {
    hour = parseInt(s.slice(0, -2) || '0', 10);
    minute = parseInt(s.slice(-2), 10);
    second = 0;
  } else {
    hour = parseInt(s.slice(0, -4), 10);
    minute = parseInt(s.slice(-4, -2), 10);
    second = parseInt(s.slice(-2), 10);
  }

  const totalMinutes = hour * 60 + minute;
  const totalSeconds = totalMinutes * 60 + second;
  const label = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { hour, minute, second, totalMinutes, totalSeconds, label };
}

/**
 * EkiJikoku文字列をパースする。
 * 駅ごとに ',' 区切り。各駅は主に "フラグ;着時刻/発時刻" の形式:
 *   "1;800"       -> 単一時刻(発のみが意味を持つ・始発駅など)
 *   "1;810/815"   -> 着8:10 / 発8:15 (停車)
 *   "1;830/"      -> 着8:30のみ(終着・以降の発車なし)
 *   "2" (フラグのみ) -> 通過(時刻情報なし)
 *   "" (空)         -> その駅は未設定(停車なし)
 * フラグの後ろに ";" が無い単独の数字(例: "2")は通過マーカーとして扱い、
 * 時刻としては解釈しない。
 */
function parseEkiJikoku(raw, stationCount) {
  const parts = (raw || '').split(',');
  const stops = new Array(stationCount).fill(null);

  for (let i = 0; i < stationCount; i++) {
    const entry = (parts[i] || '').trim();
    if (entry === '') {
      stops[i] = null;
      continue;
    }

    let flag = '1';
    let timePart = entry;
    const semiIdx = entry.indexOf(';');
    if (semiIdx >= 0) {
      flag = entry.slice(0, semiIdx);
      timePart = entry.slice(semiIdx + 1);
    } else if (!entry.includes('/')) {
      // ";"も"/"も無い短い数字(例: "2")は通過フラグのみで時刻情報を持たない
      stops[i] = null;
      continue;
    }

    if (timePart.includes('/')) {
      const [arrRaw, depRaw] = timePart.split('/');
      const arr = decodeOuDiaTime(arrRaw);
      const dep = decodeOuDiaTime(depRaw);
      stops[i] = { flag, arr, dep, terminal: !dep && !!arr };
    } else {
      const t = decodeOuDiaTime(timePart);
      stops[i] = t ? { flag, arr: t, dep: t, terminal: false } : null;
    }
  }

  return stops;
}

/** Kudari(下り) / Nobori(上り) 方向の列車一覧を抽出 */
function extractDirection(diaNode, dirKey, stations, types) {
  const dirNode = ouChildren(diaNode, dirKey)[0];
  if (!dirNode) return [];

  return ouChildren(dirNode, 'Ressya').map((rNode, idx) => {
    const typeIndex = parseInt(ouProp(rNode, 'Syubetsu') || '0', 10);
    const number = ouProp(rNode, 'Ressyabangou') || '';
    const stops = parseEkiJikoku(ouProp(rNode, 'EkiJikoku') || '', stations.length);

    // 行先(終着駅)を決定: Kudariは最後に停車するインデックスが最大の駅、
    // Noboriは最後に停車するインデックスが最小の駅
    let destIndex = null;
    for (let i = 0; i < stops.length; i++) {
      if (!stops[i]) continue;
      if (dirKey === 'Kudari') {
        destIndex = i; // 前から更新していくと最終的に最大indexが残る
      } else if (destIndex === null) {
        destIndex = i; // Noboriは最初に見つかった(最小index)が終着
      }
    }

    return {
      key: `${dirKey === 'Kudari' ? 'K' : 'N'}${idx}`,
      direction: dirKey,
      typeIndex,
      typeName: (types[typeIndex] && types[typeIndex].name) || '',
      typeColor: (types[typeIndex] && types[typeIndex].color) || null,
      number,
      stops,
      destinationIndex: destIndex,
      destinationName: destIndex !== null ? stations[destIndex].name : '',
    };
  });
}

/** JikokuhyouMojiColor(例: "00FFFFFF"や"000000FF")をCSSカラーに変換(簡易) */
function decodeColor(raw) {
  if (!raw) return null;
  const hex = raw.replace(/^0x/i, '').padStart(8, '0').slice(-8);
  // OuDiaは BGR 順に近い形式のことが多いが環境差があるため、下位6桁をRGBとして解釈するフォールバック
  const b = hex.slice(0, 2);
  const g = hex.slice(2, 4);
  const r = hex.slice(4, 6);
  return `#${r}${g}${b}`;
}

/** ルート全体(Rosen)からダイヤ情報一式を抽出する */
function extractTimetable(root) {
  const rosenNode = ouChildren(root, 'Rosen')[0];
  if (!rosenNode) {
    throw new Error('Rosen(路線)ブロックが見つかりません。正しい.oudファイルか確認してください。');
  }

  const rosenName = ouProp(rosenNode, 'Rosenmei') || '(無名路線)';

  const stations = ouChildren(rosenNode, 'Eki').map((n, i) => ({
    index: i,
    name: ouProp(n, 'Ekimei') || `駅${i + 1}`,
  }));

  if (stations.length === 0) {
    throw new Error('駅データが見つかりません。');
  }

  const types = ouChildren(rosenNode, 'Ressyasyubetsu').map((n, i) => ({
    index: i,
    name: ouProp(n, 'Syubetsumei') || '普通',
    color: decodeColor(ouProp(n, 'JikokuhyouMojiColor')),
  }));

  const dias = ouChildren(rosenNode, 'Dia').map((diaNode) => {
    const name = ouProp(diaNode, 'DiaName') || 'ダイヤ';
    const kudari = extractDirection(diaNode, 'Kudari', stations, types);
    const nobori = extractDirection(diaNode, 'Nobori', stations, types);
    return { name, kudari, nobori };
  });

  if (dias.length === 0) {
    throw new Error('ダイヤ(Dia)データが見つかりません。');
  }

  return { rosenName, stations, types, dias };
}

/** エントリポイント: 生のOuDiaテキストから直接ダイヤ情報を取得 */
function parseOuDia(text) {
  const tree = parseOuDiaTree(text);
  return extractTimetable(tree);
}

// ブラウザのグローバルスコープに公開
window.OuDiaParser = {
  parseOuDia,
  parseOuDiaTree,
  extractTimetable,
  decodeOuDiaTime,
};
