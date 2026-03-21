import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodePtyTerminalManager, createTerminalRuntime } from "./terminal.js";

type MockPty = {
  onData: (handler: (data: string) => void) => void;
  onExit: (handler: () => void) => void;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emitData: (data: string) => void;
  emitExit: () => void;
};

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node-pty", () => ({
  spawn: spawnMock,
}));

function createMockPty(): MockPty {
  let onDataHandler: ((data: string) => void) | null = null;
  let onExitHandler: (() => void) | null = null;
  const write = vi.fn();
  const resize = vi.fn();
  const kill = vi.fn();

  return {
    onData: (handler) => {
      onDataHandler = handler;
    },
    onExit: (handler) => {
      onExitHandler = handler;
    },
    write,
    resize,
    kill,
    emitData: (data) => {
      onDataHandler?.(data);
    },
    emitExit: () => {
      onExitHandler?.();
    },
  };
}

describe("NodePtyTerminalManager", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("opens a new session and broadcasts terminal output", async () => {
    const pty = createMockPty();
    spawnMock.mockReturnValue(pty);
    const broadcast = vi.fn();
    const manager = new NodePtyTerminalManager(broadcast);

    const result = await manager.openSession({
      workspaceId: "ws-1",
      terminalId: "term-1",
      cwd: "/tmp/workspace",
      cols: 120,
      rows: 40,
    });

    expect(result).toEqual({ id: "term-1" });
    pty.emitData("hello\n");
    expect(broadcast).toHaveBeenCalledWith({
      event: "terminal-output",
      payload: {
        workspaceId: "ws-1",
        terminalId: "term-1",
        data: "hello\n",
      },
    });
  });

  it("reuses an existing session by resizing instead of spawning", async () => {
    const pty = createMockPty();
    spawnMock.mockReturnValue(pty);
    const manager = new NodePtyTerminalManager(() => {});

    await manager.openSession({
      workspaceId: "ws-1",
      terminalId: "term-1",
      cwd: "/tmp/workspace",
      cols: 120,
      rows: 40,
    });
    const result = await manager.openSession({
      workspaceId: "ws-1",
      terminalId: "term-1",
      cwd: "/tmp/workspace",
      cols: 140,
      rows: 60,
    });

    expect(result).toEqual({ id: "term-1" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(pty.resize).toHaveBeenCalledWith(140, 60);
  });

  it("throws on restoreOnly when a session is missing", async () => {
    const manager = new NodePtyTerminalManager(() => {});

    await expect(
      manager.openSession({
        workspaceId: "ws-1",
        terminalId: "term-missing",
        cwd: "/tmp/workspace",
        cols: 120,
        rows: 40,
        restoreOnly: true,
      }),
    ).rejects.toThrow("Terminal session not found");
  });

  it("throws when write/resize/close target missing sessions", async () => {
    const manager = new NodePtyTerminalManager(() => {});

    await expect(manager.writeSession("ws-1", "missing", "pwd\n")).rejects.toThrow(
      "Terminal session not found",
    );
    await expect(manager.resizeSession("ws-1", "missing", 120, 40)).rejects.toThrow(
      "Terminal session not found",
    );
    await expect(manager.closeSession("ws-1", "missing")).rejects.toThrow(
      "Terminal session not found",
    );
  });

  it("broadcasts terminal exit and removes the session on pty exit", async () => {
    const pty = createMockPty();
    spawnMock.mockReturnValue(pty);
    const broadcast = vi.fn();
    const manager = new NodePtyTerminalManager(broadcast);

    await manager.openSession({
      workspaceId: "ws-1",
      terminalId: "term-1",
      cwd: "/tmp/workspace",
      cols: 120,
      rows: 40,
    });
    pty.emitExit();

    expect(broadcast).toHaveBeenCalledWith({
      event: "terminal-exit",
      payload: {
        workspaceId: "ws-1",
        terminalId: "term-1",
      },
    });
    await expect(manager.writeSession("ws-1", "term-1", "pwd\n")).rejects.toThrow(
      "Terminal session not found",
    );
  });

  it("kills sessions for closeSession and closeAll", async () => {
    const ptyOne = createMockPty();
    const ptyTwo = createMockPty();
    spawnMock.mockReturnValueOnce(ptyOne).mockReturnValueOnce(ptyTwo);
    const manager = new NodePtyTerminalManager(() => {});

    await manager.openSession({
      workspaceId: "ws-1",
      terminalId: "term-1",
      cwd: "/tmp/workspace",
      cols: 120,
      rows: 40,
    });
    await manager.openSession({
      workspaceId: "ws-1",
      terminalId: "term-2",
      cwd: "/tmp/workspace",
      cols: 120,
      rows: 40,
    });

    await manager.closeSession("ws-1", "term-1");
    expect(ptyOne.kill).toHaveBeenCalledTimes(1);

    await manager.closeAll();
    expect(ptyTwo.kill).toHaveBeenCalledTimes(1);
  });
});

describe("createTerminalRuntime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when terminal feature flag is disabled", () => {
    vi.stubEnv("CODEX_MONITOR_ENABLE_TERMINAL", "0");
    expect(createTerminalRuntime(() => {})).toBeNull();
  });

  it("returns a runtime when terminal feature flag is enabled", () => {
    vi.stubEnv("CODEX_MONITOR_ENABLE_TERMINAL", "1");
    expect(createTerminalRuntime(() => {})).toBeInstanceOf(NodePtyTerminalManager);
  });
});
