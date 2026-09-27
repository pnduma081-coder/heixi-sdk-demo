// Isolated browser fixture: no real credentials, model calls, SDK/CDN or shared DB.
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../server/config.ts";
import { AppError } from "../server/errors.ts";
import { createHandler } from "../server/http.ts";
import { createFrontendServer } from "../server/index.ts";
import { MerchantClient } from "../server/merchant.ts";
import { Operations } from "../server/operations.ts";
import { ResultService } from "../server/results.ts";
import { Store } from "../server/store.ts";

const directory = mkdtempSync(join(tmpdir(), "rhino-hardening-ui-"));
const config = resolveConfig({ directory });
config.dataDir = directory;
config.listenOrigin = "http://127.0.0.1:3455";
config.public.hostOrigin = config.listenOrigin;
config.public.apiReady = true;
config.public.sdkReady = false;
const store = new Store(":memory:");
const user = store.user("demo-a");
store.addCredit(user.id, 100, randomUUID());
const q = {
  quoteId: randomUUID(),
  clientRequestId: randomUUID(),
  externalUserId: user.externalUserId,
  estimatedCredits: 40,
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  saleItems: [{ itemId: randomUUID(), credits: 40 }],
};
try {
  await store.sales.withReservation(user, q, async () => {
    throw new AppError(502, "fixture unknown");
  });
} catch {}
const auditQuote = {
  ...q,
  quoteId: randomUUID(),
  clientRequestId: "sdk-audit-example",
  estimatedCredits: 60,
  saleItems: [{ itemId: randomUUID(), credits: 60 }],
};
store.sales.approvalPolicy(user.id, auditQuote.clientRequestId);
store.sales.freezeAudit(user, auditQuote);
store.sales.receive({
  eventId: randomUUID(),
  eventVersion: "merchant-events/v1",
  eventType: "credits.sale_debited",
  externalUserId: user.externalUserId,
  occurredAt: new Date().toISOString(),
  data: {
    quoteId: auditQuote.quoteId,
    clientRequestId: auditQuote.clientRequestId,
    itemId: auditQuote.saleItems[0].itemId,
    amount: 60,
    taskNo: "AI-ui-fixture",
    settlementId: `sale:${auditQuote.saleItems[0].itemId}:debit`,
  },
});
const requestId = "local-ui-request",
  submissionNo = "GS-local-ui";
store.startRequest(user.id, requestId, "design", {
  clientRequestId: requestId,
  feature: "MAIN_IMAGE",
  context: { example: "api-test" },
  spec: { productDescription: "独立测试：完成后延迟保存" },
});
store.finishRequest(
  user.id,
  requestId,
  { submission: { submissionNo } },
  "ACCEPTED",
);
const bytes = readFileSync(
  new URL("./fixtures/api-test-product.png", import.meta.url),
);
const file = {
  id: "b".repeat(64),
  name: "fixture.png",
  bytes: bytes.length,
  contentType: "image/png",
};
mkdirSync(join(directory, "media"));
writeFileSync(join(directory, "media", file.id), bytes);
let timer: ReturnType<typeof setTimeout> | undefined;
const api = new MerchantClient(
  "https://fixture.invalid",
  "synthetic-key",
  async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/open/models")
      return Response.json({
        code: 0,
        data: [
          {
            id: "fixture",
            modelName: "独立测试模型",
            parameterSchemaVersion: "fixture",
            isDefault: true,
          },
        ],
      });
    if (path === `/api/v1/open/generations/${submissionNo}`) {
      timer ??= setTimeout(
        () =>
          store.saveResult(
            user,
            "API",
            "fixture-event",
            {
              submissionNo,
              clientRequestId: requestId,
              status: "SUCCEEDED",
              context: { example: "api-test" },
            },
            [file],
          ),
        4000,
      );
      return Response.json({
        code: 0,
        data: { submissionNo, terminal: true, status: "SUCCEEDED", tasks: [] },
      });
    }
    throw new Error("Fixture forbids all other upstream calls");
  },
);
const results = new ResultService(store, api, {
  save: async () => {
    throw new Error("no download");
  },
});
const eventId = randomUUID();
results.inbox.receive(
  user,
  [
    {
      eventId,
      externalUserId: user.externalUserId,
      data: { submissionNo: "GS-diagnostic" },
    },
  ],
  eventId,
);
for (let attempt = 0; attempt < 3; attempt++) {
  results.inbox.failed(
    user.id,
    eventId,
    attempt,
    Date.now(),
    new AppError(400, "synthetic malformed event"),
  );
}
for (const status of ["NOT_SENT", "REJECTED"]) {
  const id = `fixture-${status}`;
  store.startRequest(user.id, id, "design", {
    clientRequestId: id,
    feature: "MAIN_IMAGE",
    context: { example: "api-test" },
  });
  store.finishRequest(user.id, id, undefined, status);
}
const handler = createHandler(
  config,
  store,
  api,
  new Operations(api, store),
  results,
);
const server = createServer((req, res) => {
  void handler(req, res).then((handled) => {
    if (!handled) vite.middlewares(req, res);
  });
});
const vite = await createFrontendServer(server, config.listenOrigin);
await new Promise<void>((resolve) => server.listen(3455, "127.0.0.1", resolve));
console.log("Independent browser fixture: http://127.0.0.1:3455/api-test");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await vite.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void stop().then(() => process.exit(0));
  });
