import type { KyooError } from "~/models";
import { RetryableError } from "~/models/retryable-error";

export const READ_RETRY_DELAYS_MS = [250, 500] as const;

export type ErrorCategory =
	| "offline"
	| "connection"
	| "temporary"
	| "rate-limited"
	| "session-expired"
	| "needAccount"
	| "forbidden"
	| "need-verification"
	| "invalid-server"
	| "not-found"
	| "invalid-response"
	| "unknown";

const errorRetryMap = new WeakMap<object, () => Promise<void>>();

export function createAbortError(): Error {
	if (typeof DOMException !== "undefined") {
		return new DOMException("The operation was aborted.", "AbortError");
	}
	const err = new Error("The operation was aborted.");
	err.name = "AbortError";
	return err;
}

export function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		error.name === "AbortError"
	);
}

export function isTransientHttpStatus(status: number): boolean {
	return status === 502 || status === 503 || status === 504;
}

export function isConfirmedBrowserOffline(): boolean {
	return (
		typeof navigator !== "undefined" &&
		"onLine" in navigator &&
		navigator.onLine === false
	);
}

export function sleepWithAbort(
	ms: number,
	signal?: AbortSignal | null,
): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(createAbortError());
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(createAbortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function getErrorStatus(error: unknown): number | string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if (Object.hasOwn(error, "status")) {
		const status = (error as { status?: unknown }).status;
		if (typeof status === "number" || typeof status === "string") {
			return status;
		}
	}
	if (error instanceof RetryableError && error.inner) {
		return getErrorStatus(error.inner);
	}
	return undefined;
}

const KNOWN_ERROR_CATEGORIES: Record<string, ErrorCategory> = {
	offline: "offline",
	connection: "connection",
	temporary: "temporary",
	"rate-limited": "rate-limited",
	unauthorized: "session-expired",
	"session-expired": "session-expired",
	needAccount: "needAccount",
	forbidden: "forbidden",
	needVerification: "need-verification",
	"invalid-server": "invalid-server",
	"not-found": "not-found",
	"invalid-response": "invalid-response",
	unknown: "unknown",
};

export function classifyError(error: unknown): ErrorCategory {
	// Only client-created errors can choose a display category by key.
	const category =
		error instanceof RetryableError &&
		Object.hasOwn(KNOWN_ERROR_CATEGORIES, error.key)
			? KNOWN_ERROR_CATEGORIES[error.key]
			: undefined;
	const status = getErrorStatus(error);
	if (typeof status === "number") {
		if (status === 401) return "session-expired";
		if (status === 403) {
			// The endpoint sets these only for the appropriate kind of denial.
			if (category === "needAccount" || category === "need-verification") {
				return category;
			}
			return "forbidden";
		}
		if (status === 404) return "not-found";
		if (status === 429) return "rate-limited";
		if (status >= 500) return "temporary";
		return "unknown";
	}
	if (status === "parse" || error instanceof SyntaxError) {
		return "invalid-response";
	}
	return category ?? "unknown";
}

export function isTransientOutageError(error: unknown): boolean {
	const category = classifyError(error);
	return (
		category === "offline" ||
		category === "connection" ||
		category === "temporary"
	);
}

export function isDefinitiveAuthError(error: unknown): boolean {
	const category = classifyError(error);
	return (
		category === "session-expired" ||
		category === "forbidden" ||
		category === "needAccount" ||
		category === "need-verification"
	);
}

export function registerErrorRetry(
	error: unknown,
	retry: () => Promise<void>,
): void {
	if (typeof error === "object" && error !== null) {
		errorRetryMap.set(error, retry);
	}
}

export function getErrorRetry(
	error: unknown,
): (() => Promise<void>) | undefined {
	if (error instanceof RetryableError && error.retry) {
		return error.retry;
	}
	if (typeof error === "object" && error !== null) {
		return errorRetryMap.get(error);
	}
	return undefined;
}

export function attachErrorRetry<T>(error: T, retry: () => Promise<void>): T {
	if (error instanceof RetryableError) {
		const wrapped = new RetryableError({
			key: error.key,
			inner: error.inner as Error | KyooError | undefined,
			retry,
		});
		errorRetryMap.set(wrapped, retry);
		return wrapped as unknown as T;
	}
	registerErrorRetry(error, retry);
	return error;
}

/**
 * Builds the exact retry handler for a cached Data Client error.
 * `getCurrentError` must read from the controller's current state, so
 * invalidating is skipped when the store was reset (for example after an
 * account change) or the cached error was already cleared.
 */
export function createCacheRetry(
	getCurrentError: () => unknown,
	invalidate: () => Promise<void>,
	error: unknown,
): () => Promise<void> {
	return async () => {
		if (getCurrentError() !== error) return;
		await invalidate();
	};
}

export type RetryCoordinator = {
	triggerManualRetry: () => Promise<boolean>;
	triggerOnlineRetry: () => Promise<boolean>;
	isRetrying: () => boolean;
	getAutoRetryCount: () => number;
	dispose: () => void;
};

export function createRetryCoordinator({
	beforeRetry,
	onRetry,
	onStateChange,
	maxAutoRetries = 1,
}: {
	beforeRetry?: () => Promise<void> | undefined;
	onRetry: () => Promise<void>;
	onStateChange?: (retrying: boolean) => void;
	maxAutoRetries?: number;
}): RetryCoordinator {
	let inFlight = false;
	let disposed = false;
	let autoRetryCount = 0;

	const run = async (): Promise<boolean> => {
		if (inFlight || disposed) return false;
		inFlight = true;
		onStateChange?.(true);
		try {
			const preparation = beforeRetry?.();
			if (preparation) await preparation;
			// The boundary may have changed while its exact cache entry was invalidated.
			if (disposed) return false;
			await onRetry();
			return !disposed;
		} catch {
			// A failed retry is expected (the boundary gets a fresh error).
			// Swallow it so fire-and-forget triggers never reject unhandled.
			return false;
		} finally {
			inFlight = false;
			if (!disposed) {
				onStateChange?.(false);
			}
		}
	};

	return {
		triggerManualRetry: () => run(),
		triggerOnlineRetry: async () => {
			if (inFlight || disposed || autoRetryCount >= maxAutoRetries) {
				return false;
			}
			autoRetryCount += 1;
			return run();
		},
		isRetrying: () => inFlight,
		getAutoRetryCount: () => autoRetryCount,
		dispose: () => {
			disposed = true;
		},
	};
}
