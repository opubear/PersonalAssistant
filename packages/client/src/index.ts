import {
  AppError,
  rpcReplySchema,
  parseRpcResult,
  type RpcMethod,
  type RpcParams,
  type RpcResults,
} from '@qiyi/contracts';

export interface Transport {
  request(method: RpcMethod, params: unknown): Promise<unknown>;
}

/** Browser-safe client. Node/SSH dependencies are isolated in @qiyi/client/node. */
export class AssistantClient {
  constructor(private readonly transport: Transport) {}

  async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
    const reply = rpcReplySchema.parse(await this.transport.request(method, params));
    if (!reply.ok) throw new AppError(reply.error.code, reply.error.message);
    return parseRpcResult(method, reply.data);
  }
}

export class HttpTransport implements Transport {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async request(method: RpcMethod, params: unknown): Promise<unknown> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(110_000),
      redirect: 'error',
    });
    const payload = await response.json();
    if (!response.ok && !rpcReplySchema.safeParse(payload).success)
      throw new AppError('TRANSPORT_ERROR', `请求失败（HTTP ${response.status}）`, response.status);
    return payload;
  }
}
