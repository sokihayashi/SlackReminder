const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Extract reminder fields from a Slack message text using the AI.
 * @param {string} text - The raw Slack message text (may include <@U...> mentions)
 * @param {Date} referenceDate - The current date used to resolve relative expressions
 * @returns {Promise<object>} Extracted reminder fields
 */
async function extractReminder(text, referenceDate = new Date()) {
  const jstFormatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
  });
  const jstNow = jstFormatter.format(referenceDate);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a reminder extraction assistant for a Japanese Slack workspace.
Extract reminder information from Slack messages. Today's date and time (JST): ${jstNow}.

Return a JSON object with these fields:
- should_create_reminder (boolean): true if this message is requesting a task reminder
- assignee (string|null): Slack mention like "<@U123456>" if present in the text, otherwise the person's name as written
- task (string|null): concise description of what needs to be done
- due_at (string|null): ISO 8601 datetime with JST offset, e.g. "2026-05-20T10:00:00+09:00"
- confidence (number): 0.0-1.0, your confidence in the extraction
- missing_fields (array of strings): fields that are unclear or missing, e.g. ["due_at", "assignee"]
- reason (string): brief explanation of your interpretation

Rules:
- Interpret relative dates (明日, 来週, 今週中, etc.) based on the JST current time above
- If a date is given but no time, default to 10:00 JST
- If "前日にリマインド" or similar, subtract one day from the deadline for due_at
- If the date is ambiguous (e.g. "そのうち", "近日中"), set confidence < 0.6 and add "due_at" to missing_fields
- If no person is clearly identified as the task owner, add "assignee" to missing_fields
- Set should_create_reminder = false for casual conversation that doesn't involve a task`,
      },
      {
        role: 'user',
        content: text,
      },
    ],
  });

  return JSON.parse(response.choices[0].message.content);
}

module.exports = { extractReminder };
