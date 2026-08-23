var justgetBrowser = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // node_modules/justget/dist/browser/index.js
  var index_exports = {};
  __export(index_exports, {
    ChecksumMismatchError: () => ChecksumMismatchError,
    DEFAULT_CONFIG: () => DEFAULT_CONFIG,
    Downloader: () => Downloader,
    EWMA: () => EWMA,
    SpeedMonitor: () => SpeedMonitor,
    cacheKey: () => cacheKey,
    calculateAverageSpeed: () => calculateAverageSpeed,
    calculateInstantSpeed: () => calculateInstantSpeed,
    concatBuffers: () => concatBuffers,
    digest: () => digest,
    download: () => download,
    generateShortHash: () => generateShortHash,
    getSpeedStats: () => getSpeedStats,
    hexToUint8Array: () => hexToUint8Array,
    isImmediateFailure: () => isImmediateFailure,
    loadBestSource: () => loadBestSource,
    mergeConfig: () => mergeConfig,
    prioritizeMirrors: () => prioritizeMirrors,
    recordSuccess: () => recordSuccess,
    saveBestSource: () => saveBestSource,
    uint8ArrayToHex: () => uint8ArrayToHex,
    validateConfig: () => validateConfig
  });

  // node_modules/justget/dist/config.js
  var DEFAULT_CONFIG = {
    primaryWarmupTime: 5e3,
    // 5 seconds
    speedThreshold: 512e3,
    // 500 KB/s (below this, consider mirrors)
    fastPrimaryThreshold: 2048e3,
    // 2 MB/s (above this, don't start mirrors)
    sizeThreshold: 52428800,
    // 50 MB
    minReplaceTime: 3e4,
    // 30 seconds
    replaceCheckInterval: 1e4,
    // 10 seconds
    chunks: "auto",
    chunkSize: "auto",
    minChunkSize: 1048576,
    // 1 MB
    retries: 3,
    retryDelay: 2e3,
    timeout: 3e5,
    // 5 minutes
    connectTimeout: 1e4,
    // 10 seconds
    checksumAlgorithm: "sha256",
    responseType: "blob"
  };
  var SPEED_CONFIG = {
    ewmaAlpha: 0.3,
    // EWMA smoothing factor
    sampleInterval: 1e3,
    // Sample every 1 second
    windowSize: 10
    // Keep last 10 samples
  };
  var REPLACEMENT_CONFIG = {
    minTimeBeforeReplace: 3e4,
    // 30 seconds minimum
    checkInterval: 1e4,
    // Check every 10 seconds
    slowThresholdRatio: 0.33,
    // Slow is < 33% of fast
    maxSlowChecks: 3,
    // Max consecutive slow checks
    bufferSize: 1048576,
    // 1 MB buffer before switch
    immediateFailureCodes: [
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN"
    ],
    immediateFailureHttp: [
      404,
      401,
      403,
      410,
      500,
      502,
      503,
      504
    ]
  };
  function isImmediateFailure(error, httpStatus) {
    if (httpStatus !== void 0) {
      if (httpStatus >= 500)
        return true;
      if (REPLACEMENT_CONFIG.immediateFailureHttp.includes(httpStatus)) {
        return true;
      }
    }
    const code = error.code;
    if (code && REPLACEMENT_CONFIG.immediateFailureCodes.includes(code)) {
      return true;
    }
    const message = error.message.toLowerCase();
    return message.includes("connection refused") || message.includes("network unreachable") || message.includes("host unreachable") || message.includes("aborted") || message.includes("cancelled") || message.includes("timeout") && !message.includes("download timeout");
  }
  function mergeConfig(userConfig) {
    if (!userConfig) {
      return { ...DEFAULT_CONFIG };
    }
    return {
      ...DEFAULT_CONFIG,
      ...userConfig
      // Handle nested merges if needed
    };
  }
  function validateConfig(config) {
    if (config.primaryWarmupTime !== void 0 && config.primaryWarmupTime < 0) {
      throw new Error("primaryWarmupTime must be non-negative");
    }
    if (config.speedThreshold !== void 0 && config.speedThreshold < 0) {
      throw new Error("speedThreshold must be non-negative");
    }
    if (config.fastPrimaryThreshold !== void 0 && config.fastPrimaryThreshold < 0) {
      throw new Error("fastPrimaryThreshold must be non-negative");
    }
    if (config.sizeThreshold !== void 0 && config.sizeThreshold < 0) {
      throw new Error("sizeThreshold must be non-negative");
    }
    if (config.minReplaceTime !== void 0 && config.minReplaceTime < 0) {
      throw new Error("minReplaceTime must be non-negative");
    }
    if (config.replaceCheckInterval !== void 0 && config.replaceCheckInterval < 0) {
      throw new Error("replaceCheckInterval must be non-negative");
    }
    if (config.connectTimeout !== void 0 && config.connectTimeout < 0) {
      throw new Error("connectTimeout must be non-negative");
    }
    if (config.chunks !== void 0 && typeof config.chunks === "number" && config.chunks < 1) {
      throw new Error("chunks must be at least 1");
    }
    if (config.chunkSize !== void 0 && typeof config.chunkSize === "number" && config.chunkSize < 1) {
      throw new Error("chunkSize must be at least 1");
    }
    if (config.minChunkSize !== void 0 && config.minChunkSize < 1) {
      throw new Error("minChunkSize must be at least 1");
    }
    if (config.retries !== void 0 && config.retries < 0) {
      throw new Error("retries must be non-negative");
    }
    if (config.timeout !== void 0 && config.timeout < 0) {
      throw new Error("timeout must be non-negative");
    }
    if (config.checksumAlgorithm !== void 0 && !["md5", "sha1", "sha256", "sha512"].includes(config.checksumAlgorithm)) {
      throw new Error(`Unsupported checksumAlgorithm: ${config.checksumAlgorithm}`);
    }
  }

  // node_modules/justget/dist/speed/ewma.js
  var EWMA = class {
    constructor(alpha = SPEED_CONFIG.ewmaAlpha) {
      __publicField(this, "alpha");
      __publicField(this, "value", 0);
      __publicField(this, "initialized", false);
      if (alpha <= 0 || alpha >= 1) {
        throw new Error("Alpha must be between 0 and 1");
      }
      this.alpha = alpha;
    }
    /**
     * Update EWMA with new value
     */
    update(newValue) {
      if (!this.initialized) {
        this.value = newValue;
        this.initialized = true;
      } else {
        this.value = this.alpha * newValue + (1 - this.alpha) * this.value;
      }
      return this.value;
    }
    /**
     * Get current EWMA value
     */
    getValue() {
      return this.value;
    }
    /**
     * Reset EWMA
     */
    reset() {
      this.value = 0;
      this.initialized = false;
    }
  };
  function calculateInstantSpeed(samples) {
    if (samples.length < 2) {
      return 0;
    }
    const newest = samples[samples.length - 1];
    const oldest = samples[0];
    const timeDiff = newest.timestamp - oldest.timestamp;
    if (timeDiff <= 0) {
      return 0;
    }
    return (newest.bytes - oldest.bytes) / (timeDiff / 1e3);
  }
  function calculateAverageSpeed(samples, startTime) {
    if (samples.length === 0) {
      return 0;
    }
    const lastSample = samples[samples.length - 1];
    const elapsed = lastSample.timestamp - startTime;
    if (elapsed <= 0) {
      return 0;
    }
    return lastSample.bytes / elapsed * 1e3;
  }
  function getSpeedStats(samples, startTime, ewma) {
    const current = calculateInstantSpeed(samples);
    const average = calculateAverageSpeed(samples, startTime);
    return {
      current,
      ewma: ewma.getValue(),
      peak: Math.max(current, ...samples.map((_, i) => i > 0 ? calculateInstantSpeed(samples.slice(0, i + 1)) : 0)),
      average
    };
  }

  // node_modules/justget/dist/speed/speed-monitor.js
  var SpeedMonitor = class {
    constructor(options = {}) {
      __publicField(this, "samples", []);
      __publicField(this, "ewma");
      __publicField(this, "startTime");
      __publicField(this, "options");
      __publicField(this, "interval");
      this.options = {
        alpha: options.alpha ?? SPEED_CONFIG.ewmaAlpha,
        sampleInterval: options.sampleInterval ?? SPEED_CONFIG.sampleInterval,
        windowSize: options.windowSize ?? SPEED_CONFIG.windowSize
      };
      this.ewma = new EWMA(this.options.alpha);
      this.startTime = Date.now();
    }
    /**
     * Record a speed sample
     */
    record(bytes) {
      const now = Date.now();
      const sample = { bytes, timestamp: now };
      this.samples.push(sample);
      while (this.samples.length > this.options.windowSize) {
        this.samples.shift();
      }
      if (this.samples.length >= 2) {
        const instantSpeed = calculateInstantSpeed(this.samples);
        this.ewma.update(instantSpeed);
      }
      return getSpeedStats(this.samples, this.startTime, this.ewma);
    }
    /**
     * Get current speed statistics
     */
    getStats() {
      return getSpeedStats(this.samples, this.startTime, this.ewma);
    }
    /**
     * Get current speed (EWMA)
     */
    getCurrentSpeed() {
      return this.ewma.getValue();
    }
    /**
     * Check if speed is below threshold
     */
    isBelowThreshold(threshold) {
      return this.getCurrentSpeed() < threshold;
    }
    /**
     * Start automatic sampling
     */
    startSampling(getBytes, callback) {
      this.interval = setInterval(() => {
        const bytes = getBytes();
        const stats = this.record(bytes);
        callback?.(stats);
      }, this.options.sampleInterval);
    }
    /**
     * Stop automatic sampling
     */
    stopSampling() {
      if (this.interval) {
        clearInterval(this.interval);
        this.interval = void 0;
      }
    }
    /**
     * Reset monitor
     */
    reset() {
      this.samples = [];
      this.ewma.reset();
      this.startTime = Date.now();
    }
    /**
     * Get elapsed time in milliseconds
     */
    getElapsedTime() {
      return Date.now() - this.startTime;
    }
  };

  // node_modules/justget/dist/browser/core/http.js
  async function openStream(url, options = {}) {
    const connectTimeout = options.connectTimeout ?? 1e4;
    const overallTimeout = options.timeout ?? 3e5;
    const connectController = new AbortController();
    const connectTimer = setTimeout(() => connectController.abort(), connectTimeout);
    try {
      const res = await fetch(url, { redirect: "follow", signal: connectController.signal });
      if (res.status >= 400) {
        res.body?.getReader().cancel();
        throw new HttpError(res.status, url);
      }
      const bodyController = new AbortController();
      const bodyTimer = setTimeout(() => bodyController.abort(), overallTimeout);
      const combined = combineSignals(bodyController.signal, options.signal);
      const onAbort = () => res.body?.getReader().cancel();
      combined.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(bodyTimer);
        combined.removeEventListener("abort", onAbort);
      };
      return {
        status: res.status,
        contentLength: parseContentLength(res.headers.get("content-length")),
        body: res.body,
        cancel: () => {
          cleanup();
          res.body?.getReader().cancel();
        },
        cleanup
      };
    } finally {
      clearTimeout(connectTimer);
    }
  }
  async function consumeBody(body, onChunk, signal) {
    const reader = body.getReader();
    try {
      for (; ; ) {
        if (signal?.aborted)
          throw new Error("Aborted");
        const { done, value } = await reader.read();
        if (done)
          break;
        await onChunk(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  var HttpError = class extends Error {
    constructor(status, url) {
      super(`HTTP ${status}: ${url}`);
      __publicField(this, "status");
      this.status = status;
      this.name = "HttpError";
    }
  };
  function parseContentLength(value) {
    if (!value)
      return void 0;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : void 0;
  }
  function combineSignals(...signals) {
    const controller = new AbortController();
    for (const signal of signals) {
      if (!signal)
        continue;
      if (signal.aborted) {
        controller.abort(signal.reason);
        return controller.signal;
      }
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  }

  // node_modules/justget/dist/browser/utils/buffer.js
  function concatBuffers(chunks) {
    if (chunks.length === 0)
      return new Uint8Array(0);
    if (chunks.length === 1)
      return chunks[0];
    const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks)
      result.set(chunk, offset), offset += chunk.byteLength;
    return result;
  }
  function hexToUint8Array(hex) {
    const normalized = hex.replace(/^0x/i, "");
    const result = new Uint8Array(normalized.length / 2);
    for (let i = 0; i < normalized.length; i += 2)
      result[i / 2] = parseInt(normalized.substring(i, i + 2), 16);
    return result;
  }
  function uint8ArrayToHex(data) {
    return Array.from(data).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // node_modules/justget/dist/browser/utils/hash.js
  async function digest(data, algorithm = "sha256") {
    if (algorithm === "md5") {
      throw new Error("MD5 \u4E0D\u88AB Web Crypto API \u652F\u6301\uFF0C\u8BF7\u7528 SHA-256 \u66FF\u4EE3");
    }
    const webAlgo = algorithm === "sha1" ? "SHA-1" : algorithm === "sha256" ? "SHA-256" : "SHA-512";
    const hashBuffer = await crypto.subtle.digest(webAlgo, data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function generateShortHash(input, length = 8) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0").slice(0, length);
  }

  // node_modules/justget/dist/browser/utils/cache.js
  var STORAGE_PREFIX = "justget:cache:";
  var DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  function cacheKey(resourceUrl) {
    try {
      const u = new URL(resourceUrl);
      return STORAGE_PREFIX + simpleHash(u.hostname + u.pathname);
    } catch {
      return STORAGE_PREFIX + simpleHash(resourceUrl);
    }
  }
  function saveBestSource(resourceUrl, successfulUrl) {
    try {
      const key = cacheKey(resourceUrl);
      const existing = loadEntry(key);
      const entry = {
        bestUrl: successfulUrl,
        timestamp: Date.now(),
        successCount: (existing?.successCount ?? 0) + 1
      };
      localStorage.setItem(key, JSON.stringify(entry));
    } catch {
    }
  }
  function loadBestSource(resourceUrl) {
    try {
      const key = cacheKey(resourceUrl);
      const entry = loadEntry(key);
      if (!entry)
        return null;
      if (Date.now() - entry.timestamp > DEFAULT_TTL_MS) {
        localStorage.removeItem(key);
        return null;
      }
      return entry.bestUrl;
    } catch {
      return null;
    }
  }
  function prioritizeMirrors(primaryUrl, mirrors, resourceUrl) {
    const bestUrl = loadBestSource(resourceUrl);
    if (!bestUrl)
      return { primaryUrl, mirrors };
    if (bestUrl === primaryUrl)
      return { primaryUrl, mirrors };
    const idx = mirrors.indexOf(bestUrl);
    if (idx !== -1) {
      const newMirrors = [...mirrors];
      newMirrors.splice(idx, 1, primaryUrl);
      return { primaryUrl: bestUrl, mirrors: newMirrors };
    }
    return { primaryUrl, mirrors };
  }
  function recordSuccess(resourceUrl, successfulUrl) {
    saveBestSource(resourceUrl, successfulUrl);
  }
  function loadEntry(key) {
    const raw = localStorage.getItem(key);
    if (!raw)
      return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.bestUrl || !parsed.timestamp)
        return null;
      return parsed;
    } catch {
      return null;
    }
  }
  function simpleHash(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  // node_modules/justget/dist/browser/core/downloader.js
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  var ChecksumMismatchError = class extends Error {
    constructor(expected, actual, badUrl) {
      super(`Checksum mismatch: expected ${expected}, got ${actual}`);
      __publicField(this, "expected");
      __publicField(this, "actual");
      __publicField(this, "badUrl");
      this.expected = expected;
      this.actual = actual;
      this.badUrl = badUrl;
      this.name = "ChecksumMismatchError";
    }
  };
  async function download(options) {
    const startedAt = Date.now();
    const { url, mirrors = [] } = options;
    if (!url)
      throw new Error("url is required");
    const cfg = mergeConfig(options.options);
    validateConfig(cfg);
    let candidates = [url, ...mirrors];
    let lastMismatch;
    let result;
    for (; ; ) {
      if (candidates.length === 0) {
        throw lastMismatch ?? new Error("Download failed: no source could complete");
      }
      try {
        result = await runDownload(candidates[0], candidates.slice(1), cfg, options.url);
        break;
      } catch (err) {
        if (err instanceof ChecksumMismatchError) {
          candidates = candidates.filter((u) => u !== err.badUrl);
          lastMismatch = err;
          continue;
        }
        throw err;
      }
    }
    const final = { ...result, duration: Date.now() - startedAt };
    if (cfg.onComplete)
      cfg.onComplete(final);
    return final;
  }
  async function runDownload(url, mirrors, cfg, resourceUrl) {
    const startedAt = Date.now();
    const reordered = prioritizeMirrors(url, mirrors, resourceUrl);
    url = reordered.primaryUrl;
    mirrors = reordered.mirrors;
    let contentLength;
    let mimeType = "application/octet-stream";
    try {
      const headRes = await fetch(url, { method: "HEAD", redirect: "follow" });
      if (headRes.ok) {
        const cl = headRes.headers.get("content-length");
        if (cl)
          contentLength = Number(cl);
        const ct = headRes.headers.get("content-type");
        if (ct)
          mimeType = ct.split(";")[0].trim();
      }
    } catch {
    }
    const ctx = {
      contentLength,
      workers: [],
      cfg,
      done: false,
      mirrorsStartedCount: 0,
      primaryFailedImmediately: false,
      winner: null,
      overallStartedAt: startedAt
    };
    const emitProgress = () => {
      if (!cfg.onProgress)
        return;
      const sources = ctx.workers.map((w) => ({
        id: w.id,
        url: w.url,
        downloadedBytes: w.bytesWritten,
        speed: w.monitor.getCurrentSpeed(),
        status: w.status
      }));
      const downloadedBytes = ctx.winner ? ctx.winner.chunks.reduce((s, c) => s + c.byteLength, 0) : ctx.workers.reduce((sum, w) => sum + w.bytesWritten, 0);
      const total = contentLength ?? downloadedBytes;
      const instant = ctx.workers.reduce((sum, w) => sum + w.monitor.getCurrentSpeed(), 0);
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      const speed = instant > 0 ? instant : downloadedBytes > 0 ? downloadedBytes / elapsedMs * 1e3 : 0;
      cfg.onProgress({
        downloadedBytes,
        totalBytes: total,
        percentage: total > 0 ? downloadedBytes / total * 100 : 0,
        speed,
        eta: speed > 0 ? (total - downloadedBytes) / speed * 1e3 : 0,
        sources
      });
    };
    const needMoreMirrors = () => {
      if (mirrors.length === 0)
        return false;
      if (ctx.mirrorsStartedCount >= mirrors.length)
        return false;
      const active = ctx.workers.filter((w) => w.status === "active" && !w.aborted);
      if (active.length === 0)
        return true;
      const fastest = active.reduce((a, b) => a.monitor.getCurrentSpeed() > b.monitor.getCurrentSpeed() ? a : b);
      const fastestSpeed = fastest.monitor.getCurrentSpeed();
      if (fastestSpeed >= (cfg.fastPrimaryThreshold ?? 2048e3))
        return false;
      const size = contentLength ?? 0;
      if (size < (cfg.sizeThreshold ?? 50 * 1024 * 1024))
        return false;
      if (fastestSpeed < (cfg.speedThreshold ?? 512e3))
        return true;
      return false;
    };
    const startNextMirror = () => {
      const nextIndex = ctx.mirrorsStartedCount++;
      if (nextIndex >= mirrors.length)
        return;
      const w = {
        id: `mirror-${nextIndex}`,
        url: mirrors[nextIndex],
        isPrimary: false,
        monitor: new SpeedMonitor(),
        controller: new AbortController(),
        aborted: false,
        slowChecks: 0,
        bytesWritten: 0,
        startedAt: Date.now(),
        status: "active",
        chunks: []
      };
      startWorker(w);
    };
    const maybeStartMirrors = () => {
      if (ctx.done || mirrors.length === 0)
        return;
      if (ctx.primaryFailedImmediately) {
        while (ctx.mirrorsStartedCount < mirrors.length && !ctx.done)
          startNextMirror();
        return;
      }
      if (needMoreMirrors())
        startNextMirror();
    };
    const startWorker = (w) => {
      ctx.workers.push(w);
      w.monitor.startSampling(() => w.bytesWritten);
      void runWorker(w, ctx, emitProgress).catch((err) => {
        w.error = err;
        w.status = "failed";
        ctx.lastError = ctx.lastError ?? err;
        if (w.isPrimary && isImmediateFailure(err, err.status)) {
          ctx.primaryFailedImmediately = true;
          maybeStartMirrors();
        }
      });
    };
    const primaryWorker = {
      id: "primary",
      url,
      isPrimary: true,
      monitor: new SpeedMonitor(),
      controller: new AbortController(),
      aborted: false,
      slowChecks: 0,
      bytesWritten: 0,
      startedAt: Date.now(),
      status: "active",
      chunks: []
    };
    startWorker(primaryWorker);
    const warmupTimer = setTimeout(() => maybeStartMirrors(), cfg.primaryWarmupTime ?? 5e3);
    const replaceCheck = setInterval(() => {
      if (ctx.done)
        return;
      maybeStartMirrors();
      const active = ctx.workers.filter((w) => w.status === "active" && !w.aborted);
      if (active.length < 2)
        return;
      if (Date.now() - startedAt < (cfg.minReplaceTime ?? 3e4))
        return;
      const fastest = active.reduce((a, b) => a.monitor.getCurrentSpeed() > b.monitor.getCurrentSpeed() ? a : b);
      const fastestSpeed = fastest.monitor.getCurrentSpeed();
      if (fastestSpeed <= 0)
        return;
      for (const w of active) {
        if (w === fastest)
          continue;
        const ratio = w.monitor.getCurrentSpeed() / fastestSpeed;
        if (ratio < REPLACEMENT_CONFIG.slowThresholdRatio) {
          if (++w.slowChecks >= REPLACEMENT_CONFIG.maxSlowChecks) {
            w.aborted = true;
            w.status = "failed";
            w.controller.abort();
            emitProgress();
          }
        } else
          w.slowChecks = 0;
      }
    }, cfg.replaceCheckInterval ?? 1e4);
    const progressTimer = setInterval(emitProgress, 200);
    try {
      await waitForCompletion(ctx, cfg);
      if (!ctx.done || !ctx.winner) {
        throw ctx.lastError ?? new Error("Download failed: no source could complete");
      }
      for (const w of ctx.workers) {
        if (w.status === "active")
          w.status = "completed";
      }
      const data = concatBuffers(ctx.winner.chunks);
      if (cfg.checksum) {
        const algorithm = cfg.checksumAlgorithm ?? "sha256";
        const actual = await digest(data, algorithm);
        if (actual !== cfg.checksum.toLowerCase()) {
          throw new ChecksumMismatchError(cfg.checksum.toLowerCase(), actual, ctx.winner.url);
        }
      }
      if (ctx.winner.url !== resourceUrl) {
        recordSuccess(resourceUrl, ctx.winner.url);
      }
      const finalData = cfg.responseType === "uint8array" ? data : new Blob([data], { type: mimeType });
      const finalSize = contentLength ?? data.byteLength;
      return summarize(finalData, finalSize, mimeType, ctx.workers, startedAt);
    } finally {
      clearTimeout(warmupTimer);
      clearInterval(replaceCheck);
      clearInterval(progressTimer);
      for (const w of ctx.workers) {
        w.controller.abort();
        w.monitor.stopSampling();
      }
    }
  }
  async function waitForCompletion(ctx, cfg) {
    const overall = (cfg.timeout ?? 3e5) * 3;
    const deadline = Date.now() + overall;
    while (Date.now() < deadline) {
      if (ctx.done)
        return;
      if (!ctx.workers.some((w) => w.status === "active" && !w.aborted) && ctx.workers.length > 0) {
        throw ctx.lastError ?? new Error("All sources failed");
      }
      await sleep(100);
    }
    throw new Error(`Download timeout (${overall}ms = timeout\xD73)`);
  }
  async function runWorker(w, ctx, emit) {
    const stream = await openStream(w.url, {
      connectTimeout: ctx.cfg.connectTimeout,
      timeout: ctx.cfg.timeout,
      signal: w.controller.signal
    });
    try {
      await consumeBody(stream.body, (chunk) => {
        if (w.aborted)
          throw new Error("Aborted");
        w.chunks.push(chunk);
        w.bytesWritten += chunk.byteLength;
      }, w.controller.signal);
    } finally {
      stream.cleanup();
    }
    if (!ctx.done) {
      ctx.done = true;
      ctx.winner = { chunks: w.chunks, mimeType: "", url: w.url };
      w.status = "completed";
      for (const other of ctx.workers) {
        if (other !== w && !other.aborted) {
          other.aborted = true;
          other.status = "failed";
          other.controller.abort();
        }
      }
      emit();
    }
  }
  function summarize(data, bytes, mimeType, workers, startedAt) {
    const sources = workers.map((w) => ({
      id: w.id,
      url: w.url,
      bytes: w.bytesWritten,
      duration: Date.now() - w.startedAt,
      averageSpeed: w.bytesWritten / Math.max(1, Date.now() - w.startedAt) * 1e3,
      status: w.status
    }));
    const duration = Date.now() - startedAt;
    return {
      data,
      bytes,
      duration,
      averageSpeed: duration > 0 ? bytes / duration * 1e3 : 0,
      sources,
      mimeType
    };
  }
  var Downloader = class {
    constructor(options) {
      __publicField(this, "options");
      this.options = options;
    }
    start() {
      return download(this.options);
    }
  };
  return __toCommonJS(index_exports);
})();
