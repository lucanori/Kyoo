export type ErrorCategory = "recoverable" | "unsupported" | "unknown";

export type ErrorReason =
	| "network"
	| "offline"
	| "unsupported"
	| "decode"
	| "auth"
	| "not-found"
	| "unknown";

export interface ClassifiedPlaybackError {
	category: ErrorCategory;
	reason: ErrorReason;
	sanitizedMessage: string;
}

export type RecoveryPhase =
	| "idle"
	| "scheduled"
	| "offline"
	| "exhausted"
	| "unrecoverable"
	| "unknown";

export interface RecoverySnapshot {
	sourceKey: string;
	phase: RecoveryPhase;
	reason: ErrorReason | null;
	attempts: number;
	maxAttempts: number;
	canManualRetry: boolean;
	resumeTime: number | null;
	restart: { key: number; startTime: number | null } | null;
}

export const MAX_AUTO_RETRIES = 3;
export const BACKOFF_DELAYS_MS = [1000, 2000, 4000] as const;
export const PROGRESS_RESET_DELTA_SEC = 2;
// A single playback step larger than this is treated as a seek or a tech
// reset, never as playback progress. Genuine steps arrive on every
// timeupdate and are far smaller, including at elevated playback rates.
export const MAX_PLAYBACK_STEP_SEC = 1;

const URL_PATTERN = /\b(?:https?|blob|data|wss?):\/\/\S+/gi;
const SECRET_PARAM_PATTERN =
	/\b(?:x-presign|token|auth|signature|sig|expires)=[^\s&"']+/gi;
const BEARER_PATTERN = /\bbearer\s+[a-z0-9._-]+/gi;

export const sanitizeErrorText = (raw: string): string => {
	const cleaned = raw
		.replace(URL_PATTERN, "[url]")
		.replace(SECRET_PARAM_PATTERN, "[redacted]")
		.replace(BEARER_PATTERN, "Bearer [redacted]")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= 180) return cleaned;
	return `${cleaned.slice(0, 177)}...`;
};

// The web error bridge forwards only the media message (see the installed
// hls.js adapter, which builds its media error from the loader message
// alone), so classification must stay anchored to the exact strings those
// packages produce. Loose digit or phrase matching is unsafe here: the
// same text can appear inside a signed URL, and the generic source
// default covers both unavailable and incompatible media.
const MEDIA_ERR_NETWORK_MESSAGE =
	"this media could not be loaded due to a network or server issue.";
const MEDIA_ERR_DECODE_MESSAGE =
	"this media could not be played. it may be corrupted, or your browser may not support its format.";
const MEDIA_ERR_SRC_NOT_SUPPORTED_MESSAGE =
	"this media could not be loaded. it may be unavailable, or your browser may not support its format.";
const MEDIA_ERR_ENCRYPTED_MESSAGE =
	"this media could not be played because it could not be decrypted.";

const HTTP_AUTH_PATTERN = /^http(?:\s+error)?\s+(401|403)\b/;
const HTTP_NOT_FOUND_PATTERN = /^http(?:\s+error)?\s+(404|410)\b/;
const HTTP_NETWORK_PATTERN = /^http(?:\s+error)?\s+(5\d\d|0)\b/;
const HTTP_TIMEOUT_PATTERN = /^timeout after \d+\s*ms\b/;
// hls.js playlist-loader's manifest branch, as forwarded by the adapter.
const HLS_MANIFEST_FAILURE =
	/^a network (?:timeout|error(?: \(status (0|[1-5]\d{2})\))?) occurred while loading manifest$/;
const TRANSIENT_GATEWAY_STATUS = new Set(["502", "503", "504"]);

export const classifyBrowserPlaybackError = (
	type: string,
	message: string,
): ClassifiedPlaybackError => {
	const sanitizedMessage = sanitizeErrorText(message || type || "");
	// The bridge sends the same message as both arguments. Evaluate each
	// candidate separately and anchor the structured patterns to its start
	// so digits or phrases inside a URL cannot trigger a classification.
	const candidates = [message, type]
		.map((value) => (value ?? "").trim().toLowerCase())
		.filter((value) => value !== "");
	const isExactly = (expected: string) =>
		candidates.some((candidate) => candidate === expected);
	const matchesStart = (pattern: RegExp) =>
		candidates.some((candidate) => pattern.test(candidate));

	if (
		candidates.length === 0 ||
		candidates.every((candidate) => candidate === "unknown error")
	) {
		return {
			category: "unknown",
			reason: "unknown",
			sanitizedMessage,
		};
	}

	if (isExactly(MEDIA_ERR_DECODE_MESSAGE)) {
		return {
			category: "unsupported",
			reason: "decode",
			sanitizedMessage,
		};
	}

	if (isExactly(MEDIA_ERR_ENCRYPTED_MESSAGE)) {
		return {
			category: "unsupported",
			reason: "unsupported",
			sanitizedMessage,
		};
	}

	// The generic source default says the media may be unavailable or may
	// be unsupported. It is ambiguous, so do not guess a retry policy from
	// it; allow a manual retry instead.
	if (isExactly(MEDIA_ERR_SRC_NOT_SUPPORTED_MESSAGE)) {
		return {
			category: "unknown",
			reason: "unknown",
			sanitizedMessage,
		};
	}

	if (isExactly("source/unsupported-content-type")) {
		return {
			category: "unsupported",
			reason: "unsupported",
			sanitizedMessage,
		};
	}

	const manifestFailure = candidates
		.map((candidate) => HLS_MANIFEST_FAILURE.exec(candidate))
		.find((match) => match !== null);
	const status = manifestFailure?.[1];

	if (status === "401" || status === "403" || matchesStart(HTTP_AUTH_PATTERN)) {
		return {
			category: "unsupported",
			reason: "auth",
			sanitizedMessage,
		};
	}

	if (
		status === "404" ||
		status === "410" ||
		matchesStart(HTTP_NOT_FOUND_PATTERN)
	) {
		return {
			category: "unsupported",
			reason: "not-found",
			sanitizedMessage,
		};
	}

	if (
		isExactly(MEDIA_ERR_NETWORK_MESSAGE) ||
		isExactly("failed to fetch") ||
		(manifestFailure &&
			(!status || status === "0" || TRANSIENT_GATEWAY_STATUS.has(status))) ||
		matchesStart(HTTP_NETWORK_PATTERN) ||
		matchesStart(HTTP_TIMEOUT_PATTERN)
	) {
		return {
			category: "recoverable",
			reason: "network",
			sanitizedMessage,
		};
	}

	return {
		category: "unknown",
		reason: "unknown",
		sanitizedMessage,
	};
};

export interface RecoveryTimers {
	setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

export interface PlaybackRecoveryOptions {
	maxAttempts?: number;
	backoffDelaysMs?: readonly number[];
	progressResetDeltaSec?: number;
	isOnline?: () => boolean;
	timers?: RecoveryTimers;
	onStateChange: (snapshot: RecoverySnapshot) => void;
}

export class PlaybackRecoveryManager {
	private readonly maxAttempts: number;
	private readonly backoffDelaysMs: readonly number[];
	private readonly progressResetDeltaSec: number;
	private readonly isOnline: () => boolean;
	private readonly timers: RecoveryTimers;
	private readonly onStateChange: (snapshot: RecoverySnapshot) => void;

	private enabled = false;
	private sourceKey = "";
	private phase: RecoveryPhase = "idle";
	private reason: ErrorReason | null = null;
	private attempts = 0;
	private canManualRetry = false;
	private lastValidTime: number | null = null;
	private resumeTime: number | null = null;
	private restart: RecoverySnapshot["restart"] = null;
	private techKey = 0;
	private awaitingConfirmation = false;
	private lastObservedTime: number | null = null;
	private progressAccumSec = 0;

	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: PlaybackRecoveryOptions) {
		this.maxAttempts = options.maxAttempts ?? MAX_AUTO_RETRIES;
		this.backoffDelaysMs = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS;
		this.progressResetDeltaSec =
			options.progressResetDeltaSec ?? PROGRESS_RESET_DELTA_SEC;
		this.isOnline =
			options.isOnline ??
			(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
		this.timers = options.timers ?? {
			setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
			clearTimeout: (id) => globalThis.clearTimeout(id),
		};
		this.onStateChange = options.onStateChange;
	}

	getSnapshot(): RecoverySnapshot {
		return {
			sourceKey: this.sourceKey,
			phase: this.phase,
			reason: this.reason,
			attempts: this.attempts,
			maxAttempts: this.maxAttempts,
			canManualRetry: this.canManualRetry,
			resumeTime: this.resumeTime,
			restart: this.restart,
		};
	}

	private emit() {
		this.onStateChange(this.getSnapshot());
	}

	private clearRetryTimer() {
		if (this.retryTimer !== null) {
			this.timers.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	private clearProgress() {
		this.lastObservedTime = null;
		this.progressAccumSec = 0;
	}

	private resetState() {
		this.clearRetryTimer();
		this.phase = "idle";
		this.reason = null;
		this.attempts = 0;
		this.canManualRetry = false;
		this.lastValidTime = null;
		this.resumeTime = null;
		this.awaitingConfirmation = false;
		this.clearProgress();
	}

	setContext({ enabled, sourceKey }: { enabled: boolean; sourceKey: string }) {
		if (this.enabled === enabled && this.sourceKey === sourceKey) return;
		// Toggling recovery (e.g. during cast) must not reload the same media.
		if (this.sourceKey !== sourceKey) this.restart = null;
		this.enabled = enabled;
		this.sourceKey = sourceKey;
		this.resetState();
		this.emit();
	}

	reportProgress({
		currentTime,
		isPlaying,
		status,
	}: {
		currentTime: number;
		isPlaying: boolean;
		status: string;
	}) {
		if (!this.enabled || this.phase !== "idle") return;
		if (!Number.isFinite(currentTime) || currentTime < 0) return;
		const ready = status === "readyToPlay";
		if (ready && !this.awaitingConfirmation) this.lastValidTime = currentTime;
		if (!ready || !isPlaying) {
			this.clearProgress();
			return;
		}
		if (!this.awaitingConfirmation) return;

		// Keep the resume position and retry budget until the new element
		// has actually advanced. A seek, startup time, or short failed load
		// is not enough to confirm recovery.
		const previousTime = this.lastObservedTime;
		this.lastObservedTime = currentTime;
		if (previousTime === null) return;
		const delta = currentTime - previousTime;
		if (delta < 0 || delta > MAX_PLAYBACK_STEP_SEC) {
			this.progressAccumSec = 0;
			return;
		}
		this.progressAccumSec += delta;
		if (this.progressAccumSec >= this.progressResetDeltaSec) {
			this.awaitingConfirmation = false;
			this.lastValidTime = currentTime;
			this.clearProgress();
			this.attempts = 0;
			this.emit();
		}
	}

	handleError(type: string, message: string): { handled: boolean } {
		if (!this.enabled) return { handled: false };

		this.clearRetryTimer();
		this.clearProgress();

		const classified = classifyBrowserPlaybackError(type, message);

		if (classified.category === "unsupported") {
			this.phase = "unrecoverable";
			this.reason = classified.reason;
			this.canManualRetry = false;
			this.resumeTime = null;
			this.emit();
			return { handled: true };
		}

		if (classified.category === "unknown") {
			this.phase = "unknown";
			this.reason = "unknown";
			this.canManualRetry = true;
			this.resumeTime = this.lastValidTime;
			this.emit();
			return { handled: true };
		}

		// Exhaustion wins over offline so flapping the network cannot
		// bypass the shared budget. Online restarts consume an attempt as
		// well, and will re-enter the exhausted edge when none remains.
		if (this.attempts >= this.maxAttempts) {
			this.phase = "exhausted";
			this.reason = "network";
			this.canManualRetry = true;
			this.resumeTime = this.lastValidTime;
			this.emit();
			return { handled: true };
		}

		if (!this.isOnline()) {
			this.phase = "offline";
			this.reason = "offline";
			this.canManualRetry = true;
			this.resumeTime = this.lastValidTime;
			this.emit();
			return { handled: true };
		}

		const delay =
			this.backoffDelaysMs[this.attempts] ??
			this.backoffDelaysMs[this.backoffDelaysMs.length - 1] ??
			1000;

		this.phase = "scheduled";
		this.reason = "network";
		this.canManualRetry = true;
		this.resumeTime = this.lastValidTime;
		this.emit();

		this.retryTimer = this.timers.setTimeout(() => {
			this.retryTimer = null;
			if (!this.enabled || this.phase !== "scheduled") return;
			if (!this.isOnline()) {
				this.phase = "offline";
				this.reason = "offline";
				this.canManualRetry = true;
				this.emit();
				return;
			}
			if (this.attempts >= this.maxAttempts) {
				this.phase = "exhausted";
				this.reason = "network";
				this.canManualRetry = true;
				this.emit();
				return;
			}
			this.attempts += 1;
			this.triggerRestart();
		}, delay);

		return { handled: true };
	}

	handleOffline() {
		if (!this.enabled) return;
		if (this.phase === "scheduled") {
			this.clearRetryTimer();
			this.phase = "offline";
			this.reason = "offline";
			this.canManualRetry = true;
			this.emit();
		}
	}

	handleOnline() {
		if (!this.enabled) return;
		if (this.phase !== "offline") return;
		// Online recovery shares the auto-retry budget with the backoff
		// timers, so repeated offline and online flaps terminate.
		if (this.attempts >= this.maxAttempts) {
			this.phase = "exhausted";
			this.reason = "network";
			this.canManualRetry = true;
			this.resumeTime = this.lastValidTime;
			this.emit();
			return;
		}
		this.attempts += 1;
		this.triggerRestart();
	}

	manualRetry() {
		if (!this.enabled || !this.canManualRetry) return;
		this.clearRetryTimer();
		this.triggerRestart();
	}

	dismiss() {
		this.clearRetryTimer();
		this.phase = "idle";
		this.reason = null;
		this.canManualRetry = false;
		this.emit();
	}

	dispose() {
		this.clearRetryTimer();
	}

	private triggerRestart() {
		const targetTime = this.resumeTime ?? this.lastValidTime;
		this.phase = "idle";
		this.reason = null;
		this.canManualRetry = false;
		this.awaitingConfirmation = true;
		this.clearProgress();
		this.restart = { key: ++this.techKey, startTime: targetTime };
		this.emit();
	}
}
