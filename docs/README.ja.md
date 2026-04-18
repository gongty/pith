# Wiki App

AI搭載のパーソナルナレッジベース。素材を投入すると、AIが構造化されたWiki記事に自動編纂します。素材を追加するほど、知識ベースは賢くなります。

[Andrej Karpathy](https://x.com/karpathy) に着想を得たプロジェクト: LLMにWikiの執筆と保守を任せ、あなたは読んで質問する。Wikiは複利で成長するナレッジ資産です。

**[中文](README.zh.md) | [English](../README.md) | 日本語 | [한국어](README.ko.md) | [Espanol](README.es.md) | [Portugues](README.pt.md) | [Deutsch](README.de.md)**

## スクリーンショット

| ダッシュボード | ナレッジグラフ |
|:-:|:-:|
| ![ダッシュボード](../docs/screenshots/dashboard.png) | ![ナレッジグラフ](../docs/screenshots/graph.png) |

| 記事閲覧 | 記事一覧 |
|:-:|:-:|
| ![記事](../docs/screenshots/article.png) | ![一覧](../docs/screenshots/browse.png) |

| 自動タスク | ダークモード |
|:-:|:-:|
| ![自動タスク](../docs/screenshots/autotask.png) | ![ダークモード](../docs/screenshots/dark-mode.png) |

## 解決する課題

**情報が散在し、読んだそばから忘れていく。** メモはあるアプリに、ブックマークは別のアプリに、PDFはデスクトップに。Wiki Appはそれらすべてを、検索可能で相互リンクされた記事に自動変換します。

**汎用的なAIではなく、自分の知識に基づいて質問したい。** 内蔵チャットはRAG（検索拡張生成）を使い、あなたのWikiから回答を導きます。すべての回答は、あなたが蓄積した記事に基づいています。

**関心のあるトピックをAIに毎日モニタリングさせたい。** RSSフィード、Webページ、APIをソースとして自動タスクを設定すれば、AIがスケジュール通りに取得・フィルタリング・記事編纂を行います -- あなた専属のリサーチアシスタントです。

## 機能

- **あらゆる素材を取り込み** -- テキスト貼り付け、ファイルドロップ（PDF、画像、音声、動画、ZIP）、URL入力に対応。AIがタグ、要約、相互参照付きの構造化された記事に編纂します。
- **ナレッジとチャット** -- RAG搭載のQ&Aが、Wikiからコンテキストを検索して回答。ハイブリッド検索: BM25キーワード + ベクトル埋め込み（RRF融合）。
- **ナレッジグラフ** -- コンセプトと記事の力学モデル可視化。知識同士のつながりを俯瞰できます。
- **記事Q&A** -- 各記事にフローティングパネルを配置し、文脈に沿った質問が可能。記事ごとの会話セッションとストリーミングレスポンスに対応。
- **自動タスク** -- RSS/Web/APIソースをスケジュール監視するAIリサーチアシスタント。LLMによる関連性判定、重複排除、デイリーブリーフィングを実行。
- **リッチ編集** -- Notion風のcontenteditable エディタ。フローティングツールバー、自動保存、タグ管理、目次を搭載。
- **マルチLLM** -- Bailian（Alibaba）、OpenRouter、Anthropic、OpenAI、DeepSeek、またはカスタムプロバイダーに対応。
- **ダークモード** -- 細部まで調整されたトークンによる完全なダークテーマ。
- **フレームワーク不要** -- バニラJSフロントエンド、ビルドステップなし。編集してリロードするだけ。

## クイックスタート

```bash
git clone https://github.com/gongty/wiki-app.git
cd wiki-app
npm install
WIKI_API_KEY=your-api-key node server.js
# http://localhost:3456 を開く
```

デフォルトポート: 3456。初回起動後、設定画面でLLMプロバイダーを設定してください。

## 設定

### 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `WIKI_API_KEY` | はい | LLMプロバイダーのAPIキー |
| `WIKI_ADMIN_TOKEN` | 本番環境 | 書き込みエンドポイントを保護する認証トークン（16文字以上） |
| `PORT` | いいえ | サーバーポート（デフォルト: 3456） |

### LLMプロバイダー

起動後に設定画面から設定:

| プロバイダー | 備考 |
|-------------|------|
| Bailian（Alibaba Cloud） | デフォルト。DashScope API |
| OpenRouter | マルチモデルアグリゲーター |
| Anthropic | Claude モデル |
| OpenAI | GPT モデル |
| DeepSeek | 中国発LLM |
| Custom | OpenAI互換の任意のエンドポイント |

## 技術スタック

| レイヤー | 選定技術 | 理由 |
|---------|---------|------|
| バックエンド | Node.js 標準ライブラリ | 単一ファイルサーバー、バックエンド依存ゼロ |
| フロントエンド | バニラJS + ES Modules | フレームワークなし、バンドラーなし、ビルドステップなし |
| スタイリング | CSS Custom Properties | デザイントークンがカスケードし、ダークモードも組み込み |
| ストレージ | ファイルシステム | Markdown + JSON、データベース不要 |
| AI | マルチプロバイダー | 統一された `callLLM()` インターフェース |

## プロジェクト構成

```
wiki-app/
├── server.js          # Node.js HTTPサーバー（約6700行、API + 静的ファイル配信）
├── app/
│   ├── index.html     # HTMLシェル
│   ├── css/           # デザインシステム（"Warm Ink": インディゴアクセント、温かみのある紙質感）
│   └── js/            # ES Modules
│       ├── app.js     # エントリーポイント
│       ├── router.js  # ハッシュベースルーティング
│       └── pages/     # dashboard, chat, article, graph, browse, autotask
└── data/              # 自動生成、gitignored
    ├── wiki/          # トピック別に整理されたMarkdown記事
    ├── raw/           # 不変のソース素材
    ├── chats/         # 会話履歴（JSON）
    ├── autotasks/     # タスク設定、実行履歴、重複排除インデックス
    └── vectors/       # セマンティック検索用の埋め込みインデックス
```

## コントリビューション

IssueやPull Requestを歓迎します。

## ライセンス

MIT
