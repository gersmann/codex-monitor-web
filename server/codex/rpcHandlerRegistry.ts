import type { JsonRecord, RpcErrorShape } from "../types.js";

export interface TypedRpcMethodDefinition<Context, Params, Result> {
  parse(context: Context, params: JsonRecord): Params | RpcErrorShape;
  handle(
    context: Context,
    params: Params,
  ): Result | RpcErrorShape | Promise<Result | RpcErrorShape>;
}

type TypedRpcRegistry<Context> = Record<
  string,
  TypedRpcMethodDefinition<Context, unknown, unknown>
>;

export function isRpcError(value: unknown): value is RpcErrorShape {
  return Boolean(
    value &&
      typeof value === "object" &&
      "error" in value &&
      typeof (value as { error?: unknown }).error === "object",
  );
}

export function defineRpcMethod<Context, Params, Result>(
  parse: (context: Context, params: JsonRecord) => Params | RpcErrorShape,
  handle: (
    context: Context,
    params: Params,
  ) => Result | RpcErrorShape | Promise<Result | RpcErrorShape>,
): TypedRpcMethodDefinition<Context, Params, Result> {
  return { parse, handle };
}

export async function dispatchTypedRpc<
  Context,
  Registry extends TypedRpcRegistry<Context>,
>(
  registry: Registry,
  context: Context,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  const definition = registry[method];
  if (!definition) {
    return undefined;
  }
  const parsedParams = definition.parse(context, params);
  if (isRpcError(parsedParams)) {
    return parsedParams;
  }
  return await definition.handle(context, parsedParams);
}
