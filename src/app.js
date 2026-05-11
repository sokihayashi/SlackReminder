require('dotenv').config();

const { App, LogLevel } = require('@slack/bolt');
const botConfig = require('./botConfig');
const { handleMention, notificationTargetBlock } = require('./handlers/mention');
const { handleReaction } = require('./handlers/reaction');
const { startScheduler } = require('./scheduler');

const { handleThreadReply } = require('./handlers/thread');
const { setSetting, setNotificationTarget, findByConfirmationTs } = require('./db');
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

(async () => {
  await app.start();

  // Resolve the bot's own user ID so reaction handler can filter self-reactions
  const { user_id } = await app.client.auth.test();
  botConfig.botUserId = user_id;

  startScheduler(app.client);

  console.log(
    `Slack Reminder Bot is running (mode: ${useSocketMode ? 'Socket' : 'HTTP'}, botUserId: ${user_id})`
  );
})();
