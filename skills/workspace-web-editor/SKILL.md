---
name: workspace-web-editor
description: ブラウザからローカルのワークスペース（Markdown / コード / フロントマター）を閲覧・編集する軽量 Web アプリ。Wiki-link / Backlinks / Quick Switcher / Mermaid / ライト・ダークテーマ対応。「workspace-web-editor 起動して」「web editor で開いて」で使用。
---

# workspace-web-editor

ローカルのワークスペースをブラウザから閲覧・編集する Node.js 製の軽量 Web アプリ。
任意で Tailscale や VPN 越しにスマホから使うこともできる。

## 機能

- ディレクトリツリー + パンくず + タグフィルター
- Markdown プレビュー（Mermaid 図 + シンタックスハイライト）
- Wiki-link `[[name]]` クリック遷移（broken は点線）
- Backlinks — どこから参照されているかを一覧表示
- Quick Switcher（`Cmd/Ctrl+P`）でファジー検索
- ライト / ダークテーマ切替（永続化）
- 編集 + `Ctrl+S` 保存
- フロントマター解析
- 任意の Git sync（pull → add → commit → push）

## セットアップ

このスキルを `gh skill install` で取り込んだ場合、アプリ本体は別途 clone する。

```bash
git clone https://github.com/karaage0703/workspace-web-editor.git
cd workspace-web-editor
npm install
```

既にチェックアウト済みの場合は、そのディレクトリを使う。

## 起動方法

以下、`<repo>` は `workspace-web-editor` のチェックアウトディレクトリ、`<workspace>` は閲覧したいワークスペースの絶対パスとする。

```bash
cd <repo>
WORKSPACE_DIR=<workspace> PORT=9080 node src/server.js
```

バックグラウンド起動:

```bash
cd <repo>
WORKSPACE_DIR=<workspace> PORT=9080 nohup node src/server.js > /tmp/workspace-web-editor.log 2>&1 &
```

停止:

```bash
pkill -f "workspace-web-editor.*server.js"
```

## 起動後の確認・報告

1. ヘルスチェック: `curl -s -o /dev/null -w "%{http_code}" http://localhost:9080/` で 200 を確認
2. アクセス URL を報告:
   - ローカルのみ: `http://localhost:9080/`
   - Tailscale 経由: `echo "http://$(tailscale ip -4):9080"`

Tailscale が利用可能な環境なら Tailscale IP の URL を優先して返す。

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `PORT` | `9080` | リッスンするポート |
| `WORKSPACE_DIR` | `process.cwd()` | 閲覧・編集するワークスペースのルート |
| `EXCLUDE_EXTRA` | （なし） | デフォルト除外に追加するディレクトリ名（カンマ区切り） |
| `VIEWABLE_EXT` | `.md,.txt,.json,.yaml,.yml,.toml,.py,.js,.ts,.sh` | 表示対象の拡張子をカンマ区切りで上書き |

詳しい使い方とトラブルシューティングはリポジトリの `README.md` / `USAGE.md` を参照する。
