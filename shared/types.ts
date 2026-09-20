export type JsonObject = Record<string, unknown>;
export type User = {
  id: string;
  name: string;
  externalUserId: string;
  credits: number;
};
export type Ledger = {
  id: string;
  userId: string;
  kind: string;
  delta: number;
  balance: number;
  reference: string;
  createdAt: string;
};
export type StoredResult = {
  id: string;
  userId: string;
  source: string;
  reference: string;
  submissionNo: string;
  status: string;
  payload: JsonObject;
  files: SavedFile[];
  receiptId: string;
  createdAt: string;
};
export type SavedFile = {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
};
export type RequestRecord = {
  id: string;
  operation: string;
  body: JsonObject;
  response: unknown;
  status: string;
  createdAt: string;
};
export type SessionState = {
  user: User;
  users: User[];
  ledger: Ledger[];
  results: StoredResult[];
  requests: RequestRecord[];
  platformCosts?: Array<{
    eventId: string;
    kind: string;
    delta: number;
    payload: JsonObject;
    createdAt: string;
  }>;
  pendingSales?: JsonObject[];
  generationFailure?: { submissionNo: string; reason: string; at: string };
};
export type DemoConfig = {
  apiOrigin?: string;
  sdkScriptUrl?: string;
  sdkVersion?: string;
  sdkDocsUrl?: string;
  apiDocsUrl?: string;
  configurationIssues?: string[];
  callbackOrigin?: string;
  apiReady: boolean;
  callbacksReady: boolean;
  sdkReady: boolean;
  missing: string[];
  hostOrigin: string;
  sdkApiOrigin: string;
};
export type ConnectionReport = {
  apiOrigin: string;
  parentOrigin: string;
  checks: Array<{
    name: string;
    status: "passed" | "failed";
    message: string;
    details?: unknown;
  }>;
};
export type MerchantEvent = {
  eventId: string;
  eventVersion: string;
  eventType: string;
  externalUserId: string;
  occurredAt: string;
  data: JsonObject;
};
