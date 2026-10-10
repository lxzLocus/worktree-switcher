# Worktree Switcher

Workspace配下のリポジトリから git worktree を切り出し、別ウィンドウで開く VS Code / Kiro 拡張。

worktree は `<Workspace>/.worktrees/<repo>/<name>` に集約されます。本体ディレクトリと
交互に並ばないので、Workspace直下は本体リポジトリだけでスッキリします。

```
Workspace/
  service-app/                ← 本体（基準点・main）
  config-repo/                ← 本体
  .worktrees/                 ← 隠しディレクトリに全worktreeを集約
    service-app/
      260427_feature-demo/     ← 作業用worktree（ディレクトリ名は YYMMDD_<name>）
    config-repo/
      ...
```

## コマンド（コマンドパレット `Cmd+Shift+P`）

- **Worktree: Create**
  1. 「やりたいこと」を入力（日本語OK。例: `新しい機能の検証を進めたい`）
  2. ルールベース生成されたslug候補を選ぶ（例: `feature-validation-review`）。または「自分で入力」
  3. 最終確認で名前を微調整
  4. `.worktrees/<repo>/<YYMMDD>_<name>` に worktree を作成（元ブランチは `origin/main` / `origin/master` を自動判定）
     - ディレクトリ名には作成日プレフィックス `YYMMDD_` が付きます。ブランチ名は日付なし（`<name>`）です。
  5. 「開く」で別ウィンドウ起動
  - 集約ディレクトリが無ければ自動で `mkdir -p` されるので、cloneした直後のリポジトリでもそのまま使えます。
- **Worktree: List / Open** — 全worktreeを一覧し、選んで別ウィンドウで開く
- **Worktree: Remove** — worktreeを選んで削除（本体は対象外・確認あり・未コミット時は強制削除を案内）

## サイドバー一覧

Activity Bar の Worktree アイコンから、Workspace 全体の `.worktrees/<repo>/<name>` を横断表示します。

- 各項目に **最終コミットからの経過時間**（例: `3 days ago`）を表示
- **未コミットの変更がある** worktree には `●` バッジと色付きアイコン
- タイトルバーのボタンで **並び順を切替**:
  - グループ表示（リポジトリごと）
  - 日付表示（全リポジトリ混在・新しい順）
- 自動更新トリガー: `.worktrees` 配下の作成/削除を検知、ウィンドウにフォーカスが戻ったとき。
  手動更新は Refresh ボタン。

## 設定

| 設定 | 既定 | 説明 |
|---|---|---|
| `worktreeSwitcher.centralDirName` | `.worktrees` | worktreeを集約する中央ディレクトリ名 |
| `worktreeSwitcher.openInNewWindow` | `true` | 作成/選択後に別ウィンドウで開くか |

## slug生成について

日本語→英語の変換はローカルのルールベース（`src/slug.ts` の辞書）です。APIキー・ネットワーク不要。
辞書に無い語はローマ字化、漢字は除去されます。訳されない語が出たら `DICTIONARY` に1行足せば
次から対応できます。

## 開発

```
npm install
npm run compile      # ビルド
npm run package      # .vsix 作成（要 @vscode/vsce）
```

今後の予定は TODO.md を参照。
