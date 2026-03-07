declare module "ws" {
  import type http from "node:http";
  import type { Duplex } from "node:stream";

  export class WebSocket {
    static readonly OPEN: number;
    readonly OPEN: number;
    readyState: number;
    send(data: string): void;
    once(event: "close", listener: () => void): this;
  }

  export class WebSocketServer {
    constructor(options: { noServer: boolean });
    on(event: "connection", listener: (socket: WebSocket) => void): this;
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
