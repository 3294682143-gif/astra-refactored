declare module "@/vendor/katex/katex.mjs" {
  export interface KatexOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
    errorColor?: string;
    output?: "html" | "mathml" | "htmlAndMathml";
  }
  const katex: {
    renderToString(tex: string, options?: KatexOptions): string;
  };
  export default katex;
}

declare module "./vendor/katex/katex.mjs" {
  export interface KatexOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
    errorColor?: string;
    output?: "html" | "mathml" | "htmlAndMathml";
  }
  const katex: {
    renderToString(tex: string, options?: KatexOptions): string;
  };
  export default katex;
}

declare module "katex" {
  export interface KatexOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
    errorColor?: string;
    output?: "html" | "mathml" | "htmlAndMathml";
  }
  const katex: {
    renderToString(tex: string, options?: KatexOptions): string;
  };
  export default katex;
}
