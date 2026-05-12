const { extractReminder, resolveCancelTarget, extractTasksFromThread } = require('../ai');
const {
  createReminder, setConfirmationTs, setNotificationTarget,
  getAllPending, getPendingByAssignee, cancelReminder, approveReminder,
  getSetting, setSetting, getAllSettings,
  savePendingQuestion, deletePendingQuestion, findByThreadTs,
} = require('../db');
const { formatDueAt, formatHours, displayAssignee, silentAssigneeDisplay, silentDisplayAssignee, getDisplayName, CONFIDENCE_THRESHOLD, DEFAULT_ADVANCE_NOTICE_HOURS } = require('../utils');
const botConfig = require('../botConfig');

async function handleMention({ event, client, priorText = null }) {
  const { text, channel, ts, thread_ts, user } = event;
  const replyThreadTs = thread_ts || ts;

  console.log(`[mention] user=${user} channel=${channel}${priorText ? ' (follow-up)' : ''}`);

  try {
    // Fast-path: keyword match before calling AI (only for first-turn)
    if (!priorText) {
      const bare = text.replace(/<@[^>]+>/g, '').trim();
      if (/^(ヘルプ|help|使い方|つかいかた)\??$/i.test(bare)) {
        await postHelp(channel, replyThreadTs, client);
        return;
      }
    }

    const threadMessages = await fetchThreadContext(client, channel, thread_ts, ts);
    const botMentionPattern = botConfig.botUserId
      ? new RegExp(`<@${botConfig.botUserId}>`, 'g')
      : null;
    const stripBot = (s) => botMentionPattern ? s.replace(botMentionPattern, '').trim() : s;
    const cleanText = priorText
      ? `${stripBot(priorText)}\n${stripBot(text)}`
      : stripBot(text);
    const extraction = await extractReminder(cleanText, new Date(), threadMessages);

    switch (extraction.intent) {
      case 'query_tasks':           return handleTaskQuery(extraction, channel, replyThreadTs, client);
      case 'cancel_reminder':       return handleCancelReminder(text, channel, replyThreadTs, client);
      case 'update_setting':        return handleUpdateSetting(extraction, channel, replyThreadTs, client);
      case 'set_summary_channel':   return handleSetSummaryChannel(channel, replyThreadTs, client);
      case 'remove_summary_channel':return handleRemoveSummaryChannel(channel, replyThreadTs, client);
      case 'show_settings':         return handleShowSettings(channel, replyThreadTs, client);
      case 'extract_from_thread':   return handleExtractFromThread(channel, thread_ts, replyThreadTs, ts, user, client);
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
      savePendingQuestion({
        channelId: channel,
        threadTs: replyThreadTs,
        originalText: cleanText,
        sourceMessageTs: ts,
        createdBy: user,
      });
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `リマインドの作成に必要な情報が不足しています。\n不足情報：*${missing}*\n\nこのスレッドに返信して詳細を教えてください（メンション不要）。`,
      });
      return;
    }

    const { assigneeSlackUserId, assigneeName } = resolveAssignee(extraction.assignee);

    if (!assigneeSlackUserId && !assigneeName) {
      savePendingQuestion({
        channelId: channel,
        threadTs: replyThreadTs,
        originalText: cleanText,
        sourceMessageTs: ts,
        createdBy: user,
      });
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: 'リマインドの作成に必要な情報が不足しています。\n不足情報：*担当者*\n\n担当する人をスレッド返信でメンションしてください（bot へのメンション不要）。',
      });
      return;
    }

    deletePendingQuestion(channel, replyThreadTs);

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
    const assigneeDisplay = await silentAssigneeDisplay(client, assigneeSlackUserId, assigneeName);
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

// ── Intent handlers ──────────────────────────────────────────────────────────────

async function handleTaskQuery(extraction, channel, replyThreadTs, client) {
  const queryUserId = extractUserId(extraction.query_assignee);
  const reminders = queryUserId ? getPendingByAssignee(queryUserId) : getAllPending();
  let headerText = 'ペンディングタスク一覧';
  if (queryUserId) {
    const name = await getDisplayName(client, queryUserId);
    headerText = `${name ? `@${name}` : 'ユーザー'} のタスク一覧`;
  }

  if (reminders.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: `*${headerText}*\n\n現在ペンディング中のタスクはありません。`,
    });
    return;
  }

  const lines = await Promise.all(reminders.map(async (r, i) => {
    const assignee = await silentDisplayAssignee(client, r);
    const statusLabel = r.status === 'draft' ? '未確認' : '確認済み';
    return `${i + 1}. *${r.task}*\n　担当：${assignee}　期限：${formatDueAt(r.due_at)}　[${statusLabel}]`;
  }));

  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `*${headerText}*\n\n${lines.join('\n\n')}`,
  });
}

async function handleCancelReminder(text, channel, replyThreadTs, client) {
  const pending = getAllPending();

  if (pending.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: 'キャンセル対象のペンディングリマインドが見つかりませんでした。',
    });
    return;
  }

  const { scope, reminder_id, assignee_filter } = await resolveCancelTarget(text, pending);

  switch (scope) {
    case 'all':         return cancelAll(pending, channel, replyThreadTs, client);
    case 'one':         return cancelOne(reminder_id, pending, channel, replyThreadTs, client);
    case 'by_assignee': return cancelByAssignee(assignee_filter, pending, channel, replyThreadTs, client);
    default:            return showAmbiguousList(pending, channel, replyThreadTs, client);
  }
}

async function cancelAll(pending, channel, replyThreadTs, client) {
  for (const r of pending) cancelReminder(r.id);
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `❌ ${pending.length}件のリマインドをすべてキャンセルしました。`,
  });
}

async function cancelOne(reminderId, pending, channel, replyThreadTs, client) {
  const r = pending.find(p => p.id === reminderId);
  if (!r) return showAmbiguousList(pending, channel, replyThreadTs, client);

  cancelReminder(r.id);
  const assignee = await silentDisplayAssignee(client, r);
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `❌ リマインドをキャンセルしました。\n*内容：* ${r.task}　*担当：* ${assignee}　*期限：* ${formatDueAt(r.due_at)}`,
  });
}

async function cancelByAssignee(assigneeFilter, pending, channel, replyThreadTs, client) {
  if (!assigneeFilter) return showAmbiguousList(pending, channel, replyThreadTs, client);

  const assigneeId = extractUserId(assigneeFilter);
  const matched = pending.filter(r =>
    assigneeId
      ? r.assignee_slack_user_id === assigneeId
      : r.assignee_name?.includes(assigneeFilter)
  );
  if (matched.length === 0) return showAmbiguousList(pending, channel, replyThreadTs, client);

  for (const r of matched) cancelReminder(r.id);
  let label;
  if (assigneeId) {
    const name = await getDisplayName(client, assigneeId);
    label = name ? `@${name}` : assigneeFilter;
  } else {
    label = assigneeFilter;
  }
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `❌ ${label} のリマインドを ${matched.length}件キャンセルしました。`,
  });
}

async function showAmbiguousList(pending, channel, replyThreadTs, client) {
  const lines = await Promise.all(pending.map(async (r, i) => {
    const assignee = await silentDisplayAssignee(client, r);
    return `${i + 1}. *${r.task}*　担当：${assignee}　期限：${formatDueAt(r.due_at)}`;
  }));
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `キャンセル対象を特定できませんでした。確認メッセージの ❌ でキャンセルするか、もう少し詳しく教えてください。\n\n${lines.join('\n')}`,
  });
}

async function handleExtractFromThread(channel, threadTs, replyThreadTs, currentTs, user, client) {
  const messages = threadTs
    ? await fetchFullThread(client, channel, threadTs, currentTs)
    : await fetchChannelHistory(client, channel, currentTs);

  if (messages.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: threadTs ? 'スレッド内にメッセージが見つかりませんでした。' : 'チャンネルの履歴が見つかりませんでした。',
    });
    return;
  }

  const tasks = await extractTasksFromThread(messages, new Date(), botConfig.botUserId);
  const filtered = tasks.filter(t => t.confidence >= 0.4);

  if (filtered.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: threadTs ? 'スレッド内にタスクが見つかりませんでした。' : 'チャンネルの直近メッセージにタスクが見つかりませんでした。',
    });
    return;
  }

  const defaultDueAt = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const y = jst.getUTCFullYear();
    const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
    const da = String(jst.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${da}T10:00:00+09:00`;
  })();

  const results = [];
  for (const t of filtered) {
    const { assigneeSlackUserId, assigneeName } = resolveAssignee(t.assignee);
    const dueAt = t.due_at || defaultDueAt;
    const hasDefaultDue = !t.due_at;
    try {
      const id = createReminder({
        task: t.task,
        assigneeName,
        assigneeSlackUserId,
        dueAt,
        sourceChannelId: channel,
        sourceMessageTs: currentTs,
        sourceThreadTs: replyThreadTs,
        createdBy: user,
        confidence: t.confidence,
        advanceNoticeHours: null,
        notificationTarget: 'dm',
      });
      approveReminder(id);
      const assigneeDisplay = await silentAssigneeDisplay(client, assigneeSlackUserId, assigneeName);
      results.push({ task: t.task, assigneeDisplay, dueAt, hasDefaultDue, status: 'created' });
    } catch (err) {
      console.error('[extract_from_thread] createReminder error:', err.message);
      results.push({ task: t.task, status: 'error' });
    }
  }

  const created = results.filter(r => r.status === 'created');
  if (created.length === 0) {
    await client.chat.postMessage({ channel, thread_ts: replyThreadTs, text: 'タスクの登録に失敗しました。' });
    return;
  }

  const lines = results.map((r, i) => {
    if (r.status !== 'created') return `${i + 1}. ⚠️ 登録失敗: ${r.task}`;
    const dueNote = r.hasDefaultDue ? '　_※期限未指定のため1週間後_' : '';
    return `${i + 1}. ✅ *${r.task}*\n　　担当: ${r.assigneeDisplay}　期限: ${formatDueAt(r.dueAt)}${dueNote}`;
  });

  const scope = threadTs ? 'スレッド' : 'チャンネル';
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `📋 ${scope}から *${created.length} 件* のリマインドを登録しました。\n\n${lines.join('\n\n')}\n\n_キャンセルは「@Reminder Bot ○○のリマインドキャンセル」_`,
  });
}

async function handleUpdateSetting(extraction, channel, replyThreadTs, client) {
  const { setting_key: key, setting_value: value } = extraction;

  if (key === 'advance_notice_hours') {
    const hours = parseInt(value, 10);
    if (Number.isFinite(hours) && hours >= 0) {
      setSetting('advance_notice_hours', String(hours));
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `⚙️ 事前通知タイミングを *${formatHours(hours)}前* に設定しました。`,
      });
    } else {
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
  const dm = { type: 'button', text: { type: 'plain_text', text: '📱 DM' }, value: 'dm', action_id: 'set_notification_target__dm' };
  const thread = { type: 'button', text: { type: 'plain_text', text: '💬 スレッド' }, value: 'thread', action_id: 'set_notification_target__thread' };
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

// ── Helpers ───────────────────────────────────────────────────────────────────────────

async function fetchFullThread(client, channel, threadTs, currentTs) {
  const botPattern = botConfig.botUserId ? new RegExp(`<@${botConfig.botUserId}>`, 'g') : null;
  try {
    const result = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    return (result.messages || [])
      .filter(m => m.user && m.user !== botConfig.botUserId && m.ts !== currentTs && m.text)
      .map(m => {
        const txt = botPattern ? m.text.replace(botPattern, '').trim() : m.text;
        return { user: m.user, text: txt.slice(0, 500) };
      });
  } catch (e) {
    console.error('[mention] Failed to fetch full thread:', e.message);
    return [];
  }
}

async function fetchChannelHistory(client, channel, beforeTs) {
  const botPattern = botConfig.botUserId ? new RegExp(`<@${botConfig.botUserId}>`, 'g') : null;
  try {
    const result = await client.conversations.history({ channel, latest: beforeTs, limit: 30, inclusive: false });
    return (result.messages || [])
      .filter(m => m.user && m.user !== botConfig.botUserId && m.text && !m.thread_ts)
      .reverse()
      .map(m => {
        const txt = botPattern ? m.text.replace(botPattern, '').trim() : m.text;
        return { user: m.user, text: txt.slice(0, 500) };
      });
  } catch (e) {
    console.error('[mention] Failed to fetch channel history:', e.message);
    return [];
  }
}

async function fetchThreadContext(client, channel, thread_ts, currentTs) {
  if (!thread_ts) return [];
  try {
    const result = await client.conversations.replies({ channel, ts: thread_ts, limit: 10 });
    return (result.messages || [])
      .filter(m => m.user && m.user !== botConfig.botUserId && m.ts !== currentTs && m.text)
      .slice(-5)
      .map(m => ({ user: m.user, text: m.text.slice(0, 300) }));
  } catch (e) {
    console.error('[mention] Failed to fetch thread context:', e.message);
    return [];
  }
}

function resolveAssignee(rawAssignee) {
  const name = rawAssignee || '(未設定)';
  const m = name.match(/^<@(U[A-Z0-9]+)>$/) || name.match(/^(U[A-Z0-9]{6,})$/);
  if (m) {
    if (m[1] === botConfig.botUserId) return { assigneeSlackUserId: null, assigneeName: null };
    return { assigneeSlackUserId: m[1], assigneeName: `<@${m[1]}>` };
  }
  return { assigneeSlackUserId: null, assigneeName: name };
}

function extractUserId(raw) {
  if (!raw) return null;
  const m = raw.match(/^<@(U[A-Z0-9]+)>$/) || raw.match(/^(U[A-Z0-9]{6,})$/);
  return m ? m[1] : null;
}

/**
 * Passive monitoring: called for all non-bot messages containing @USER mentions.
 * Auto-creates a reminder when a task + assignee + due_at can be extracted with high confidence.
 */
async function handlePassiveDetection({ message, client }) {
  const { text, channel, ts, thread_ts, user } = message;

  // Skip if this thread already has a reminder being managed
  if (thread_ts) {
    const existing = findByThreadTs(channel, thread_ts);
    if (existing) return;
  }

  let extraction;
  try {
    extraction = await extractReminder(text, new Date(), []);
  } catch (err) {
    console.error('[passive] extractReminder error:', err.message);
    return;
  }

  if (!extraction.should_create_reminder) return;
  if (extraction.confidence < 0.85) return;
  if (extraction.missing_fields?.length > 0) return;
  if (!extraction.due_at) return;

  const { assigneeSlackUserId, assigneeName } = resolveAssignee(extraction.assignee);
  if (!assigneeSlackUserId && !assigneeName) return;

  const replyThreadTs = thread_ts || ts;

  try {
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
      notificationTarget: 'dm',
    });
    approveReminder(reminderId);

    const assigneeDisplay = await silentAssigneeDisplay(client, assigneeSlackUserId, assigneeName);
    const confirmMsg = await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: `🔔 リマインドを自動登録しました。\n担当: ${assigneeDisplay}　期限: ${formatDueAt(extraction.due_at)}\n内容: ${extraction.task}\n\n_❌ リアクションでキャンセル_`,
    });
    setConfirmationTs(reminderId, confirmMsg.ts);
    await client.reactions.add({ channel, timestamp: confirmMsg.ts, name: 'x' });
  } catch (err) {
    console.error('[passive] createReminder error:', err.message);
  }
}

module.exports = { handleMention, notificationTargetBlock, handlePassiveDetection };
