/** IndexedDB history of the last N tool tasks (inputs + detection snapshots). */

export type HistoryToolId =
  | "blur"
  | "foveal"
  | "saliency"
  | "report"
  | "portraits"
  | "collages"
  | "av"
  | "brandRemoval"
  | "textReplace";

export const HISTORY_TOOL_LABELS: Record<HistoryToolId, string> = {
  blur: "Logo blur",
  foveal: "Foveal vision",
  saliency: "Attention",
  report: "PowerPoint",
  portraits: "Faces",
  collages: "Collages",
  av: "Audio / Video",
  brandRemoval: "Brand removal",
  textReplace: "Text replace",
};

export const MAX_TASK_HISTORY = 10;

export type TaskSummary = {
  id: string;
  toolId: HistoryToolId;
  title: string;
  usedAt: number;
  createdAt: number;
};

export type StoredBlobRef = {
  key: string;
  name: string;
  mime: string;
};

export type ImageAppPayload = {
  kind: "imageApp";
  toolId: "blur" | "foveal" | "saliency" | "report";
  fileName: string;
  mimeType: string;
  blurLevelIndex: number;
  regions: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  fovealParams: {
    focalX: number;
    focalY: number;
    foveaRadius: number;
    transitionSpread: number;
    blurIntensity: number;
    desaturation: number;
  } | null;
  saliencyParams: { blurIntensity: number; desaturation: number };
  hotspotCount: number;
  hotspots: Array<{
    rank: number;
    x: number;
    y: number;
    value: number;
    share: number;
  }>;
};

export type TextReplacePayload = {
  kind: "textReplace";
  fileName: string;
  mimeType: string;
  items: unknown[];
  edits: Record<string, { replaceText: string; replaceValue: number | null }>;
  series: { itemId: string | null; steps: number; step: number };
};

export type BrandRemovalFileSnap = {
  name: string;
  mime: string;
  targets: string[];
  scene: "flat_2d" | "product_3d" | null;
  sceneConfidence: number | null;
  sceneRationale: string | null;
};

export type BrandRemovalPayload = {
  kind: "brandRemoval";
  sceneMode: "auto" | "flat_2d" | "product_3d";
  files: BrandRemovalFileSnap[];
};

export type PortraitsPayload = {
  kind: "portraits";
  smartFaceCrop: boolean;
  width: number;
  height: number;
  lockAspect: boolean;
  background: string;
  bgRemovalModel: string;
  includeBrands: boolean;
  filenameSuffix: string;
  files: Array<{ name: string; mime: string }>;
};

export type CollagesPayload = {
  kind: "collages";
  layout: "vertical" | "horizontal" | "collage";
  stripWhitespace: boolean;
  optimizeForPowerpoint: boolean;
  removeBackground: boolean;
  background: string;
  bgRemovalModel: string;
  gap: number;
  selectedGrid: { cols: number; rows: number } | null;
  allGrids: boolean;
  files: Array<{ name: string; mime: string }>;
};

export type AvPayload = {
  kind: "av";
  url: string;
  title: string;
  options: {
    transcribe: boolean;
    exportSlideImages: boolean;
    exportSlidePdf: boolean;
    language: string;
    speakerDiarization: boolean;
  };
  selectedQualityId: string | null;
  selectedPickerUrl: string | null;
  probe: unknown | null;
  transcript: string | null;
  slides: Array<{ index: number; timeSec: number }>;
};

export type TaskPayload =
  | ImageAppPayload
  | TextReplacePayload
  | BrandRemovalPayload
  | PortraitsPayload
  | CollagesPayload
  | AvPayload;

export type TaskRecord = TaskSummary & {
  payload: TaskPayload;
  blobs: StoredBlobRef[];
};

export type RestoredTask = {
  record: TaskRecord;
  files: File[];
};

const DB_NAME = "bluring-task-history";
const DB_VERSION = 1;
const STORE_TASKS = "tasks";
const STORE_BLOBS = "blobs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        const tasks = db.createObjectStore(STORE_TASKS, { keyPath: "id" });
        tasks.createIndex("usedAt", "usedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB tx failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB tx aborted"));
  });
}

export function formatUsedAt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatTaskOption(task: TaskSummary): string {
  const label = HISTORY_TOOL_LABELS[task.toolId] ?? task.toolId;
  return `${label} — ${task.title} — ${formatUsedAt(task.usedAt)}`;
}

export async function listTaskSummaries(
  limit = MAX_TASK_HISTORY,
): Promise<TaskSummary[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_TASKS, "readonly");
    const store = tx.objectStore(STORE_TASKS);
    const all = (await idbReq(store.getAll())) as TaskRecord[];
    await idbTxDone(tx);
    return all
      .map(({ id, toolId, title, usedAt, createdAt }) => ({
        id,
        toolId,
        title,
        usedAt,
        createdAt,
      }))
      .sort((a, b) => b.usedAt - a.usedAt)
      .slice(0, limit);
  } finally {
    db.close();
  }
}

export async function getRestoredTask(id: string): Promise<RestoredTask | null> {
  const db = await openDb();
  try {
    const tx = db.transaction([STORE_TASKS, STORE_BLOBS], "readonly");
    const record = (await idbReq(
      tx.objectStore(STORE_TASKS).get(id),
    )) as TaskRecord | undefined;
    if (!record) {
      await idbTxDone(tx);
      return null;
    }
    const files: File[] = [];
    for (const ref of record.blobs) {
      const row = (await idbReq(
        tx.objectStore(STORE_BLOBS).get(ref.key),
      )) as { key: string; blob: Blob } | undefined;
      if (!row?.blob) continue;
      files.push(new File([row.blob], ref.name, { type: ref.mime || row.blob.type }));
    }
    await idbTxDone(tx);
    return { record, files };
  } finally {
    db.close();
  }
}

export async function touchTask(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_TASKS, "readwrite");
    const store = tx.objectStore(STORE_TASKS);
    const record = (await idbReq(store.get(id))) as TaskRecord | undefined;
    if (record) {
      record.usedAt = Date.now();
      store.put(record);
    }
    await idbTxDone(tx);
  } finally {
    db.close();
  }
}

async function trimTasks(db: IDBDatabase): Promise<void> {
  const tx = db.transaction([STORE_TASKS, STORE_BLOBS], "readwrite");
  const taskStore = tx.objectStore(STORE_TASKS);
  const blobStore = tx.objectStore(STORE_BLOBS);
  const all = (await idbReq(taskStore.getAll())) as TaskRecord[];
  all.sort((a, b) => b.usedAt - a.usedAt);
  const keep = new Set(all.slice(0, MAX_TASK_HISTORY).map((t) => t.id));
  for (const task of all) {
    if (keep.has(task.id)) continue;
    taskStore.delete(task.id);
    for (const ref of task.blobs) {
      blobStore.delete(ref.key);
    }
  }
  await idbTxDone(tx);
}

export type SaveTaskInput = {
  toolId: HistoryToolId;
  title: string;
  payload: TaskPayload;
  files: Array<{ blob: Blob; name: string; mime?: string }>;
};

export type UpdateTaskInput = {
  title?: string;
  payload: TaskPayload;
  files?: Array<{ blob: Blob; name: string; mime?: string }>;
};

export async function saveTask(input: SaveTaskInput): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const blobs: StoredBlobRef[] = [];
  const db = await openDb();
  try {
    const tx = db.transaction([STORE_TASKS, STORE_BLOBS], "readwrite");
    const blobStore = tx.objectStore(STORE_BLOBS);
    for (let i = 0; i < input.files.length; i++) {
      const f = input.files[i];
      const key = `${id}:${i}`;
      const mime = f.mime || f.blob.type || "application/octet-stream";
      blobStore.put({ key, blob: f.blob });
      blobs.push({ key, name: f.name, mime });
    }
    const record: TaskRecord = {
      id,
      toolId: input.toolId,
      title: input.title.slice(0, 80) || "untitled",
      usedAt: now,
      createdAt: now,
      payload: input.payload,
      blobs,
    };
    tx.objectStore(STORE_TASKS).put(record);
    await idbTxDone(tx);
    await trimTasks(db);
    return id;
  } finally {
    db.close();
  }
}

export async function updateTask(
  id: string,
  input: UpdateTaskInput,
): Promise<boolean> {
  const db = await openDb();
  try {
    const tx = db.transaction([STORE_TASKS, STORE_BLOBS], "readwrite");
    const taskStore = tx.objectStore(STORE_TASKS);
    const blobStore = tx.objectStore(STORE_BLOBS);
    const existing = (await idbReq(taskStore.get(id))) as TaskRecord | undefined;
    if (!existing) {
      await idbTxDone(tx);
      return false;
    }

    let blobs = existing.blobs;
    if (input.files) {
      for (const ref of existing.blobs) {
        blobStore.delete(ref.key);
      }
      blobs = [];
      for (let i = 0; i < input.files.length; i++) {
        const f = input.files[i];
        const key = `${id}:${i}`;
        const mime = f.mime || f.blob.type || "application/octet-stream";
        blobStore.put({ key, blob: f.blob });
        blobs.push({ key, name: f.name, mime });
      }
    }

    const record: TaskRecord = {
      ...existing,
      title: input.title != null ? input.title.slice(0, 80) || "untitled" : existing.title,
      usedAt: Date.now(),
      payload: input.payload,
      blobs,
    };
    taskStore.put(record);
    await idbTxDone(tx);
    return true;
  } finally {
    db.close();
  }
}

export type UpsertTaskInput = SaveTaskInput & { id?: string | null };

/** Update existing id if present; otherwise create. Returns the task id. */
export async function upsertTask(input: UpsertTaskInput): Promise<string> {
  if (input.id) {
    const ok = await updateTask(input.id, {
      title: input.title,
      payload: input.payload,
      files: input.files,
    });
    if (ok) return input.id;
  }
  return saveTask({
    toolId: input.toolId,
    title: input.title,
    payload: input.payload,
    files: input.files,
  });
}

export function avTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    const tail = path.split("/").filter(Boolean).pop() || u.hostname;
    return `${u.hostname}/${tail}`.slice(0, 60);
  } catch {
    return url.slice(0, 60) || "media";
  }
}

export function filesTitle(names: string[]): string {
  if (names.length === 0) return "untitled";
  if (names.length === 1) return names[0].slice(0, 60);
  return `${names.length} files`;
}
