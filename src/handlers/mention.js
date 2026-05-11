const { extractReminder } = require('../ai');
const {
  createReminder, setConfirmationTs, setNotificationTarget,
  getAllPending, getPendingByAssignee,
  getSetting, setSetting, getAllSettings,
} = require('../db');
const { formatDueAt, formatHours, CONFIDENCE_THRESHOLD, DEFAULT_ADVANCE_NOTICE_HOURS } = require('../utils');
const botConfig = require('../botConfig');

async function handleMention({ event, client }) {
  const { text, channel, ts, thread_ts, user } = event;
  const replyThreadTs = thread_ts || ts;

  console.log(`[mention] user=${user} channel=${channel}`);

  try {
    // Fast-path: keyword match before calling AI
    const bare = text.replace(/<@[^>]+>/g, '').trim();
    if (/^(ヘルプ|help|使い方|つかいかた)\??$/i.test(bare)) {
      await postHelp(channel, replyThreadTs, client);
      return;
    }

    const threadMessages = await fetchThreadContext(client, channel, thread_ts, ts);
    const extraction = await extractReminder(text, new Date(), threadMessages);

    switch (extraction.intent) {
      case 'query_tasks':           return handleTaskQuery(extraction, channel, replyThreadTs, client);
      case 'update_setting':        return handleUpdateSetting(extraction, channel, replyThreadTs, client);
      case 'set_summary_channel':   return handleSetSummaryChannel(channel, replyThreadTs, client);
      case 'remove_summary_channel':return handleRemoveSummaryChannel(channel, replyThreadTs, client);
      case 'show_settings':         return handleShowSettings(channel, replyThreadTs, client);
    }

    if (!extraction.should_create_reminder) {
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `リマインド対象のタスクが見つかりませんでした。\n理由：${extraction.reason || '不明'}`,
      });
      return;
    }

    if (extraction.confidence < CONFIDENCE_THRESHOLD || extraction.missing_fields?.length > 0) {
      const missing = extraction.missing_fields?.length > 0
        ? extraction.missing_fields.join('、')
        : '日時または担当者';
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `リマインドの作成に必要な情報が不足しています。\n不足情報：*${missing}*\n\nもう少し詳しく教えてください。`,
      });
      return;
    }

    const { assigneeSlackUserId, assigneeName } = resolveAssignee(extraction.assignee);

    const notifTarget = extraction.notification_target === 'thread' ? 'thread' : 'dm';

    const reminderId = createReminder({
      task: extraction.task,
      assigneeName,
      assigneeSlackUserId,
      dueAt: extraction.due_at,
      sourceChannelId: channel,
      sourceMessageTs: ts,
      sourceThreadTs: replyThreadTs,
      createdBy: user,
      confidence: extraction.confidence,
      advanceNoticeHours: extraction.advance_notice_hours ?? null,
      notificationTarget: notifTarget,
    });

    const dueDisplay = formatDueAt(extraction.due_at);
    const assigneeDisplay = assigneeSlackUserId ? `<@${assigneeSlackUserId}>` : assigneeName;
    const noticeHours = extraction.advance_notice_hours
      ?? parseInt(getSetting('advance_notice_hours', String(DEFAULT_ADVANCE_NOTICE_HOURS)), 10);
    const noticeLabel = formatHours(noticeHours);

    const confirmMsg = await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: `リマインド候補を作成しました。\n担当：${assigneeDisplay}\n期限：${dueDisplay}\n内容：${extraction.task}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*リマインド候補を作成しました。*\n\n*担当：* ${assigneeDisplay}\n*期限：* ${dueDisplay}\n*内容：* ${extraction.task}`,
          },
        },
        notificationTargetBlock(notifTarget),
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `事前通知：${noticeLabel}前　|　✅ 登録　❌ キャンセル　※スレッドに返信で修正可`,
            },
          ],
        },
      ],
    });

    setConfirmationTs(reminderId, confirmMsg.ts);
    await client.reactions.add({ channel, timestamp: confirmMsg.ts, name: 'white_check_mark' });
    await client.reactions.add({ channel, timestamp: confirmMsg.ts, name: 'x' });
  } catch (err) {
    console.error('[mention] Error:', err);
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: 'エラーが発生しました。しばらく後にもう一度お試しください。',
    });
  }
}

// ── Intent handlers ───────────────────────────────────────────────────────────

async function handleTaskQuery(extraction, channel, replyThreadTs, client) {
  const queryUserId = extractUserId(extraction.query_assignee);
  const reminders = queryUserId ? getPendingByAssignee(queryUserId) : getAllPending();
  const headerText = queryUserId ? `<@${queryUserId}> のタスク一覧` : 'ペンディングタスク一覧';

  if (reminders.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: `*${headerText}*\n\n現在ペンディング中のタスクはありません。`,
    });
    return;
  }

  const lines = reminders.map((r, i) => {
    const assignee = r.assignee_slack_user_id ? `<@${r.assignee_slack_user_id}>` : r.assignee_name;
    const statusLabel = r.status === 'draft' ? '未確認' : '確認済み';
    return `${i + 1}. *${r.task}*\n　担当：${assignee}　期限：${formatDueAt(r.due_at)}　[${statusLabel}]`;
  });

  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `*${headerText}*\n\n${lines.join('\n\n')}`,
  });
}

async function handleUpdateSetting(extraction, channel, replyThreadTs, client) {
  const { setting_key: key, setting_value: value } = extraction;

  if (key === 'advance_notice_hours') {
    const hours = parseInt(value, 10);
    if (Number.isFinite(hours) && hours >= 0) {
      // 具体的な時間が指定された場合はすぐ保存
      setSetting('advance_notice_hours', String(hours));
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `⚙️ 事前通知タイミングを *${formatHours(hours)}前* に設定しました。`,
      });
    } else {
      // 時間が不明な場合はボタンを表示
      await postAdvanceNoticeButtons(channel, replyThreadTs, client);
    }
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `不明な設定キーです：\`${key}\``,
  });
}

async function handleSetSummaryChannel(channel, replyThreadTs, client) {
  setSetting('summary_channel_id', channel);
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `📋 このチャンネルを週次タスクサマリーの送信先に設定しました。\n毎週月曜 9:00 にペンディングタスクをまとめて投稿します。`,
  });
}

async function handleRemoveSummaryChannel(channel, replyThreadTs, client) {
  const current = getSetting('summary_channel_id');
  if (current !== channel) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: 'このチャンネルはサマリー送信先として設定されていません。',
    });
    return;
  }
  setSetting('summary_channel_id', '');
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: '📋 週次タスクサマリーの設定を解除しました。',
  });
}

async function handleShowSettings(channel, replyThreadTs, client) {
  const advanceHours = parseInt(getSetting('advance_notice_hours', String(DEFAULT_ADVANCE_NOTICE_HOURS)), 10);
  const summaryChannelId = getSetting('summary_channel_id', '');
  const summaryLine = summaryChannelId
    ? `*週次サマリー：* <#${summaryChannelId}>（毎週月曜 9:00）`
    : `*週次サマリー：* 未設定`;

  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `⚙️ 現在の設定`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚙️ *現在の設定*\n\n*事前通知タイミング：* ${formatHours(advanceHours)}前\n${summaryLine}`,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*事前通知タイミングを変更：*' },
      },
      advanceNoticeActionsBlock(),
    ],
  });
}

function notificationTargetBlock(current) {
  const dm = { type: 'button', text: { type: 'plain_text', text: '📱 DM' }, value: 'dm', action_id: 'set_notification_target' };
  const thread = { type: 'button', text: { type: 'plain_text', text: '💬 スレッド' }, value: 'thread', action_id: 'set_notification_target' };
  if (current === 'dm') dm.style = 'primary';
  else thread.style = 'primary';
  return { type: 'actions', elements: [dm, thread] };
}

function advanceNoticeActionsBlock() {
  const options = [
    { label: '12時間前', value: '12' },
    { label: '1日前',   value: '24' },
    { label: '2日前',   value: '48' },
    { label: '3日前',   value: '72' },
    { label: '1週間前', value: '168' },
  ];
  return {
    type: 'actions',
    elements: options.map(o => ({
      type: 'button',
      text: { type: 'plain_text', text: o.label },
      value: o.value,
      action_id: `set_advance_notice_hours__${o.value}`,
    })),
  };
}

async function postAdvanceNoticeButtons(channel, replyThreadTs, client) {
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: '事前通知タイミングを選択してください',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '⚙️ *事前通知タイミングを選択してください：*' },
      },
      advanceNoticeActionsBlock(),
    ],
  });
}

async function postHelp(channel, replyThreadTs, client) {
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: 'Reminder Bot の使い方',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📌 Reminder Bot の使い方' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*リマインド登録*\nメンションして依頼内容を書くだけ。スレッドの途中でメンションすると会話から文脈を読み取ります。\n```@Reminder Bot @田中 台本の初稿、金曜17時まで\n@Reminder Bot @yamada 編集書き出し 来週月曜 2日前に通知して```',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*リアクション操作*\n✅ → 登録確定　❌ → キャンセル\nキャンセル後に ✅ → 再登録\n確認メッセージのスレッドに返信 → 担当者・期限の修正や再登録',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*タスク一覧*\n```@Reminder Bot タスク一覧\n@Reminder Bot @田中 のタスク```',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*設定*\n```@Reminder Bot 設定確認\n@Reminder Bot 設定: 事前通知 2日前\n@Reminder Bot このチャンネルにタスクサマリーを設定\n@Reminder Bot サマリーを解除```',
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '週次サマリーは毎週月曜 9:00 に送信先チャンネルへ自動投稿されます。',
          },
        ],
      },
    ],
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchThreadContext(client, channel, thread_ts, currentTs) {
  if (!thread_ts) return [];
  try {
    const result = await client.conversations.replies({ channel, ts: thread_ts, limit: 10 });
    return (result.messages || [])
      .filter(m => m.user && m.user !== botConfig.botUserId && m.ts !== currentTs)
      .slice(-5)
      .map(m => ({ user: m.user, text: m.text }));
  } catch (e) {
    console.error('[mention] Failed to fetch thread context:', e.message);
    return [];
  }
}

function resolveAssignee(rawAssignee) {
  const name = rawAssignee || '(未設定)';
  const m = name.match(/^<@(U[A-Z0-9]+)>$/) || name.match(/^(U[A-Z0-9]{6,})$/);
  if (m) return { assigneeSlackUserId: m[1], assigneeName: `<@${m[1]}>` };
  return { assigneeSlackUserId: null, assigneeName: name };
}

function extractUserId(raw) {
  if (!raw) return null;
  const m = raw.match(/^<@(U[A-Z0-9]+)>$/) || raw.match(/^(U[A-Z0-9]{6,})$/);
  return m ? m[1] : null;
}

module.exports = { handleMention };
