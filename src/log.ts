export function localTimestamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${zone}`;
}

export function log(message: string, stream: { write(line: string): unknown } = process.stderr, date = new Date()): void {
  const lines = message.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  const timestamp = localTimestamp(date);
  for (const line of lines) stream.write(`[${timestamp}] ${line}\n`);
}
