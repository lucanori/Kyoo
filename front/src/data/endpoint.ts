import {
	type IRestEndpoint,
	RestEndpoint,
	type RestEndpointConstructorOptions,
	type RestGenerics,
} from "@data-client/rest";
import { Platform } from "react-native";
import type { z } from "zod/v4";
import type { KyooError } from "~/models";
import { RetryableError } from "~/models/retryable-error";
import {
	createAbortError,
	isAbortError,
	isConfirmedBrowserOffline,
	isTransientHttpStatus,
	isTransientOutageError,
	READ_RETRY_DELAYS_MS,
	sleepWithAbort,
} from "./error-utils";
import type { Params } from "./query";

const ssrApiUrl = process.env.KYOO_URL ?? "http://api:3567/api";

export type Auth = { apiUrl: string; authToken: string | null; lang: string };

type KyooRestEndpoint<O extends RestGenerics> = IRestEndpoint<O> & {
	auth: Auth;
	parser: z.ZodType;
};

interface KyooEndpointConstructor {
	new <O extends RestGenerics = any>(
		options: RestEndpointConstructorOptions<O> &
			Readonly<O> &
			O & { auth: Auth; parser: z.ZodType },
	): KyooRestEndpoint<O>;
	readonly prototype: IRestEndpoint;
}

const BaseRestEndpoint = RestEndpoint as unknown as KyooEndpointConstructor;

export class KyooEndpoint<O extends RestGenerics> extends BaseRestEndpoint<O> {
	url(...args: Parameters<IRestEndpoint<O>["url"]>): string {
		const [params] = args as [Record<string, unknown>?];
		// `next` links sent by the api are complete urls
		if (typeof params?.next === "string") return params.next;
		const url = super.url(...args);
		if (Platform.OS === "web" && typeof window === "undefined")
			return `${ssrApiUrl}${url}`;
		return `${this.auth.apiUrl.replace(/\/$/, "")}${url}`;
	}

	searchToString(params: Params): string {
		return Object.entries(params)
			.filter(
				([_, v]) => v !== undefined && (Array.isArray(v) ? v.length > 0 : true),
			)
			.map(
				([k, v]) =>
					`${k}=${encodeURIComponent(Array.isArray(v) ? v.join(",") : String(v))}`,
			)
			.sort()
			.join("&");
	}

	getHeaders(headers: HeadersInit): HeadersInit {
		return {
			...headers,
			...(this.auth.authToken
				? { Authorization: `Bearer ${this.auth.authToken}` }
				: {}),
			"Accept-Language": `${this.auth.lang}, en, *`,
		};
	}

	async fetchResponse(input: RequestInfo, init: RequestInit) {
		const method = (init.method ?? this.method ?? "GET").toUpperCase();
		const canRetry =
			!this.sideEffect && (method === "GET" || method === "HEAD");
		const delays = canRetry ? READ_RETRY_DELAYS_MS : [];
		const wait = sleepWithAbort;

		for (let attempt = 0; ; attempt++) {
			if (init.signal?.aborted) throw createAbortError();

			let resp: Response;
			try {
				resp = await fetch(input, init);
			} catch (e) {
				if (isAbortError(e) || init.signal?.aborted) {
					throw isAbortError(e) ? e : createAbortError();
				}
				const offline = isConfirmedBrowserOffline();
				// Confirmed offline: don't burn the bounded read retries. The
				// error boundary retries automatically when back online.
				if (!offline && attempt < delays.length) {
					await wait(delays[attempt], init.signal);
					continue;
				}
				console.log("Fetch transport error", { method, offline });
				throw new RetryableError({
					key: offline ? "offline" : "connection",
				});
			}

			if (resp.ok) return resp;

			if (
				canRetry &&
				isTransientHttpStatus(resp.status) &&
				attempt < delays.length
			) {
				resp.body?.cancel?.().catch(() => {});
				await wait(delays[attempt], init.signal);
				continue;
			}

			if (resp.status === 404) {
				resp.body?.cancel?.().catch(() => {});
				throw { message: "Resource not found.", status: 404 } as KyooError;
			}

			const errorText = await resp.text();
			const data: KyooError = { message: errorText, status: resp.status };
			let needsVerification = false;
			try {
				const parsed: unknown = JSON.parse(errorText);
				if (typeof parsed === "object" && parsed !== null) {
					const body = parsed as Record<string, unknown>;
					if (
						Object.hasOwn(body, "message") &&
						typeof body.message === "string"
					) {
						data.message = body.message;
					}
					if (Object.hasOwn(body, "details")) data.details = body.details;
					// This structured error code only refines a 403 with a token.
					needsVerification =
						resp.status === 403 &&
						!!this.auth.authToken &&
						Object.hasOwn(body, "error") &&
						body.error === "needVerification";
				}
			} catch {
				// Leave non-JSON responses as plain text for existing API callers.
			}
			console.log("Invalid response", { method, status: resp.status });

			if (resp.status === 401) {
				throw new RetryableError({
					key: "unauthorized",
					inner: data,
				});
			}
			if (resp.status === 403) {
				// 401 is an expired/invalid session (sign in again), while a
				// 403 with a token is a verified denial. Guests get needAccount.
				throw new RetryableError({
					key: needsVerification
						? "needVerification"
						: this.auth.authToken
							? "forbidden"
							: "needAccount",
					inner: data,
				});
			}
			if (resp.status >= 500) {
				throw new RetryableError({
					key: "temporary",
					inner: data,
				});
			}
			throw data;
		}
	}

	process(
		value: unknown,
		..._args: Parameters<IRestEndpoint<O>["url"]>
	): ReturnType<IRestEndpoint<O>["process"]> {
		const parsed = this.parser.safeParse(value);
		if (parsed.success)
			return parsed.data as ReturnType<IRestEndpoint<O>["process"]>;
		console.log("Response parse error", {
			issueCount: parsed.error.issues.length,
		});
		throw {
			status: "parse",
			message:
				"Invalid response from kyoo. Possible version mismatch between the server and the application.",
		} as KyooError;
	}

	errorPolicy(error: unknown) {
		if (isTransientOutageError(error)) return "soft" as const;
		return undefined;
	}
}
