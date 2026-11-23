import { describe, expect, it } from "bun:test";
import {
	BACKOFF_DELAYS_MS,
	classifyBrowserPlaybackError,
	MAX_AUTO_RETRIES,
	PlaybackRecoveryManager,
	type RecoverySnapshot,
	type RecoveryTimers,
	sanitizeErrorText,
} from "../recovery";

const createFakeTimers = () => {
	let nextId = 1;
	const pending = new Map<number, { fn: () => void; at: number }>();
	let now = 0;

	const timers: RecoveryTimers = {
		setTimeout: (fn, ms) => {
			const id = nextId++;
			pending.set(id, { fn, at: now + ms });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (id) => {
			pending.delete(id as unknown as number);
		},
	};

	const advanceBy = (ms: number) => {
		const target = now + ms;
		while (true) {
			let earliestId: number | null = null;
			let earliestAt = Number.POSITIVE_INFINITY;
			for (const [id, entry] of pending) {
				if (entry.at <= target && entry.at < earliestAt) {
					earliestAt = entry.at;
					earliestId = id;
				}
			}
			if (earliestId === null) break;
			const entry = pending.get(earliestId)!;
			pending.delete(earliestId);
			now = entry.at;
			entry.fn();
		}
		now = target;
	};

	return {
		timers,
		advanceBy,
		pendingCount: () => pending.size,
	};
};

describe("sanitizeErrorText", () => {
	it("redacts signed URLs, tokens, and bearer headers", () => {
		const raw =
			"Failed to load https://kyoo.example.com/api/videos/ep1/master.m3u8?x-presign=secret123&token=abc Authorization: Bearer eyJhbGciOiJIUzI1NiJ9";
		const sanitized = sanitizeErrorText(raw);
		expect(sanitized).not.toContain("secret123");
		expect(sanitized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
		expect(sanitized).not.toContain("https://kyoo.example.com");
		expect(sanitized).toContain("[url]");
		expect(sanitized).toContain("Bearer [redacted]");
	});

	it("truncates overly long messages", () => {
		const raw = "x".repeat(250);
		const sanitized = sanitizeErrorText(raw);
		expect(sanitized.length).toBe(180);
		expect(sanitized.endsWith("...")).toBe(true);
	});
});

describe("classifyBrowserPlaybackError", () => {
	it.each([
		"A network error (status 502) occurred while loading manifest",
		"A network error (status 503) occurred while loading manifest",
		"A network error (status 504) occurred while loading manifest",
		"A network error (status 0) occurred while loading manifest",
		"A network error occurred while loading manifest",
		"A network timeout occurred while loading manifest",
	])("retries the hls.js message: %s", (message) => {
		expect(classifyBrowserPlaybackError(message, message)).toMatchObject({
			category: "recoverable",
			reason: "network",
		});
	});

	it.each([
		["A network error (status 401) occurred while loading manifest", "auth"],
		["A network error (status 403) occurred while loading manifest", "auth"],
		[
			"A network error (status 404) occurred while loading manifest",
			"not-found",
		],
	])("does not retry the hls.js message: %s", (message, reason) => {
		for (const type of [message, "Failed to fetch"]) {
			expect(classifyBrowserPlaybackError(type, message)).toMatchObject({
				category: "unsupported",
				reason,
			});
		}
	});

	it.each([
		"A network error (status 400) occurred while loading manifest",
		"A network error (status 501) occurred while loading manifest",
		"A network error (status 503) occurred while loading level: 0 id: 0",
		"A network error (status 503) occurred while loading manifest https://example.org/",
		"https://example.org/?message=A network error (status 503) occurred while loading manifest",
	])("does not infer a manifest retry from: %s", (message) => {
		expect(classifyBrowserPlaybackError(message, message)).toMatchObject({
			category: "unknown",
			reason: "unknown",
		});
	});

	it("classifies exact media and structured loader failures as recoverable", () => {
		expect(
			classifyBrowserPlaybackError(
				"This media could not be loaded due to a network or server issue.",
				"This media could not be loaded due to a network or server issue.",
			),
		).toMatchObject({ category: "recoverable", reason: "network" });

		expect(
			classifyBrowserPlaybackError("Failed to fetch", "Failed to fetch"),
		).toMatchObject({ category: "recoverable", reason: "network" });

		expect(
			classifyBrowserPlaybackError(
				"HTTP Error 503 Service Unavailable",
				"HTTP Error 503 Service Unavailable",
			),
		).toMatchObject({ category: "recoverable", reason: "network" });

		expect(
			classifyBrowserPlaybackError("HTTP Error 0", "HTTP Error 0"),
		).toMatchObject({ category: "recoverable", reason: "network" });

		expect(
			classifyBrowserPlaybackError(
				"Timeout after 20000ms",
				"Timeout after 20000ms",
			),
		).toMatchObject({ category: "recoverable", reason: "network" });
	});

	it("classifies decode, encrypted, unsupported, auth, and 404 as unrecoverable", () => {
		expect(
			classifyBrowserPlaybackError(
				"This media could not be played. It may be corrupted, or your browser may not support its format.",
				"This media could not be played. It may be corrupted, or your browser may not support its format.",
			),
		).toMatchObject({ category: "unsupported", reason: "decode" });

		expect(
			classifyBrowserPlaybackError(
				"This media could not be played because it could not be decrypted.",
				"This media could not be played because it could not be decrypted.",
			),
		).toMatchObject({ category: "unsupported", reason: "unsupported" });

		expect(
			classifyBrowserPlaybackError(
				"source/unsupported-content-type",
				"source/unsupported-content-type",
			),
		).toMatchObject({ category: "unsupported", reason: "unsupported" });

		expect(
			classifyBrowserPlaybackError(
				"HTTP Error 401 Unauthorized",
				"HTTP Error 401 Unauthorized",
			),
		).toMatchObject({ category: "unsupported", reason: "auth" });

		expect(
			classifyBrowserPlaybackError(
				"HTTP Error 403 Forbidden",
				"HTTP Error 403 Forbidden",
			),
		).toMatchObject({ category: "unsupported", reason: "auth" });

		expect(
			classifyBrowserPlaybackError(
				"HTTP Error 404 Not Found",
				"HTTP Error 404 Not Found",
			),
		).toMatchObject({ category: "unsupported", reason: "not-found" });
	});

	it("classifies the ambiguous source default, loader detail strings, and URLs as unknown", () => {
		// The generic source default covers both unavailable and
		// incompatible media, so do not guess a retry policy from it.
		expect(
			classifyBrowserPlaybackError(
				"This media could not be loaded. It may be unavailable, or your browser may not support its format.",
				"This media could not be loaded. It may be unavailable, or your browser may not support its format.",
			),
		).toMatchObject({ category: "unknown", reason: "unknown" });

		// Loader details are not forwarded by the bridge, only the message.
		expect(
			classifyBrowserPlaybackError("manifestLoadError", "manifestLoadError"),
		).toMatchObject({ category: "unknown", reason: "unknown" });

		// Bare digits and path segments inside signed URLs must not be
		// mistaken for structured HTTP statuses.
		expect(
			classifyBrowserPlaybackError(
				"https://cdn.example.com/videos/seg-404.ts?x-presign=abc123",
				"https://cdn.example.com/videos/seg-404.ts?x-presign=abc123",
			),
		).toMatchObject({ category: "unknown", reason: "unknown" });

		expect(classifyBrowserPlaybackError("404", "404")).toMatchObject({
			category: "unknown",
			reason: "unknown",
		});

		expect(
			classifyBrowserPlaybackError(
				"segment 503 missing",
				"segment 503 missing",
			),
		).toMatchObject({ category: "unknown", reason: "unknown" });

		expect(
			classifyBrowserPlaybackError("Unknown error", "Unknown error"),
		).toMatchObject({ category: "unknown", reason: "unknown" });

		expect(classifyBrowserPlaybackError("", "")).toMatchObject({
			category: "unknown",
			reason: "unknown",
		});

		expect(
			classifyBrowserPlaybackError("Unexpected glitch", "Unexpected glitch"),
		).toMatchObject({ category: "unknown", reason: "unknown" });
	});
});

describe("PlaybackRecoveryManager", () => {
	const setup = (initialOnline = true) => {
		const fake = createFakeTimers();
		let online = initialOnline;
		const restarts: Array<number | null> = [];
		const snapshots: RecoverySnapshot[] = [];

		const manager = new PlaybackRecoveryManager({
			timers: fake.timers,
			isOnline: () => online,
			onStateChange: (s) => {
				if (s.restart && s.restart !== snapshots.at(-1)?.restart) {
					restarts.push(s.restart.startTime);
				}
				snapshots.push(s);
			},
		});

		manager.setContext({ enabled: true, sourceKey: "ep-1:hls:remote" });

		return {
			manager,
			fake,
			restarts,
			snapshots,
			setOnline: (val: boolean) => {
				online = val;
			},
		};
	};

	it("bounds auto-retries with exponential backoff and preserves latest valid position across repeated failures", () => {
		const { manager, fake, restarts } = setup(true);

		manager.reportProgress({
			currentTime: 42.7,
			isPlaying: true,
			status: "readyToPlay",
		});

		const manifestError =
			"A network error (status 503) occurred while loading manifest";
		manager.handleError(manifestError, manifestError);
		expect(manager.getSnapshot()).toMatchObject({
			phase: "scheduled",
			attempts: 0,
			resumeTime: 42.7,
			restart: null,
			canManualRetry: true,
		});
		expect(fake.pendingCount()).toBe(1);

		fake.advanceBy(BACKOFF_DELAYS_MS[0] - 1);
		expect(restarts).toEqual([]);
		fake.advanceBy(1);
		expect(restarts).toEqual([42.7]);
		expect(manager.getSnapshot()).toMatchObject({
			phase: "idle",
			attempts: 1,
			restart: { key: 1, startTime: 42.7 },
		});

		// Simulate tech reporting 0 during failed reload. It must not
		// overwrite the resume position or reset the budget.
		manager.reportProgress({
			currentTime: 0,
			isPlaying: false,
			status: "loading",
		});

		manager.handleError("Failed to fetch", "Failed to fetch");
		expect(manager.getSnapshot()).toMatchObject({
			resumeTime: 42.7,
			restart: { key: 1, startTime: 42.7 },
		});
		fake.advanceBy(BACKOFF_DELAYS_MS[1]);
		expect(restarts).toEqual([42.7, 42.7]);
		expect(manager.getSnapshot().attempts).toBe(2);
		expect(manager.getSnapshot().restart).toEqual({ key: 2, startTime: 42.7 });

		manager.handleError("Failed to fetch", "Failed to fetch");
		fake.advanceBy(BACKOFF_DELAYS_MS[2]);
		expect(restarts).toEqual([42.7, 42.7, 42.7]);
		expect(manager.getSnapshot().attempts).toBe(MAX_AUTO_RETRIES);

		manager.handleError("Failed to fetch", "Failed to fetch");
		expect(manager.getSnapshot()).toMatchObject({
			phase: "exhausted",
			attempts: MAX_AUTO_RETRIES,
			canManualRetry: true,
			resumeTime: 42.7,
		});
		expect(fake.pendingCount()).toBe(0);

		manager.manualRetry();
		expect(restarts).toEqual([42.7, 42.7, 42.7, 42.7]);
		expect(manager.getSnapshot().restart).toEqual({ key: 4, startTime: 42.7 });
		expect(manager.getSnapshot().attempts).toBe(MAX_AUTO_RETRIES);
	});

	it("resets attempts only on observed incremental playback progress", () => {
		const { manager, fake } = setup(true);

		manager.reportProgress({
			currentTime: 10,
			isPlaying: true,
			status: "readyToPlay",
		});
		manager.handleError("Failed to fetch", "Failed to fetch");
		fake.advanceBy(BACKOFF_DELAYS_MS[0]);
		expect(manager.getSnapshot().attempts).toBe(1);

		// First report after the restart is only the baseline.
		manager.reportProgress({
			currentTime: 10,
			isPlaying: true,
			status: "readyToPlay",
		});
		expect(manager.getSnapshot().attempts).toBe(1);
		manager.reportProgress({
			currentTime: 10.5,
			isPlaying: true,
			status: "readyToPlay",
		});
		expect(manager.getSnapshot().attempts).toBe(1);
		manager.reportProgress({
			currentTime: 11.1,
			isPlaying: true,
			status: "readyToPlay",
		});
		expect(manager.getSnapshot().attempts).toBe(1);
		manager.reportProgress({
			currentTime: 11.6,
			isPlaying: true,
			status: "readyToPlay",
		});
		expect(manager.getSnapshot().attempts).toBe(1);
		manager.reportProgress({
			currentTime: 12.2,
			isPlaying: true,
			status: "readyToPlay",
		});
		expect(manager.getSnapshot()).toMatchObject({
			attempts: 0,
			restart: { key: 1, startTime: 10 },
		});
	});

	it("does not reset attempts on stuck ready playback or seek jumps", () => {
		const { manager, fake } = setup(true);

		manager.reportProgress({
			currentTime: 10,
			isPlaying: true,
			status: "readyToPlay",
		});
		manager.handleError("Failed to fetch", "Failed to fetch");
		fake.advanceBy(BACKOFF_DELAYS_MS[0]);
		expect(manager.getSnapshot().attempts).toBe(1);

		manager.reportProgress({
			currentTime: 10,
			isPlaying: true,
			status: "readyToPlay",
		});
		for (let i = 0; i < 5; i++) {
			manager.reportProgress({
				currentTime: 10,
				isPlaying: true,
				status: "readyToPlay",
			});
		}
		fake.advanceBy(10000);
		expect(manager.getSnapshot().attempts).toBe(1);
		expect(fake.pendingCount()).toBe(0);

		// A seek jump re-baselines without counting as progress.
		manager.reportProgress({
			currentTime: 30,
			isPlaying: true,
			status: "readyToPlay",
		});
		expect(manager.getSnapshot().attempts).toBe(1);
		manager.reportProgress({
			currentTime: 30.4,
			isPlaying: true,
			status: "readyToPlay",
		});
		expect(manager.getSnapshot().attempts).toBe(1);
	});

	it("keeps intentional seek to 0 but ignores a failed reload zero", () => {
		const { manager, fake } = setup(true);

		manager.reportProgress({
			currentTime: 30,
			isPlaying: true,
			status: "readyToPlay",
		});
		manager.reportProgress({
			currentTime: 0,
			isPlaying: true,
			status: "readyToPlay",
		});
		manager.handleError("Failed to fetch", "Failed to fetch");
		expect(manager.getSnapshot().resumeTime).toBe(0);
		fake.advanceBy(BACKOFF_DELAYS_MS[0]);

		const second = setup(true);
		second.manager.reportProgress({
			currentTime: 42.7,
			isPlaying: true,
			status: "readyToPlay",
		});
		second.manager.handleError("Failed to fetch", "Failed to fetch");
		second.fake.advanceBy(BACKOFF_DELAYS_MS[0]);
		second.manager.reportProgress({
			currentTime: 0,
			isPlaying: true,
			status: "readyToPlay",
		});
		second.manager.reportProgress({
			currentTime: 0,
			isPlaying: true,
			status: "readyToPlay",
		});
		expect(second.manager.getSnapshot().attempts).toBe(1);
		second.manager.handleError("Failed to fetch", "Failed to fetch");
		expect(second.manager.getSnapshot().resumeTime).toBe(42.7);
	});

	it("keeps the previous resume time during a brief failed restart", () => {
		const { manager, fake } = setup(true);
		manager.reportProgress({
			currentTime: 42.7,
			isPlaying: true,
			status: "readyToPlay",
		});
		manager.handleError("Failed to fetch", "Failed to fetch");
		fake.advanceBy(BACKOFF_DELAYS_MS[0]);
		for (const currentTime of [0, 0.2, 0.5, 0.8]) {
			manager.reportProgress({
				currentTime,
				isPlaying: true,
				status: "readyToPlay",
			});
		}
		manager.handleError("Failed to fetch", "Failed to fetch");
		expect(manager.getSnapshot()).toMatchObject({
			attempts: 1,
			resumeTime: 42.7,
			restart: { key: 1, startTime: 42.7 },
		});
	});

	it("waits for online event when offline and consumes an attempt on restart", () => {
		const { manager, fake, restarts, setOnline } = setup(false);

		manager.reportProgress({
			currentTime: 15,
			isPlaying: true,
			status: "readyToPlay",
		});
		manager.handleError("Failed to fetch", "Failed to fetch");

		expect(manager.getSnapshot()).toMatchObject({
			phase: "offline",
			reason: "offline",
			attempts: 0,
			canManualRetry: true,
			resumeTime: 15,
		});
		expect(fake.pendingCount()).toBe(0);

		setOnline(true);
		manager.handleOnline();
		expect(restarts).toEqual([15]);
		expect(manager.getSnapshot()).toMatchObject({
			phase: "idle",
			attempts: 1,
			restart: { key: 1, startTime: 15 },
		});
	});

	it("cancels scheduled retry if browser goes offline and resumes on online with shared budget", () => {
		const { manager, fake, restarts, setOnline } = setup(true);

		manager.handleError("Failed to fetch", "Failed to fetch");
		expect(manager.getSnapshot().phase).toBe("scheduled");
		expect(fake.pendingCount()).toBe(1);

		setOnline(false);
		manager.handleOffline();
		expect(manager.getSnapshot().phase).toBe("offline");
		expect(fake.pendingCount()).toBe(0);

		setOnline(true);
		manager.handleOnline();
		expect(restarts).toEqual([null]);
		expect(manager.getSnapshot().attempts).toBe(1);
	});

	it("bounds repeated offline and online flaps to the shared budget", () => {
		const { manager, restarts, setOnline } = setup(false);

		manager.reportProgress({
			currentTime: 20,
			isPlaying: true,
			status: "readyToPlay",
		});

		for (let i = 0; i < MAX_AUTO_RETRIES; i++) {
			manager.handleError("Failed to fetch", "Failed to fetch");
			expect(manager.getSnapshot().phase).toBe("offline");
			setOnline(true);
			manager.handleOnline();
			expect(manager.getSnapshot()).toMatchObject({
				phase: "idle",
				attempts: i + 1,
			});
			setOnline(false);
		}

		expect(restarts).toEqual([20, 20, 20]);

		// With the budget spent, an offline error goes straight to
		// exhausted instead of waiting for another online restart.
		manager.handleError("Failed to fetch", "Failed to fetch");
		expect(manager.getSnapshot()).toMatchObject({
			phase: "exhausted",
			attempts: MAX_AUTO_RETRIES,
			resumeTime: 20,
		});
		expect(restarts).toEqual([20, 20, 20]);
	});

	it("does not auto-retry unsupported/auth/404 or unknown errors, and allows manual retry only for unknown", () => {
		const { manager, fake, restarts } = setup(true);

		manager.handleError("HTTP Error 404 Not Found", "HTTP Error 404 Not Found");
		expect(manager.getSnapshot()).toMatchObject({
			phase: "unrecoverable",
			reason: "not-found",
			canManualRetry: false,
		});
		expect(fake.pendingCount()).toBe(0);
		manager.manualRetry();
		expect(restarts).toEqual([]);

		manager.handleError("Unknown error", "Unknown error");
		expect(manager.getSnapshot()).toMatchObject({
			phase: "unknown",
			reason: "unknown",
			canManualRetry: true,
		});
		expect(fake.pendingCount()).toBe(0);
		manager.manualRetry();
		expect(restarts).toEqual([null]);
	});

	it("cancels timers and resets state on source/mode change and dispose", () => {
		const { manager, fake, restarts } = setup(true);

		manager.reportProgress({
			currentTime: 30,
			isPlaying: true,
			status: "readyToPlay",
		});
		manager.handleError("Failed to fetch", "Failed to fetch");
		fake.advanceBy(BACKOFF_DELAYS_MS[0]);
		manager.handleError("Failed to fetch", "Failed to fetch");
		expect(fake.pendingCount()).toBe(1);

		manager.setContext({ enabled: true, sourceKey: "ep-2:hls:remote" });
		fake.advanceBy(BACKOFF_DELAYS_MS[1]);
		expect(restarts).toEqual([30]);
		expect(fake.pendingCount()).toBe(0);
		expect(manager.getSnapshot()).toMatchObject({
			phase: "idle",
			attempts: 0,
			resumeTime: null,
			restart: null,
			sourceKey: "ep-2:hls:remote",
		});

		manager.handleError("Failed to fetch", "Failed to fetch");
		manager.handleError("Failed to fetch", "Failed to fetch");
		expect(fake.pendingCount()).toBe(1);

		manager.dispose();
		expect(fake.pendingCount()).toBe(0);

		manager.handleError("Failed to fetch", "Failed to fetch");
		expect(fake.pendingCount()).toBe(1);
		manager.dismiss();
		expect(fake.pendingCount()).toBe(0);
		expect(manager.getSnapshot()).toMatchObject({
			phase: "idle",
			reason: null,
			canManualRetry: false,
		});
	});
});
