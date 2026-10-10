import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as util from 'util';
import * as fs from 'fs';
import { generateSlugCandidates } from './slug';

const execAsync = util.promisify(exec);

/** 設定値の取得ヘルパー */
function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('worktreeSwitcher').get<T>(key, fallback);
}

/** 指定ディレクトリで git コマンドを実行 */
async function git(cwd: string, args: string): Promise<string> {
  const { stdout } = await execAsync(`git ${args}`, { cwd, maxBuffer: 1024 * 1024 * 10 });
  return stdout.trim();
}

/** 拡張のコンテキスト（最近使ったリポジトリの記憶などに使う） */
let extensionContext: vscode.ExtensionContext | undefined;
const RECENT_REPO_KEY = 'worktreeSwitcher.recentRepo';

/**
 * 任意のパスから git 本体リポジトリのルートを解決する。
 * worktreeやサブディレクトリから実行しても、--git-common-dir で本体に辿り着く。
 * gitリポジトリでなければ undefined。
 */
async function gitTopFrom(fsPath: string): Promise<string | undefined> {
  try {
    const commonDir = await git(fsPath, 'rev-parse --path-format=absolute --git-common-dir');
    // commonDir は <repo>/.git（本体）を指すので、その親が本体ルート。
    return path.dirname(commonDir);
  } catch {
    return undefined;
  }
}

/** フォルダ選択ダイアログを出し、選ばれたフォルダから git 本体を解決する */
async function pickRepoViaDialog(): Promise<string | undefined> {
  const recent = extensionContext?.globalState.get<string>(RECENT_REPO_KEY);
  const defaultUri = recent ? vscode.Uri.file(path.dirname(recent)) : undefined;

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'このリポジトリを使う',
    title: 'worktreeの元になるリポジトリフォルダを選択',
    defaultUri,
  });
  if (!picked || picked.length === 0) {
    return undefined;
  }
  const repo = await gitTopFrom(picked[0].fsPath);
  if (!repo) {
    vscode.window.showErrorMessage(`gitリポジトリではありません: ${picked[0].fsPath}`);
    return undefined;
  }
  await extensionContext?.globalState.update(RECENT_REPO_KEY, repo);
  return repo;
}

/**
 * worktreeの「元」になるリポジトリ本体のパスを決める。
 * 優先順位:
 *   1. 開いているワークスペースフォルダ（git repoのもの）。複数あれば選択。
 *   2. どれもgit repoでない / 何も開いていない → フォルダ選択ダイアログ（Finder）。
 * @param forcePick true のときは常にフォルダ選択ダイアログを出す（GUIの「リポジトリを選ぶ」用）。
 * @param noDialog  true のときはダイアログを出さず、未解決なら undefined を返す（ツリー表示用）。
 */
async function resolveMainRepo(
  forcePick = false,
  noDialog = false
): Promise<string | undefined> {
  if (forcePick) {
    return pickRepoViaDialog();
  }

  const folders = vscode.workspace.workspaceFolders ?? [];

  // 開いているフォルダのうち git repo のものを集める
  const repoCandidates: { label: string; fsPath: string; repo: string }[] = [];
  for (const f of folders) {
    const repo = await gitTopFrom(f.uri.fsPath);
    if (repo) {
      repoCandidates.push({ label: f.name, fsPath: f.uri.fsPath, repo });
    }
  }

  // 重複（同じ本体を指す複数フォルダ）を除去
  const uniqueRepos = Array.from(new Set(repoCandidates.map((c) => c.repo)));

  if (uniqueRepos.length === 1) {
    return uniqueRepos[0];
  }

  if (uniqueRepos.length > 1) {
    if (noDialog) {
      // ツリー表示では最初の候補を黙って使う
      return uniqueRepos[0];
    }
    const pick = await vscode.window.showQuickPick(
      [
        ...uniqueRepos.map((r) => ({ label: path.basename(r), description: r, repo: r })),
        { label: '$(folder-opened) 別のフォルダを選択...', description: '', repo: '' },
      ],
      { placeHolder: 'どのリポジトリから操作しますか？' }
    );
    if (!pick) {
      return undefined;
    }
    return pick.repo ? pick.repo : pickRepoViaDialog();
  }

  // 開いているフォルダに git repo が無い
  if (noDialog) {
    // 直近に使ったrepoがあればそれを表示に使う
    return extensionContext?.globalState.get<string>(RECENT_REPO_KEY);
  }
  return pickRepoViaDialog();
}

/** origin/main と origin/master のどちらが存在するかを判定し、ベースref名を返す */
async function detectBaseRef(repo: string): Promise<string> {
  for (const ref of ['origin/main', 'origin/master']) {
    try {
      await git(repo, `rev-parse --verify --quiet ${ref}`);
      return ref;
    } catch {
      // 次を試す
    }
  }
  // どちらも無ければ現在のHEADを使う
  return 'HEAD';
}

/**
 * worktree集約ディレクトリのパス（案2: central方式）。
 * 本体が <Workspace>/<repo> のとき、worktreeは <Workspace>/<centralDir>/<repo>/ に集約する。
 * 例: /ws/project-main -> /ws/.worktrees/project-main
 * このディレクトリが無い場合（新規cloneした直後など）は作成側で mkdir -p する。
 */
function worktreesDir(repo: string): string {
  const centralDir = cfg('centralDirName', '.worktrees');
  const parent = path.dirname(repo); // = Workspace
  const repoName = path.basename(repo); // = project-main
  return path.join(parent, centralDir, repoName);
}

/** 新しいウィンドウ(設定次第)でフォルダを開く */
async function openFolder(fsPath: string) {
  const newWindow = cfg('openInNewWindow', true);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(fsPath), {
    forceNewWindow: newWindow,
  });
}

/** 入力名をディレクトリ/ブランチに使える形へ正規化 */
function sanitizeName(input: string): string {
  return input.trim().replace(/\s+/g, '-');
}

/** 今日の日付を YYMMDD で返す（ローカルタイム） */
function todayYYMMDD(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * worktree名を決める2段フロー:
 *  1. 「やりたいこと」を自由文(日本語可)で入力
 *  2. ルールベース生成のslug候補をQuickPickで提示（+自分で入力）
 *  3. 選んだ候補を最終編集できる
 * 空入力なら従来どおり直接名前入力にフォールバック。
 */
async function pickWorktreeName(repoName: string): Promise<string | undefined> {
  const intent = await vscode.window.showInputBox({
    title: `Worktree作成 (${repoName}) 1/2`,
    prompt: 'やりたいことを入力 (日本語OK)。空のままEnterで名前を直接入力。',
    placeHolder: '例: 新しい機能の検証を進めたい',
  });
  if (intent === undefined) {
    return undefined; // Escでキャンセル
  }

  let chosen: string | undefined;

  if (intent.trim().length > 0) {
    const candidates = generateSlugCandidates(intent);
    const items: vscode.QuickPickItem[] = candidates.map((c) => ({
      label: c,
      description: 'ルールベース生成',
    }));
    items.push({ label: '$(edit) 自分で入力する', description: '', alwaysShow: true });

    const pick = await vscode.window.showQuickPick(items, {
      title: `Worktree作成 (${repoName}) 2/2`,
      placeHolder:
        candidates.length > 0 ? 'ディレクトリ名/ブランチ名の候補を選択' : '候補なし。自分で入力してください。',
    });
    if (!pick) {
      return undefined;
    }
    if (!pick.label.startsWith('$(edit)')) {
      chosen = pick.label;
    }
  }

  // 候補未選択 or 「自分で入力」 or やりたいこと空 → 直接入力（chosenがあれば初期値に）
  const edited = await vscode.window.showInputBox({
    title: `Worktree作成 (${repoName}) 最終確認`,
    prompt: 'ブランチ名 / ディレクトリ名を確認・編集',
    value: chosen ?? '',
    placeHolder: 'feature-validation-review',
    validateInput: (v) => (v.trim().length === 0 ? '名前を入力してください' : undefined),
  });
  if (!edited) {
    return undefined;
  }
  return sanitizeName(edited);
}

/**
 * Worktree: Create
 * @param repoArg   明示的に使うリポジトリ本体パス（ツリーのコンテキストメニューなどから）
 * @param forcePick true のとき、常にフォルダ選択ダイアログでリポジトリを選ばせる
 */
async function createWorktree(repoArg?: string, forcePick = false) {
  const repo = repoArg ?? (await resolveMainRepo(forcePick));
  if (!repo) {
    return;
  }
  // 使ったリポジトリを記憶（次回ダイアログのデフォルトに）
  await extensionContext?.globalState.update(RECENT_REPO_KEY, repo);

  const repoName = path.basename(repo);

  const name = await pickWorktreeName(repoName);
  if (!name) {
    return;
  }
  // ディレクトリ名は作成日プレフィックス付き（YYMMDD_<name>）。ブランチ名は日付なし。
  // ブランチ名の "/"（chore/xxx 等）はディレクトリのネストを起こすので "-" に置換する。
  const dirName = `${todayYYMMDD()}_${name.replace(/[\\/]+/g, '-')}`;
  const destDir = path.join(worktreesDir(repo), dirName);
  const baseRef = await detectBaseRef(repo);

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `worktree作成中: ${dirName}` },
      async () => {
        // 集約ディレクトリ <Workspace>/.worktrees/<repo> を事前作成。
        // 新規cloneした直後で .worktrees/<repo> が無くても、ここで作られる。
        await fs.promises.mkdir(worktreesDir(repo), { recursive: true });
        // 既存ブランチと衝突する場合に備えて -b で新規作成。失敗時はフォールバック。
        try {
          await git(repo, `worktree add -b "${name}" "${destDir}" "${baseRef}"`);
        } catch (e) {
          // ブランチが既に存在する場合は -b なしで既存ブランチをチェックアウト
          await git(repo, `worktree add "${destDir}" "${name}"`);
        }
      }
    );
  } catch (e: any) {
    vscode.window.showErrorMessage(`worktree作成に失敗: ${e.message ?? e}`);
    return;
  }

  const centralDir = cfg('centralDirName', '.worktrees');
  const openIt = await vscode.window.showInformationMessage(
    `worktreeを作成しました: ${centralDir}/${repoName}/${dirName} (branch: ${name}, base: ${baseRef})`,
    '開く',
    '閉じる'
  );
  if (openIt === '開く') {
    await openFolder(destDir);
  }
}

type WorktreeEntry = { worktree: string; branch?: string; head?: string };

/** `git worktree list --porcelain` をパース */
function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) {
        entries.push(cur);
      }
      cur = { worktree: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line.startsWith('HEAD ') && cur) {
      cur.head = line.slice('HEAD '.length).slice(0, 9);
    }
  }
  if (cur) {
    entries.push(cur);
  }
  return entries;
}

/** Worktree: List / Open */
async function listWorktrees() {
  const repo = await resolveMainRepo();
  if (!repo) {
    return;
  }
  const porcelain = await git(repo, 'worktree list --porcelain');
  const entries = parseWorktrees(porcelain);

  const items = entries.map((e) => ({
    label: path.basename(e.worktree),
    description: e.branch ? `[${e.branch}]` : `(detached ${e.head ?? ''})`,
    detail: e.worktree,
    fsPath: e.worktree,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: '開くworktreeを選択',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) {
    return;
  }
  await openFolder(pick.fsPath);
}

/**
 * Worktree: Remove
 * ツリー項目から呼ばれた場合は arg にそのノードが渡る。GUI/コマンドパレット両対応。
 */
async function removeWorktree(arg?: WorktreeNode) {
  let targetPath: string | undefined;
  let targetLabel: string | undefined;
  let repo: string | undefined;

  if (arg && arg.fsPath) {
    // ツリーの削除アクションから呼ばれた
    repo = arg.repoPath ?? (await gitTopFrom(arg.fsPath));
    if (repo && path.resolve(arg.fsPath) === path.resolve(repo)) {
      vscode.window.showWarningMessage('本体リポジトリは削除できません。');
      return;
    }
    targetPath = arg.fsPath;
    targetLabel = path.basename(arg.fsPath);
  } else {
    // コマンドパレットから：QuickPickで選ばせる
    repo = await resolveMainRepo();
    if (!repo) {
      return;
    }
    const porcelain = await git(repo, 'worktree list --porcelain');
    const entries = parseWorktrees(porcelain);
    const removable = entries.filter((e) => path.resolve(e.worktree) !== path.resolve(repo!));
    const items = removable.map((e) => ({
      label: path.basename(e.worktree),
      description: e.branch ? `[${e.branch}]` : `(detached ${e.head ?? ''})`,
      detail: e.worktree,
      fsPath: e.worktree,
    }));
    if (items.length === 0) {
      vscode.window.showInformationMessage('削除可能なworktreeがありません。');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: '削除するworktreeを選択',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick) {
      return;
    }
    targetPath = pick.fsPath;
    targetLabel = pick.label;
  }

  if (!repo || !targetPath) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `worktreeを削除しますか？\n${targetPath}`,
    { modal: true },
    '削除',
    '強制削除 (未コミット変更も破棄)'
  );
  if (!confirm) {
    return;
  }

  try {
    const force = confirm.startsWith('強制') ? ' --force' : '';
    await git(repo, `worktree remove${force} "${targetPath}"`);
    vscode.window.showInformationMessage(`削除しました: ${targetLabel}`);
  } catch (e: any) {
    const retry = await vscode.window.showErrorMessage(
      `削除に失敗: ${e.message ?? e}\n未コミットの変更がある場合は強制削除が必要です。`,
      '強制削除'
    );
    if (retry === '強制削除') {
      await git(repo, `worktree remove --force "${targetPath}"`);
      vscode.window.showInformationMessage(`強制削除しました: ${targetLabel}`);
    }
  }
  worktreeTreeProvider?.refresh();
}

// ============================================================
// サイドバー（Activity Bar）用 TreeView
//  - Workspace 全体の <centralDir>/<repo>/<name> を横断表示
//  - ソートモード: group（リポジトリごと） / date（全部混ぜて新しい順）
// ============================================================

const SORT_MODE_KEY = 'worktreeSwitcher.sortMode';
type SortMode = 'group' | 'date';

/** 相対時間 "3 days ago" を作る（秒単位のUNIX時刻 or null） */
function relativeTime(epochSec: number | null): string {
  if (!epochSec) {
    return 'no commits';
  }
  const diff = Math.floor(Date.now() / 1000) - epochSec;
  if (diff < 60) {
    return 'just now';
  }
  const units: [number, string][] = [
    [60, 'sec'],
    [60, 'min'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Number.MAX_SAFE_INTEGER, 'year'],
  ];
  let v = diff;
  let unit = 'sec';
  for (let i = 0; i < units.length; i++) {
    const [size, name] = units[i];
    if (v < size) {
      unit = name;
      break;
    }
    v = Math.floor(v / size);
    unit = units[i + 1] ? units[i + 1][1] : name;
  }
  return `${v} ${unit}${v === 1 ? '' : 's'} ago`;
}

/** 1つのworktreeの収集情報 */
interface WtInfo {
  fsPath: string;
  repoPath: string;
  repoName: string;
  name: string;
  branch?: string;
  lastCommitEpoch: number | null;
  dirty: boolean;
}

/** Workspace ルート（.worktrees の置き場所）を推定する */
function detectWorkspaceRoot(): string | undefined {
  const centralDir = cfg('centralDirName', '.worktrees');
  const folders = vscode.workspace.workspaceFolders ?? [];

  for (const f of folders) {
    let dir = f.uri.fsPath;
    // 開いているフォルダ自身やその祖先に <centralDir> があればその親をルートとする
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, centralDir))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  // フォールバック: 最初に開いているフォルダの親（本体が <root>/<repo> 前提）
  if (folders.length > 0) {
    return path.dirname(folders[0].uri.fsPath);
  }
  // さらにフォールバック: 直近で使ったrepoの親
  const recent = extensionContext?.globalState.get<string>(RECENT_REPO_KEY);
  return recent ? path.dirname(recent) : undefined;
}

/** <root>/<centralDir>/<repo>/<name> を全走査して WtInfo[] を返す */
async function scanWorktrees(): Promise<WtInfo[]> {
  const root = detectWorkspaceRoot();
  if (!root) {
    return [];
  }
  const centralDir = cfg('centralDirName', '.worktrees');
  const base = path.join(root, centralDir);
  if (!fs.existsSync(base)) {
    return [];
  }

  const result: WtInfo[] = [];
  let repoDirs: string[] = [];
  try {
    repoDirs = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const repoName of repoDirs) {
    const repoWtDir = path.join(base, repoName);
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(repoWtDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const wtPath = path.join(repoWtDir, name);
      // git repo でなければスキップ
      let branch: string | undefined;
      let lastCommitEpoch: number | null = null;
      let dirty = false;
      try {
        branch = (await git(wtPath, 'branch --show-current')) || undefined;
        const ts = await git(wtPath, 'log -1 --format=%ct').catch(() => '');
        lastCommitEpoch = ts ? parseInt(ts, 10) : null;
        const status = await git(wtPath, 'status --porcelain').catch(() => '');
        dirty = status.trim().length > 0;
      } catch {
        // .git が無い等 → それでも項目としては出す（情報なし）
      }
      result.push({
        fsPath: wtPath,
        repoPath: path.join(root, repoName),
        repoName,
        name,
        branch,
        lastCommitEpoch,
        dirty,
      });
    }
  }
  return result;
}

/** ツリーのノード種別 */
type TreeNode = RepoGroupNode | WorktreeNode;

/** リポジトリのグループ見出し（group モード時のみ） */
class RepoGroupNode extends vscode.TreeItem {
  constructor(public readonly repoName: string, public readonly children: WtInfo[]) {
    super(repoName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'repoGroup';
    this.iconPath = new vscode.ThemeIcon('repo');
    this.description = `${children.length}`;
  }
}

/** ツリーの1項目（worktree） */
class WorktreeNode extends vscode.TreeItem {
  constructor(public readonly info: WtInfo, showRepo: boolean) {
    super(info.name, vscode.TreeItemCollapsibleState.None);

    const rel = relativeTime(info.lastCommitEpoch);
    // description: [branch] · 3 days ago （date モードでは repo名も前置）
    const parts: string[] = [];
    if (showRepo) {
      parts.push(info.repoName);
    }
    if (info.branch) {
      parts.push(info.branch);
    }
    parts.push(rel);
    this.description = parts.join('  ·  ');

    this.tooltip =
      `${info.fsPath}\n` +
      `repo: ${info.repoName}\n` +
      `branch: ${info.branch ?? '(none)'}\n` +
      `last commit: ${rel}\n` +
      `status: ${info.dirty ? 'uncommitted changes' : 'clean'}`;

    this.resourceUri = vscode.Uri.file(info.fsPath);
    this.contextValue = 'worktree';
    // dirty なら目立つアイコン、clean は通常のブランチアイコン
    this.iconPath = info.dirty
      ? new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'))
      : new vscode.ThemeIcon('git-branch');
    // dirty バッジ
    if (info.dirty) {
      this.description = '● ' + this.description;
    }
    this.command = {
      command: 'worktreeSwitcher.openNode',
      title: 'Open',
      arguments: [this],
    };
  }

  get fsPath(): string {
    return this.info.fsPath;
  }
  get repoPath(): string {
    return this.info.repoPath;
  }
}

class WorktreeTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private cache: WtInfo[] | undefined;

  refresh(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire();
  }

  getSortMode(): SortMode {
    return extensionContext?.globalState.get<SortMode>(SORT_MODE_KEY) ?? 'group';
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  private async getAll(): Promise<WtInfo[]> {
    if (!this.cache) {
      this.cache = await scanWorktrees();
    }
    return this.cache;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    const mode = this.getSortMode();
    const all = await this.getAll();

    // date モード: フラットに新しい順
    if (mode === 'date') {
      if (element) {
        return [];
      }
      const sorted = [...all].sort(
        (a, b) => (b.lastCommitEpoch ?? 0) - (a.lastCommitEpoch ?? 0)
      );
      return sorted.map((i) => new WorktreeNode(i, true));
    }

    // group モード: repo 見出し → worktree
    if (!element) {
      const byRepo = new Map<string, WtInfo[]>();
      for (const i of all) {
        const arr = byRepo.get(i.repoName) ?? [];
        arr.push(i);
        byRepo.set(i.repoName, arr);
      }
      const groups = [...byRepo.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([repoName, children]) => {
          // グループ内は新しい順
          children.sort((x, y) => (y.lastCommitEpoch ?? 0) - (x.lastCommitEpoch ?? 0));
          return new RepoGroupNode(repoName, children);
        });
      return groups;
    }
    if (element instanceof RepoGroupNode) {
      return element.children.map((i) => new WorktreeNode(i, false));
    }
    return [];
  }
}

let worktreeTreeProvider: WorktreeTreeProvider | undefined;

/** ツリー項目クリック/コンテキストから「開く」 */
async function openNode(arg?: WorktreeNode) {
  if (arg && arg.fsPath) {
    await openFolder(arg.fsPath);
  } else {
    await listWorktrees();
  }
}

/** ソートモードを切り替えて context key を更新（ボタンのアイコン出し分け用） */
async function toggleSortMode() {
  const cur = worktreeTreeProvider?.getSortMode() ?? 'group';
  const next: SortMode = cur === 'group' ? 'date' : 'group';
  await extensionContext?.globalState.update(SORT_MODE_KEY, next);
  await vscode.commands.executeCommand('setContext', 'worktreeSwitcher.sortMode', next);
  worktreeTreeProvider?.refresh();
  vscode.window.showInformationMessage(
    `並び順: ${next === 'group' ? 'リポジトリごと' : '日付（新しい順）'}`
  );
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  worktreeTreeProvider = new WorktreeTreeProvider();

  // 現在のソートモードを context key に反映（タイトルボタンの出し分け）
  vscode.commands.executeCommand(
    'setContext',
    'worktreeSwitcher.sortMode',
    worktreeTreeProvider.getSortMode()
  );

  // 自動更新トリガー: Workspace の .worktrees 配下の変更を監視（軽量）
  const watcher = vscode.workspace.createFileSystemWatcher('**/.worktrees/**');
  const onChange = () => worktreeTreeProvider?.refresh();
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);

  // ウィンドウにフォーカスが戻ったら更新（他worktreeで作業後に戻ってきた時）
  const focusSub = vscode.window.onDidChangeWindowState((st) => {
    if (st.focused) {
      worktreeTreeProvider?.refresh();
    }
  });

  context.subscriptions.push(
    worktreeTreeProvider as any,
    watcher,
    focusSub,
    vscode.window.registerTreeDataProvider('worktreeSwitcherView', worktreeTreeProvider),
    vscode.commands.registerCommand('worktreeSwitcher.create', async () => {
      await createWorktree();
      worktreeTreeProvider?.refresh();
    }),
    vscode.commands.registerCommand('worktreeSwitcher.createFromFolder', async () => {
      await createWorktree(undefined, true);
      worktreeTreeProvider?.refresh();
    }),
    vscode.commands.registerCommand('worktreeSwitcher.list', listWorktrees),
    vscode.commands.registerCommand('worktreeSwitcher.remove', removeWorktree),
    vscode.commands.registerCommand('worktreeSwitcher.openNode', openNode),
    vscode.commands.registerCommand('worktreeSwitcher.refresh', () =>
      worktreeTreeProvider?.refresh()
    ),
    vscode.commands.registerCommand('worktreeSwitcher.sortByGroup', () => toggleSortMode()),
    vscode.commands.registerCommand('worktreeSwitcher.sortByDate', () => toggleSortMode())
  );
}

export function deactivate() {}
