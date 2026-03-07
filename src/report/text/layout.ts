const ANSI_REGEX = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export function padRightAnsi(text: string, plain: string, width: number): string {
  const missing = Math.max(0, width - plain.length);
  return `${text}${" ".repeat(missing)}`;
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function wrapLine(value: string, width: number): string[] {
  if (width <= 4) {
    return [value.slice(0, width)];
  }

  const lines: string[] = [];
  const input = value.trimEnd();
  if (input.length === 0) {
    return [""];
  }

  let cursor = 0;
  while (cursor < input.length) {
    const remaining = input.slice(cursor);
    if (remaining.length <= width) {
      lines.push(remaining);
      break;
    }

    const slice = remaining.slice(0, width + 1);
    const breakAt = slice.lastIndexOf(" ");
    if (breakAt <= 0) {
      lines.push(remaining.slice(0, width));
      cursor += width;
      continue;
    }

    lines.push(remaining.slice(0, breakAt));
    cursor += breakAt + 1;
  }

  return lines;
}
