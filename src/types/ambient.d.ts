declare module "react-file-icon";

declare module "prismjs" {
  export type Grammar = Record<string, unknown>;
  export const languages: Record<string, Grammar>;
  export function highlight(
    text: string,
    grammar: Grammar,
    language: string,
  ): string;
  const Prism: {
    languages: Record<string, Grammar>;
    highlight: typeof highlight;
  };
  export default Prism;
}

declare module "prismjs/components/*";
