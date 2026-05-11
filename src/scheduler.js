const cron = require('node-cron');
const { getPendingDueReminders, markSent, markFailed } = require('./db');
const { formatDueAt } = require('./utils');

function startScheduler(client) {
  // Poll every minute for due reminders
  cron.schedule('* * * * *', async () => {
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
        // Open (or reuse) a DM conversation with the assignee
        const dmResult = await client.conversations.open({ users: reminder.assignee_slack_user_id });
        const dmChannel = dmResult.channel.id;

        await client.chat.postMessage({
          channel: dmChannel,
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

        // Use optimistic status update to prevent double-sends
        markSent(reminder.id);
        console.log(`[scheduler] Sent reminder ${reminder.id} → ${reminder.assignee_slack_user_id}`);
      } catch (err) {
        console.error(`[scheduler] Failed to send reminder ${reminder.id}:`, err.message);
        markFailed(reminder.id);
      }
    }
  });

  console.log('[scheduler] Started — checking every minute');
}

module.exports = { startScheduler };
