# Slack Reminder Bot

`@reminder-bot` がメンションされた投稿をAIが解析し、担当者・期限・内容を抽出して確認後にDB登録、期限時刻に担当者へDMリマインドするBotです。

## 基本フロー

```
ユーザー: @reminder-bot 田中さん、来週水曜までにロゴ確認お願いします
  ↓
Bot がスレッドに確認メッセージを投稿
  ↓
ユーザーが ✅ or ❌ でリアクション
  ↓
✅ → DB に登録 (status: pending)
❌ → 候補を破棄 (status: cancelled)
  ↓
定期ジョブが期限到来を検知 → 担当者に DM 通知
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

#### 必要な Bot Token Scopes

| Scope | 用途 |
|-------|------|
| `app_mentions:read` | メンション検知 |
| `chat:write` | メッセージ投稿 |
| `reactions:add` | リアクション追加 |
| `reactions:read` | リアクション受信 |
| `im:write` | DM チャンネルを開く |
| `channels:read` | チャンネル情報取得 |

#### イベントサブスクリプション

**Subscribe to Bot Events** に以下を追加してください：

- `app_mention`
- `reaction_added`

#### Socket Mode（ローカル開発推奨）

App Settings → Socket Mode を有効にし、App-Level Token (`xapp-...`) を発行して `SLACK_APP_TOKEN` に設定してください。

### 4. 起動

```bash
# 通常起動
npm start

# 開発時（ファイル変更を監視）
npm run dev
```

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `SLACK_BOT_TOKEN` | ✅ | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | ✅ | App Signing Secret |
| `SLACK_APP_TOKEN` | Socket Mode のみ | App-Level Token (`xapp-...`) |
| `OPENAI_API_KEY` | ✅ | OpenAI API Key |
| `PORT` | - | HTTPモード時のポート番号（デフォルト: 3000） |

## 使い方

### リマインド登録

チャンネルで Bot をメンションして依頼内容を書くだけです：

```
@reminder-bot 田中さん、来週水曜までにロゴ確認お願いします
```

Bot がスレッドに確認メッセージを返します：

```
リマインド候補を作成しました。

担当： @tanaka
期限： 2026/05/20(水) 10:00
内容： ロゴ確認

確信度：87%　|　✅ でリアクションすると登録、❌ でキャンセル
```

- ✅ リアクション → 登録確定
- ❌ リアクション → キャンセル

### リマインド通知

期限になると担当者に DM が届きます：

```
リマインドです。

内容： ロゴ確認
期限： 2026/05/20(水) 10:00
依頼元： #design
```

## DB スキーマ

`reminders.db`（SQLite）に保存されます。

| カラム | 型 | 説明 |
|--------|-----|------|
| `id` | TEXT | UUID |
| `task` | TEXT | タスク内容 |
| `assignee_name` | TEXT | 担当者名（AI 抽出） |
| `assignee_slack_user_id` | TEXT | 担当者 Slack ID |
| `due_at` | TEXT | 期限（UTC ISO 8601） |
| `source_channel_id` | TEXT | 依頼元チャンネル |
| `source_message_ts` | TEXT | 依頼元メッセージ ts |
| `source_thread_ts` | TEXT | 依頼元スレッド ts |
| `confirmation_message_ts` | TEXT | 確認メッセージ ts |
| `status` | TEXT | `draft` / `pending` / `sent` / `cancelled` / `failed` |
| `created_by` | TEXT | 依頼者 Slack ID |
| `ai_confidence` | REAL | AI 確信度 |
| `created_at` | TEXT | 作成日時（UTC） |
| `updated_at` | TEXT | 更新日時（UTC） |

## ファイル構成

```
src/
├── app.js              # エントリポイント（Bolt 初期化・イベント登録）
├── ai.js               # OpenAI による情報抽出
├── db.js               # SQLite CRUD
├── scheduler.js        # 定期ジョブ（毎分、期限到来チェック）
├── utils.js            # 日時フォーマット
├── botConfig.js        # Bot 自身の user_id 保持
└── handlers/
    ├── mention.js      # app_mention ハンドラ
    └── reaction.js     # reaction_added ハンドラ
```

## 注意事項

- `.env` は Git 管理外です（`.gitignore` に含まれています）
- `reminders.db` も Git 管理外です
- 担当者が Slack メンション形式（`<@U123456>`）でなく名前のみの場合、DM 送信はできません
- 低確信度（< 60%）または必要情報不足の場合は、Bot が確認を求めます
