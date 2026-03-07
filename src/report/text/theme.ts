export interface Theme {
  bold(text: string): string;
  dim(text: string): string;
  cyan(text: string): string;
  blue(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  magenta(text: string): string;
}

export function useColorByDefault(): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  if (process.env.FORCE_COLOR === "0") {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }
  return Boolean(process.stdout.isTTY);
}

export function makeTheme(colorEnabled: boolean): Theme {
  const wrap = (code: string) =>
    colorEnabled
      ? (text: string) => `\u001b[${code}m${text}\u001b[0m`
      : (text: string) => text;

  return {
    bold: wrap("1"),
    dim: wrap("2"),
    cyan: wrap("36"),
    blue: wrap("34"),
    green: wrap("32"),
    yellow: wrap("33"),
    red: wrap("31"),
    magenta: wrap("35"),
  };
}
