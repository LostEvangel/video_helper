const TIMESTAMP_PATTERN = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})$/;

export function parseTime(text: string): number {
  const match = TIMESTAMP_PATTERN.exec(text.trim());
  if (!match) throw new Error('请输入 HH:mm:ss.SSS 格式的时间。');

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  const value = hours * 3_600 + minutes * 60 + seconds + milliseconds / 1_000;
  if (!Number.isFinite(value)) throw new Error('时间超出可处理范围。');
  return value;
}

export function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('时间必须是有限的非负数。');
  const milliseconds = Math.round(value * 1_000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1_000) % 60;
  const fraction = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`;
}
