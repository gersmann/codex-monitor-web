import { describe, expect, it } from "vitest";
import { classifyRpcBoundaryError, isRpcErrorShape } from "./rpcErrors.js";

describe("rpcErrors", () => {
  it("preserves typed rpc errors at the boundary", () => {
    const error = { error: { status: 418, message: "teapot" } };

    expect(isRpcErrorShape(error)).toBe(true);
    expect(classifyRpcBoundaryError(error)).toEqual(error);
  });

  it("maps not found failures to 404 responses", () => {
    const classified = classifyRpcBoundaryError(new Error("Workspace not found."));

    expect(classified).toEqual({
      error: {
        status: 404,
        message: "Workspace not found.",
      },
    });
  });

  it("maps validation failures to 400 responses", () => {
    const classified = classifyRpcBoundaryError(
      new Error("Prompt path is not within allowed directories."),
    );

    expect(classified).toEqual({
      error: {
        status: 400,
        message: "Prompt path is not within allowed directories.",
      },
    });
  });

  it("matches normalized bad request rules", () => {
    const classified = classifyRpcBoundaryError(new Error("TerminalId is required."));

    expect(classified).toEqual({
      error: {
        status: 400,
        message: "TerminalId is required.",
      },
    });
  });

  it("keeps unexpected failures as 500 responses", () => {
    const classified = classifyRpcBoundaryError(new Error("database offline"));

    expect(classified).toEqual({
      error: {
        status: 500,
        message: "database offline",
      },
    });
  });
});
