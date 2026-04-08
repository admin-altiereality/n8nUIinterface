import {
  collection,
  doc,
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where
} from 'firebase/firestore';
import { getCurrentAuthUser, getDb, isFirebaseConfigured } from './firebase';

export type SalesFunnelExecutionStatus = 'success' | 'error' | 'waiting';

export type SalesFunnelExecutionNodeStatus = 'success' | 'error' | 'running';

export interface SalesFunnelExecutionNode {
  name: string;
  status: SalesFunnelExecutionNodeStatus;
  executionTime: number;
  itemsInput: number;
  itemsOutput: number;
}

export interface SalesFunnelExecution {
  id: string;
  status: SalesFunnelExecutionStatus;
  mode?: string;
  startedAt: string;
  stoppedAt?: string;
  nodes: SalesFunnelExecutionNode[];
}

export interface SalesFunnelHistoryItem {
  city: string;
  queryPrefix: string;
  query: string;
  ok: boolean;
  time: string;
}

export interface SalesFunnelLogEntry {
  type: string;
  message: string;
  at: string; // ISO string for display ordering
}

export interface SalesFunnelCreateRunInput {
  runId: string;
  userId: string;

  city: string;
  queryPrefix: string;
  query: string;
  startedAt: string;
  stoppedAt: string;
  ok: boolean;
  endpointMode: string;
  webhookUrl: string;
  requestUrl: string;
  responseStatus: number;
  responseBody: string;

  nodes: SalesFunnelExecutionNode[];
  logEntries: SalesFunnelLogEntry[];
}

const RUNS_COLLECTION = 'salesFunnelRuns';
const LOGS_COLLECTION = 'salesFunnelLogs';

function formatResponseText(input: {
  responseStatus: number;
  requestUrl: string;
  responseBody: string;
}): string {
  return (
    `Status: ${input.responseStatus || 'NETWORK_ERROR'}\n` +
    `Endpoint: ${input.requestUrl}\n\n` +
    `${input.responseBody || '(No response body)'}`
  );
}

export function isFirebaseBackendAvailable(): boolean {
  return isFirebaseConfigured();
}

export async function fetchRecentSalesFunnelRuns(limitCount: number): Promise<
  Array<{
    run: SalesFunnelExecution;
    history: SalesFunnelHistoryItem;
    resultText: string;
  }>
> {
  if (!isFirebaseConfigured()) return [];

  const user = getCurrentAuthUser();
  if (!user) return [];

  const db = getDb();
  const runsQuery = query(
    collection(db, RUNS_COLLECTION),
    where('userId', '==', user.uid),
    orderBy('createdAt', 'desc'),
    fsLimit(limitCount)
  );

  const snapshots = await getDocs(runsQuery);
  const items: Array<{
    run: SalesFunnelExecution;
    history: SalesFunnelHistoryItem;
    resultText: string;
  }> = [];

  snapshots.forEach((snap) => {
    const data = snap.data() as any;
    const runId = String(data.id ?? snap.id);
    const nodes = Array.isArray(data.nodes) ? (data.nodes as SalesFunnelExecutionNode[]) : [];

    const startedAt = String(data.startedAt ?? '');
    const stoppedAt = data.stoppedAt ? String(data.stoppedAt) : undefined;
    const status = (String(data.status ?? 'success').toLowerCase() as SalesFunnelExecutionStatus) || 'success';

    const run: SalesFunnelExecution = {
      id: runId,
      status: status === 'error' ? 'error' : 'success',
      mode: data.mode ? String(data.mode) : undefined,
      startedAt,
      stoppedAt,
      nodes
    };

    const history: SalesFunnelHistoryItem = {
      city: String(data.city ?? ''),
      queryPrefix: String(data.queryPrefix ?? ''),
      query: String(data.query ?? ''),
      ok: Boolean(data.ok),
      time: String(data.time ?? data.startedAt ?? new Date().toISOString())
    };

    const resultText = formatResponseText({
      responseStatus: Number(data.responseStatus ?? 0),
      requestUrl: String(data.requestUrl ?? ''),
      responseBody: String(data.responseBody ?? '')
    });

    items.push({ run, history, resultText });
  });

  return items;
}

export async function fetchRecentSalesFunnelLogs(limitCount: number): Promise<SalesFunnelLogEntry[]> {
  if (!isFirebaseConfigured()) return [];

  const user = getCurrentAuthUser();
  if (!user) return [];

  const db = getDb();
  const logsQuery = query(
    collection(db, LOGS_COLLECTION),
    where('userId', '==', user.uid),
    orderBy('createdAt', 'desc'),
    fsLimit(limitCount)
  );

  const snapshots = await getDocs(logsQuery);
  const items: SalesFunnelLogEntry[] = [];

  snapshots.forEach((snap) => {
    const data = snap.data() as any;
    items.push({
      type: String(data.type ?? ''),
      message: String(data.message ?? ''),
      at: String(data.at ?? data.createdAt?.toDate?.().toISOString?.() ?? new Date().toISOString())
    });
  });

  return items;
}

export async function createSalesFunnelRunWithLogs(input: SalesFunnelCreateRunInput): Promise<void> {
  if (!isFirebaseConfigured()) return;

  const db = getDb();

  const runDocRef = doc(db, RUNS_COLLECTION, input.runId);
  await setDoc(runDocRef, {
    id: input.runId,
    userId: input.userId,

    city: input.city,
    queryPrefix: input.queryPrefix,
    query: input.query,
    startedAt: input.startedAt,
    stoppedAt: input.stoppedAt,
    time: new Date().toISOString(),

    ok: input.ok,
    endpointMode: input.endpointMode,
    webhookUrl: input.webhookUrl,
    requestUrl: input.requestUrl,
    responseStatus: input.responseStatus,
    responseBody: input.responseBody,

    status: input.ok ? 'success' : 'error',
    mode: 'ui-trigger',
    nodes: input.nodes,

    createdAt: serverTimestamp()
  });

  // Logs are stored independently so the run doc doesn't grow without bound.
  const logsColRef = collection(db, LOGS_COLLECTION);
  const writes = input.logEntries.map((entry) => {
    const logId = `${input.runId}-${entry.at}-${Math.random().toString(16).slice(2)}`.slice(0, 200);
    return setDoc(doc(logsColRef, logId), {
      userId: input.userId,
      runId: input.runId,
      type: entry.type,
      message: entry.message,
      at: entry.at,
      createdAt: serverTimestamp()
    });
  });

  await Promise.all(writes);
}

