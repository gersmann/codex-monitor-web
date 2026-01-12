import { useEffect, useRef, useState } from "react";
import type { ConversationItem } from "../types";
import { Markdown } from "./Markdown";
import { DiffBlock } from "./DiffBlock";
import { languageFromPath } from "../utils/syntax";

type MessagesProps = {
  items: ConversationItem[];
  isThinking: boolean;
};

export function Messages({ items, isThinking }: MessagesProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const seenItems = useRef(new Set<string>());
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const maxVisibleItems = 30;

  const visibleItems =
    !showAll && items.length > maxVisibleItems
      ? items.slice(-maxVisibleItems)
      : items;

  useEffect(() => {
    setOpenItems((prev) => {
      let changed = false;
      const next = new Set(prev);
      items.forEach((item) => {
        if (seenItems.current.has(item.id)) {
          return;
        }
        seenItems.current.add(item.id);
        const shouldOpen =
          item.kind === "tool" && item.toolType === "fileChange";
        if (shouldOpen) {
          next.add(item.id);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [items]);

  useEffect(() => {
    if (!bottomRef.current) {
      return undefined;
    }
    let raf1 = 0;
    let raf2 = 0;
    const target = bottomRef.current;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: "smooth", block: "end" });
      });
    });
    return () => {
      if (raf1) {
        window.cancelAnimationFrame(raf1);
      }
      if (raf2) {
        window.cancelAnimationFrame(raf2);
      }
    };
  }, [items.length, isThinking]);

  return (
    <div
      ref={listRef}
      className="messages messages-full"
      onScroll={() => {
        const node = listRef.current;
        if (!node) {
          return;
        }
        const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
        if (!showAll && node.scrollTop <= 80) {
          setShowAll(true);
        } else if (showAll && distanceFromBottom <= 80) {
          setShowAll(false);
        }
      }}
    >
      {visibleItems.map((item) => {
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
            <details
              key={item.id}
              className="item-card reasoning"
              open={openItems.has(item.id)}
              onToggle={(event) => {
                const isOpen = event.currentTarget.open;
                setOpenItems((prev) => {
                  const next = new Set(prev);
                  if (isOpen) {
                    next.add(item.id);
                  } else {
                    next.delete(item.id);
                  }
                  return next;
                });
              }}
            >
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
        if (item.kind === "review") {
          const title =
            item.state === "started" ? "Review started" : "Review completed";
          return (
            <div key={item.id} className="item-card review">
              <div className="review-header">
                <span className="review-title">{title}</span>
                <span
                  className={`review-badge ${
                    item.state === "started" ? "active" : "done"
                  }`}
                >
                  Review
                </span>
              </div>
              {item.text && (
                <Markdown value={item.text} className="item-text markdown" />
              )}
            </div>
          );
        }
        const isFileChange = item.toolType === "fileChange";
        const isCommand = item.toolType === "commandExecution";
        const commandText = isCommand
          ? item.title.replace(/^Command:\s*/i, "").trim()
          : "";
        const summaryTitle = isCommand ? "Command" : item.title;
        return (
          <details
            key={item.id}
            className="item-card tool"
            open={isFileChange ? openItems.has(item.id) : undefined}
            onToggle={
              isFileChange
                ? (event) => {
                    const isOpen = event.currentTarget.open;
                    setOpenItems((prev) => {
                      const next = new Set(prev);
                      if (isOpen) {
                        next.add(item.id);
                      } else {
                        next.delete(item.id);
                      }
                      return next;
                    });
                  }
                : undefined
            }
          >
            <summary>
              <span className="item-summary-left">
                <span className="item-chevron" aria-hidden>
                  ▸
                </span>
                <span className="item-title">{summaryTitle}</span>
                {isCommand && commandText && (
                  <span className="item-subtitle">{commandText}</span>
                )}
              </span>
              {item.status && <span className="item-status">{item.status}</span>}
            </summary>
            <div className="item-body">
              {!isFileChange && isCommand && commandText && (
                <div className="tool-command">
                  <span className="tool-label">Command</span>
                  <pre className="tool-command-text">{commandText}</pre>
                </div>
              )}
              {!isFileChange && isCommand && item.detail && (
                <div className="tool-meta">
                  <span className="tool-label">CWD</span>
                  <span className="tool-cwd">{item.detail}</span>
                </div>
              )}
              {!isFileChange && !isCommand && item.detail && (
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
                        <div className="diff-viewer-output">
                          <DiffBlock
                            diff={change.diff}
                            language={languageFromPath(change.path)}
                          />
                        </div>
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
