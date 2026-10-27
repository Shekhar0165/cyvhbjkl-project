const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const REQUEST_TIMEOUT_MS = 30_000;
const GET_CACHE_MS = 20_000;
const completed = new Map();
const requests = new Map();
const queue = [];
let activeCount = 0;
const MAX_CONCURRENT_REQUESTS = 4;

function pumpQueue() {
  while (activeCount < MAX_CONCURRENT_REQUESTS && queue.length) {
    const entry = queue.shift();
    if (entry.abandoned) continue;
    activeCount += 1;
    entry.started = true;
    runWithRetry(entry).then((value) => { entry.completed = true; entry.resolve(value); }, (error) => { entry.completed = true; entry.reject(error); }).finally(() => {
      activeCount -= 1;
      if (requests.get(entry.key) === entry) requests.delete(entry.key);
      pumpQueue();
    });
  }
}

async function fetchAttempt(entry) {
  const controller = new AbortController();
  entry.controller = controller;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(entry.url, { ...entry.options, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof body?.detail === "string" ? body.detail : `Request failed (${response.status})`;
      const error = new Error(message);
      error.retryable = response.status >= 500;
      throw error;
    }
    if (entry.method === "GET") completed.set(entry.key, { body, expiresAt: Date.now() + GET_CACHE_MS });
    return body;
  } catch (error) {
    if (controller.signal.aborted && entry.abandoned) throw new Error("The request was cancelled because the inputs changed. Try again.");
    if (timedOut) {
      const timeout = new Error("The request took longer than 30 seconds. Please try again.");
      timeout.retryable = true;
      throw timeout;
    }
    if (error instanceof TypeError) {
      const network = new Error("Could not reach the backend. Check that it is running, then try again.");
      network.retryable = true;
      throw network;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    entry.controller = null;
  }
}

async function runWithRetry(entry) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await fetchAttempt(entry); }
    catch (error) {
      if (!error.retryable || attempt >= 1 || entry.abandoned) throw error;
    }
  }
}

function sharedRequest(url, options = {}, subscriberSignal) {
  const method = (options.method || "GET").toUpperCase();
  const key = `${method} ${url} ${options.body || ""}`;
  if (subscriberSignal?.aborted) return Promise.reject(new Error("The request was cancelled because the inputs changed. Try again."));
  if (method === "GET") {
    const cached = completed.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.body);
    if (cached) completed.delete(key);
  }

  let entry = requests.get(key);
  if (!entry) {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    entry = { key, url, method, options: { ...options }, promise, resolve, reject, subscribers: 0, started: false, abandoned: false, completed: false, controller: null };
    requests.set(key, entry);
    queue.push(entry);
    pumpQueue();
  }

  entry.subscribers += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (!entry.subscribers && !entry.completed) {
        // Defer cancellation one task so StrictMode's immediate remount can re-subscribe.
        setTimeout(() => {
          if (!entry.subscribers && !entry.completed) {
            entry.abandoned = true;
            entry.controller?.abort();
            if (!entry.started) {
              const index = queue.indexOf(entry);
              if (index >= 0) queue.splice(index, 1);
              if (requests.get(entry.key) === entry) requests.delete(entry.key);
              entry.reject(new Error("The request was cancelled because the inputs changed. Try again."));
            }
          }
        }, 0);
      }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      subscriberSignal?.removeEventListener("abort", onAbort);
      release();
      callback(value);
    };
    const onAbort = () => {
      finish(reject, new Error("The request was cancelled because the inputs changed. Try again."));
    };
    subscriberSignal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then((data) => finish(resolve, data), (error) => finish(reject, error)).finally(release);
  });
}

function get(path, options = {}) {
  const url = `${API_BASE_URL}${path}`;
  const { signal, ...fetchOptions } = options;
  return sharedRequest(url, { ...fetchOptions, method: "GET", cache: "no-store" }, signal);
}

export const fetchMeta = (options) => get("/api/v1/meta", options);
export const fetchHealth = (options) => get("/health", options);
export function fetchForecast(decisionDate, cutoff, options) {
  return get(`/api/v1/forecast?${new URLSearchParams({ decision_date: decisionDate, cutoff })}`, options);
}
export function fetchEvolution(decisionDate, cutoff, options) {
  return get(`/api/v1/forecast/evolution?${new URLSearchParams({ decision_date: decisionDate, cutoff })}`, options);
}
export function fetchAccuracy(from, to, cutoff, options) {
  return get(`/api/v1/accuracy?${new URLSearchParams({ from, to, cutoff })}`, options);
}
export function fetchErrorDistribution(from, to, cutoff, options) {
  return get(`/api/v1/accuracy/error-distribution?${new URLSearchParams({ from, to, cutoff })}`, options);
}
export function fetchHorizon(from, to, options) {
  return get(`/api/v1/accuracy/by-horizon?${new URLSearchParams({ from, to })}`, options);
}
export function fetchHourOfDay(from, to, cutoff, options) {
  return get(`/api/v1/accuracy/by-hour-of-day?${new URLSearchParams({ from, to, cutoff })}`, options);
}
export function fetchProcurementPlan(payload, { signal } = {}) {
  return sharedRequest(`${API_BASE_URL}/api/v1/procurement/plan`, {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }, signal);
}
export function fetchProcurementBacktest(from, to, cutoff, confidence, demand, { signal } = {}) {
  const query = new URLSearchParams({ from, to, cutoff, confidence: String(confidence), demand_mw: String(demand) });
  return get(`/api/v1/procurement/backtest?${query}`, { signal });
}
