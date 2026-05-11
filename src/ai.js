const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// JSON schema for structured extraction — ensures valid JSON every call
const extractionSchema = {
  type: 'object',
  properties: {
    should_create_reminder: {
      type: 'boolean',
      description: 'Whether this message is requesting a task reminder',
    },
    assignee: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Slack mention like "<@U123456>" if present, or person\'s name as written',
    },
    task: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Concise description of what needs to be done',
    },
    due_at: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'ISO 8601 datetime with JST offset, e.g. "2026-05-20T10:00:00+09:00"',
    },
    confidence: {
      type: 'number',
      description: '0.0–1.0 confidence in the extraction',
    },
    missing_fields: {
      type: 'array',
      items: { type: 'string' },
      description: 'Fields that are unclear or missing, e.g. ["due_at", "assignee"]',
    },
    reason: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Brief explanation of interpretation',
    },
  },
  required: ['should_create_reminder', 'confidence', 'missing_fields'],
  additionalProperties: false,
};

/**
 * Extract reminder fields from a Slack message text using Claude.
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

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    output_config: {
      format: {
        type: 'json_schema',
        name: 'reminder_extraction',
        schema: extractionSchema,
      },
    },
    system: `You are a reminder extraction assistant for a Japanese Slack workspace.
Extract reminder information from Slack messages. Today's date and time (JST): ${jstNow}.

Rules:
- Interpret relative dates (明日, 来週, 今週中, etc.) based on the JST current time above
- If a date is given but no time, default to 10:00 JST
- If "前日にリマインド" or similar, subtract one day from the deadline for due_at
- If the date is ambiguous (e.g. "そのうち", "近日中"), set confidence below 0.6 and add "due_at" to missing_fields
- If no person is clearly identified as the task owner, add "assignee" to missing_fields
- Set should_create_reminder to false for casual conversation that does not involve a task
- due_at must be ISO 8601 with JST offset, e.g. "2026-05-20T10:00:00+09:00"`,
    messages: [{ role: 'user', content: text }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return JSON.parse(textBlock.text);
}

module.exports = { extractReminder };
