declare module "ws" {
  import type http from "node:http";
  import type { Duplex } from "node:stream";

  export class WebSocket {
    static readonly OPEN: number;
    readonly OPEN: number;
    readyState: number;
    constructor(url: string);
    send(data: string): void;
    close(): void;
    once(event: "open" | "close", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
  }

  export class WebSocketServer {
    constructor(options: { noServer: boolean });
    on(
      event: "connection",
      listener: (socket: WebSocket, request: http.IncomingMessage) => void,
    ): this;
    close(callback: () => void): void;
    emit(
      event: "connection",
      socket: WebSocket,
      request: http.IncomingMessage,
    ): boolean;
    handleUpgrade(
      request: http.IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: WebSocket) => void,
    ): void;
  }
}
