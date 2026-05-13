const { extractReminder, resolveCancelTarget, extractTasksFromThread } = require('../ai');
const {
  createReminder, setConfirmationTs, setNotificationTarget,
  getAllPending, getPendingByAssignee, cancelReminder, approveReminder,
  getSetting, setSetting,
  savePendingQuestion, deletePendingQuestion, findByThreadTs,
  findAllByConfirmationTs,
} = require('../db');
const { formatDueAt, formatHours, computeAdvanceNoticeHours, displayAssignee, silentAssigneeDisplay, silentDisplayAssignee, getDisplayName, CONFIDENCE_THRESHOLD, DEFAULT_ADVANCE_NOTICE_HOURS } = require('../utils');
const { listBotMemberChannels } = require('../slackHelpers');
const { handleReset } = require('./admin');
const { runDiagnostics } = require('./diagnostics');
const botConfig = require('../botConfig');

async function handleMention({ event, client, priorText = null, silentOnNone = false }) {
  const { text, channel, ts, thread_ts, user } = event;
  const replyThreadTs = thread_ts || ts;

  console.log(`[mention] user=${user} channel=${channel}${priorText ? ' (follow-up)' : ''}${silentOnNone ? ' (silent)' : ''}`);

  try {
    // Fast-path: keyword match before calling AI (only for first-turn, only on explicit mention)
    if (!priorText && !silentOnNone) {
      const bare = text.replace(/<@[^>]+>/g, '').trim();
      if (/^(ヘルプ|help|使い方|つかいかた)\??$/i.test(bare)) {
        await postHelp(channel, replyThreadTs, client);
        return;
      }
      if (/^(診断|debug|diagnos[ei]s|scope確認|セルフチェック)\??$/i.test(bare)) {
        await runDiagnostics(channel, replyThreadTs, client);
        return;
      }
      const resetMatch = bare.match(/^RESET\s+(\S+)\s*$/i);
      if (resetMatch) {
        await handleReset(channel, replyThreadTs, client, resetMatch[1]);
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
      case 'extract_from_thread':
        if (extraction.channel_scope === 'all') {
          const fullHistory = /全期間|過去全部|過去全て|all\s*time/i.test(cleanText);
          return handleExtractFromAllChannels(channel, replyThreadTs, ts, user, client, { fullHistory });
        }
        return handleExtractFromThread(channel, thread_ts, replyThreadTs, ts, user, client);
    }

    if (extraction.intent !== 'create_reminder' || extraction.tasks.length === 0) {
      if (silentOnNone) return;
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `リマインド対象のタスクが見つかりませんでした。\n理由：${extraction.reason || '不明'}`,
      });
      return;
    }

    // Trust task-level data over AI's missing_fields (AI sometimes flags fields as missing
    // even when it populated them). Re-derive from the actual tasks array.
    const missingFromTasks = [];
    if (extraction.tasks.every(t => !t.due_at)) missingFromTasks.push('due_at');
    if (extraction.tasks.every(t => !t.assignee)) missingFromTasks.push('assignee');

    if (extraction.confidence < CONFIDENCE_THRESHOLD || missingFromTasks.length > 0) {
      const missing = missingFromTasks.length > 0
        ? missingFromTasks.join('、')
        : '日時または担当者';
      const needsDueAt = missingFromTasks.includes('due_at');
      savePendingQuestion({
        channelId: channel,
        threadTs: replyThreadTs,
        originalText: cleanText,
        sourceMessageTs: ts,
        createdBy: user,
      });
      const blocks = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `リマインドの作成に必要な情報が不足しています。\n不足情報：*${missing}*` },
        },
      ];
      if (needsDueAt) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: '*期限を選択するか、スレッド返信で詳細を教えてください：*' },
        });
        blocks.push(quickDueAtActionsBlock());
      }
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_スレッド返信例: 「明日 17時」「今週金曜まで」「@田中」など（メンション不要）_' }],
      });
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `リマインドの作成に必要な情報が不足しています。不足情報：${missing}`,
        blocks,
      });
      return;
    }

    deletePendingQuestion(channel, replyThreadTs);

    const notifTarget = extraction.notification_target === 'dm' ? 'dm' : 'thread';

    if (extraction.tasks.length === 1) {
      return postSingleConfirmation(extraction.tasks[0], notifTarget, channel, ts, replyThreadTs, user, client);
    }
    return postBulkCreate(extraction.tasks, notifTarget, channel, ts, replyThreadTs, user, client);
  } catch (err) {
    console.error('[mention] Error:', err);
    if (silentOnNone) return;
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

// ── Reminder creation helpers ───────────────────────────────────────────────

function defaultDueAtJST(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const da = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}T10:00:00+09:00`;
}

async function bulkCreateReminders(tasks, source, client, { approve = true } = {}) {
  const fallbackDue = defaultDueAtJST(7);
  const messageTs = source.messageTs || '';
  const threadTs = source.threadTs || '';
  const results = [];
  for (const t of tasks) {
    const { assigneeSlackUserId, assigneeName } = resolveAssignee(t.assignee);
    if (!assigneeSlackUserId && !assigneeName) {
      results.push({ task: t.task, status: 'error', errorMessage: '担当者不明' });
      continue;
    }
    const dueAt = t.due_at || fallbackDue;
    const hasDefaultDue = !t.due_at;
    const advanceNoticeHours = t.advance_notice_hours ?? computeAdvanceNoticeHours(dueAt);
    try {
      const id = createReminder({
        task: t.task,
        assigneeName,
        assigneeSlackUserId,
        dueAt,
        sourceChannelId: source.channelId,
        sourceMessageTs: messageTs,
        sourceThreadTs: threadTs,
        createdBy: source.user,
        confidence: t.confidence ?? 1,
        advanceNoticeHours,
        notificationTarget: source.notificationTarget || 'dm',
      });
      if (approve) approveReminder(id);
      const assigneeDisplay = await silentAssigneeDisplay(client, assigneeSlackUserId, assigneeName);
      results.push({ id, task: t.task, assigneeDisplay, dueAt, hasDefaultDue, advanceNoticeHours, status: 'created' });
    } catch (err) {
      console.error('[bulk] createReminder error:', err.message);
      results.push({ task: t.task, status: 'error', errorMessage: err.message });
    }
  }
  return results;
}

function formatBulkLines(results) {
  return results.map((r, i) => {
    if (r.status !== 'created') return `${i + 1}. ⚠️ 登録失敗: ${r.task}`;
    const dueNote = r.hasDefaultDue ? '　_※期限未指定のため1週間後_' : '';
    return `${i + 1}. ✅ *${r.task}*\n　　担当: ${r.assigneeDisplay}　期限: ${formatDueAt(r.dueAt)}${dueNote}`;
  });
}

async function postSingleConfirmation(t, notifTarget, channel, ts, replyThreadTs, user, client) {
  const { assigneeSlackUserId, assigneeName } = resolveAssignee(t.assignee);
  if (!assigneeSlackUserId && !assigneeName) {
    savePendingQuestion({ channelId: channel, threadTs: replyThreadTs, originalText: t.task, sourceMessageTs: ts, createdBy: user });
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: 'リマインドの作成に必要な情報が不足しています。\n不足情報：*担当者*\n\n担当する人をスレッド返信でメンションしてください。',
    });
    return;
  }

  const reminderId = createReminder({
    task: t.task,
    assigneeName,
    assigneeSlackUserId,
    dueAt: t.due_at,
    sourceChannelId: channel,
    sourceMessageTs: ts,
    sourceThreadTs: replyThreadTs,
    createdBy: user,
    confidence: t.confidence ?? 1,
    advanceNoticeHours: t.advance_notice_hours ?? null,
    notificationTarget: notifTarget,
  });

  const dueDisplay = formatDueAt(t.due_at);
  const assigneeDisplay = await silentAssigneeDisplay(client, assigneeSlackUserId, assigneeName);
  const noticeHours = t.advance_notice_hours
    ?? parseInt(getSetting('advance_notice_hours', String(DEFAULT_ADVANCE_NOTICE_HOURS)), 10);
  const noticeLabel = formatHours(noticeHours);

  const confirmMsg = await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `リマインド候補を作成しました。\n担当：${assigneeDisplay}\n期限：${dueDisplay}\n内容：${t.task}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*リマインド候補を作成しました。*\n\n*担当：* ${assigneeDisplay}\n*期限：* ${dueDisplay}\n*内容：* ${t.task}` },
      },
      notificationTargetBlock(notifTarget),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `事前通知：${noticeLabel}前　|　✅ 登録　❌ キャンセル　※スレッドに返信で修正可` }],
      },
    ],
  });

  setConfirmationTs(reminderId, confirmMsg.ts);
  await client.reactions.add({ channel, timestamp: confirmMsg.ts, name: 'white_check_mark' });
  await client.reactions.add({ channel, timestamp: confirmMsg.ts, name: 'x' });
}

async function postBulkCreate(tasks, notifTarget, channel, ts, replyThreadTs, user, client) {
  // Draft mode: don't approve immediately, require user to confirm via buttons.
  const results = await bulkCreateReminders(tasks, {
    channelId: channel, messageTs: ts, threadTs: replyThreadTs, user, notificationTarget: notifTarget,
  }, client, { approve: false });

  const created = results.filter(r => r.status === 'created');
  if (created.length === 0) {
    await client.chat.postMessage({ channel, thread_ts: replyThreadTs, text: 'タスクの登録に失敗しました。担当者が特定できませんでした。' });
    return;
  }

  const blocks = bulkConfirmBlocks(created.map((r, i) => ({ ...r, index: i + 1, _status: 'draft' })));
  const headerText = `📋 ${created.length} 件のリマインド候補を作成しました。確定 / キャンセルしてください。`;

  const confirmMsg = await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: headerText,
    blocks,
  });

  // Track which message hosts these drafts so action handlers can find them.
  for (const r of created) setConfirmationTs(r.id, confirmMsg.ts);
}

/**
 * Build the Block Kit message for bulk-draft confirmation.
 * Each reminder gets a section + per-row ✅/❌ buttons.
 * Footer has 全件確定 / 全件キャンセル.
 *
 * Each entry must include: { id, index, task, assigneeDisplay, dueAt, advanceNoticeHours, hasDefaultDue, _status }
 *   _status: 'draft' | 'pending' (approved) | 'cancelled'
 */
function bulkConfirmBlocks(entries) {
  const blocks = [];
  const draftCount = entries.filter(e => e._status === 'draft').length;

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: draftCount > 0
        ? `📋 *${entries.length} 件* のリマインド候補。下記から個別に確定 / キャンセル、または末尾で一括操作してください。`
        : `📋 *${entries.length} 件* のリマインドを処理しました。`,
    },
  });

  for (const e of entries) {
    const dueNote = e.hasDefaultDue ? '　_※期限未指定のため1週間後_' : '';
    const noticeLabel = e.advanceNoticeHours ? `事前通知: ${formatHours(e.advanceNoticeHours)}前` : '';
    const statusBadge = e._status === 'pending' ? ' ✅ *確定済み*'
      : e._status === 'cancelled' ? ' ❌ *キャンセル済み*'
      : '';
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${e.index}. ${e.task}*${statusBadge}\n担当: ${e.assigneeDisplay}　期限: ${formatDueAt(e.dueAt)}${dueNote}${noticeLabel ? `\n_${noticeLabel}_` : ''}`,
      },
    });
    if (e._status === 'draft') {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: `✅ ⌗${e.index} 確定` },
            value: e.id,
            action_id: 'bulk_approve_one',
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: `❌ ⌗${e.index} 取消` },
            value: e.id,
            action_id: 'bulk_cancel_one',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: `✏️ 修正` },
            value: e.id,
            action_id: 'bulk_modify_one',
          },
        ],
      });
    }
  }

  blocks.push({ type: 'divider' });

  if (draftCount > 0) {
    const draftIds = entries.filter(e => e._status === 'draft').map(e => e.id);
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: `✅ 全件確定 (${draftCount})` },
          value: JSON.stringify(draftIds),
          action_id: 'bulk_approve_all',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: `❌ 全件キャンセル` },
          value: JSON.stringify(draftIds),
          action_id: 'bulk_cancel_all',
          style: 'danger',
        },
      ],
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '_✏️ 修正ボタンで担当者・期限・事前通知を変更できます。スレッド返信でも可: 「⌗1 の期限を 明日 17時 に」_' }],
  });

  return blocks;
}

/**
 * Rebuilds the bulk confirmation Block Kit message from current DB state.
 * Used after approve/cancel/modify actions to keep the message in sync.
 */
async function refreshBulkMessage(client, channel, ts) {
  const reminders = findAllByConfirmationTs(channel, ts);
  if (reminders.length === 0) return;
  const entries = await Promise.all(reminders.map(async (r, i) => ({
    id: r.id,
    index: i + 1,
    task: r.task,
    assigneeDisplay: await silentAssigneeDisplay(client, r.assignee_slack_user_id, r.assignee_name),
    dueAt: r.due_at,
    hasDefaultDue: false,
    advanceNoticeHours: r.advance_notice_hours,
    _status: r.status === 'pending' ? 'pending' : r.status === 'cancelled' ? 'cancelled' : 'draft',
  })));
  const blocks = bulkConfirmBlocks(entries);
  const draftCount = entries.filter(e => e._status === 'draft').length;
  const headerText = draftCount > 0
    ? `📋 ${entries.length} 件のリマインド候補。${draftCount} 件未確定。`
    : `📋 ${entries.length} 件のリマインドを処理しました。`;
  try {
    await client.chat.update({ channel, ts, text: headerText, blocks });
  } catch (e) {
    console.error('[refreshBulkMessage] update failed:', e.message);
  }
}

async function handleExtractFromThread(channel, threadTs, replyThreadTs, currentTs, user, client) {
  const messages = threadTs
    ? await fetchFullThread(client, channel, threadTs, currentTs)
    : await fetchChannelHistory(client, channel, currentTs);

  if (messages.length === 0) {
    await client.chat.postMessage({
      channel, thread_ts: replyThreadTs,
      text: threadTs ? 'スレッド内にメッセージが見つかりませんでした。' : 'チャンネルの履歴が見つかりませんでした。',
    });
    return;
  }

  const tasks = await extractTasksFromThread(messages, new Date(), botConfig.botUserId);
  const filtered = tasks.filter(t => t.confidence >= 0.4);

  if (filtered.length === 0) {
    await client.chat.postMessage({
      channel, thread_ts: replyThreadTs,
      text: threadTs ? 'スレッド内にタスクが見つかりませんでした。' : 'チャンネルの直近メッセージにタスクが見つかりませんでした。',
    });
    return;
  }

  // Draft mode: show confirmation UI before any DMs fire
  return postBulkCreate(filtered, 'dm', channel, currentTs, replyThreadTs, user, client);
}

async function handleExtractFromAllChannels(originChannel, replyThreadTs, currentTs, user, client, { fullHistory = false } = {}) {
  const oldest = fullHistory ? undefined : Math.floor((Date.now() - 7 * 24 * 3600 * 1000) / 1000).toString();
  const rangeLabel = fullHistory ? '全期間' : '直近1週間';
  await client.chat.postMessage({
    channel: originChannel, thread_ts: replyThreadTs,
    text: `🔍 ${rangeLabel}で全チャンネルをスキャン中…（チャンネル数によっては数十秒かかります）`,
  });

  const channels = await fetchAllChannelsHistory(client, oldest);
  if (channels.length === 0) {
    await client.chat.postMessage({
      channel: originChannel, thread_ts: replyThreadTs,
      text: `スキャン対象のチャンネルが見つかりませんでした（${rangeLabel}）。\`@Reminder Bot 診断\` でメンバー状態を確認してください。`,
    });
    return;
  }

  const perChannel = await Promise.all(channels.map(async (ch) => {
    try {
      const allTasks = await extractTasksFromThread(ch.messages, new Date(), botConfig.botUserId);
      const tasks = allTasks.filter(t => t.confidence >= 0.35);
      console.log(`[all-channels] #${ch.channelName}: AI ${allTasks.length} tasks → ${tasks.length} pass confidence>=0.35`);
      return { ...ch, allTasks, tasks };
    } catch (e) {
      console.error(`[all-channels] extract failed for #${ch.channelName}:`, e.message);
      return { ...ch, allTasks: [], tasks: [], error: e.message };
    }
  }));

  // Dedup: classify each extracted task as "new" or "already-pending"
  // by comparing against active reminders in the same channel.
  const allPending = getAllPending();
  const newDrafts = [];           // { channelName, taskData, draftResult }
  const existingMatches = [];     // { channelName, taskData, existingReminder }

  for (const ch of perChannel) {
    const newTasksHere = [];
    for (const t of ch.tasks) {
      const existing = findExistingReminder(allPending, ch.channelId, t);
      if (existing) {
        existingMatches.push({ channelName: ch.channelName, taskData: t, existingReminder: existing });
      } else {
        newTasksHere.push(t);
      }
    }
    if (newTasksHere.length === 0) continue;

    const r = await bulkCreateReminders(newTasksHere, {
      channelId: originChannel, messageTs: currentTs, threadTs: replyThreadTs, user, notificationTarget: 'thread',
    }, client, { approve: false });
    for (const item of r.filter(x => x.status === 'created')) {
      newDrafts.push({ channelName: ch.channelName, ...item });
    }
  }

  // Nothing extracted at all → diagnostic message
  if (newDrafts.length === 0 && existingMatches.length === 0) {
    const diag = perChannel.map(ch => {
      let status;
      if (ch.error) status = `❌ ${ch.error}`;
      else if (ch.allTasks.length === 0) status = 'AI抽出: 0件';
      else if (ch.tasks.length === 0) status = `AI抽出: ${ch.allTasks.length}件 (全て信頼度<0.35)`;
      else status = `AI抽出: ${ch.tasks.length}件`;

      const sample = ch.allTasks.slice(0, 3).map(t => {
        const conf = (t.confidence ?? 0).toFixed(2);
        const assignee = t.assignee || '(担当不明)';
        return `　　• "${t.task}" 担当=${assignee} conf=${conf}`;
      }).join('\n');

      return `  *#${ch.channelName}* (${ch.messages.length}件) — ${status}${sample ? '\n' + sample : ''}`;
    }).join('\n');

    await client.chat.postMessage({
      channel: originChannel, thread_ts: replyThreadTs,
      text: `🔍 ${rangeLabel}・${channels.length} チャンネルからタスク候補は見つかりませんでした。\n\n*診断:*\n${diag}`,
    });
    return;
  }

  // Build extraction review message (draft mode — no auto-register).
  const MAX_NEW_DISPLAY = 15;
  const displayedNew = newDrafts.slice(0, MAX_NEW_DISPLAY);
  const newOverflow = newDrafts.length - displayedNew.length;

  const entries = displayedNew.map((r, i) => ({
    id: r.id,
    index: i + 1,
    task: `${r.task}　_〔#${r.channelName}〕_`,
    assigneeDisplay: r.assigneeDisplay,
    dueAt: r.dueAt,
    hasDefaultDue: r.hasDefaultDue,
    advanceNoticeHours: r.advanceNoticeHours,
    _status: 'draft',
  }));

  const blocks = [];
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `🔍 *${rangeLabel}・${channels.length} チャンネル抽出結果*\n\n*新規候補*: ${newDrafts.length}件　／　*既存リマインドあり*: ${existingMatches.length}件\n\n_棚卸し用です。新規候補から確定したいものだけボタンで選んでください。_` },
  });

  if (entries.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'header', text: { type: 'plain_text', text: `📝 新規候補 (${newDrafts.length}件)` } });
    const draftBlocks = bulkConfirmBlocks(entries);
    // Skip the first section in bulkConfirmBlocks (intro line) since we already added header.
    blocks.push(...draftBlocks.slice(1));
  }

  if (existingMatches.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'header', text: { type: 'plain_text', text: `🔔 既存リマインドあり (${existingMatches.length}件)` } });
    for (const m of existingMatches.slice(0, 10)) {
      const assignee = await silentAssigneeDisplay(client, m.existingReminder.assignee_slack_user_id, m.existingReminder.assignee_name);
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• *${m.taskData.task}*　_〔#${m.channelName}〕_\n　 ↳ 登録済み: 担当 ${assignee}　期限 ${formatDueAt(m.existingReminder.due_at)}` },
      });
    }
    if (existingMatches.length > 10) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_他に${existingMatches.length - 10}件の既存マッチあり。_` }],
      });
    }
  }

  if (newOverflow > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_新規候補は${newDrafts.length}件あるが、最初の${MAX_NEW_DISPLAY}件のみ表示。「全件確定」で全部登録できます。範囲を狭めて再実行するなら直近指定を変えてください。_` }],
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_全期間で再実行するなら: @Reminder Bot 全期間で全チャンネルからタスク抽出_` }],
  });

  const confirmMsg = await client.chat.postMessage({
    channel: originChannel, thread_ts: replyThreadTs,
    text: `🔍 ${rangeLabel}・${channels.length}チャンネル抽出 — 新規${newDrafts.length}件 / 既存${existingMatches.length}件`,
    blocks,
  });

  // Tag all drafts (including non-displayed overflow) with the confirmation msg ts
  // so 全件確定 catches them all and refreshBulkMessage can resolve them.
  for (const r of newDrafts) setConfirmationTs(r.id, confirmMsg.ts);
}

/**
 * Heuristic dedup: is there an active (draft/pending) reminder in `pendingList`
 * that already covers the task being extracted?
 *
 * Match criteria:
 * - Same source_channel_id
 * - Same assignee (Slack ID OR name overlap)
 * - Task text overlap (case-insensitive substring or significant prefix)
 */
function findExistingReminder(pendingList, channelId, taskData) {
  const newAssigneeId = extractUserId(taskData.assignee || '');
  const newAssigneeName = taskData.assignee || '';

  return pendingList.find(r => {
    if (r.source_channel_id !== channelId) return false;
    if (!['draft', 'pending'].includes(r.status)) return false;

    const assigneeMatch =
      (newAssigneeId && r.assignee_slack_user_id === newAssigneeId) ||
      (!newAssigneeId && newAssigneeName && (
        (r.assignee_name || '').includes(newAssigneeName) ||
        newAssigneeName.includes(r.assignee_name || '')
      ));
    if (!assigneeMatch) return false;

    return isTaskSimilar(r.task, taskData.task);
  });
}

function isTaskSimilar(a, b) {
  if (!a || !b) return false;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '');
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  // Containment
  if (na.length >= 6 && (na.includes(nb) || nb.includes(na))) return true;
  // First 8 normalized chars match
  if (na.length >= 8 && nb.length >= 8 && na.slice(0, 8) === nb.slice(0, 8)) return true;
  return false;
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

function quickDueAtActionsBlock() {
  const options = [
    { label: '今日 17時', value: '今日 17時' },
    { label: '明日 10時', value: '明日 10時' },
    { label: '明日 18時', value: '明日 18時' },
    { label: '今週金曜 17時', value: '今週金曜 17時' },
    { label: '来週月曜 10時', value: '来週月曜 10時' },
  ];
  // action_id must be unique within the actions block — use index suffix.
  return {
    type: 'actions',
    elements: options.map((o, i) => ({
      type: 'button',
      text: { type: 'plain_text', text: o.label },
      value: o.value,
      action_id: `set_due_at_quick__${i}`,
    })),
  };
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
          text: '*設定・診断*\n```@Reminder Bot 設定確認\n@Reminder Bot 設定: 事前通知 2日前\n@Reminder Bot このチャンネルにタスクサマリーを設定\n@Reminder Bot サマリーを解除\n@Reminder Bot 診断   ← スコープ・チャンネルメンバー状態を確認```',
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

async function fetchChannelHistory(client, channel, beforeTs, limit = 100) {
  const botPattern = botConfig.botUserId ? new RegExp(`<@${botConfig.botUserId}>`, 'g') : null;
  try {
    const result = await client.conversations.history({ channel, latest: beforeTs, limit, inclusive: false });
    return (result.messages || [])
      .filter(m => m.user && m.user !== botConfig.botUserId && m.text)
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

async function fetchAllChannelsHistory(client, oldest) {
  const botPattern = botConfig.botUserId ? new RegExp(`<@${botConfig.botUserId}>`, 'g') : null;
  try {
    const memberChannels = await listBotMemberChannels(client);
    console.log(`[all-channels] bot is member of ${memberChannels.length} channels${oldest ? ` (oldest=${oldest})` : ''}`);

    const perChannel = await Promise.all(memberChannels.map(async (ch) => {
      try {
        const params = { channel: ch.id, limit: 100 };
        if (oldest) params.oldest = oldest;
        const r = await client.conversations.history(params);
        const messages = (r.messages || [])
          .filter(m => m.user && m.user !== botConfig.botUserId && m.text)
          .reverse()
          .map(m => {
            const txt = botPattern ? m.text.replace(botPattern, '').trim() : m.text;
            return { user: m.user, text: txt.slice(0, 500) };
          });
        console.log(`[all-channels] #${ch.name}: ${r.messages?.length ?? 0} raw → ${messages.length} user msgs`);
        return { channelId: ch.id, channelName: ch.name, messages };
      } catch (e) {
        console.error(`[all-channels] history failed for #${ch.name}:`, e.message);
        return { channelId: ch.id, channelName: ch.name, messages: [] };
      }
    }));

    return perChannel.filter(p => p.messages.length > 0);
  } catch (e) {
    console.error('[all-channels] conversations.list failed:', e.message);
    return [];
  }
}

async function fetchThreadContext(client, channel, thread_ts, currentTs) {
  if (!thread_ts) return [];
  const botPattern = botConfig.botUserId ? new RegExp(`<@${botConfig.botUserId}>`, 'g') : null;
  try {
    const result = await client.conversations.replies({ channel, ts: thread_ts, limit: 50 });
    return (result.messages || [])
      .filter(m => m.user && m.user !== botConfig.botUserId && m.ts !== currentTs && m.text)
      .map(m => {
        const txt = botPattern ? m.text.replace(botPattern, '').trim() : m.text;
        return { user: m.user, text: txt.slice(0, 500) };
      });
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

  if (extraction.intent !== 'create_reminder') {
    console.log(`[passive] skip: intent=${extraction.intent}`);
    return;
  }
  if (extraction.confidence < 0.85) {
    console.log(`[passive] skip: confidence=${extraction.confidence} tasks=${JSON.stringify(extraction.tasks.map(t => t.task))}`);
    return;
  }
  if (extraction.missing_fields?.length > 0) {
    console.log(`[passive] skip: missing_fields=${extraction.missing_fields}`);
    return;
  }
  if (extraction.tasks.length === 0) return;

  const replyThreadTs = thread_ts || ts;
  const valid = extraction.tasks.filter(t => t.due_at && (resolveAssignee(t.assignee).assigneeSlackUserId || resolveAssignee(t.assignee).assigneeName));
  if (valid.length === 0) {
    console.log(`[passive] skip: no valid tasks (due_at or assignee missing) tasks=${JSON.stringify(extraction.tasks.map(t => ({ task: t.task, due_at: t.due_at, assignee: t.assignee })))}`);
    return;
  }

  console.log(`[passive] showing confirmation for ${valid.length} task(s)`);
  if (valid.length === 1) {
    await postSingleConfirmation(valid[0], 'thread', channel, ts, replyThreadTs, user, client);
  } else {
    await postBulkCreate(valid, 'thread', channel, ts, replyThreadTs, user, client);
  }
}

/**
 * Auto-crawl on channel join: silently scan the recent history and bulk-register
 * any action items. Posts a single summary message only when reminders are
 * actually created — otherwise stays quiet to avoid channel noise.
 */
async function handleBotJoinedChannel({ event, client }) {
  if (!botConfig.botUserId || event.user !== botConfig.botUserId) return;
  const channel = event.channel;
  console.log(`[join] bot joined channel=${channel}; starting background crawl`);

  // Background extraction: silent unless tasks are actually registered.
  const messages = await fetchChannelHistory(client, channel, undefined, 100);
  if (messages.length === 0) return;

  let tasks;
  try {
    tasks = await extractTasksFromThread(messages, new Date(), botConfig.botUserId);
  } catch (err) {
    console.error('[join] extractTasksFromThread error:', err.message);
    return;
  }
  const filtered = tasks.filter(t => t.confidence >= 0.5);
  if (filtered.length === 0) return;

  // Draft mode: require manager confirmation before DMs fire
  await postBulkCreate(filtered, 'dm', channel, null, null, botConfig.botUserId, client);
}

module.exports = { handleMention, notificationTargetBlock, handlePassiveDetection, handleBotJoinedChannel, bulkConfirmBlocks, refreshBulkMessage };
