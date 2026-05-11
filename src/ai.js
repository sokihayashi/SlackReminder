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
    // AIがJSON以外のテキストを前後に付けた場合、最初の { から最後の } を切り出す
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(`AI returned non-JSON response: ${text.slice(0, 120)}`);
  }
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
- "create_reminder": user wants to set a new reminder
  → The first <@UXXXXXXX> in the message is the bot — ignore it for assignee
  → Other <@UXXXXXXX> mentions are the assignee; also infer from thread context
  → Interpret relative dates (明日, 来週, 今週中) from JST time above; default time 10:00 JST
  → "前日にリマインド" → subtract one day from due_at
  → Ambiguous date → confidence < 0.6, add "due_at" to missing_fields
  → No clear assignee → add "assignee" to missing_fields
  → "X日前に通知" or "X時間前に通知" in the message → set advance_notice_hours accordingly
  → "このスレッドに通知" / "チャンネルで通知" / "DMじゃなく" / "ここに通知" → notification_target: "thread"
  → default notification_target: "dm"
  → due_at must be ISO 8601 with JST offset, e.g. "2026-05-20T10:00:00+09:00"
- "query_tasks": user wants to list existing reminders (e.g. タスク一覧, 誰が何を, リスト)
  → set query_assignee to <@U...> if asking for a specific person, else null
- "update_setting": user wants to change a bot setting (e.g. 設定: 事前通知 2日前, デフォルト通知を3日前に)
  → setting_key: "advance_notice_hours"
  → setting_value: integer string (e.g. "48" for 2日前)
- "cancel_reminder": user wants to cancel an existing pending reminder
  (e.g. はやしへのリマインド解除して, @田中のタスクをキャンセル, 編集のリマインド取り消し)
  → set cancel_assignee to <@U...> or display name if a person is specified, else null
  → set cancel_task_hint to a keyword from the task description if specified, else null
- "set_summary_channel": user wants this channel to receive the weekly task summary
  (e.g. このチャンネルにタスクサマリーを設定, ここに週次サマリーを送って, このチャンネルで月曜まとめ)
- "remove_summary_channel": user wants to stop summary in this channel
  (e.g. サマリーを解除, 週次まとめを止めて)
- "show_settings": user wants to see current settings (e.g. 設定確認, 現在の設定)
- "none": casual conversation or unclear

Respond with JSON:
- intent: "create_reminder" | "query_tasks" | "cancel_reminder" | "update_setting" | "set_summary_channel" | "remove_summary_channel" | "show_settings" | "none"
- cancel_assignee: string or null
- cancel_task_hint: string or null
- query_assignee: string or null
- setting_key: string or null
- setting_value: string or null
- should_create_reminder: true if intent is create_reminder, else false
- assignee: string or null
- task: string or null
- due_at: string or null
- advance_notice_hours: integer or null (per-reminder override; null = use global default)
- notification_target: "dm" | "thread"
- confidence: number 0.0-1.0
- missing_fields: array of strings
- reason: string or null`,
      },
      { role: 'user', content: text },
    ],
  });

  return parseJSON(response.choices[0].message.content);
}

/**
 * Detect if a thread reply is a modification or restore instruction.
 */
async function extractModification(text, referenceDate = new Date()) {
  const jstNow = formatJST(referenceDate);

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a reminder modification assistant for a Japanese Slack workspace.
Today's date and time (JST): ${jstNow}.

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

module.exports = { extractReminder, extractModification };
