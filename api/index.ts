import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../services/relay/src/env.ts";
import { createRelayHandler } from "../services/relay/src/http.ts";
import { handleNodeRequest } from "../services/relay/src/node-adapter.ts";
import { PostgresStore } from "../services/relay/src/postgres-store.ts";

const config = loadConfig();
const store = new PostgresStore(config.databaseUrl);
const relay = createRelayHandler({ store, config });

export default async function handler(
  request: IncomingMessage & {
    body?: unknown;
    query?: Record<string, string | string[] | undefined>;
  },
  response: ServerResponse,
): Promise<void> {
  await handleNodeRequest(request, response, relay);
}
