declare module "@babel/highlight" {
  export interface HighlightOptions {
    forceColor?: boolean;
    compact?: boolean;
  }

  export default function highlight(code: string, options?: HighlightOptions): string;
}
