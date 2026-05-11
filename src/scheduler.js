const cron = require('node-cron');
const { getPendingDueReminders, markSent, markFailed, getRemindersForAdvanceNotice, markAdvanceNotified } = require('./db');
const { formatDueAt } = require('./utils');

function startScheduler(client) {
  cron.schedule('* * * * *', async () => {
    await processAdvanceNotices(client);
    await processDueReminders(client);
  });

  console.log('[scheduler] Started — checking every minute');
}

async function processAdvanceNotices(client) {
  const reminders = getRemindersForAdvanceNotice();
  for (const reminder of reminders) {
    if (!reminder.assignee_slack_user_id) {
      markAdvanceNotified(reminder.id);
      continue;
    }
    try {
      const dmResult = await client.conversations.open({ users: reminder.assignee_slack_user_id });
      await client.chat.postMessage({
        channel: dmResult.channel.id,
        text: `*⏰ 明日期限のリマインドです。*\n\n内容：${reminder.task}\n期限：${formatDueAt(reminder.due_at)}\n依頼元：<#${reminder.source_channel_id}>`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*⏰ 明日期限のリマインドです。*\n\n*内容：* ${reminder.task}\n*期限：* ${formatDueAt(reminder.due_at)}\n*依頼元：* <#${reminder.source_channel_id}>`,
            },
          },
        ],
      });
      markAdvanceNotified(reminder.id);
      console.log(`[scheduler] Advance notice sent for ${reminder.id} → ${reminder.assignee_slack_user_id}`);
    } catch (err) {
      console.error(`[scheduler] Advance notice failed for ${reminder.id}:`, err.message);
    }
  }
}

async function processDueReminders(client) {
  const reminders = getPendingDueReminders();
  if (reminders.length === 0) return;

  console.log(`[scheduler] ${reminders.length} reminder(s) due`);

  for (const reminder of reminders) {
    if (!reminder.assignee_slack_user_id) {
      console.error(`[scheduler] Reminder ${reminder.id} has no Slack user ID — marking failed`);
      markFailed(reminder.id);
      continue;
    }
    try {
      const dmResult = await client.conversations.open({ users: reminder.assignee_slack_user_id });
      await client.chat.postMessage({
        channel: dmResult.channel.id,
        text: `*リマインドです。*\n\n内容：${reminder.task}\n期限：${formatDueAt(reminder.due_at)}\n依頼元：<#${reminder.source_channel_id}>`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*リマインドです。*\n\n*内容：* ${reminder.task}\n*期限：* ${formatDueAt(reminder.due_at)}\n*依頼元：* <#${reminder.source_channel_id}>`,
            },
          },
        ],
      });
      markSent(reminder.id);
      console.log(`[scheduler] Sent reminder ${reminder.id} → ${reminder.assignee_slack_user_id}`);
    } catch (err) {
      console.error(`[scheduler] Failed to send reminder ${reminder.id}:`, err.message);
      markFailed(reminder.id);
    }
  }
}

module.exports = { startScheduler };
