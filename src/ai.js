const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://github.com/sokihayashi/SlackReminder',
  },
});

const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-3-haiku';

/**
 * Extract reminder fields from a Slack message text using OpenRouter.
 * @param {string} text - Raw Slack message text (may include <@U...> mentions)
 * @param {Date} referenceDate - Current date used to resolve relative expressions
 * @returns {Promise<object>} Extracted reminder fields
 */
async function extractReminder(text, referenceDate = new Date()) {
  const jstNow = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
  }).format(referenceDate);

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a reminder extraction assistant for a Japanese Slack workspace.
Extract reminder information from Slack messages. Today's date and time (JST): ${jstNow}.

Rules:
- Interpret relative dates (明日, 来週, 今週中, etc.) based on the JST current time above
- If a date is given but no time, default to 10:00 JST
- If "前日にリマインド" or similar, subtract one day from the deadline for due_at
- If the date is ambiguous (e.g. "そのうち", "近日中"), set confidence below 0.6 and add "due_at" to missing_fields
- If no person is clearly identified as the task owner, add "assignee" to missing_fields
- Set should_create_reminder to false for casual conversation that does not involve a task
- due_at must be ISO 8601 with JST offset, e.g. "2026-05-20T10:00:00+09:00"

Respond with a JSON object with exactly these fields:
- should_create_reminder (boolean)
- assignee (string or null)
- task (string or null)
- due_at (string or null)
- confidence (number 0.0-1.0)
- missing_fields (array of strings)
- reason (string or null)`,
      },
      { role: 'user', content: text },
    ],
  });

  return JSON.parse(response.choices[0].message.content);
}

module.exports = { extractReminder };
