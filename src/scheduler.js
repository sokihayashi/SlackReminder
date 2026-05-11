const cron = require('node-cron');
const { getPendingDueReminders, getUnnotifiedPendingReminders, getAllPending, markSent, markFailed, markAdvanceNotified, getSetting, setSetting } = require('./db');
const { formatDueAt, formatHours, DEFAULT_ADVANCE_NOTICE_HOURS } = require('./utils');

const UNRECOVERABLE_CODES = ['user_not_found', 'user_disabled', 'account_inactive', 'no_such_channel', 'channel_not_found'];

function isUnrecoverable(err) {
  return UNRECOVERABLE_CODES.some(c => err.code === c || err.message?.includes(c));
}

function startScheduler(client) {
  cron.schedule('* * * * *', async () => {
    await processAdvanceNotices(client);
    await processDueReminders(client);
  });

  // 毎週月曜 9:00 JST (= 0:00 UTC)
  cron.schedule('0 0 * * 1', async () => {
    await postWeeklySummary(client);
  }, { timezone: 'Asia/Tokyo' });

  console.log('[scheduler] Started — checking every minute');
}

async function processAdvanceNotices(client) {
  const globalHours = parseInt(getSetting('advance_notice_hours', String(DEFAULT_ADVANCE_NOTICE_HOURS)), 10);
  const now = Date.now();

  for (const reminder of getUnnotifiedPendingReminders()) {
    const windowHours = reminder.advance_notice_hours ?? globalHours;
    if (new Date(reminder.due_at).getTime() - windowHours * 60 * 60 * 1000 > now) continue;

    const hoursLabel = formatHours(windowHours);
    const assigneeDisplay = reminder.assignee_slack_user_id
      ? `<@${reminder.assignee_slack_user_id}>`
      : reminder.assignee_name;
    const bodyText = `*⏰ ${hoursLabel}後に期限のリマインドです。*\n\n*内容：* ${reminder.task}\n*期限：* ${formatDueAt(reminder.due_at)}`;

    try {
      if (reminder.notification_target === 'thread') {
        await client.chat.postMessage({
          channel: reminder.source_channel_id,
          thread_ts: reminder.source_thread_ts,
          text: `${assigneeDisplay} ⏰ ${hoursLabel}後に期限のリマインドです。`,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${assigneeDisplay} ${bodyText}` } }],
        });
      } else {
        if (!reminder.assignee_slack_user_id) { markAdvanceNotified(reminder.id); continue; }
        const dm = await client.conversations.open({ users: reminder.assignee_slack_user_id });
        await client.chat.postMessage({
          channel: dm.channel.id,
          text: `⏰ ${hoursLabel}後に期限のリマインドです。`,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${bodyText}\n*依頼元：* <#${reminder.source_channel_id}>` } }],
        });
      }
      markAdvanceNotified(reminder.id);
      console.log(`[scheduler] Advance notice (${reminder.notification_target}) sent for ${reminder.id}`);
    } catch (err) {
      console.error(`[scheduler] Advance notice failed for ${reminder.id}:`, err.message);
      if (isUnrecoverable(err)) {
        markAdvanceNotified(reminder.id);
        console.warn(`[scheduler] Unrecoverable error — skipping advance notice for ${reminder.id}`);
      }
    }
  }
}

async function processDueReminders(client) {
  const reminders = getPendingDueReminders();
  if (reminders.length === 0) return;

  console.log(`[scheduler] ${reminders.length} reminder(s) due`);

  for (const reminder of reminders) {
    const assigneeDisplay = reminder.assignee_slack_user_id
      ? `<@${reminder.assignee_slack_user_id}>`
      : reminder.assignee_name;
    const bodyText = `*リマインドです。*\n\n*内容：* ${reminder.task}\n*期限：* ${formatDueAt(reminder.due_at)}`;

    try {
      if (reminder.notification_target === 'thread') {
        await client.chat.postMessage({
          channel: reminder.source_channel_id,
          thread_ts: reminder.source_thread_ts,
          text: `${assigneeDisplay} リマインドです。`,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${assigneeDisplay} ${bodyText}` } }],
        });
      } else {
        if (!reminder.assignee_slack_user_id) {
          console.error(`[scheduler] Reminder ${reminder.id} has no Slack user ID — marking failed`);
          markFailed(reminder.id);
          continue;
        }
        const dm = await client.conversations.open({ users: reminder.assignee_slack_user_id });
        await client.chat.postMessage({
          channel: dm.channel.id,
          text: 'リマインドです。',
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${bodyText}\n*依頼元：* <#${reminder.source_channel_id}>` } }],
        });
      }
      markSent(reminder.id);
      console.log(`[scheduler] Sent (${reminder.notification_target}) reminder ${reminder.id}`);
    } catch (err) {
      console.error(`[scheduler] Failed to send reminder ${reminder.id}:`, err.message);
      if (isUnrecoverable(err)) {
        console.warn(`[scheduler] Unrecoverable error — marking failed for ${reminder.id}`);
      }
      markFailed(reminder.id);
    }
  }
}

async function postWeeklySummary(client) {
  const channelId = getSetting('summary_channel_id', '');
  if (!channelId) return;

  const reminders = getAllPending();
  const today = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  if (reminders.length === 0) {
    try {
      await client.chat.postMessage({
        channel: channelId,
        text: `📋 *週次タスクサマリー（${today}）*\n\n現在ペンディング中のタスクはありません。`,
      });
    } catch (err) {
      console.error(`[scheduler] Weekly summary (empty) failed for channel ${channelId}:`, err.message);
      if (isUnrecoverable(err)) {
        setSetting('summary_channel_id', '');
        console.warn(`[scheduler] Cleared summary_channel_id — channel no longer accessible`);
      }
    }
    return;
  }

  const lines = reminders.map((r, i) => {
    const assignee = r.assignee_slack_user_id ? `<@${r.assignee_slack_user_id}>` : r.assignee_name;
    const statusLabel = r.status === 'draft' ? '⏳未確認' : '✅確認済み';
    return `${i + 1}. *${r.task}*\n　担当：${assignee}　期限：${formatDueAt(r.due_at)}　${statusLabel}`;
  });

  try {
    await client.chat.postMessage({
      channel: channelId,
      text: `📋 *週次タスクサマリー（${today}）*\n\n${lines.join('\n\n')}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `📋 週次タスクサマリー（${today}）` },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: lines.join('\n\n') },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `合計 ${reminders.length} 件のペンディングタスク` }],
        },
      ],
    });
    console.log(`[scheduler] Weekly summary posted to ${channelId} (${reminders.length} tasks)`);
  } catch (err) {
    console.error(`[scheduler] Weekly summary failed for channel ${channelId}:`, err.message);
    if (isUnrecoverable(err)) {
      setSetting('summary_channel_id', '');
      console.warn(`[scheduler] Cleared summary_channel_id — channel no longer accessible`);
    }
  }
}

module.exports = { startScheduler };
