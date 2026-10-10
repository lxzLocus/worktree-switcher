# TODO

## 複数リポジトリ横断 / マルチルートワークスペース対応（後回し）

複数リポジトリを同時に触るタスク（例: service-app と config-repo をまたぐ変更）で、 VS Code が全部を横断参照できるようにしたい。別ウィンドウだと横断できない。

VS Code の「マルチルートワークスペース」を使えば、1ウィンドウに複数フォルダを束ねて
開ける。拡張からは `vscode.workspace.updateWorkspaceFolders()` でウィンドウを開き直さず
現在のワークスペースにフォルダを追加できる。

### やること候補

- [ ] `Worktree: Create` に「開き方」の選択を追加
  - A. 別ウィンドウで開く（現状の挙動）
  - B. 今のウィンドウにフォルダ追加（マルチルート。Kiroに全部見せたいとき）
  - 設定案: `worktreeSwitcher.openMode: "newWindow" | "addToWorkspace"`（既定は newWindow）
- [ ] `Worktree: List / Open` にも「追加で開く(addToWorkspace)」の選択肢を足す
- [ ] （検討）関連リポジトリをまとめて開くコマンド。「どのrepoが関連か」の定義が必要なので
  やりすぎかもしれない。一旦スコープ外。
- [ ] （検討）`.code-workspace` ファイルを生成/保存して、よく使う組み合わせを使い回せるように。

### 実装メモ

- `vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...folders)` で追加/削除。
  - 単一フォルダのウィンドウに2つ目を足すと、暗黙に無題のマルチルートWSになる。
  - 追加時は `{ uri: vscode.Uri.file(path), name: label }` を渡す。
- 既にワークスペースに入っているフォルダは重複追加しない（事前にチェック）。
