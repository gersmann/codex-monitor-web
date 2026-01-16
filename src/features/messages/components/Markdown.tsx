import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

type MarkdownProps = {
  value: string;
  className?: string;
  codeBlock?: boolean;
};

export function Markdown({ value, className, codeBlock }: MarkdownProps) {
  const content = codeBlock ? `\`\`\`\n${value}\n\`\`\`` : value;
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const url = href ?? "";
            const isExternal =
              url.startsWith("http://") ||
              url.startsWith("https://") ||
              url.startsWith("mailto:");

            if (!isExternal) {
              return <a href={href}>{children}</a>;
            }

            return (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void openUrl(url);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
