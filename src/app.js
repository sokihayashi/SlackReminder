require('dotenv').config();

const { App, LogLevel } = require('@slack/bolt');
const botConfig = require('./botConfig');
const { handleMention, notificationTargetBlock, handlePassiveDetection, handleBotJoinedChannel, bulkConfirmBlocks, refreshBulkMessage } = require('./handlers/mention');
const { handleReaction } = require('./handlers/reaction');
const { startScheduler } = require('./scheduler');

const { handleThreadReply } = require('./handlers/thread');
const { setSetting, setNotificationTarget, findByConfirmationTs, approveReminder, cancelReminder, getPendingQuestion, deletePendingQuestion } = require('./db');
const { formatHours } = require('./utils');

// Validate required environment variables at startup
const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'OPENROUTER_API_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const useSocketMode = Boolean(process.env.SLACK_APP_TOKEN);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: useSocketMode,
  appToken: process.env.SLACK_APP_TOKEN,
  port: Number(process.env.PORT) || 3000,
  logLevel: LogLevel.INFO,
});

// Debug: log all incoming events
app.use(async ({ payload, next }) => {
  console.log(`[debug] incoming event type=${payload?.type} subtype=${payload?.subtype}`);
  await next();
});

// Register event handlers before starting
app.event('app_mention', handleMention);
app.event('reaction_added', handleReaction);
app.event('member_joined_channel', handleBotJoinedChannel);

// Action handler: advance notice timing buttons
// action_id format: set_advance_notice_hours__<hours>
app.action(/^set_advance_notice_hours__\d+$/, async ({ body, ack, client }) => {
  await ack();
  const hours = parseInt(body.actions[0].value, 10);
  setSetting('advance_notice_hours', String(hours));
  const label = formatHours(hours);
  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `⚙️ 事前通知タイミングを ${label}前 に更新しました。`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚙️ *事前通知タイミングを更新しました*\n\n*${label}前* ✅`,
        },
      },
    ],
  });
});

// ── Bulk draft confirm/cancel ──────────────────────────────────────────────────

app.action('bulk_approve_one', async ({ body, ack, client }) => {
  await ack();
  approveReminder(body.actions[0].value);
  await refreshBulkMessage(client, body.channel.id, body.message.ts);
});

app.action('bulk_cancel_one', async ({ body, ack, client }) => {
  await ack();
  cancelReminder(body.actions[0].value);
  await refreshBulkMessage(client, body.channel.id, body.message.ts);
});

app.action('bulk_approve_all', async ({ body, ack, client }) => {
  await ack();
  try {
    const ids = JSON.parse(body.actions[0].value);
    for (const id of ids) approveReminder(id);
  } catch (e) { console.error('[bulk_approve_all] parse failed:', e.message); }
  await refreshBulkMessage(client, body.channel.id, body.message.ts);
});

app.action('bulk_cancel_all', async ({ body, ack, client }) => {
  await ack();
  try {
    const ids = JSON.parse(body.actions[0].value);
    for (const id of ids) cancelReminder(id);
  } catch (e) { console.error('[bulk_cancel_all] parse failed:', e.message); }
  await refreshBulkMessage(client, body.channel.id, body.message.ts);
});

// Quick due-at buttons posted when AI extraction is missing due_at
app.action('set_due_at_quick', async ({ body, ack, client }) => {
  await ack();
  const dueText = body.actions[0].value;
  const channel = body.channel.id;
  const thread_ts = body.message.thread_ts || body.message.ts;
  const pending = getPendingQuestion(channel, thread_ts);
  if (!pending) {
    await client.chat.postMessage({
      channel, thread_ts,
      text: '元の依頼情報の有効期限が切れました。もう一度メンションして依頼し直してください。',
    });
    return;
  }
  // Acknowledge selection in the original buttons message
  try {
    await client.chat.update({
      channel, ts: body.message.ts,
      text: `期限を「${dueText}」で処理中…`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `⏳ 期限を *${dueText}* で処理中…` } }],
    });
  } catch (e) { /* ignore */ }

  // Re-route through handleMention with chosen due-at appended as priorText follow-up
  await handleMention({
    event: { text: dueText, channel, ts: pending.source_message_ts, thread_ts, user: body.user.id },
    client,
    priorText: pending.original_text,
  });
});

// Action handler: notification target toggle (DM ↔ スレッド)
app.action(/^set_notification_target__/, async ({ body, ack, client }) => {
  await ack();
  const target = body.actions[0].value;
  const reminder = findByConfirmationTs(body.channel.id, body.message.ts);
  if (!reminder) return;

  setNotificationTarget(reminder.id, target);

  const updatedBlocks = body.message.blocks.map(b =>
    b.type === 'actions' && b.elements?.some(e => e.action_id?.startsWith('set_notification_target__'))
      ? notificationTargetBlock(target)
      : b
  );
  const fallbackText = body.message.text || 'リマインド候補を作成しました。';
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, blocks: updatedBlocks, text: fallbackText });
});

// Thread reply handler: modification and restore instructions
app.message(async ({ message, client }) => {
  if (!message.thread_ts) return;
  if (!message.user || message.subtype === 'bot_message') return;
  if (message.user === botConfig.botUserId) return;
  // Skip messages that mention the bot (handled by app_mention)
  if (message.text && message.text.includes(`<@${botConfig.botUserId}>`)) return;
  await handleThreadReply({ message, client });
});

// Passive monitoring: auto-detect task assignments (@USER + deadline) in all channel messages
app.message(async ({ message, client }) => {
  if (!message.user || message.subtype === 'bot_message') return;
  if (message.user === botConfig.botUserId) return;
  if (!message.text) return;
  // Skip messages mentioning the bot (handled by app_mention)
  if (message.text.includes(`<@${botConfig.botUserId}>`)) return;
  // Only process messages containing an explicit @USER mention
  if (!/<@U[A-Z0-9]+>/.test(message.text)) return;
  await handlePassiveDetection({ message, client });
});

(async () => {
  await app.start();

  // Resolve the bot's own user ID so reaction handler can filter self-reactions
  const { user_id } = await app.client.auth.test();
  botConfig.botUserId = user_id;

  startScheduler(app.client);

  console.log(
    `Slack Reminder Bot is running (mode: ${useSocketMode ? 'Socket' : 'HTTP'}, botUserId: ${user_id}, commit: ${botConfig.commitHash}, runId: ${botConfig.runId}, started: ${botConfig.startTime})`
  );
})();
