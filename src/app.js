require('dotenv').config();

const { App, LogLevel } = require('@slack/bolt');
const botConfig = require('./botConfig');
const { handleMention, notificationTargetBlock, handlePassiveDetection, handleBotJoinedChannel, bulkConfirmBlocks, refreshBulkMessage } = require('./handlers/mention');
const { executeReset } = require('./handlers/admin');
const { handleReaction } = require('./handlers/reaction');
const { startScheduler } = require('./scheduler');

const { handleThreadReply } = require('./handlers/thread');
const { setSetting, setNotificationTarget, findByConfirmationTs, approveReminder, cancelReminder, getPendingQuestion, deletePendingQuestion, recordBotSentMessage, getReminderById, updateReminder } = require('./db');
const { formatHours, formatDueAt } = require('./utils');
const { extractModification } = require('./ai');

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

// Track every message the bot sends so RESET can delete them even without im:read scope.
// Monkey-patch app.client.chat.postMessage — Bolt passes this same WebClient to all handlers.
const _origPostMessage = app.client.chat.postMessage.bind(app.client.chat);
app.client.chat.postMessage = async (opts) => {
  const result = await _origPostMessage(opts);
  if (result?.ok && result?.channel && result?.ts) {
    recordBotSentMessage(result.channel, result.ts);
  }
  return result;
};

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

// Admin RESET confirmation
app.action('reset_confirm', async ({ body, ack, client }) => {
  await ack();
  try {
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts,
      text: '🗑️ RESET 実行中…',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '🗑️ RESET 実行中…' } }],
    });
  } catch (_) {}
  await executeReset(client, body.channel.id, body.message.ts);
});

app.action('reset_cancel', async ({ body, ack, client }) => {
  await ack();
  await client.chat.update({
    channel: body.channel.id, ts: body.message.ts,
    text: 'RESET を中止しました。',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '🚫 RESET を中止しました。' } }],
  });
});

// Quick due-at buttons posted when AI extraction is missing due_at
// action_id format: set_due_at_quick__<index>
app.action(/^set_due_at_quick__\d+$/, async ({ body, ack, client }) => {
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

// ── Per-item "修正" modal ──────────────────────────────────────────────────────

const ADVANCE_NOTICE_OPTIONS = [0, 1, 2, 3, 6, 12, 24, 48].map(h => ({
  text: { type: 'plain_text', text: h === 0 ? 'なし（当日のみ）' : `${formatHours(h)}前` },
  value: String(h),
}));

app.action('bulk_modify_one', async ({ body, ack, client }) => {
  await ack();
  const reminderId = body.actions[0].value;
  const channel = body.channel.id;
  const confirmationTs = body.message.ts;
  const reminder = getReminderById(reminderId);
  if (!reminder) return;

  const currentAdvanceOption = ADVANCE_NOTICE_OPTIONS.find(
    o => o.value === String(reminder.advance_notice_hours ?? '')
  );

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'bulk_modify_modal',
      private_metadata: JSON.stringify({ reminderId, channel, confirmationTs }),
      title: { type: 'plain_text', text: 'リマインド修正' },
      submit: { type: 'plain_text', text: '保存' },
      close: { type: 'plain_text', text: 'キャンセル' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*タスク:* ${reminder.task}\n*担当:* ${reminder.assignee_name || '（未設定）'}　*期限:* ${formatDueAt(reminder.due_at)}`,
          },
        },
        { type: 'divider' },
        {
          type: 'input',
          block_id: 'assignee_block',
          optional: true,
          label: { type: 'plain_text', text: '担当者を変更' },
          hint: { type: 'plain_text', text: '<@U...> 形式またはお名前。空欄 = 変更しない' },
          element: {
            type: 'plain_text_input',
            action_id: 'assignee_input',
            placeholder: { type: 'plain_text', text: `現在: ${reminder.assignee_name || '（未設定）'}` },
          },
        },
        {
          type: 'input',
          block_id: 'due_at_block',
          optional: true,
          label: { type: 'plain_text', text: '期限を変更' },
          hint: { type: 'plain_text', text: '例: 明日17時 / 5月20日 / 来週月曜。空欄 = 変更しない' },
          element: {
            type: 'plain_text_input',
            action_id: 'due_at_input',
            placeholder: { type: 'plain_text', text: `現在: ${formatDueAt(reminder.due_at)}` },
          },
        },
        {
          type: 'input',
          block_id: 'advance_notice_block',
          optional: true,
          label: { type: 'plain_text', text: '事前通知タイミングを変更' },
          hint: { type: 'plain_text', text: '選択しない = 変更しない' },
          element: {
            type: 'static_select',
            action_id: 'advance_notice_select',
            placeholder: { type: 'plain_text', text: `現在: ${currentAdvanceOption ? currentAdvanceOption.text.text : '未設定'}` },
            options: ADVANCE_NOTICE_OPTIONS,
          },
        },
      ],
    },
  });
});

app.view('bulk_modify_modal', async ({ body, ack, client, view }) => {
  await ack();

  let { reminderId, channel, confirmationTs } = JSON.parse(view.private_metadata);
  const vals = view.state.values;

  const assigneeRaw = vals.assignee_block?.assignee_input?.value?.trim() || null;
  const dueAtRaw    = vals.due_at_block?.due_at_input?.value?.trim() || null;
  const advanceHoursStr = vals.advance_notice_block?.advance_notice_select?.selected_option?.value ?? null;

  const update = {};

  if (assigneeRaw) {
    const m = assigneeRaw.match(/<@(U[A-Z0-9]+)>/) || assigneeRaw.match(/^(U[A-Z0-9]{6,})$/);
    if (m) {
      update.assigneeSlackUserId = m[1];
      update.assigneeName = `<@${m[1]}>`;
    } else {
      update.assigneeName = assigneeRaw;
      update.assigneeSlackUserId = null;
    }
  }

  if (dueAtRaw) {
    try {
      const reminder = getReminderById(reminderId);
      const mod = await extractModification(`期限を ${dueAtRaw} に変更して`, reminder);
      if (mod?.due_at) update.dueAt = mod.due_at;
    } catch (e) {
      console.error('[bulk_modify_modal] due_at parse error:', e.message);
    }
  }

  if (advanceHoursStr !== null) {
    update.advanceNoticeHours = parseInt(advanceHoursStr, 10);
  }

  if (Object.keys(update).length > 0) {
    updateReminder(reminderId, update);
  }

  await refreshBulkMessage(client, channel, confirmationTs);
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
