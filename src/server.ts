import { createServer } from "node:http";
import { createHttpBusiness } from "./chat/business.ts";
import { createChatService, DEFAULT_PORT, routeChat } from "./chat/handle.ts";
import { proposeMemories } from "./memory/remember.ts";

const service = createChatService({ business: createHttpBusiness(), proposeMemories });
const port = Number(process.env.PORT || DEFAULT_PORT);

createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const url = new URL(request.url || "/", "http://fithub-ai");
  const result = await routeChat({
    method: request.method || "GET",
    path: url.pathname,
    authorization: request.headers.authorization,
    rawBody,
  }, service);
  const payload = JSON.stringify(result.payload);
  response.writeHead(result.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}).listen(port, "0.0.0.0", () => {
  console.log(`fithub-ai listening on ${port}`);
});
