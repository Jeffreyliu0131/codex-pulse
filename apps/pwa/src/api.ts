export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; message?: string }
    | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error ?? "request_failed",
      payload?.message ?? "请求未完成",
    );
  }
  return payload as T;
}
