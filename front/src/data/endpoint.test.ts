/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Controller, createReducer, NetworkManager } from "@data-client/core";
import { z } from "zod/v4";
import { RetryableError } from "~/models/retryable-error";
import {
	attachErrorRetry,
	classifyError,
	createCacheRetry,
	createRetryCoordinator,
	getErrorRetry,
	isDefinitiveAuthError,
	isTransientOutageError,
	sleepWithAbort,
} from "./error-utils";

mock.module("react-native", () => ({
	Platform: {
		OS: "web",
		isTV: false,
	},
}));

const { KyooEndpoint } = await import("./endpoint");

const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;
const originalNavigator = globalThis.navigator;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

async function httpError(
	ep: ReturnType<typeof makeEndpoint>,
	status: number,
	body: object,
) {
	globalThis.fetch = (async () =>
		Response.json(body, { status })) as unknown as typeof fetch;
	try {
		await ep.fetchResponse("https://kyoo.example.com/api/movies/a", {});
	} catch (error) {
		return error;
	}
	throw new Error(`Expected HTTP ${status} to fail`);
}

function setBrowserOnline(online: boolean) {
	Object.defineProperty(globalThis, "navigator", {
		value: { onLine: online },
		configurable: true,
		writable: true,
	});
}

function makeEndpoint(
	overrides: Partial<{
		method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE";
		authToken: string | null;
	}> = {},
) {
	const method = overrides.method ?? "GET";
	const ep = new KyooEndpoint({
		path: "/movies/:slug",
		method,
		sideEffect: method === "GET" || method === "HEAD" ? undefined : true,
		schema: undefined,
		parser: z.object({ id: z.string() }),
		auth: {
			apiUrl: "https://kyoo.example.com/api",
			authToken:
				"authToken" in overrides
					? (overrides.authToken ?? null)
					: "secret-jwt-token",
			lang: "en",
		},
	});
	return ep;
}

function setupController() {
	const nm = new NetworkManager({ errorExpiryLength: 60_000 });
	const controller = new Controller();
	let state = createReducer(controller)(undefined, {
		type: "@@INIT",
	} as never);

	const dispatch = (action: unknown): Promise<void> => {
		const mw = nm.middleware(controller)(() => {
			state = createReducer(controller)(state, action as never);
			return Promise.resolve();
		});
		return mw(action as never) as Promise<void>;
	};
	controller.bindMiddleware({
		dispatch: dispatch as Controller["dispatch"],
		getState: () => state,
	});
	return { controller, getState: () => state };
}

describe("KyooEndpoint read retries and error handling", () => {
	let logs: unknown[][] = [];

	beforeEach(() => {
		logs = [];
		console.log = (...args: unknown[]) => {
			logs.push(args);
		};
	});

	afterEach(() => {
		console.log = originalConsoleLog;
		Object.defineProperty(globalThis, "navigator", {
			value: originalNavigator,
			configurable: true,
			writable: true,
		});
	});

	test("retries transient transport errors on GET and recovers", async () => {
		setBrowserOnline(true);
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			if (calls < 3) throw new TypeError("network down");
			return new Response(JSON.stringify({ id: "1" }), { status: 200 });
		}) as unknown as typeof fetch;

		const ep = makeEndpoint();
		const resp = await ep.fetchResponse(
			"https://kyoo.example.com/api/movies/a",
			{
				method: "GET",
			},
		);
		expect(resp.status).toBe(200);
		expect(calls).toBe(3);
	});

	test("retries transient 502/503/504 on HEAD without buffering body", async () => {
		let calls = 0;
		let cancelled = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			if (calls === 1) {
				return {
					ok: false,
					status: 502,
					body: {
						cancel: async () => {
							cancelled += 1;
						},
					},
					text: async () => {
						throw new Error("should not buffer retried body");
					},
				} as unknown as Response;
			}
			if (calls === 2) {
				return {
					ok: false,
					status: 503,
					body: {
						cancel: async () => {
							cancelled += 1;
						},
					},
					text: async () => {
						throw new Error("should not buffer retried body");
					},
				} as unknown as Response;
			}
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const ep = makeEndpoint({ method: "HEAD" });
		const resp = await ep.fetchResponse(
			"https://kyoo.example.com/api/movies/a",
			{
				method: "HEAD",
			},
		);
		expect(resp.status).toBe(200);
		expect(calls).toBe(3);
		expect(cancelled).toBe(2);
	});

	test("differentiates confirmed browser offline vs unreachable server", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw new TypeError("Failed to fetch https://kyoo.example.com/secret");
		}) as unknown as typeof fetch;

		setBrowserOnline(false);
		const ep = makeEndpoint();
		await expect(
			ep.fetchResponse("https://kyoo.example.com/api/movies/a", {
				method: "GET",
			}),
		).rejects.toMatchObject({ key: "offline" });
		// Confirmed offline must not burn the bounded read retries.
		expect(calls).toBe(1);

		setBrowserOnline(true);
		calls = 0;
		await expect(
			ep.fetchResponse("https://kyoo.example.com/api/movies/a", {
				method: "GET",
			}),
		).rejects.toMatchObject({ key: "connection" });
		expect(calls).toBe(3);

		const serializedLogs = JSON.stringify(logs);
		expect(serializedLogs).not.toContain("https://kyoo.example.com");
		expect(serializedLogs).not.toContain("secret-jwt-token");
	});

	test("stops retrying as soon as the browser goes offline mid-retry", async () => {
		setBrowserOnline(true);
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			if (calls === 2) setBrowserOnline(false);
			throw new TypeError("network down");
		}) as unknown as typeof fetch;

		const ep = makeEndpoint();
		await expect(
			ep.fetchResponse("https://kyoo.example.com/api/movies/a", {
				method: "GET",
			}),
		).rejects.toMatchObject({ key: "offline" });
		expect(calls).toBe(2);
	});

	test("throws temporary RetryableError on exhausted 504 and does not retry 500", async () => {
		let calls504 = 0;
		globalThis.fetch = (async () => {
			calls504 += 1;
			return new Response("<html>raw nginx 504</html>", { status: 504 });
		}) as unknown as typeof fetch;

		const ep = makeEndpoint();
		await expect(
			ep.fetchResponse("https://kyoo.example.com/api/movies/a", {
				method: "GET",
			}),
		).rejects.toMatchObject({ key: "temporary" });
		expect(calls504).toBe(3);

		let calls500 = 0;
		globalThis.fetch = (async () => {
			calls500 += 1;
			return new Response("internal error body", { status: 500 });
		}) as unknown as typeof fetch;

		await expect(
			ep.fetchResponse("https://kyoo.example.com/api/movies/a", {
				method: "GET",
			}),
		).rejects.toMatchObject({ key: "temporary" });
		expect(calls500).toBe(1);

		const serializedLogs = JSON.stringify(logs);
		expect(serializedLogs).not.toContain("raw nginx 504");
		expect(serializedLogs).not.toContain("internal error body");
		expect(serializedLogs).not.toContain("https://kyoo.example.com");
	});

	test("does not retry mutations, 401/403, 404, or 429", async () => {
		setBrowserOnline(true);
		let postCalls = 0;
		globalThis.fetch = (async () => {
			postCalls += 1;
			return new Response("bad gateway", { status: 502 });
		}) as unknown as typeof fetch;

		const postEp = makeEndpoint({ method: "POST" });
		await expect(
			postEp.fetchResponse("https://kyoo.example.com/api/movies/a", {
				method: "POST",
			}),
		).rejects.toMatchObject({ key: "temporary" });
		expect(postCalls).toBe(1);

		for (const status of [401, 403, 404, 429]) {
			let calls = 0;
			globalThis.fetch = (async () => {
				calls += 1;
				return new Response(JSON.stringify({ message: "err" }), { status });
			}) as unknown as typeof fetch;

			const ep = makeEndpoint();
			await expect(
				ep.fetchResponse("https://kyoo.example.com/api/movies/a", {
					method: "GET",
				}),
			).rejects.toBeDefined();
			expect(calls).toBe(1);
		}
	});

	test("differentiates 401 session expired from verified 403 denied and guest 403", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ message: "expired" }), {
				status: 401,
			})) as unknown as typeof fetch;

		const ep = makeEndpoint();
		let caught: unknown;
		try {
			await ep.fetchResponse("https://kyoo.example.com/api/movies/a", {
				method: "GET",
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toMatchObject({ key: "unauthorized" });
		expect(classifyError(caught)).toBe("session-expired");
		expect(isDefinitiveAuthError(caught)).toBe(true);

		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ message: "missing permission" }), {
				status: 403,
			})) as unknown as typeof fetch;

		caught = undefined;
		try {
			await ep.fetchResponse("https://kyoo.example.com/api/movies/a", {
				method: "GET",
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toMatchObject({ key: "forbidden" });
		expect(classifyError(caught)).toBe("forbidden");
		expect(isDefinitiveAuthError(caught)).toBe(true);

		const guestEp = makeEndpoint({ authToken: null });
		caught = undefined;
		try {
			await guestEp.fetchResponse("https://kyoo.example.com/api/movies/a", {
				method: "GET",
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toMatchObject({ key: "needAccount" });
		expect(classifyError(caught)).toBe("needAccount");
		expect(isDefinitiveAuthError(caught)).toBe(true);
	});

	test("classifies 429 as rate-limited without retries or auto-retry", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response(JSON.stringify({ message: "slow down" }), {
				status: 429,
			});
		}) as unknown as typeof fetch;

		const ep = makeEndpoint();
		let caught: unknown;
		try {
			await ep.fetchResponse("https://kyoo.example.com/api/movies/a", {
				method: "GET",
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toMatchObject({ status: 429, message: "slow down" });
		expect(caught).not.toBeInstanceOf(RetryableError);
		expect(calls).toBe(1);
		expect(classifyError(caught)).toBe("rate-limited");
		expect(isTransientOutageError(caught)).toBe(false);
		expect(isDefinitiveAuthError(caught)).toBe(false);
		expect(ep.errorPolicy(caught)).toBeUndefined();
	});

	test("supports the verification discriminator only on an authenticated 403", async () => {
		const ep = makeEndpoint();
		const body = { error: "needVerification", message: "verify" };
		const error = await httpError(ep, 403, body);
		expect(error).toMatchObject({ key: "needVerification" });
		expect(classifyError(error)).toBe("need-verification");
		expect(isDefinitiveAuthError(error)).toBe(true);
		expect(ep.errorPolicy(error)).toBeUndefined();
		expect(classifyError(await httpError(ep, 403, { key: body.error }))).toBe(
			"forbidden",
		);
		expect(
			classifyError(
				await httpError(makeEndpoint({ authToken: null }), 403, body),
			),
		).toBe("needAccount");
		expect(classifyError(await httpError(ep, 400, body))).toBe("unknown");
	});

	test.each(["constructor", "__proto__", "toString"])(
		"ignores the inherited category name %s",
		async (key) => {
			const ep = makeEndpoint();
			expect(classifyError({ key })).toBe("unknown");
			expect(classifyError(new RetryableError({ key }))).toBe("unknown");
			expect(classifyError(await httpError(ep, 401, { key, error: key }))).toBe(
				"session-expired",
			);
			expect(classifyError(await httpError(ep, 500, { key, error: key }))).toBe(
				"temporary",
			);
		},
	);

	test("untrusted fields cannot change HTTP classification or stale policy", async () => {
		const ep = makeEndpoint();
		const outageBody = { key: "offline", error: "offline", status: 503 };
		const unauthorized = await httpError(ep, 401, outageBody);
		const forbidden = await httpError(ep, 403, outageBody);
		expect(classifyError(unauthorized)).toBe("session-expired");
		expect(classifyError(forbidden)).toBe("forbidden");
		for (const error of [unauthorized, forbidden]) {
			expect(isDefinitiveAuthError(error)).toBe(true);
			expect(isTransientOutageError(error)).toBe(false);
			expect(ep.errorPolicy(error)).toBeUndefined();
		}

		const authBody = {
			key: "unauthorized",
			error: "needVerification",
			status: 401,
		};
		const unavailable = await httpError(ep, 500, authBody);
		expect(classifyError(unavailable)).toBe("temporary");
		expect(isDefinitiveAuthError(unavailable)).toBe(false);
		expect(ep.errorPolicy(unavailable)).toBe("soft");
		expect(classifyError(await httpError(ep, 429, authBody))).toBe(
			"rate-limited",
		);
		expect(classifyError({ status: 429, key: "unauthorized" })).toBe(
			"rate-limited",
		);
	});

	test("aborts promptly during backoff delay without extra fetch", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response("unavailable", { status: 503 });
		}) as unknown as typeof fetch;

		const ac = new AbortController();
		const ep = makeEndpoint();
		const start = Date.now();
		setTimeout(() => ac.abort(), 15);

		await expect(
			ep.fetchResponse("https://kyoo.example.com/api/movies/a", {
				method: "GET",
				signal: ac.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(Date.now() - start).toBeLessThan(1000);
		expect(calls).toBe(1);
	});

	test("sleepWithAbort rejects immediately if already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(sleepWithAbort(1000, ac.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	test("process throws parse KyooError without logging URL or raw issues", () => {
		const ep = makeEndpoint();
		let caught: unknown;
		try {
			ep.process({ invalid: true }, { slug: "secret-slug" });
		} catch (e) {
			caught = e;
		}
		expect(caught).toMatchObject({ status: "parse" });
		const serializedLogs = JSON.stringify(logs);
		expect(serializedLogs).not.toContain("secret-slug");
		expect(serializedLogs).not.toContain("https://kyoo.example.com");
	});

	test("errorPolicy preserves soft stale fallback only for transient outages", () => {
		const ep = makeEndpoint();
		expect(ep.errorPolicy(new RetryableError({ key: "offline" }))).toBe("soft");
		expect(ep.errorPolicy(new RetryableError({ key: "connection" }))).toBe(
			"soft",
		);
		expect(ep.errorPolicy(new RetryableError({ key: "temporary" }))).toBe(
			"soft",
		);
		expect(ep.errorPolicy({ status: 503, message: "x" })).toBe("soft");

		expect(
			ep.errorPolicy(new RetryableError({ key: "unauthorized" })),
		).toBeUndefined();
		expect(
			ep.errorPolicy(new RetryableError({ key: "forbidden" })),
		).toBeUndefined();
		expect(
			ep.errorPolicy(new RetryableError({ key: "needAccount" })),
		).toBeUndefined();
		expect(ep.errorPolicy({ status: 404, message: "x" })).toBeUndefined();
		expect(ep.errorPolicy({ status: 429, message: "x" })).toBeUndefined();
		expect(ep.errorPolicy({ status: "parse", message: "x" })).toBeUndefined();
	});
});

describe("error classification, auth guard, and retry coordinator", () => {
	test("classifies all error categories and auth/transient predicates", () => {
		const offline = new RetryableError({ key: "offline" });
		const connection = new RetryableError({ key: "connection" });
		const temporary = new RetryableError({ key: "temporary" });
		const unauthorized = new RetryableError({ key: "unauthorized" });
		const forbidden = new RetryableError({ key: "forbidden" });
		const needAccount = new RetryableError({ key: "needAccount" });
		const notFound = { status: 404, message: "missing" };
		const rateLimited = { status: 429, message: "slow down" };
		const parseErr = { status: "parse", message: "bad" };
		const generic = new Error("boom");

		expect(classifyError(offline)).toBe("offline");
		expect(classifyError(connection)).toBe("connection");
		expect(classifyError(temporary)).toBe("temporary");
		expect(classifyError(unauthorized)).toBe("session-expired");
		expect(classifyError(forbidden)).toBe("forbidden");
		expect(classifyError(needAccount)).toBe("needAccount");
		expect(classifyError({ status: 401, message: "expired" })).toBe(
			"session-expired",
		);
		expect(classifyError({ status: 403, message: "denied" })).toBe("forbidden");
		expect(classifyError(notFound)).toBe("not-found");
		expect(classifyError(rateLimited)).toBe("rate-limited");
		expect(classifyError(parseErr)).toBe("invalid-response");
		expect(classifyError(new SyntaxError("bad json"))).toBe("invalid-response");
		expect(classifyError(generic)).toBe("unknown");
		expect(classifyError(new RetryableError({ key: "invalid-server" }))).toBe(
			"invalid-server",
		);

		expect(isTransientOutageError(offline)).toBe(true);
		expect(isTransientOutageError(connection)).toBe(true);
		expect(isTransientOutageError(temporary)).toBe(true);
		expect(isTransientOutageError({ status: 502 })).toBe(true);
		expect(isTransientOutageError(rateLimited)).toBe(false);
		expect(isTransientOutageError(unauthorized)).toBe(false);
		expect(isTransientOutageError(forbidden)).toBe(false);
		expect(isTransientOutageError(notFound)).toBe(false);

		expect(isDefinitiveAuthError(unauthorized)).toBe(true);
		expect(isDefinitiveAuthError(forbidden)).toBe(true);
		expect(isDefinitiveAuthError(needAccount)).toBe(true);
		expect(isDefinitiveAuthError({ status: 401 })).toBe(true);
		expect(isDefinitiveAuthError({ status: 403 })).toBe(true);
		expect(isDefinitiveAuthError(offline)).toBe(false);
		expect(isDefinitiveAuthError(connection)).toBe(false);
		expect(isDefinitiveAuthError(temporary)).toBe(false);
		expect(isDefinitiveAuthError(rateLimited)).toBe(false);
		expect(isDefinitiveAuthError(notFound)).toBe(false);
	});

	test("retry coordinator prevents concurrent retries and bounds online auto-retry to once", async () => {
		let resolveRetry!: () => void;
		let count = 0;
		const states: boolean[] = [];

		const coordinator = createRetryCoordinator({
			maxAutoRetries: 1,
			onStateChange: (s) => states.push(s),
			onRetry: () => {
				count += 1;
				return new Promise<void>((res) => {
					resolveRetry = res;
				});
			},
		});

		const p1 = coordinator.triggerManualRetry();
		const p2 = coordinator.triggerManualRetry();
		const pOnlineConcurrent = coordinator.triggerOnlineRetry();

		expect(coordinator.isRetrying()).toBe(true);
		expect(await p2).toBe(false);
		expect(await pOnlineConcurrent).toBe(false);
		expect(count).toBe(1);

		resolveRetry();
		expect(await p1).toBe(true);
		expect(coordinator.isRetrying()).toBe(false);

		const pOnline1 = coordinator.triggerOnlineRetry();
		resolveRetry();
		expect(await pOnline1).toBe(true);
		expect(coordinator.getAutoRetryCount()).toBe(1);

		// Second online transition is ignored (bounded to once)
		expect(await coordinator.triggerOnlineRetry()).toBe(false);
		expect(count).toBe(2);

		coordinator.dispose();
		expect(await coordinator.triggerManualRetry()).toBe(false);
		expect(states).toEqual([true, false, true, false]);
	});

	test("disposal during exact cache invalidation stops the old retry without changing the replacement state", async () => {
		const oldPreparation = Promise.withResolvers<void>();
		const newRetry = Promise.withResolvers<void>();
		const oldRetry = mock(async () => {});
		const states: boolean[] = [];
		const onStateChange = (retrying: boolean) => states.push(retrying);
		const first = createRetryCoordinator({
			beforeRetry: () => oldPreparation.promise,
			onRetry: oldRetry,
			onStateChange,
		});
		const pending = first.triggerManualRetry();
		first.dispose();
		const replacement = createRetryCoordinator({
			onRetry: () => newRetry.promise,
			onStateChange,
		});
		expect(replacement.isRetrying()).toBe(false);
		const current = replacement.triggerManualRetry();

		oldPreparation.resolve();
		expect(await pending).toBe(false);
		expect(oldRetry).not.toHaveBeenCalled();
		expect(await first.triggerOnlineRetry()).toBe(false);
		expect(replacement.isRetrying()).toBe(true);
		expect(states).toEqual([true, true]);

		newRetry.resolve();
		expect(await current).toBe(true);
		expect(states).toEqual([true, true, false]);
	});

	test("disposal also suppresses state updates from an already running boundary retry", async () => {
		const running = Promise.withResolvers<void>();
		const onStateChange = mock((_retrying: boolean) => {});
		const coordinator = createRetryCoordinator({
			onRetry: () => running.promise,
			onStateChange,
		});
		const retry = coordinator.triggerOnlineRetry();
		coordinator.dispose();
		running.resolve();
		expect(await retry).toBe(false);
		expect(onStateChange.mock.calls).toEqual([[true]]);
	});

	test("retry coordinator swallows handler rejection so fire-and-forget is safe", async () => {
		let attempts = 0;
		const states: boolean[] = [];
		const coordinator = createRetryCoordinator({
			maxAutoRetries: 1,
			onStateChange: (s) => states.push(s),
			onRetry: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("retry failed");
			},
		});

		// Must resolve (not reject) even though the handler rejected.
		expect(await coordinator.triggerManualRetry()).toBe(false);
		expect(coordinator.isRetrying()).toBe(false);

		// The coordinator is not wedged: a later press runs again.
		expect(await coordinator.triggerManualRetry()).toBe(true);
		expect(attempts).toBe(2);
		expect(states).toEqual([true, false, true, false]);
	});

	test("a fresh coordinator works after the previous one was disposed (StrictMode remount)", async () => {
		let count = 0;
		const onRetry = async () => {
			count += 1;
		};

		const first = createRetryCoordinator({ onRetry });
		first.dispose();
		expect(await first.triggerManualRetry()).toBe(false);
		expect(await first.triggerOnlineRetry()).toBe(false);
		expect(count).toBe(0);

		const second = createRetryCoordinator({ onRetry });
		expect(await second.triggerManualRetry()).toBe(true);
		expect(await second.triggerOnlineRetry()).toBe(true);
		expect(count).toBe(2);
	});

	test("exact failed endpoint retry invalidates cached error in Data Client Controller", async () => {
		const { controller, getState } = setupController();
		let shouldFail = true;
		globalThis.fetch = (async () => {
			if (shouldFail) {
				return new Response("down", { status: 500 });
			}
			return new Response(JSON.stringify({ id: "ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const ep = makeEndpoint();
		const args = { slug: "test" } as const;
		const otherArgs = { slug: "unrelated" } as const;

		await expect(controller.fetch(ep, args)).rejects.toMatchObject({
			key: "temporary",
		});
		await expect(controller.fetch(ep, otherArgs)).rejects.toMatchObject({
			key: "temporary",
		});
		const otherError = controller.getError(ep, otherArgs, getState());

		const cachedError = controller.getError(ep, args, getState());
		expect(cachedError).toBeInstanceOf(RetryableError);

		const attached = attachErrorRetry(
			cachedError,
			createCacheRetry(
				() => controller.getError(ep, args, getState()),
				() => controller.invalidate(ep, args),
				cachedError,
			),
		);
		expect(getErrorRetry(attached)).toBeDefined();

		// Before invalidation, fetchIfStale returns cached error (no-op)
		await expect(controller.fetchIfStale(ep, args)).rejects.toBe(cachedError);

		// Exact retry invalidates only this endpoint, clearing cached error
		await getErrorRetry(attached)?.();
		expect(controller.getError(ep, args, getState())).toBeUndefined();
		expect(controller.getError(ep, otherArgs, getState())).toBe(otherError);

		shouldFail = false;
		const recovered = await controller.fetchIfStale(ep, args);
		expect(recovered).toEqual({ id: "ok" });
	});

	test("authenticated stale data survives a server outage but not an auth denial", async () => {
		const { controller, getState } = setupController();
		const ep = makeEndpoint();
		const args = { slug: "test" };
		let response = Response.json({ id: "ok" });
		globalThis.fetch = (async () => response) as unknown as typeof fetch;
		await expect(controller.fetch(ep, args)).resolves.toEqual({ id: "ok" });

		response = Response.json({ key: "unauthorized" }, { status: 500 });
		await expect(controller.fetch(ep, args)).rejects.toMatchObject({
			key: "temporary",
		});
		expect(controller.getError(ep, args, getState())).toBeUndefined();
		expect<unknown>(controller.getResponse(ep, args, getState()).data).toEqual({
			id: "ok",
		});

		response = Response.json({ key: "offline" }, { status: 403 });
		await expect(controller.fetch(ep, args)).rejects.toMatchObject({
			key: "forbidden",
		});
		expect(controller.getError(ep, args, getState())).toMatchObject({
			key: "forbidden",
		});
	});

	test("cache retry is a no-op after the controller store is reset", async () => {
		const { controller, getState } = setupController();
		globalThis.fetch = (async () =>
			new Response("down", { status: 500 })) as unknown as typeof fetch;

		const ep = makeEndpoint();
		const args = { slug: "test" } as const;

		await expect(controller.fetch(ep, args)).rejects.toMatchObject({
			key: "temporary",
		});
		const cachedError = controller.getError(ep, args, getState());
		expect(cachedError).toBeDefined();

		const retry = createCacheRetry(
			() => controller.getError(ep, args, getState()),
			() => controller.invalidate(ep, args),
			cachedError,
		);

		// Simulate an account change: the whole store is reset before the
		// user presses retry. The stale handler must not invalidate anything.
		await controller.resetEntireStore();
		await retry();
		expect(controller.getError(ep, args, getState())).toBeUndefined();
	});

	test("cache retry is a no-op once the cached error was cleared", async () => {
		const { controller, getState } = setupController();
		let shouldFail = true;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			if (shouldFail) return new Response("down", { status: 500 });
			return new Response(JSON.stringify({ id: "ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const ep = makeEndpoint();
		const args = { slug: "test" } as const;

		await expect(controller.fetch(ep, args)).rejects.toMatchObject({
			key: "temporary",
		});
		const cachedError = controller.getError(ep, args, getState());
		const retry = createCacheRetry(
			() => controller.getError(ep, args, getState()),
			() => controller.invalidate(ep, args),
			cachedError,
		);

		await retry();
		shouldFail = false;
		await controller.fetchIfStale(ep, args);
		const callsAfterRecovery = calls;

		// Pressing the stale retry again must not invalidate fresh data.
		await retry();
		expect(calls).toBe(callsAfterRecovery);
		expect(controller.getError(ep, args, getState())).toBeUndefined();
	});

	test("searchToString and getHeaders format query params and auth headers", () => {
		const ep = makeEndpoint({ authToken: "tok-123" });
		expect(
			ep.searchToString({
				b: ["x", "y"],
				a: 1,
				empty: [],
				undef: undefined,
			}),
		).toBe("a=1&b=x%2Cy");
		expect(ep.getHeaders({ "X-Custom": "1" })).toEqual({
			"X-Custom": "1",
			Authorization: "Bearer tok-123",
			"Accept-Language": "en, en, *",
		});
	});

	test("preserves callable function, prototype, auth/parser options, and extend()", async () => {
		const { RestEndpoint } = await import("@data-client/rest");
		const ep = makeEndpoint({ authToken: "tok-call" });

		expect(typeof ep).toBe("function");
		expect(ep).toBeInstanceOf(KyooEndpoint);
		expect(ep).toBeInstanceOf(RestEndpoint);
		expect(ep.auth).toEqual({
			apiUrl: "https://kyoo.example.com/api",
			authToken: "tok-call",
			lang: "en",
		});
		expect(ep.parser.parse({ id: "42" })).toEqual({ id: "42" });

		let seenUrl: string | undefined;
		let seenHeaders: HeadersInit | undefined;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			seenUrl = String(input);
			seenHeaders = init?.headers;
			return new Response(JSON.stringify({ id: "42", extra: "ignored" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await expect(ep({ slug: "matrix" })).resolves.toEqual({ id: "42" });
		expect(seenUrl).toBe("http://api:3567/api/movies/matrix");
		expect(seenHeaders).toMatchObject({
			Authorization: "Bearer tok-call",
			"Accept-Language": "en, en, *",
		});

		const extended = ep.extend({ method: "HEAD" });
		expect(typeof extended).toBe("function");
		expect(extended).toBeInstanceOf(KyooEndpoint);
		expect(extended.auth).toEqual(ep.auth);
		expect(extended.parser).toBe(ep.parser);
		expect(extended.method).toBe("HEAD");
	});
});
