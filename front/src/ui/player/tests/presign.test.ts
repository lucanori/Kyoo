import { describe, expect, it } from "bun:test";
import { type PresignSnapshot, isPresignForCurrent } from "../presign";

const snapshot = (overrides?: Partial<PresignSnapshot>): PresignSnapshot => ({
	for: JSON.stringify({ for: [{ prefix: "/api/videos/ep-1", verb: "GET" }] }),
	apiUrl: "https://kyoo.example.com",
	authToken: "tok-a",
	signature: "sig-1",
	...overrides,
});

describe("isPresignForCurrent", () => {
	it("accepts a snapshot for the current request, server and account", () => {
		const snap = snapshot();
		expect(
			isPresignForCurrent(snap, snap.for, snap.apiUrl, snap.authToken),
		).toBe(true);
	});

	it("accepts a scoped snapshot whose presign response failed", () => {
		const snap = snapshot({ signature: null });
		expect(
			isPresignForCurrent(snap, snap.for, snap.apiUrl, snap.authToken),
		).toBe(true);
	});

	it("rejects a missing snapshot and a changed request", () => {
		const snap = snapshot();
		expect(
			isPresignForCurrent(undefined, snap.for, snap.apiUrl, snap.authToken),
		).toBe(false);
		expect(
			isPresignForCurrent(
				snap,
				JSON.stringify({ for: [{ prefix: "/api/videos/ep-2", verb: "GET" }] }),
				snap.apiUrl,
				snap.authToken,
			),
		).toBe(false);
	});

	it("rejects a signature issued for another server", () => {
		const snap = snapshot();
		expect(
			isPresignForCurrent(
				snap,
				snap.for,
				"https://other.example.com",
				snap.authToken,
			),
		).toBe(false);
	});

	it("rejects a signature issued for another account on the same server", () => {
		const snap = snapshot();
		expect(isPresignForCurrent(snap, snap.for, snap.apiUrl, "tok-b")).toBe(
			false,
		);
	});
});
