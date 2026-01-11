import type { Message } from "../types";

type MessagesProps = {
  messages: Message[];
};

export function Messages({ messages }: MessagesProps) {
  return (
    <div className="messages messages-full">
      {messages.map((msg) => (
        <div key={msg.id} className={`message ${msg.role}`}>
          <div className="bubble">{msg.text}</div>
        </div>
      ))}
      {!messages.length && (
        <div className="empty messages-empty">
          Start a thread and send a prompt to the agent.
        </div>
      )}
    </div>
  );
}
