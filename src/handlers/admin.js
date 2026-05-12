const botConfig = require('../botConfig');
const {
  getAllReminders,
  wipeAll,
  getBotSentMessages,
  deleteBotSentMessage,
} = require('../db');
const {
  listBotMemberChannels,
  listAllIMConversations,
  deleteBotMessagesInConversation,
} = require('../slackHelpers');

async function handleReset(channel, replyThreadTs, client, code) {
  const expected = process.env.ADMIN_RESET_CODE;
  if (!expected) {
    await client.chat.postMessage({
      channel, thread_ts: replyThreadTs,
      text: '⚠️ ADMIN_RESET_CODE が GitHub Secrets に設定されていません。',
    });
    return;
  }
  if (code !== expected) {
    await client.chat.postMessage({
      channel, thread_ts: replyThreadTs,
      text: '❌ RESET コードが一致しません。',
    });
    return;
  }
  const count = getAllReminders().length;
  await client.chat.postMessage({
    channel, thread_ts: replyThreadTs,
    text: '⚠️ RESET 確認',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `⚠️ *RESET 確認*\n\n以下を全削除します（**元に戻せません**）:\n• DB のリマインド: *${count} 件*\n• \`pending_questions\` テーブル\n• bot がメンバーチャンネルに投稿した過去メッセージ（最大5ページ＝1000件/ch）\n• bot から各ユーザーへ送った *DM* も全削除（リマインド通知含む）\n\n_設定（事前通知時刻、サマリーチャンネル）は保持されます。Slack API レートリミットの都合で時間がかかります。_` },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '🗑️ 実行' }, value: 'do', action_id: 'reset_confirm', style: 'danger' },
          { type: 'button', text: { type: 'plain_text', text: '中止' }, value: 'no', action_id: 'reset_cancel' },
        ],
      },
    ],
  });
}

function makePhase() {
  return { scanned: 0, deleted: 0, errors: 0, firstErr: null, fail: null };
}

async function purgeTrackedMessages(client, phase) {
  const tracked = getBotSentMessages();
  phase.scanned = tracked.length;
  console.log(`[reset] deleting ${tracked.length} tracked bot messages`);
  for (const { channel_id, ts } of tracked) {
    try {
      await client.chat.delete({ channel: channel_id, ts });
      phase.deleted++;
      deleteBotSentMessage(channel_id, ts);
    } catch (e) {
      const code = e?.data?.error;
      // message_not_found = already gone upstream; drop from DB without flagging as error
      if (code === 'message_not_found') {
        deleteBotSentMessage(channel_id, ts);
        continue;
      }
      phase.errors++;
      if (!phase.firstErr) phase.firstErr = code || e.message;
    }
  }
}

async function purgeConversations(client, ids, phase, { scanReplies }) {
  for (const id of ids) {
    try {
      const r = await deleteBotMessagesInConversation(client, id, { scanReplies });
      phase.deleted += r.deleted;
      phase.errors += r.errors;
      if (!phase.firstErr && r.firstErr) phase.firstErr = r.firstErr;
    } catch (e) {
      phase.errors++;
      if (!phase.firstErr) phase.firstErr = e?.data?.error || e.message;
    }
  }
}

function collectKnownDmPartners() {
  const userIds = new Set();
  try {
    for (const r of getAllReminders()) {
      if (r.assignee_slack_user_id) userIds.add(r.assignee_slack_user_id);
      if (r.created_by) userIds.add(r.created_by);
    }
  } catch (e) {
    console.error('[reset] getAllReminders failed:', e.message);
  }
  return userIds;
}

async function executeReset(client, channel, ts) {
  try {
    await client.chat.update({ channel, ts, text: '🗑️ RESET 実行中… (Slack メッセージ削除に時間がかかります)' });
  } catch (_) {}

  const phases = {
    tracked: makePhase(),
    channels: makePhase(),
    ims: makePhase(),
    imsByAssignee: makePhase(),
  };

  await purgeTrackedMessages(client, phases.tracked);

  // Capture DM partner IDs BEFORE wipe so the assignee-fallback works even
  // when im:read is missing.
  const knownDmPartners = collectKnownDmPartners();

  if (botConfig.botUserId) {
    try {
      const channels = await listBotMemberChannels(client);
      phases.channels.scanned = channels.length;
      await purgeConversations(client, channels.map(c => c.id), phases.channels, { scanReplies: true });
    } catch (e) {
      phases.channels.fail = e?.data?.error || e.message;
      console.error('[reset] member channel sweep failed:', e.message);
    }

    let listedIms = [];
    try {
      listedIms = await listAllIMConversations(client);
      phases.ims.scanned = listedIms.length;
      await purgeConversations(client, listedIms.map(im => im.id), phases.ims, { scanReplies: false });
    } catch (e) {
      phases.ims.fail = e?.data?.error || e.message;
      console.error('[reset] IM sweep failed:', e.message);
    }

    const alreadyCovered = new Set(listedIms.map(im => im.user).filter(Boolean));
    for (const userId of knownDmPartners) {
      if (userId === botConfig.botUserId) continue;
      if (alreadyCovered.has(userId)) continue;
      try {
        const open = await client.conversations.open({ users: userId });
        const dmId = open?.channel?.id;
        if (!dmId) continue;
        phases.imsByAssignee.scanned++;
        const r = await deleteBotMessagesInConversation(client, dmId, { scanReplies: false });
        phases.imsByAssignee.deleted += r.deleted;
        phases.imsByAssignee.errors += r.errors;
        if (!phases.imsByAssignee.firstErr && r.firstErr) phases.imsByAssignee.firstErr = r.firstErr;
      } catch (e) {
        phases.imsByAssignee.errors++;
        if (!phases.imsByAssignee.firstErr) phases.imsByAssignee.firstErr = e?.data?.error || e.message;
      }
    }
  }

  const wiped = wipeAll();
  await postResetReport(client, channel, phases, wiped);
}

async function postResetReport(client, channel, phases, wiped) {
  const totalDeleted = Object.values(phases).reduce((s, p) => s + p.deleted, 0);
  const totalErrors  = Object.values(phases).reduce((s, p) => s + p.errors, 0);

  const fmt        = (p) => `${p.scanned} scan / ${p.deleted}削除 / ${p.errors}エラー`;
  const errSuffix  = (p) => p.firstErr ? ` (例: \`${p.firstErr}\`)` : '';
  const failSuffix = (p, hint = '') => p.fail ? ` (列挙失敗: \`${p.fail}\`${hint})` : '';

  const lines = [
    '✅ RESET 完了。',
    `• DB: リマインド ${wiped.reminders}件 / pending ${wiped.pending}件 削除`,
    `• 追跡済み (DB記録): ${fmt(phases.tracked)}${errSuffix(phases.tracked)}`,
    `• チャンネル (履歴scan): ${fmt(phases.channels)}${failSuffix(phases.channels)}${errSuffix(phases.channels)}`,
    `• DM (im list): ${fmt(phases.ims)}${failSuffix(phases.ims, ' — `im:read` scope不足')}${errSuffix(phases.ims)}`,
    `• DM (assignee fallback): ${fmt(phases.imsByAssignee)}${errSuffix(phases.imsByAssignee)}`,
    `• 合計 Slack削除: *${totalDeleted}件* / エラー: ${totalErrors}件`,
  ];

  if (phases.ims.fail || phases.imsByAssignee.errors > 0) {
    lines.push('');
    lines.push('ℹ️ 既存の古いDMメッセージを一掃するには `im:read` + `im:history` scope を追加して reinstall してください。');
    lines.push('   今後 bot が送る新しいメッセージは DB に自動記録されるので、scope なしでも次回 RESET で削除されます。');
  }

  await client.chat.postMessage({ channel, text: lines.join('\n') });
}

module.exports = { handleReset, executeReset };
