const FRAME_END = /\r?\n\r?\n/;

export function parseFrames(buffer: string, onData: (data: string) => void): string {
  let remaining = buffer;
  let match = FRAME_END.exec(remaining);
  while (match) {
    const frame = remaining.slice(0, match.index);
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) onData(data);
    remaining = remaining.slice(match.index + match[0].length);
    match = FRAME_END.exec(remaining);
  }
  return remaining;
}
