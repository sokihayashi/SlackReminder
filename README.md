# Slack Reminder Bot

`@reminder-bot` をメンションするとAIが担当者・期限・内容を抽出し、確認後にDB登録、期限時刻に担当者へDMでリマインドするBotです。

## 基本フロー

```
ユーザー: @reminder-bot 田中さん、来週水曜までにロゴ確認お願いします
  ↓
Bot がスレッドに確認メッセージを投稿（事前通知タイミング表示）
  ↓
ユーザーが ✅ or ❌ でリアクション
  ↓
✅ → DB に登録 (status: pending)
❌ → 取り消し (status: cancelled)
  ↓
期限の N 時間前 → 担当者に事前 DM
期限到来 → 担当者に本番 DM
```

## セットアップ

### 1. 依存パッケージをインストール

```bash
npm install
```

### 2. 環境変数を設定

```bash
cp .env.example .env
# .env を編集して各トークンを入力
```

### 3. Slack App の作成

[api.slack.com/apps](https://api.slack.com/apps) で新しい App を作成します。

#### Bot Token Scopes

| Scope | 用途 |
|-------|------|
| `app_mentions:read` | メンション検知 |
| `chat:write` | メッセージ投稿 |
| `reactions:add` | リアクション追加 |
| `reactions:read` | リアクション受信 |
| `channels:history` | スレッド文脈読み取り |
| `groups:history` | プライベートチャンネルのスレッド |
| `im:write` | DM チャンネルを開く |
| `channels:read` | チャンネル情報取得 |

#### Event Subscriptions

**Subscribe to Bot Events** に以下を追加：

| イベント | 用途 |
|---------|------|
| `app_mention` | メンション検知 |
| `reaction_added` | ✅/❌ リアクション |
| `message.channels` | スレッド返信（修正・再登録コマンド） |
| `message.groups` | プライベートチャンネルの返信 |

#### Interactivity & Shortcuts

設定ボタン（事前通知タイミング変更）を使うには **Interactivity** を有効にしてください。

- **Socket Mode**（推奨）：自動で有効になります
- **HTTP Mode**：Request URL に `https://<your-host>/slack/events` を設定

#### Socket Mode（ローカル開発推奨）

App Settings → Socket Mode を有効にし、App-Level Token (`xapp-...`) を発行して `SLACK_APP_TOKEN` に設定してください。

### 4. 起動

```bash
npm start          # 通常起動
npm run dev        # 開発時（ファイル変更を監視）
```

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `SLACK_BOT_TOKEN` | ✅ | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | ✅ | App Signing Secret |
| `SLACK_APP_TOKEN` | Socket Mode のみ | App-Level Token (`xapp-...`) |
| `OPENROUTER_API_KEY` | ✅ | OpenRouter API Key |
| `OPENROUTER_MODEL` | - | 使用モデル（デフォルト: `anthropic/claude-haiku-4-5`） |
| `PORT` | - | HTTPモード時のポート番号（デフォルト: 3000） |

## 使い方

### リマインド登録

```
@reminder-bot 田中さん、来週水曜までにロゴ確認お願いします
@reminder-bot @tanaka 企画書提出 金曜17時まで 3日前に通知して
```

スレッドの途中でメンションすると、会話の文脈から担当者・タスクを推測します。

### リアクション操作

| リアクション | 動作 |
|-------------|------|
| ✅ on draft | 登録確定（pending に移行） |
| ❌ on draft/pending | キャンセル |
| ✅ on cancelled | 再登録 |

### スレッド返信で修正

確認メッセージのスレッドに返信することで内容を変更できます：

```
担当者を @suzuki に変更して
期限を来週金曜に変更
再登録
```

### タスク一覧

```
@reminder-bot タスク一覧
@reminder-bot @tanaka のタスク
```

### 設定

```
@reminder-bot 設定確認
@reminder-bot 設定: 事前通知 2日前
@reminder-bot このチャンネルにタスクサマリーを設定
@reminder-bot サマリーを解除
```

設定確認コマンドでは事前通知タイミングをボタンで変更できます。

### 週次タスクサマリー

指定チャンネルに毎週月曜 9:00 JST にペンディングタスクの一覧が自動投稿されます。

## DB スキーマ

`reminders.db`（SQLite）に保存されます。

### reminders テーブル

| カラム | 型 | 説明 |
|--------|-----|------|
| `id` | TEXT | UUID |
| `task` | TEXT | タスク内容 |
| `assignee_name` | TEXT | 担当者名 |
| `assignee_slack_user_id` | TEXT | 担当者 Slack ID |
| `due_at` | TEXT | 期限（UTC ISO 8601） |
| `source_channel_id` | TEXT | 依頼元チャンネル |
| `source_message_ts` | TEXT | 依頼元メッセージ ts |
| `source_thread_ts` | TEXT | 依頼元スレッド ts |
| `confirmation_message_ts` | TEXT | 確認メッセージ ts |
| `status` | TEXT | `draft` / `pending` / `sent` / `cancelled` / `failed` |
| `created_by` | TEXT | 依頼者 Slack ID |
| `ai_confidence` | REAL | AI 確信度 |
| `advance_notified` | INTEGER | 事前通知送信済みフラグ |
| `advance_notice_hours` | INTEGER | 個別事前通知時間（null = グローバル設定を使用） |
| `created_at` | TEXT | 作成日時（UTC） |
| `updated_at` | TEXT | 更新日時（UTC） |

### settings テーブル

| カラム | 型 | 説明 |
|--------|-----|------|
| `key` | TEXT | 設定キー |
| `value` | TEXT | 設定値 |
| `updated_at` | TEXT | 更新日時 |

現在の設定キー：
- `advance_notice_hours` — 事前通知タイミング（時間）、デフォルト 24
- `summary_channel_id` — 週次サマリー送信先チャンネル ID

## ファイル構成

```
src/
├── app.js              # エントリポイント（Bolt 初期化・イベント・アクション登録）
├── ai.js               # OpenRouter による情報抽出・修正検知
├── db.js               # SQLite CRUD（reminders + settings）
├── scheduler.js        # 定期ジョブ（毎分: 事前通知・期限通知 / 月曜9時: 週次サマリー）
├── utils.js            # 日時フォーマット・定数
├── botConfig.js        # Bot 自身の user_id 保持
└── handlers/
    ├── mention.js      # app_mention ハンドラ（リマインド登録・クエリ・設定）
    ├── reaction.js     # reaction_added ハンドラ
    └── thread.js       # スレッド返信ハンドラ（修正・再登録）
```

## 注意事項

- `.env` と `reminders.db` は Git 管理外です
- 担当者が Slack メンション形式でない場合は DM 送信できません
- 週次サマリーは送信先チャンネルにBotが参加している必要があります
