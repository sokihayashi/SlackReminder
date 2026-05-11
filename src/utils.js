// Format a UTC ISO date string for display in JST
function formatDueAt(dueAt) {
  if (!dueAt) return '(未設定)';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).format(new Date(dueAt));
}

module.exports = { formatDueAt };
