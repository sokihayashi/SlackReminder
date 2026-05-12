// Shared mutable config populated at startup (before any events arrive)
const botConfig = {
  botUserId: null,
  startTime: new Date().toISOString(),
  commitHash: process.env.GITHUB_SHA?.slice(0, 7) || 'local',
  runId: process.env.GITHUB_RUN_ID || 'local',
};

module.exports = botConfig;
