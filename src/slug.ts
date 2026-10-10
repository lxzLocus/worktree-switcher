/**
 * 日本語の「やりたいこと」自由文から、worktreeディレクトリ名/ブランチ名向けの
 * kebab-case slug 候補をルールベースで生成する。
 * 外部API・ネットワーク不要。辞書に無い語はローマ字化 or 除外する。
 */

/** 日本語→英語の変換辞書（インフラ/開発文脈中心）。長い語を先に並べること。 */
const DICTIONARY: Array<[RegExp, string]> = [
  // --- 汎用的なクラウド/開発用語 ---
  [/クラウド|cloud/gi, 'cloud'],
  [/コンテナ|container/gi, 'container'],
  [/モバイル|mobile/gi, 'mobile'],
  [/kubernetes|k8s/gi, 'k8s'],
  [/infrastructure|infra/gi, 'infra'],

  // --- 複合語（単語より先に判定したいもの） ---
  [/実行環境/g, 'runtime'],
  [/開発環境/g, 'dev-env'],
  [/本番環境/g, 'prod'],
  [/検証環境|ステージング/g, 'stg'],
  [/インフラ(ストラクチャ)?/g, 'infra'],
  [/パイプライン/g, 'pipeline'],
  [/デプロイ/g, 'deploy'],
  [/マイグレーション/g, 'migration'],
  [/モニタリング|監視/g, 'monitoring'],
  [/バックアップ/g, 'backup'],
  [/リファクタリング|リファクタ/g, 'refactor'],

  // --- 動作/操作 ---
  [/構築|作成|新規|セットアップ|用意/g, 'setup'],
  [/追加/g, 'add'],
  [/削除/g, 'remove'],
  [/更新|アップデート/g, 'update'],
  [/変更|修正/g, 'change'],
  [/有効化|有効/g, 'enable'],
  [/無効化|無効/g, 'disable'],
  [/移行/g, 'migrate'],
  [/調査|検証/g, 'investigate'],
  [/対応/g, 'support'],

  // --- 物/概念 ---
  [/アプリ(ケーション)?/g, 'app'],
  [/サーバー?/g, 'server'],
  [/データベース|データーベース/g, 'db'],
  [/ネットワーク/g, 'network'],
  [/セキュリティ/g, 'security'],
  [/権限|ロール/g, 'role'],
  [/ユーザー?/g, 'user'],
  [/環境/g, 'env'],
  [/設定/g, 'config'],
  [/機能/g, 'feature'],
  [/認証/g, 'auth'],
  [/証明書/g, 'cert'],
  [/暗号化/g, 'encryption'],
  [/テスト/g, 'test'],
  [/ログ/g, 'log'],
  [/コスト/g, 'cost'],
  [/ルール/g, 'rule'],
  [/クラスタ(ー)?/g, 'cluster'],
  [/アップグレード/g, 'upgrade'],
  [/レプリケーション/g, 'replication'],
  [/シークレット/g, 'secret'],
  [/権限/g, 'permission'],
  [/付与/g, 'grant'],
  [/取得/g, 'get'],
  [/論理/g, 'logical'],
  [/物理/g, 'physical'],
  [/クローン/g, 'clone'],
  [/ゲートウェイ/g, 'gateway'],
  [/エンドポイント/g, 'endpoint'],
  [/キャッシュ/g, 'cache'],
  [/キュー/g, 'queue'],
  [/通知/g, 'notification'],
  [/バッチ/g, 'batch'],
  [/ジョブ/g, 'job'],
  [/スケジュール/g, 'schedule'],
  [/ワークフロー/g, 'workflow'],
  [/バージョン/g, 'version'],
];

/** slug から落とす助詞・無意味語（辞書適用後に残った日本語の助詞など） */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'with', 'wo', 'ni',
  'wa', 'ga', 'no', 'he', 'de', 'shitai', 'suru', 'shi', 'tai', 'you', 'te',
  'kara', 'made', 'shite', 'nado', 'mono', 'koto',
]);

/** ローマ字化した語の末尾に残りがちな助詞を剥がす（例: noruruwo → noruru） */
function stripTrailingParticles(token: string): string {
  let t = token;
  // 長い助詞から順に、末尾から1回だけ剥がすのを数回繰り返す
  const particles = ['shite', 'kara', 'made', 'wo', 'ni', 'wa', 'ga', 'no', 'de', 'te', 'he'];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of particles) {
      if (t.length > p.length + 1 && t.endsWith(p)) {
        t = t.slice(0, t.length - p.length);
        changed = true;
        break;
      }
    }
  }
  return t;
}

/** ひらがな/カタカナ→ヘボン式ローマ字（簡易）。辞書に無い語の保険。 */
function toRomaji(input: string): string {
  const map: Record<string, string> = {
    きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
    ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
    ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
    りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
    じゃ: 'ja', じゅ: 'ju', じょ: 'jo', びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
    ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
    あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
    か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
    さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
    た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
    な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
    は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
    ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
    や: 'ya', ゆ: 'yu', よ: 'yo',
    ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
    わ: 'wa', を: 'wo', ん: 'n',
    が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
    ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
    だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
    ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
    ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
    ー: '', っ: '',
  };
  // カタカナをひらがなへ寄せてから変換
  const hira = input.replace(/[\u30a1-\u30f6]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
  let out = '';
  let i = 0;
  while (i < hira.length) {
    const two = hira.slice(i, i + 2);
    const one = hira.slice(i, i + 1);
    if (map[two] !== undefined) {
      out += map[two];
      i += 2;
    } else if (map[one] !== undefined) {
      out += map[one];
      i += 1;
    } else {
      out += one;
      i += 1;
    }
  }
  return out;
}

/** 文字列を kebab-case に正規化 */
function kebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** 自由文 → 英単語トークン列（辞書適用 → 残りはローマ字化） */
function tokenize(text: string): string[] {
  let t = text;
  // 1. 辞書で置換
  for (const [re, en] of DICTIONARY) {
    t = t.replace(re, ` ${en} `);
  }
  // 2. 残った日本語（ひらがな/カタカナ/漢字以外は後で除去）をローマ字化。
  //    かな由来の語は末尾に助詞が残りやすいので剥がす（辞書ヒット語には適用しない）。
  t = t.replace(/[\u3040-\u30ff]+/g, (m) => ` ${stripTrailingParticles(toRomaji(m))} `);
  // 3. 漢字など残る非ASCIIは除去
  t = t.replace(/[^\x00-\x7f]+/g, ' ');

  const raw = t
    .split(/[\s]+/)
    .map((w) => kebab(w))
    .filter((w) => w.length > 0)
    .filter((w) => !STOPWORDS.has(w));

  // 連続重複を除去（cloud cloud → cloud）
  const dedup: string[] = [];
  for (const w of raw) {
    if (dedup[dedup.length - 1] !== w) {
      dedup.push(w);
    }
  }
  return dedup;
}

export interface SlugOptions {
  /** 最大トークン数（長すぎるディレクトリ名を防ぐ） */
  maxTokens?: number;
}

/**
 * 自由文から slug 候補を複数生成する。
 * - 1番目: 全トークン（上限まで）
 * - 2番目: 先頭3トークンに短縮
 * - 3番目: 名詞寄せ（辞書ヒット語＝英数字のみ短語）を優先した短縮版
 */
export function generateSlugCandidates(text: string, opts: SlugOptions = {}): string[] {
  const maxTokens = opts.maxTokens ?? 5;
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return [];
  }

  const candidates: string[] = [];
  const push = (toks: string[]) => {
    const s = toks.slice(0, maxTokens).join('-');
    if (s && !candidates.includes(s)) {
      candidates.push(s);
    }
  };

  push(tokens);
  push(tokens.slice(0, 3));

  // 辞書由来のキーワードを優先的に並べ替えた版
  const known = new Set(
    DICTIONARY.map(([, en]) => en)
  );
  const prioritized = [
    ...tokens.filter((t) => known.has(t)),
    ...tokens.filter((t) => !known.has(t)),
  ];
  push(prioritized);

  return candidates;
}
