import type { AppServerEventPayload, JsonRecord } from "./types.js";

export function buildAppServerEvent(
  workspaceId: string,
  method: string,
  params: JsonRecord = {},
  id?: string | number,
): AppServerEventPayload {
  const message: JsonRecord = {
    method,
    params,
  };
  if (id !== undefined) {
    message.id = id;
  }
  return {
    workspace_id: workspaceId,
    message,
  };
}
