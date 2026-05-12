const botConfig = require('../botConfig');
const { listBotMemberChannels } = require('../slackHelpers');

function scopeHintForError(err) {
  const code = err?.data?.error || err?.code || err?.message || '';
  if (code.includes('missing_scope')) {
    const needed = err?.data?.needed;
    return needed ? `不足scope: \`${needed}\`` : '不足scope（needed情報なし）';
  }
  if (code.includes('not_in_channel'))    return 'bot がそのチャンネルに招待されていません';
  if (code.includes('channel_not_found')) return 'チャンネルIDが無効、または bot から見えない（プライベートで未招待）';
  if (code.includes('account_inactive'))  return 'bot ユーザーが無効化されています';
  return `エラー: \`${code}\``;
}

async function runDiagnostics(channel, replyThreadTs, client) {
  const ver = `commit: \`${botConfig.commitHash}\` | run: \`${botConfig.runId}\` | 起動: ${botConfig.startTime}`;
  const lines = [`🔧 *セルフ診断レポート*\n${ver}\n`];

  try {
    const auth = await client.auth.test();
    lines.push(`✅ *認証* OK — bot user: \`${auth.user}\` (\`${auth.user_id}\`), team: \`${auth.team}\``);
  } catch (e) {
    lines.push(`❌ *認証* 失敗 — ${scopeHintForError(e)}`);
    await client.chat.postMessage({ channel, thread_ts: replyThreadTs, text: lines.join('\n') });
    return;
  }

  let memberChannels = [];
  try {
    memberChannels = await listBotMemberChannels(client);
    const pub  = memberChannels.filter(c => !c.is_private).length;
    const priv = memberChannels.filter(c => c.is_private).length;
    lines.push(`✅ *users.conversations* OK — bot がメンバーのチャンネル: *${memberChannels.length} 個* (public ${pub} / private ${priv})`);
    if (memberChannels.length > 0) {
      const sample = memberChannels.slice(0, 5).map(c => `#${c.name}`).join(', ');
      lines.push(`  サンプル: ${sample}${memberChannels.length > 5 ? ` ほか${memberChannels.length - 5}件` : ''}`);
    }
  } catch (e) {
    lines.push(`❌ *users.conversations* 失敗 — ${scopeHintForError(e)}\n  → \`channels:read\` / \`groups:read\` を追加して再インストール`);
  }

  try {
    const r = await client.conversations.history({ channel, limit: 1 });
    lines.push(`✅ *このチャンネルの history* OK — 取得可能(${r.messages?.length ?? 0}件サンプル)`);
  } catch (e) {
    lines.push(`❌ *このチャンネルの history* 失敗 — ${scopeHintForError(e)}\n  → public なら \`channels:history\`、private なら \`groups:history\` を追加して再インストール`);
  }

  lines.push('');
  if (memberChannels.length === 0) {
    lines.push('⚠️ bot がメンバーになっているチャンネルが0件です。原因の可能性:');
    lines.push('  1. 後から追加した scope を反映するため *Reinstall to Workspace* が必要');
    lines.push('  2. bot を実際にチャンネルに招待していない');
    lines.push('  3. プライベートチャンネルのみで `groups:read` が未付与');
  } else {
    lines.push(`📊 合計: *${memberChannels.length} チャンネル* で動作可能`);
  }

  await client.chat.postMessage({ channel, thread_ts: replyThreadTs, text: lines.join('\n') });
}

module.exports = { runDiagnostics, scopeHintForError };
