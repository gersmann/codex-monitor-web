import { useEffect, useRef } from "react";
import type { ConversationItem } from "../types";
import { Markdown } from "./Markdown";

type MessagesProps = {
  items: ConversationItem[];
  isThinking: boolean;
};

export function Messages({ items, isThinking }: MessagesProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, isThinking]);

  return (
    <div className="messages messages-full">
      {items.map((item) => {
        if (item.kind === "message") {
          return (
            <div key={item.id} className={`message ${item.role}`}>
              <div className="bubble">
                <Markdown value={item.text} className="markdown" />
              </div>
            </div>
          );
        }
        if (item.kind === "reasoning") {
          const summaryText = item.summary || item.content;
          const summaryLines = summaryText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const rawTitle =
            summaryLines.length > 0
              ? summaryLines[summaryLines.length - 1]
              : "Reasoning";
          const cleanTitle = rawTitle
            .replace(/[`*_~]/g, "")
            .replace(/\[(.*?)\]\(.*?\)/g, "$1")
            .trim();
          const summaryTitle =
            cleanTitle.length > 80
              ? `${cleanTitle.slice(0, 80)}…`
              : cleanTitle || "Reasoning";
          return (
            <details key={item.id} className="item-card reasoning">
              <summary>
                <span className="item-summary-left">
                  <span className="item-chevron" aria-hidden>
                    ▸
                  </span>
                  <span className="item-title">{summaryTitle}</span>
                </span>
              </summary>
              <div className="item-body">
                {item.summary && (
                  <Markdown value={item.summary} className="item-text markdown" />
                )}
                {item.content && (
                  <Markdown value={item.content} className="item-text markdown" />
                )}
              </div>
            </details>
          );
        }
        if (item.kind === "diff") {
          return (
            <details key={item.id} className="item-card diff">
              <summary>
                <span className="item-summary-left">
                  <span className="item-chevron" aria-hidden>
                    ▸
                  </span>
                  <span className="item-title">{item.title}</span>
                </span>
                {item.status && <span className="item-status">{item.status}</span>}
              </summary>
              <div className="item-body">
                <Markdown
                  value={item.diff}
                  className="item-output markdown"
                  codeBlock
                />
              </div>
            </details>
          );
        }
        const isFileChange = item.toolType === "fileChange";
        return (
          <details key={item.id} className="item-card tool">
            <summary>
              <span className="item-summary-left">
                <span className="item-chevron" aria-hidden>
                  ▸
                </span>
                <span className="item-title">{item.title}</span>
              </span>
              {item.status && <span className="item-status">{item.status}</span>}
            </summary>
            <div className="item-body">
              {!isFileChange && item.detail && (
                <Markdown value={item.detail} className="item-text markdown" />
              )}
              {isFileChange && item.changes?.length ? (
                <div className="file-change-list">
                  {item.changes.map((change, index) => (
                    <div
                      key={`${change.path}-${index}`}
                      className="file-change"
                    >
                      <div className="file-change-header">
                        {change.kind && (
                          <span className="file-change-kind">
                            {change.kind.toUpperCase()}
                          </span>
                        )}
                        <span className="file-change-path">{change.path}</span>
                      </div>
                      {change.diff && (
                        <Markdown
                          value={change.diff}
                          className="item-output markdown"
                          codeBlock
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
              {isFileChange && !item.changes?.length && item.detail && (
                <Markdown value={item.detail} className="item-text markdown" />
              )}
              {item.output && (!isFileChange || !item.changes?.length) && (
                <Markdown
                  value={item.output}
                  className="item-output markdown"
                  codeBlock
                />
              )}
              {isFileChange && item.output && item.changes?.length ? (
                <Markdown
                  value={item.output}
                  className="item-output markdown"
                  codeBlock
                />
              ) : null}
            </div>
          </details>
        );
      })}
      {isThinking && (
        <div className="thinking">Codex is thinking...</div>
      )}
      {!items.length && (
        <div className="empty messages-empty">
          Start a thread and send a prompt to the agent.
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
