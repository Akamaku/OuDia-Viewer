# 放送音声ファイルについて

このフォルダに、以下のファイル名と完全に一致するWAVファイルを置くと、
発車案内の各行にある🔊ボタンから放送が再生されます。

ファイルが無くても他の機能には影響しません(その行の放送ボタンが鳴らないだけです)。

| ファイル名 | 内容 |
|---|---|
| 000-Aonami-Kosoku.wav 〜 028-Aonami-Kosoku.wav | 0時 〜 28時 |
| 029-Aonami-Kosoku.wav | ちょうど発 |
| 030-Aonami-Kosoku.wav 〜 088-Aonami-Kosoku.wav | 1分発 〜 59分発 |
| 089-Aonami-Kosoku.wav | 普通 |
| 090-Aonami-Kosoku.wav | 急行 |
| 091-Aonami-Kosoku.wav | 特急 |
| 092-Aonami-Kosoku.wav | 通勤急行 |
| 093-Aonami-Kosoku.wav | 区間急行 |
| 094-Aonami-Kosoku.wav | ライナー |
| 095-Aonami-Kosoku.wav | 船渡川から普通特急 |
| 096-Aonami-Kosoku.wav | 回送列車 |
| 097-Aonami-Kosoku.wav | 試運転列車 |
| 098-Aonami-Kosoku.wav | 臨時列車 |
| 099-Aonami-Kosoku.wav | 団体専用列車 |
| 100-Aonami-Kosoku.wav | 当駅止まりの列車 |
| 101-Aonami-Kosoku.wav 〜 108-Aonami-Kosoku.wav | 青波中央行き 〜 茶志内行き(8駅) |
| 109-Aonami-Kosoku.wav | がまいります |
| 110-Aonami-Kosoku.wav | 危ないですから黄色の点字ブロックの内側へお下がりください |
| 111-Aonami-Kosoku.wav | この電車にはご乗車いただけません |
| 112-Aonami-Kosoku.wav | お待たせいたしました |
| 113-Aonami-Kosoku.wav | まもなく |
| 114-Aonami-Kosoku.wav | が発車します。 |
| 115-Aonami-Kosoku.wav | ドアが締まります。ご注意ください。 |

組み立てのルール(`js/app.js`の`buildAnnouncementQueue()`)は以下の通りです。

**通常の列車**(普通・急行・特急・通勤急行・区間急行・ライナー・複合種別):
まもなく → [時] → [分] → [種別] → [行先(当駅止まりの場合は「当駅止まりの列車」)] → がまいります → 安全のご案内

**回送・試運転**(お客様は乗車できない):
[回送列車/試運転列車] → この電車にはご乗車いただけません

**臨時・団体**:
まもなく → [時] → [分] → [臨時列車/団体専用列車] → がまいります → 安全のご案内
