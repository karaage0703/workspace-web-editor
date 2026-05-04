#!/usr/bin/env node
import express from 'express';
import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join, dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';

// フロントマター解析
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  
  const yaml = match[1];
  const result = {};
  
  // シンプルなYAML解析（tags, category対応）
  for (const line of yaml.split('\n')) {
    const [key, ...valueParts] = line.split(':');
    if (!key || valueParts.length === 0) continue;
    
    let value = valueParts.join(':').trim();
    
    // 配列形式 [a, b, c] の解析
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(v => v.trim().replace(/['"]/g, ''));
    }
    // リスト形式の解析
    else if (value === '') {
      const listItems = [];
      const lines = yaml.split('\n');
      const keyIndex = lines.findIndex(l => l.startsWith(key + ':'));
      for (let i = keyIndex + 1; i < lines.length; i++) {
        if (lines[i].startsWith('  - ')) {
          listItems.push(lines[i].replace('  - ', '').trim());
        } else if (!lines[i].startsWith(' ')) {
          break;
        }
      }
      if (listItems.length > 0) value = listItems;
    }
    
    result[key.trim()] = value;
  }
  
  return result;
}

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// === Config (env vars) ===
//   PORT             — listen port (default: 9080)
//   WORKSPACE_DIR    — root directory to browse/edit (default: current working dir)
//   EXCLUDE_EXTRA    — comma-separated extra directory names to exclude
//   VIEWABLE_EXT     — comma-separated allowed extensions (override default)
const PORT = parseInt(process.env.PORT || '9080', 10);
const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR || process.cwd());
const PID_FILE = join(__dirname, '.workspace-web-editor.pid');

// 除外パターン（hidden files/dirs は別途 startsWith('.') で除外）
const DEFAULT_EXCLUDES = ['node_modules', '.git', '__pycache__', '.venv', 'venv'];
const EXCLUDE_PATTERNS = [
  ...DEFAULT_EXCLUDES,
  ...(process.env.EXCLUDE_EXTRA || '').split(',').map(s => s.trim()).filter(Boolean)
];

// 対応拡張子
const VIEWABLE_EXTENSIONS = process.env.VIEWABLE_EXT
  ? process.env.VIEWABLE_EXT.split(',').map(s => s.trim()).filter(Boolean).map(s => s.startsWith('.') ? s : '.' + s)
  : ['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.py', '.js', '.ts', '.sh'];

// 拡張子なしでも表示する慣習的なファイル名（OSS リポジトリでよくあるやつ）
const VIEWABLE_BASENAMES = new Set([
  'LICENSE', 'LICENCE', 'README', 'CHANGELOG', 'CHANGES', 'HISTORY',
  'AUTHORS', 'CONTRIBUTORS', 'CONTRIBUTING', 'CODEOWNERS', 'NOTICE',
  'Makefile', 'Dockerfile', 'Procfile'
]);

function isViewable(filename) {
  if (VIEWABLE_EXTENSIONS.some(ext => filename.endsWith(ext))) return true;
  return VIEWABLE_BASENAMES.has(filename);
}

// 二重起動防止
function checkAlreadyRunning() {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    // プロセスが生きているか確認（シグナル0で存在チェック）
    process.kill(pid, 0);
    console.error(`❌ workspace-web-editor is already running (PID: ${pid})`);
    process.exit(1);
  } catch (e) {
    if (e.code === 'ESRCH') {
      // PID file exists but process is dead → ignore (will overwrite)
    } else if (e.code === 'ENOENT') {
      // PID file missing → first launch
    } else {
      throw e;
    }
  }
  writeFileSync(PID_FILE, String(process.pid));
}

checkAlreadyRunning();

// Cleanup PID file on exit
function cleanupSync() {
  try { unlinkSync(PID_FILE); } catch {}
}
process.on('exit', cleanupSync);
process.on('SIGINT', () => { cleanupSync(); process.exit(0); });
process.on('SIGTERM', () => { cleanupSync(); process.exit(0); });

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ===== リンクインデックス（Wiki-link / Markdown link / Backlinks 用） =====
// wikilinksFrom: filePath -> Set<string>  // ファイル内の [[name]] 集合
// mdlinksFrom:   filePath -> Set<string>  // ファイル内の [text](path) を WORKSPACE 相対パスに解決した集合
// fileBaseIndex: baseName(no ext) -> [filePath, ...]  // [[name]] の resolve 用
const wikilinksFrom = new Map();
const mdlinksFrom = new Map();
const fileBaseIndex = new Map();
let linkIndexBuilt = false;

function parseLinks(content) {
  const wikilinks = new Set();
  const mdlinks = new Set();

  // [[name]] / [[name|alias]]（コードブロック内も拾う簡易版）
  const wikiRe = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let m;
  while ((m = wikiRe.exec(content)) !== null) {
    const name = m[1].trim();
    if (name) wikilinks.add(name);
  }

  // [text](path) — 画像 ![...](...) は除外、外部URLも除外
  const mdRe = /(^|[^!])\[([^\]]+)\]\(([^)]+)\)/g;
  while ((m = mdRe.exec(content)) !== null) {
    let url = m[3].trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;  // http:, https:, mailto:, etc.
    url = url.split('#')[0].split('?')[0];
    if (!url) continue;
    mdlinks.add(url);
  }

  return { wikilinks, mdlinks };
}

function resolveMdLinks(sourceRelPath, mdlinks) {
  const fileDir = dirname(sourceRelPath);
  const resolved = new Set();
  for (const url of mdlinks) {
    let p = url.startsWith('/') ? url.slice(1) : join(fileDir, url);
    p = p.replace(/\\/g, '/');
    resolved.add(p);
  }
  return resolved;
}

async function buildLinkIndex() {
  const t0 = Date.now();
  wikilinksFrom.clear();
  mdlinksFrom.clear();
  fileBaseIndex.clear();

  async function scan(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (EXCLUDE_PATTERNS.some(p => entry.name === p) || entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.name.endsWith('.md')) {
        const relPath = relative(WORKSPACE_DIR, fullPath).replace(/\\/g, '/');
        const base = entry.name.replace(/\.md$/, '');
        if (!fileBaseIndex.has(base)) fileBaseIndex.set(base, []);
        fileBaseIndex.get(base).push(relPath);
        try {
          const content = await readFile(fullPath, 'utf-8');
          const { wikilinks, mdlinks } = parseLinks(content);
          if (wikilinks.size) wikilinksFrom.set(relPath, wikilinks);
          if (mdlinks.size) mdlinksFrom.set(relPath, resolveMdLinks(relPath, mdlinks));
        } catch (e) { /* ignore */ }
      }
    }
  }

  await scan(WORKSPACE_DIR);
  linkIndexBuilt = true;
  const ms = Date.now() - t0;
  console.log(`📑 Link index built in ${ms}ms: ${wikilinksFrom.size} wiki-link sources, ${mdlinksFrom.size} md-link sources, ${fileBaseIndex.size} unique basenames`);
}

async function updateLinkIndex(relPath) {
  if (!relPath.endsWith('.md')) return;
  relPath = relPath.replace(/\\/g, '/');
  const fullPath = join(WORKSPACE_DIR, relPath);
  // basename index 更新
  const base = relPath.split('/').pop().replace(/\.md$/, '');
  const arr = fileBaseIndex.get(base) || [];
  if (!arr.includes(relPath)) {
    arr.push(relPath);
    fileBaseIndex.set(base, arr);
  }
  try {
    const content = await readFile(fullPath, 'utf-8');
    const { wikilinks, mdlinks } = parseLinks(content);
    if (wikilinks.size) wikilinksFrom.set(relPath, wikilinks);
    else wikilinksFrom.delete(relPath);
    if (mdlinks.size) mdlinksFrom.set(relPath, resolveMdLinks(relPath, mdlinks));
    else mdlinksFrom.delete(relPath);
  } catch (e) { /* ignore */ }
}

// ディレクトリを読み込み
async function getFilesRecursive(dir, baseDir = WORKSPACE_DIR) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(baseDir, fullPath);
    
    // 除外パターンをスキップ
    if (EXCLUDE_PATTERNS.some(p => entry.name === p || entry.name.startsWith('.'))) {
      continue;
    }
    
    if (entry.isDirectory()) {
      files.push({
        name: entry.name,
        path: relativePath,
        type: 'directory'
      });
    } else if (isViewable(entry.name)) {
      const stats = await stat(fullPath);
      const fileInfo = {
        name: entry.name,
        path: relativePath,
        type: 'file',
        mtime: stats.mtime
      };
      
      // .mdファイルはフロントマター解析
      if (entry.name.endsWith('.md')) {
        try {
          const content = await readFile(fullPath, 'utf-8');
          const frontmatter = parseFrontmatter(content);
          if (frontmatter.tags) fileInfo.tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags];
          if (frontmatter.category) fileInfo.category = frontmatter.category;
        } catch (e) { /* ignore */ }
      }
      
      files.push(fileInfo);
    }
  }
  
  return files;
}

// ファイル一覧取得（ディレクトリ指定可能）
app.get('/api/files', async (req, res) => {
  try {
    const subdir = req.query.dir || '';
    const sortBy = req.query.sort || 'name'; // 'name' or 'mtime'
    const order = req.query.order || 'asc'; // 'asc' or 'desc'
    const tagFilter = req.query.tag || '';
    const targetDir = join(WORKSPACE_DIR, subdir);
    
    // ディレクトリトラバーサル防止
    if (!targetDir.startsWith(WORKSPACE_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    let files = await getFilesRecursive(targetDir);
    
    // タグフィルター
    if (tagFilter) {
      files = files.filter(f => f.type === 'directory' || (f.tags && f.tags.includes(tagFilter)));
    }
    
    // ソート
    files = files.sort((a, b) => {
      // ディレクトリ優先
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      
      let result;
      if (sortBy === 'name') {
        result = a.name.localeCompare(b.name);
      } else {
        // 更新日時順
        if (a.type === 'file') {
          result = new Date(a.mtime) - new Date(b.mtime);
        } else {
          result = a.name.localeCompare(b.name);
        }
      }
      return order === 'desc' ? -result : result;
    });
    
    res.json({ currentDir: subdir || '/', files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 全ファイル平坦リスト（Quick switcher 用）
app.get('/api/all-files', async (req, res) => {
  try {
    const allFiles = [];
    async function scan(dir) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (EXCLUDE_PATTERNS.some(p => entry.name === p) || entry.name.startsWith('.')) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (isViewable(entry.name)) {
          let mtime;
          try { mtime = (await stat(fullPath)).mtime; } catch { continue; }
          allFiles.push({
            name: entry.name,
            path: relative(WORKSPACE_DIR, fullPath).replace(/\\/g, '/'),
            mtime
          });
        }
      }
    }
    await scan(WORKSPACE_DIR);
    allFiles.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(allFiles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// バックリンク取得（Wiki-link + Markdown link の双方）
app.get('/api/backlinks', (req, res) => {
  if (!linkIndexBuilt) return res.json({ ready: false, links: [] });
  const target = (req.query.path || '').replace(/\\/g, '/');
  if (!target) return res.status(400).json({ error: 'path required' });
  const targetBase = target.split('/').pop().replace(/\.md$/, '');
  const map = new Map(); // source -> type ('wiki' | 'md' | 'both')

  for (const [src, names] of wikilinksFrom.entries()) {
    if (src === target) continue;
    if (names.has(targetBase)) map.set(src, 'wiki');
  }
  for (const [src, paths] of mdlinksFrom.entries()) {
    if (src === target) continue;
    if (paths.has(target)) {
      map.set(src, map.has(src) ? 'both' : 'md');
    }
  }

  const links = [...map.entries()]
    .map(([source, type]) => ({ source, type }))
    .sort((a, b) => a.source.localeCompare(b.source));
  res.json({ ready: true, target, links });
});

// Wiki-link 名解決: [[name]] のクリック時に呼ばれる
app.get('/api/resolve', (req, res) => {
  if (!linkIndexBuilt) return res.json({ ready: false, matches: [] });
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  const matches = fileBaseIndex.get(name) || [];
  res.json({ ready: true, name, matches });
});

// ファイル読み込み
app.get('/api/files/*', async (req, res) => {
  try {
    const filePath = req.params[0];
    const fullPath = join(WORKSPACE_DIR, filePath);
    
    // ディレクトリトラバーサル防止
    if (!fullPath.startsWith(WORKSPACE_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const content = await readFile(fullPath, 'utf-8');
    res.json({ path: filePath, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ファイル保存
app.put('/api/files/*', async (req, res) => {
  try {
    const filePath = req.params[0];
    const fullPath = join(WORKSPACE_DIR, filePath);
    
    // ディレクトリトラバーサル防止
    if (!fullPath.startsWith(WORKSPACE_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const { content } = req.body;
    await writeFile(fullPath, content, 'utf-8');
    // 保存後にリンクインデックスを更新（.md のみ対象）
    updateLinkIndex(filePath).catch(() => {});
    res.json({ success: true, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// タグ一覧取得
app.get('/api/tags', async (req, res) => {
  try {
    const tags = new Map();
    
    async function scanDir(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (EXCLUDE_PATTERNS.some(p => entry.name === p || entry.name.startsWith('.'))) continue;
        
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.name.endsWith('.md')) {
          try {
            const content = await readFile(fullPath, 'utf-8');
            const frontmatter = parseFrontmatter(content);
            if (frontmatter.tags) {
              const fileTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags];
              for (const tag of fileTags) {
                tags.set(tag, (tags.get(tag) || 0) + 1);
              }
            }
          } catch (e) { /* ignore */ }
        }
      }
    }
    
    await scanDir(WORKSPACE_DIR);
    
    const sortedTags = [...tags.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));
    
    res.json(sortedTags);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git sync
app.post('/api/sync', async (req, res) => {
  try {
    await execAsync(`cd ${WORKSPACE_DIR} && git pull && git add -A && git commit -m "Sync from workspace-web-editor" && git push`, {
      timeout: 30000
    });
    res.json({ success: true });
  } catch (err) {
    // コミットするものがない場合もエラーになるが成功扱い
    if (err.message.includes('nothing to commit')) {
      res.json({ success: true, message: 'Already up to date' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📁 workspace-web-editor running at http://localhost:${PORT}`);
  console.log(`📂 Workspace : ${WORKSPACE_DIR}`);
  console.log(`🚫 Excludes  : ${EXCLUDE_PATTERNS.join(', ')}`);
  console.log(`📄 Extensions: ${VIEWABLE_EXTENSIONS.join(' ')}`);
  // Build link index asynchronously so the server is responsive immediately
  buildLinkIndex().catch(e => console.error('Link index build failed:', e));
});
