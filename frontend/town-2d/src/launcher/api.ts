export class TownApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public details?: Record<string, unknown>
  ) {
    super(message)
  }
}
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/towns' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Town-Client': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(120000),
  })
  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false
  const data: Partial<{ error: string; code: string; details: Record<string, unknown> }> | null =
    isJson ? await response.json() : null
  if (!response.ok)
    throw new TownApiError(
      data?.error ??
        `小镇服务返回 ${response.status}${response.statusText ? ' ' + response.statusText : ''}`,
      data?.code,
      data?.details
    )
  if (!isJson) throw new TownApiError('小镇服务返回了非 JSON 内容')
  return data as T
}
