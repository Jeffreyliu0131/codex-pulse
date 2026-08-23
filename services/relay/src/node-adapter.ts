import type { IncomingMessage, ServerResponse } from "node:http";

interface VercelLikeRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

async function readNodeBody(request: VercelLikeRequest): Promise<string | undefined> {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) return undefined;
  if (typeof request.body === "string") return request.body;
  if (Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  if (request.body != null) return JSON.stringify(request.body);

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function handleNodeRequest(
  request: VercelLikeRequest,
  response: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  const protocol = firstHeader(request.headers["x-forwarded-proto"]) ?? "http";
  const host = firstHeader(request.headers["x-forwarded-host"] ?? request.headers.host) ?? "localhost";
  const incomingUrl = new URL(request.url ?? "/", `${protocol}://${host}`);
  const route = request.query?.route ?? incomingUrl.searchParams.get("route");
  if (route) {
    const routeValue = Array.isArray(route) ? route.join("/") : route;
    incomingUrl.pathname = `/api/${routeValue.replace(/^\/+/, "")}`;
    incomingUrl.searchParams.delete("route");
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value != null) headers.set(name, value);
  }

  const body = await readNodeBody(request);
  const fetchRequest = new Request(incomingUrl, {
    method: request.method ?? "GET",
    headers,
    ...(body == null ? {} : { body }),
  });
  const fetchResponse = await handler(fetchRequest);
  response.statusCode = fetchResponse.status;
  for (const [name, value] of fetchResponse.headers) response.setHeader(name, value);
  response.end(Buffer.from(await fetchResponse.arrayBuffer()));
}
