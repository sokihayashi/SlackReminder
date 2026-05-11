const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://github.com/sokihayashi/SlackReminder',
  },
});

const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4-5';

function formatJST(date) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
  }).format(date);
}

function parseJSON(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Extract reminder intent and fields from a Slack message.
 * @param {string} text - Raw Slack message (may include <@U...> mentions)
 * @param {Date} referenceDate
 * @param {{user: string, text: string}[]} threadMessages - Prior thread messages for context
 */
async function extractReminder(text, referenceDate = new Date(), threadMessages = []) {
  const jstNow = formatJST(referenceDate);

  const threadSection = threadMessages.length > 0
    ? `\n\nThread context (recent messages before this mention — use to infer assignee or task if not stated):\n${threadMessages.map(m => `  [${m.user}]: ${m.text}`).join('\n')}`
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

Intent rules:
- "query_tasks": user wants to see a list of existing reminders (e.g. タスク一覧、誰が何を、リスト表示)
  → set query_assignee to <@UXXXXXX> if they asked for a specific person's tasks, else null
- "create_reminder": user wants to create a new reminder
  → The first <@UXXXXXXX> in the message is the bot itself — ignore it for assignee detection
  → Other <@UXXXXXXX> mentions are the assignee; also infer from thread context if no mention
  → Interpret relative dates (明日, 来週, 今週中) based on JST time; default time 10:00 JST
  → "前日にリマインド" → subtract one day from due_at
  → Ambiguous date (そのうち, 近日中) → confidence < 0.6, add "due_at" to missing_fields
  → No clear assignee → add "assignee" to missing_fields
  → due_at must be ISO 8601 with JST offset, e.g. "2026-05-20T10:00:00+09:00"
- "none": casual conversation, greetings, unclear

Respond with JSON:
- intent: "create_reminder" | "query_tasks" | "none"
- query_assignee: string or null
- should_create_reminder: true if intent is create_reminder, else false
- assignee: string or null
- task: string or null
- due_at: string or null
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
  - "modify": user wants to change assignee or due date (e.g. 担当を@田中に変更, 期限を明日に変更)
  - "restore": user wants to re-register a cancelled reminder (e.g. やっぱり登録して, 再登録, 復活)
  - null: not a modification instruction
- assignee: new assignee as <@U...> or display name, or null if not changing
- due_at: new ISO 8601 JST offset datetime, or null if not changing
- reason: brief explanation`,
      },
      { role: 'user', content: text },
    ],
  });

  return parseJSON(response.choices[0].message.content);
}

module.exports = { extractReminder, extractModification };
