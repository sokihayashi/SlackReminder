const cron = require('node-cron');
const { getPendingDueReminders, getUnnotifiedPendingReminders, getAllPending, getRecentlySentReminders, markSent, markFailed, markAdvanceNotified, getSetting, setSetting } = require('./db');
const { formatDueAt, formatHours, displayAssignee, silentDisplayAssignee, DEFAULT_ADVANCE_NOTICE_HOURS } = require('./utils');

const UNRECOVERABLE_CODES = ['user_not_found', 'user_disabled', 'account_inactive', 'no_such_channel'];
function isUnrecoverable(err) {
  return UNRECOVERABLE_CODES.some(c => err.code === c || err.message?.includes(c));
}

function dueDateJST(isoString) {
  return new Date(isoString).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
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

  const allUnnotified = getUnnotifiedPendingReminders();
  if (allUnnotified.length === 0) return;

  // Group by (assignee_slack_user_id OR thread-key, due_date_JST).
  // Within each group the earliest fire time = due_at - max(advance_notice_hours).
  // If that time has passed, notify ALL tasks in the group at once.
  const dmGroups   = new Map(); // `${userId}:${dueDateJST}` → reminder[]
  const threadGroups = new Map(); // `${channel}:${thread_ts}:${dueDateJST}` → reminder[]
  const noUserIdReminders = [];

  for (const r of allUnnotified) {
    const dateKey = dueDateJST(r.due_at);
    if (r.notification_target === 'thread') {
      const key = `${r.source_channel_id}:${r.source_thread_ts}:${dateKey}`;
      if (!threadGroups.has(key)) threadGroups.set(key, []);
      threadGroups.get(key).push(r);
    } else if (r.assignee_slack_user_id) {
      const key = `${r.assignee_slack_user_id}:${dateKey}`;
      if (!dmGroups.has(key)) dmGroups.set(key, []);
      dmGroups.get(key).push(r);
    } else {
      noUserIdReminders.push(r);
    }
  }

  // Mark no-user-id reminders as notified (can't DM without a user ID)
  for (const r of noUserIdReminders) markAdvanceNotified(r.id);

  // Process DM groups
  for (const [, reminders] of dmGroups) {
    // Fire when the earliest window (= largest advance_notice_hours) in the group has passed
    const maxWindow = Math.max(...reminders.map(r => r.advance_notice_hours ?? globalHours));
    const earliestDueAt = Math.min(...reminders.map(r => new Date(r.due_at).getTime()));
    const earliestFireTime = earliestDueAt - maxWindow * 60 * 60 * 1000;
    if (earliestFireTime > now) continue;

    const userId = reminders[0].assignee_slack_user_id;
    try {
      const dm = await client.conversations.open({ users: userId });
      await client.chat.postMessage({
        channel: dm.channel.id,
        ...buildAdvanceNoticeMessage(reminders, globalHours, /* isDm */ true),
      });
      for (const r of reminders) markAdvanceNotified(r.id);
      console.log(`[scheduler] Advance notice (DM, ${reminders.length} task(s)) → ${userId}`);
    } catch (err) {
      console.error(`[scheduler] Advance notice DM failed for ${userId}:`, err.message);
      if (isUnrecoverable(err)) for (const r of reminders) markAdvanceNotified(r.id);
    }
  }

  // Process thread groups
  for (const [, reminders] of threadGroups) {
    const maxWindow = Math.max(...reminders.map(r => r.advance_notice_hours ?? globalHours));
    const earliestDueAt = Math.min(...reminders.map(r => new Date(r.due_at).getTime()));
    const earliestFireTime = earliestDueAt - maxWindow * 60 * 60 * 1000;
    if (earliestFireTime > now) continue;

    const r0 = reminders[0];
    try {
      await client.chat.postMessage({
        channel: r0.source_channel_id,
        thread_ts: r0.source_thread_ts,
        ...buildAdvanceNoticeMessage(reminders, globalHours, /* isDm */ false),
      });
      for (const r of reminders) markAdvanceNotified(r.id);
      console.log(`[scheduler] Advance notice (thread, ${reminders.length} task(s)) → ${r0.source_channel_id}/${r0.source_thread_ts}`);
    } catch (err) {
      console.error(`[scheduler] Advance notice thread failed:`, err.message);
      if (isUnrecoverable(err)) for (const r of reminders) markAdvanceNotified(r.id);
    }
  }
}

function buildAdvanceNoticeMessage(reminders, globalHours, isDm) {
  if (reminders.length === 1) {
    const r = reminders[0];
    const windowHours = r.advance_notice_hours ?? globalHours;
    const hoursLabel = formatHours(windowHours);
    const prefix = isDm ? '' : `${displayAssignee(r)} `;
    const srcLine = isDm ? `\n*依頼元：* <#${r.source_channel_id}>` : '';
    return {
      text: `${prefix}⏰ ${hoursLabel}後に期限のリマインドです。`,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `${prefix}*⏰ ${hoursLabel}後に期限のリマインドです。*\n\n*内容：* ${r.task}\n*期限：* ${formatDueAt(r.due_at)}${srcLine}` },
      }],
    };
  }

  // Multiple tasks — build a list
  const windowHours = Math.max(...reminders.map(r => r.advance_notice_hours ?? globalHours));
  const hoursLabel = formatHours(windowHours);
  const header = isDm
    ? `*⏰ ${hoursLabel}以内に期限のタスクが ${reminders.length} 件あります。*`
    : `*⏰ 期限が近いタスクが ${reminders.length} 件あります。（${hoursLabel}以内）*`;

  const lines = reminders.map((r, i) => {
    const srcLine = isDm ? `　依頼元: <#${r.source_channel_id}>` : '';
    const assigneePart = isDm ? '' : `${displayAssignee(r)} `;
    return `${i + 1}. ${assigneePart}*${r.task}*\n　　期限: ${formatDueAt(r.due_at)}${srcLine}`;
  }).join('\n');

  return {
    text: `⏰ 期限が近いタスクが ${reminders.length} 件あります。`,
    blocks: [{
      type: 'section',
      text: { type: 'mrkdwn', text: `${header}\n\n${lines}` },
    }],
  };
}

async function processDueReminders(client) {
  const reminders = getPendingDueReminders();
  if (reminders.length === 0) return;

  console.log(`[scheduler] ${reminders.length} reminder(s) due`);

  // Group by assignee (DM) or thread, then send one message per group
  const dmGroups     = new Map(); // assignee_slack_user_id → reminder[]
  const threadGroups = new Map(); // `${channel}:${thread_ts}` → reminder[]

  for (const r of reminders) {
    if (r.notification_target === 'thread') {
      const key = `${r.source_channel_id}:${r.source_thread_ts}`;
      if (!threadGroups.has(key)) threadGroups.set(key, []);
      threadGroups.get(key).push(r);
    } else {
      if (!r.assignee_slack_user_id) {
        console.error(`[scheduler] Reminder ${r.id} has no Slack user ID — marking failed`);
        markFailed(r.id);
        continue;
      }
      if (!dmGroups.has(r.assignee_slack_user_id)) dmGroups.set(r.assignee_slack_user_id, []);
      dmGroups.get(r.assignee_slack_user_id).push(r);
    }
  }

  for (const [userId, group] of dmGroups) {
    try {
      const dm = await client.conversations.open({ users: userId });
      await client.chat.postMessage({
        channel: dm.channel.id,
        ...buildDueMessage(group, /* isDm */ true),
      });
      for (const r of group) markSent(r.id);
      console.log(`[scheduler] Due reminder (DM, ${group.length} task(s)) → ${userId}`);
    } catch (err) {
      console.error(`[scheduler] Due reminder DM failed for ${userId}:`, err.message);
      for (const r of group) markFailed(r.id);
    }
  }

  for (const [, group] of threadGroups) {
    const r0 = group[0];
    try {
      await client.chat.postMessage({
        channel: r0.source_channel_id,
        thread_ts: r0.source_thread_ts,
        ...buildDueMessage(group, /* isDm */ false),
      });
      for (const r of group) markSent(r.id);
      console.log(`[scheduler] Due reminder (thread, ${group.length} task(s)) → ${r0.source_channel_id}`);
    } catch (err) {
      console.error(`[scheduler] Due reminder thread failed:`, err.message);
      for (const r of group) markFailed(r.id);
    }
  }
}

function buildDueMessage(reminders, isDm) {
  if (reminders.length === 1) {
    const r = reminders[0];
    const prefix = isDm ? '' : `${displayAssignee(r)} `;
    const srcLine = isDm ? `\n*依頼元：* <#${r.source_channel_id}>` : '';
    return {
      text: `${prefix}リマインドです。`,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `${prefix}*リマインドです。*\n\n*内容：* ${r.task}\n*期限：* ${formatDueAt(r.due_at)}${srcLine}` },
      }],
    };
  }

  const header = `*リマインド：期限を迎えたタスクが ${reminders.length} 件あります。*`;

  const lines = reminders.map((r, i) => {
    const srcLine = isDm ? `　依頼元: <#${r.source_channel_id}>` : '';
    const assigneePart = isDm ? '' : `${displayAssignee(r)} `;
    return `${i + 1}. ${assigneePart}*${r.task}*\n　　期限: ${formatDueAt(r.due_at)}${srcLine}`;
  }).join('\n');

  return {
    text: `リマインド：期限を迎えたタスクが ${reminders.length} 件あります。`,
    blocks: [{
      type: 'section',
      text: { type: 'mrkdwn', text: `${header}\n\n${lines}` },
    }],
  };
}

async function postWeeklySummary(client) {
  const channelId = getSetting('summary_channel_id', '');
  if (!channelId) return;

  const pending = getAllPending();
  const sent = getRecentlySentReminders(7);
  const today = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  if (pending.length === 0 && sent.length === 0) {
    await client.chat.postMessage({
      channel: channelId,
      text: `📋 *週次タスクサマリー（${today}）*\n\nペンディング中・直近通知済みのタスクはありません。`,
    });
    return;
  }

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📋 週次タスクサマリー（${today}）` } },
  ];

  if (pending.length > 0) {
    const lines = await Promise.all(pending.map(async (r, i) => {
      const assignee = await silentDisplayAssignee(client, r);
      const statusLabel = r.status === 'draft' ? '⏳未確認' : '✅確認済み';
      return `${i + 1}. *${r.task}*\n　担当：${assignee}　期限：${formatDueAt(r.due_at)}　${statusLabel}`;
    }));
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*📌 ペンディング中 (${pending.length}件)*\n\n${lines.join('\n\n')}` } });
  }

  if (sent.length > 0) {
    const sentLines = await Promise.all(sent.map(async (r, i) => {
      const assignee = await silentDisplayAssignee(client, r);
      return `${i + 1}. *${r.task}*\n　担当：${assignee}　期限：${formatDueAt(r.due_at)}`;
    }));
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*📬 最近通知済み（過去7日・${sent.length}件）*\n\n${sentLines.join('\n\n')}` } });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `ペンディング ${pending.length}件 / 通知済み ${sent.length}件` }],
  });

  try {
    await client.chat.postMessage({
      channel: channelId,
      text: `📋 週次タスクサマリー（${today}）— ペンディング ${pending.length}件 / 通知済み ${sent.length}件`,
      blocks,
    });
    console.log(`[scheduler] Weekly summary posted to ${channelId} (pending=${pending.length}, sent=${sent.length})`);
  } catch (err) {
    console.error(`[scheduler] Weekly summary failed for channel ${channelId}:`, err.message);
    if (isUnrecoverable(err)) {
      setSetting('summary_channel_id', '');
      console.log('[scheduler] Summary channel cleared due to unrecoverable error');
    }
  }
}

module.exports = { startScheduler };
