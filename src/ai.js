const OpenAI = require('openai');
const { formatJST } = require('./utils');

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://github.com/sokihayashi/SlackReminder',
  },
});

const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4-5';

function parseJSON(raw) {
  const text = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    if (start === -1) throw new Error('No JSON found in AI response');
    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) throw new Error('Unbalanced JSON braces in AI response');
    return JSON.parse(text.slice(start, end + 1));
  }
}

/**
 * Tolerant parser for AI responses containing { "tasks": [...] }.
 * When the outer JSON is truncated mid-array, recover all complete task objects.
 */
function parseTasksJSON(raw) {
  try {
    return parseJSON(raw);
  } catch (err) {
    if (!/Unbalanced|No JSON/.test(err.message)) throw err;
    const text = raw.replace(/^```(?:json)?\s*/m, '').trim();
    const keyMatch = text.search(/"tasks"\s*:\s*\[/);
    if (keyMatch === -1) throw err;
    const bracketIdx = text.indexOf('[', keyMatch);
    const tasks = [];
    let i = bracketIdx + 1;
    while (i < text.length) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (i >= text.length || text[i] === ']') break;
      if (text[i] !== '{') break;
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end === -1) break;
      try { tasks.push(JSON.parse(text.slice(i, end + 1))); }
      catch (_) { break; }
      i = end + 1;
    }
    return { tasks };
  }
}

const VALID_INTENTS = [
  'create_reminder', 'query_tasks', 'cancel_reminder',
  'update_setting', 'set_summary_channel', 'remove_summary_channel',
  'show_settings', 'extract_from_thread', 'none',
];

function sanitizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  if (typeof t.task !== 'string' || !t.task.trim()) return null;
  return {
    task: t.task.trim(),
    assignee: t.assignee ?? null,
    due_at: t.due_at ?? null,
    advance_notice_hours: Number.isFinite(t.advance_notice_hours) ? t.advance_notice_hours : null,
    confidence: typeof t.confidence === 'number' ? t.confidence : 1,
  };
}

function sanitizeExtraction(raw) {
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map(sanitizeTask).filter(Boolean)
    : [];
  return {
    intent:               VALID_INTENTS.includes(raw.intent) ? raw.intent : 'none',
    tasks,
    confidence:           typeof raw.confidence === 'number' ? raw.confidence : 0,
    missing_fields:       Array.isArray(raw.missing_fields) ? raw.missing_fields : [],
    reason:               raw.reason              ?? null,
    notification_target:  raw.notification_target === 'thread' ? 'thread' : 'dm',
    channel_scope:        raw.channel_scope === 'all' ? 'all' : 'current',
    query_assignee:       raw.query_assignee      ?? null,
    cancel_assignee:      raw.cancel_assignee     ?? null,
    cancel_task_hint:     raw.cancel_task_hint    ?? null,
    setting_key:          raw.setting_key         ?? null,
    setting_value:        raw.setting_value       ?? null,
  };
}

/**
 * Extract reminder intent and fields from a Slack message.
 * @param {string} text
 * @param {Date} referenceDate
 * @param {{user: string, text: string}[]} threadMessages - Prior thread messages for context
 */
async function extractReminder(text, referenceDate = new Date(), threadMessages = []) {
  const jstNow = formatJST(referenceDate);

  const threadSection = threadMessages.length > 0
    ? `\n\nThread context (recent messages — use to infer assignee or task if not stated):\n${threadMessages.map(m => `  [${m.user}]: ${m.text}`).join('\n')}`
    : '';

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a reminder extraction assistant for a Japanese Slack workspace.
Today's date and time (JST): ${jstNow}.${threadSection}

Determine the user's intent, then extract fields accordingly.

Intent options:
- "create_reminder": user wants to register one or more reminders
  → Populate the "tasks" array. Each entry is ONE distinct action item.
  → If the user message contains multiple verbs/requests, decompose into separate entries.
    Example: 「Aを借りて、Bを確保して、Cを確認して」 → 3 entries
    Example: 「QKからインカム借りて、段ボール確保、15日に制作チームに確認」 → 3 entries
  → If the user message lacks task details (e.g. just 「登録して」「リマインドして」「お願い」), look at Thread context above and extract action items discussed there.
  → **ASSIGNEE EXTRACTION (重要)**: The user's bot mention has already been stripped from the input.
    - Rule A: Any remaining <@UXXXXXXX> in the user's message IS the per-task assignee. Copy it verbatim to tasks[].assignee (e.g. "<@U12345>"). This applies even if the mentioned user is the message sender themselves — self-reminders are valid and common.
    - Rule B: Plain Japanese names directly addressed to a person ("はやしさん", "田中", "@山田") also count as assignees — use the name as a string.
    - Rule C: Fall back to thread context (most recent name mentioned) when current message has no name.
    - Never use the bot as assignee.
    - Only add "assignee" to missing_fields if NO assignee can be inferred from the message AND thread context.
  → Interpret relative dates (明日, 来週, 今週中) from JST time above; default time 10:00 JST
  → "前日にリマインド" → subtract one day from due_at
  → Ambiguous date → confidence < 0.6, add "due_at" to missing_fields
  → カスタム絵文字（:emoji_name: 形式）も期限ヒントとして解釈：
    【日付指定】
    - :asitakana: :asitayaro: :asitamatakite: :asita_tantou: :ashita: :ashitadeok: :ashitanokoban: :ashitayaru_明日_やる: → 翌日 23:59 JST
    - :kyouhamazi: :kyouyaro: → 今日 23:59 JST
    - :mataraisyuu: → 来週月曜 09:00 JST
    【時刻指定（既出の日付を修飾。日付なしなら今日）】
    - :9zisyussya: :asadayo: :asadazo: :asayarou: → 09:00
    - :gogosyussya: → 12:00
    - :mouyoru: :yorunoyoga: :yoruyarou: :yorukana: :yorudazo: → 23:59
    例: "15日 :asadayo:" → 今月15日 09:00 / ":asitanokoban: :gogosyussya:" → 明日 12:00 / ":mataraisyuu: :mouyoru:" → 来週月曜 23:59
  → "X日前に通知" or "X時間前に通知" → set advance_notice_hours on that task
  → "このスレッドに通知" / "チャンネルで通知" / "DMじゃなく" / "ここに通知" → notification_target: "thread"
  → default notification_target: "dm"
  → due_at must be ISO 8601 with JST offset, e.g. "2026-05-20T10:00:00+09:00"
- "query_tasks": user wants to list existing reminders (e.g. タスク一覧, 誰が何を, リスト)
  → set query_assignee to <@U...> if asking for a specific person, else null
- "update_setting": user wants to change a bot setting (e.g. 設定: 事前通知 2日前, デフォルト通知を3日前に)
  → setting_key: "advance_notice_hours"
  → setting_value: integer string (e.g. "48" for 2日前)
- "cancel_reminder": user wants to cancel an existing pending reminder
  (e.g. はやしへのリマインド解除して, @田中のタスクをキャンセル, 編集のリマインド取り消し, 全部キャンセル, クリア, リセット)
  → set cancel_assignee to <@U...> or display name if a person is specified, else null
  → set cancel_task_hint to a keyword from the task description if specified, else null
- "set_summary_channel": user wants this channel to receive the weekly task summary
  (e.g. このチャンネルにタスクサマリーを設定, ここに週次サマリーを送って, このチャンネルで月曜まとめ)
- "remove_summary_channel": user wants to stop summary in this channel
  (e.g. サマリーを解除, 週次まとめを止めて)
- "show_settings": user wants to see current settings (e.g. 設定確認, 現在の設定)
- "extract_from_thread": user wants bot to scan this thread or channel and bulk-register all action items as reminders
  (e.g. このスレッドのタスクを登録して, やること一覧にして しめきり切って, スレッドからタスク拾って, スレッド内で発生しているタスクを一覧にして, このスレッドのやることまとめて, このチャンネルのタスクを抽出して, 最近のメッセージからタスクを拾って, botがメンションされてないタスクも含めて, 全チャンネルからタスク抽出, 入ってるチャンネル全部からタスク, 全てのチャンネルをスキャン)
  → use when user wants to EXTRACT NEW tasks from conversation, NOT list reminders already in the system
  → set should_create_reminder: false
  → channel_scope: "all" if user explicitly wants to scan all channels the bot is a member of (e.g. 全チャンネル, 入ってる全チャンネル, 全部のチャンネル, all channels, 全てのチャンネル). Otherwise "current".
- "none": casual conversation or unclear

Respond with JSON:
- intent: "create_reminder" | "query_tasks" | "cancel_reminder" | "update_setting" | "set_summary_channel" | "remove_summary_channel" | "show_settings" | "extract_from_thread" | "none"
- tasks: array of { task: string, assignee: string|null, due_at: string|null, advance_notice_hours: integer|null, confidence: number 0.0-1.0 }
  → Empty array [] if intent is not create_reminder, or if no action item is found.
  → For create_reminder, ALWAYS populate at least one entry when the user clearly asks to register a task.
- cancel_assignee: string or null
- cancel_task_hint: string or null
- query_assignee: string or null
- setting_key: string or null
- setting_value: string or null
- notification_target: "dm" | "thread"
- channel_scope: "current" | "all"
- confidence: number 0.0-1.0 (overall extraction confidence)
- missing_fields: array of strings (overall; e.g. ["assignee"] if no task has a clear assignee)
- reason: string or null`,
      },
      { role: 'user', content: text },
    ],
  });

  return sanitizeExtraction(parseJSON(response.choices[0].message.content));
}

const VALID_CANCEL_SCOPES = ['all', 'one', 'by_assignee', 'none'];

/**
 * Use AI to determine the cancel scope and target.
 * Returns { scope, reminder_id, assignee_filter, reason }.
 *   scope: 'all' | 'one' | 'by_assignee' | 'none'
 */
async function resolveCancelTarget(userMessage, pendingReminders) {
  if (pendingReminders.length === 0) {
    return { scope: 'none', reminder_id: null, assignee_filter: null, reason: 'no pending reminders' };
  }

  const list = pendingReminders.map((r, i) =>
    `${i + 1}. id=${r.id}  担当=${r.assignee_name}  タスク=${r.task}  期限=${r.due_at}`
  ).join('\n');

  const prompt = `あなたはSlackリマインドBotのキャンセル意図解析アシスタントです。\nユーザーのメッセージと現在のペンディングリマインド一覧から、何をキャンセルしたいかを判定してください。\n\nペンディング一覧:\n${list}\n\nscope の決め方:\n- "all": 対象を絞らず全部を消したい。例: 「全部キャンセル」「ぜんぶ消して」「クリア」「リセット」「全件削除」「リマインド全部やめて」「すべて取り消し」など意味的に「すべて対象」のとき。\n- "one": 一覧の中の特定1件を確実にロックオンできる場合のみ（担当・タスク・期限の組み合わせで一意に決まる）。\n- "by_assignee": 特定の担当者は明確だがその人の中で1件に絞れない／複数を一括で消したい。例: 「はやしのリマインド解除」「@田中のタスク全部キャンセル」「林さんのやつ消して」\n- "none": 上記いずれにも当てはまらない・あいまい・候補が複数で絞れない。\n\nRespond with JSON:\n- scope: "all" | "one" | "by_assignee" | "none"\n- reminder_id: string (scope="one" のときのみ、一覧の id) | null\n- assignee_filter: string (scope="by_assignee" のとき、一覧の担当=表記をそのままコピー。例: "<@U123>" または "はやし"） | null\n- reason: 判断理由（短く）`;

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userMessage },
    ],
  });

  const parsed = parseJSON(response.choices[0].message.content);
  const scope = VALID_CANCEL_SCOPES.includes(parsed.scope) ? parsed.scope : 'none';
  return {
    scope,
    reminder_id:     typeof parsed.reminder_id === 'string'     ? parsed.reminder_id     : null,
    assignee_filter: typeof parsed.assignee_filter === 'string' ? parsed.assignee_filter : null,
    reason: parsed.reason ?? null,
  };
}

/**
 * Detect if a thread reply is a modification or restore instruction.
 * @param {string} text
 * @param {object|null} reminder - Current reminder for context
 * @param {Date} referenceDate
 */
async function extractModification(text, reminder = null, referenceDate = new Date()) {
  const jstNow = formatJST(referenceDate);

  const context = reminder
    ? `\n\n現在のリマインド: タスク="${reminder.task}", 担当="${reminder.assignee_name}", 期限="${reminder.due_at}"`
    : '';

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a reminder modification assistant for a Japanese Slack workspace.
Today's date and time (JST): ${jstNow}.${context}

Determine if this message is a modification instruction for an existing reminder.

Respond with JSON:
- action: "modify" | "restore" | null
  - "modify": changing assignee or due date
  - "restore": re-register a cancelled reminder (e.g. やっぱり登録して, 再登録, 復活)
  - null: not a modification
- assignee: new assignee as <@U...> or display name, or null
- due_at: new ISO 8601 JST offset datetime, or null
- reason: brief explanation`,
      },
      { role: 'user', content: text },
    ],
  });

  return parseJSON(response.choices[0].message.content);
}

/**
 * Extract all action items from a thread conversation and return them as task objects.
 * @param {{user: string, text: string}[]} threadMessages
 * @param {Date} referenceDate
 */
async function extractTasksFromThread(threadMessages, referenceDate = new Date(), botUserId = null) {
  if (threadMessages.length === 0) return [];

  const jstNow = formatJST(referenceDate);
  const thread = threadMessages.map(m => `[${m.user}]: ${m.text}`).join('\n');
  const botNote = botUserId ? `\n- ※ <@${botUserId}> は Reminder Bot 自身なので担当者にしないこと` : '';

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `あなたはSlack会話からアクションアイテムを抽出するアシスタントです。
Today's date and time (JST): ${jstNow}

以下の会話から、タスク・依頼・やること（〜してください、〜お願い、〜確認して、〜借りる、〜確保する など）をすべて抽出してください。
単なるメモや情報共有（「〜あるとなおよし」「〜がある」など）はタスクではありません。

重要: 1つのメッセージに複数のタスクが含まれる場合は、それぞれ別のエントリとして返すこと。
例: 「〜を借りてください。〜も確保してください。〜を確認してほしい」→ 3つのエントリ

各タスクについて:
- task: 具体的なタスク内容（簡潔に、動詞で終わる形で）
- assignee: 担当者（<@UXXXXXX> 形式。名前のみの場合はそのまま。メッセージの宛先 (<@U...>) を優先。不明な場合は null）${botNote}
- due_at: 期限（ISO 8601 JST offset, e.g. "2026-05-20T10:00:00+09:00"）。会話中の日付・「15日」「来週」などから推測。不明な場合は null
  カスタム絵文字（:emoji_name: 形式）も期限ヒントとして解釈：
  【日付指定】
  - :asitakana: :asitayaro: :asitamatakite: :asita_tantou: :ashita: :ashitadeok: :ashitanokoban: :ashitayaru_明日_やる: → 翌日 23:59 JST
  - :kyouhamazi: :kyouyaro: → 今日 23:59 JST
  - :mataraisyuu: → 来週月曜 09:00 JST
  【時刻指定（既出の日付を修飾。日付なしなら今日）】
  - :9zisyussya: :asadayo: :asadazo: :asayarou: → 09:00
  - :gogosyussya: → 12:00
  - :mouyoru: :yorunoyoga: :yoruyarou: :yorukana: :yorudazo: → 23:59
  例: "15日 :asadayo:" → 今月15日 09:00 / ":asitanokoban: :gogosyussya:" → 明日 12:00
- confidence: タスクである確信度 0.0-1.0

Respond with JSON:
{ "tasks": [ { "task": string, "assignee": string|null, "due_at": string|null, "confidence": number } ] }

タスクが見つからない場合は { "tasks": [] } を返す。`,
      },
      {
        role: 'user',
        content: `スレッド:\n${thread}`,
      },
    ],
  });

  const parsed = parseTasksJSON(response.choices[0].message.content);
  if (!Array.isArray(parsed.tasks)) return [];
  return parsed.tasks.filter(t => typeof t.task === 'string' && t.task.length > 0);
}

module.exports = { extractReminder, extractModification, resolveCancelTarget, extractTasksFromThread };
