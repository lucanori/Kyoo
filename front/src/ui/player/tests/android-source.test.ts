import { describe, expect, it } from "bun:test";
import type { CastStatus, OmniPlayer, Source } from "react-native-omni";
import {
	type AppliedAndroidSource,
	applyAndroidPlayerSource,
	areSubstantiveSourcesEqual,
	isNativeSourceMatch,
	parseExplicitStartTime,
} from "../android-source";

const createFakePlayer = (initial?: {
	castStatus?: CastStatus;
	currentTime?: number;
	source?: Source;
}) => {
	const assignments: Array<Source | undefined> = [];
	let currentSource: Source | undefined = initial?.source;

	const player = {
		castStatus: initial?.castStatus ?? ("available" as CastStatus),
		currentTime: initial?.currentTime ?? 0,
		get source() {
			return currentSource;
		},
		set source(value: Source | undefined) {
			assignments.push(value);
			currentSource = value;
		},
	};

	return {
		player: player as unknown as OmniPlayer,
		state: player,
		assignments,
	};
};

const makeSource = (overrides?: {
	slug?: string;
	mode?: "direct" | "hls";
	sign?: string;
	token?: string | null;
	castToken?: string | null;
	startTime?: number;
	title?: string;
	hasNext?: boolean;
	subtitles?: Source["subtitles"];
	fonts?: string[];
	localFile?: string;
}): Source => {
	const slug = overrides?.slug ?? "ep-1";
	const mode = overrides?.mode ?? "direct";
	const sign = overrides?.sign ?? "sig-1";
	const token = overrides?.token === undefined ? "tok-a" : overrides.token;
	const castToken =
		overrides?.castToken === undefined ? token : overrides.castToken;
	const uri =
		overrides?.localFile ??
		`https://kyoo.example.com/api/videos/${slug}/${mode === "direct" ? "direct" : "master.m3u8"}?clientId=c1&x-presign=${sign}`;

	return {
		src: {
			uri,
			mimeType:
				mode === "direct"
					? 'video/mp4; codecs="avc1"'
					: "application/x-mpegURL",
			headers:
				overrides?.localFile || token === null
					? {}
					: { Authorization: `Bearer ${token}` },
		},
		startTime: overrides?.startTime,
		subtitles: overrides?.subtitles ?? [
			{
				id: "0",
				link: `https://kyoo.example.com/api/videos/${slug}/sub/0.ass?x-presign=${sign}`,
				label: "English",
				language: "eng",
			},
		],
		fonts: overrides?.fonts ?? [
			`https://kyoo.example.com/api/fonts/font.ttf?x-presign=${sign}`,
		],
		metadata: {
			title: overrides?.title ?? "Episode 1",
			artist: "Show",
			imageLink: `https://kyoo.example.com/api/images/thumb?x-presign=${sign}`,
			hasPrev: false,
			hasNext: overrides?.hasNext ?? true,
		},
		castId: `https://kyoo.example.com/api/videos/${slug}`,
		castData: {
			apiUrl: "https://kyoo.example.com",
			slug,
			clientId: "c1",
			...(castToken !== null && { token: castToken }),
			title: overrides?.title ?? "Episode 1",
		},
	};
};

describe("parseExplicitStartTime", () => {
	it("parses numeric strings including 0 and returns undefined for missing or invalid", () => {
		expect(parseExplicitStartTime(undefined)).toBeUndefined();
		expect(parseExplicitStartTime("0")).toBe(0);
		expect(parseExplicitStartTime("125")).toBe(125);
		expect(parseExplicitStartTime("invalid")).toBeUndefined();
	});
});

describe("areSubstantiveSourcesEqual", () => {
	it("ignores startTime, metadata, castData, and object identity", () => {
		const a = makeSource({ startTime: 10, title: "Title A", hasNext: false });
		const b = makeSource({ startTime: 55, title: "Title B", hasNext: true });
		expect(areSubstantiveSourcesEqual(a, b)).toBe(true);
	});

	it("detects changes in uri, mimeType, headers, subtitles, fonts, and castId", () => {
		const base = makeSource();
		expect(
			areSubstantiveSourcesEqual(base, makeSource({ sign: "sig-2" })),
		).toBe(false);
		expect(areSubstantiveSourcesEqual(base, makeSource({ mode: "hls" }))).toBe(
			false,
		);
		expect(
			areSubstantiveSourcesEqual(base, makeSource({ token: "tok-b" })),
		).toBe(false);
		expect(
			areSubstantiveSourcesEqual(
				base,
				makeSource({
					subtitles: [
						{
							id: "1",
							link: "https://kyoo.example.com/sub/1.srt",
							label: "French",
							language: "fra",
						},
					],
				}),
			),
		).toBe(false);
		expect(
			areSubstantiveSourcesEqual(
				base,
				makeSource({ fonts: ["https://kyoo.example.com/fonts/other.ttf"] }),
			),
		).toBe(false);
		expect(areSubstantiveSourcesEqual(base, makeSource({ slug: "ep-2" }))).toBe(
			false,
		);

		const localWithTokA = makeSource({
			localFile: "file:///downloads/ep-1.mkv",
			castToken: "tok-a",
		});
		const localWithTokB = makeSource({
			localFile: "file:///downloads/ep-1.mkv",
			castToken: "tok-b",
		});
		const localWithoutToken = makeSource({
			localFile: "file:///downloads/ep-1.mkv",
			castToken: null,
		});
		expect(areSubstantiveSourcesEqual(localWithTokA, localWithTokB)).toBe(
			false,
		);
		expect(areSubstantiveSourcesEqual(localWithTokA, localWithoutToken)).toBe(
			false,
		);
		expect(areSubstantiveSourcesEqual(localWithoutToken, localWithTokA)).toBe(
			false,
		);
	});
});

describe("applyAndroidPlayerSource", () => {
	it("applies initial DB resume once and ignores rolling cache progress and metadata updates", () => {
		const fake = createFakePlayer({ currentTime: 0 });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		const initial = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ startTime: 120 }),
			explicitStartTime: undefined,
		});
		expect(initial.action).toBe("apply");
		expect(fake.assignments).toHaveLength(1);
		expect(fake.assignments[0]?.startTime).toBe(120);

		// Simulate 5s progress observer ticks & metadata updates
		for (const tick of [125, 130, 135, 140]) {
			fake.state.currentTime = tick;
			const decision = applyAndroidPlayerSource({
				player: fake.player,
				appliedRef,
				nextSource: makeSource({
					startTime: tick,
					title: `Episode 1 (${tick})`,
					hasNext: tick % 2 === 0,
				}),
				explicitStartTime: undefined,
			});
			expect(decision.action).toBe("skip");
		}
		expect(fake.assignments).toHaveLength(1);
	});

	it("applies explicit t=0 once and supports explicit t=0 transition on same media", () => {
		const fake = createFakePlayer({ currentTime: 0 });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		// Initial load with explicit t=0
		const first = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ startTime: 0 }),
			explicitStartTime: 0,
		});
		expect(first.action).toBe("apply");
		expect(fake.assignments).toHaveLength(1);
		expect(fake.assignments[0]?.startTime).toBe(0);

		// Progress tick does not re-trigger t=0
		fake.state.currentTime = 15;
		const tick = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ startTime: 0 }),
			explicitStartTime: 0,
		});
		expect(tick.action).toBe("skip");
		expect(fake.assignments).toHaveLength(1);

		// Explicit t=45 transition on same media applies once
		const seek = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ startTime: 45 }),
			explicitStartTime: 45,
		});
		expect(seek.action).toBe("apply");
		expect(fake.assignments).toHaveLength(2);
		expect(fake.assignments[1]?.startTime).toBe(45);

		// Explicit t=0 transition back to start on same media applies once
		const resetZero = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ startTime: 0 }),
			explicitStartTime: 0,
		});
		expect(resetZero.action).toBe("apply");
		expect(fake.assignments).toHaveLength(3);
		expect(fake.assignments[2]?.startTime).toBe(0);
	});

	it("applies mode switch (direct -> hls) and preserves live position on same-media transport updates", () => {
		const fake = createFakePlayer({ currentTime: 0 });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ mode: "direct", startTime: 120 }),
			explicitStartTime: undefined,
		});

		// User watches to 350.4s and switches to HLS (PlayMode sets start="350")
		fake.state.currentTime = 350.4;
		const modeChange = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ mode: "hls", startTime: 350 }),
			explicitStartTime: 350,
		});
		expect(modeChange.action).toBe("apply");
		expect(fake.assignments[1]?.src.mimeType).toBe("application/x-mpegURL");
		expect(fake.assignments[1]?.startTime).toBe(350);

		// Later at 600s, presign signature refreshes without explicit t change -> preserves 600s
		fake.state.currentTime = 600;
		const transportRefresh = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({
				mode: "hls",
				sign: "sig-2",
				startTime: 350,
			}),
			explicitStartTime: 350,
		});
		expect(transportRefresh.action).toBe("apply");
		expect(fake.assignments[2]?.src.uri).toContain("x-presign=sig-2");
		expect(fake.assignments[2]?.startTime).toBe(600);
	});

	it("does not preserve old position across episode or account/auth transitions and clears when undefined", () => {
		const fake = createFakePlayer({ currentTime: 0 });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", token: "tok-a", startTime: 100 }),
			explicitStartTime: undefined,
		});
		fake.state.currentTime = 240;

		// Episode transition: must use ep-2's startTime, not 240
		applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-2", token: "tok-a", startTime: 0 }),
			explicitStartTime: 0,
		});
		expect(fake.assignments[1]?.castId).toContain("/ep-2");
		expect(fake.assignments[1]?.startTime).toBe(0);

		// Account transition: presign becomes undefined first -> must clear player.source
		fake.state.currentTime = 80;
		applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: undefined,
			explicitStartTime: undefined,
		});
		expect(fake.assignments[2]).toBeUndefined();
		expect(fake.state.source).toBeUndefined();

		// Direct auth header transition without intermediate undefined -> must use new startTime
		applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-2", token: "tok-a", startTime: 10 }),
			explicitStartTime: undefined,
		});
		fake.state.currentTime = 90;
		applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-2", token: "tok-b", startTime: 5 }),
			explicitStartTime: undefined,
		});
		expect(fake.assignments.at(-1)?.src.headers).toEqual({
			Authorization: "Bearer tok-b",
		});
		expect(fake.assignments.at(-1)?.startTime).toBe(5);
	});

	it("handles local downloaded files without reassigning on progress ticks", () => {
		const fake = createFakePlayer({ currentTime: 0 });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({
				localFile: "file:///downloads/ep-1.mkv",
				startTime: 40,
			}),
			explicitStartTime: undefined,
		});
		expect(fake.assignments).toHaveLength(1);

		fake.state.currentTime = 50;
		const tick = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({
				localFile: "file:///downloads/ep-1.mkv",
				startTime: 50,
			}),
			explicitStartTime: undefined,
		});
		expect(tick.action).toBe("skip");
		expect(fake.assignments).toHaveLength(1);
	});

	it("preserves casting guard, allows cast episode switch, and avoids reset on cast detach", () => {
		const ep1 = makeSource({ slug: "ep-1", startTime: 100 });
		const fake = createFakePlayer({
			castStatus: "connected",
			currentTime: 300,
			source: ep1,
		});
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		// While casting same castId -> skip
		expect(
			applyAndroidPlayerSource({
				player: fake.player,
				appliedRef,
				nextSource: makeSource({ slug: "ep-1", startTime: 305 }),
				explicitStartTime: undefined,
			}).action,
		).toBe("skip");
		expect(fake.assignments).toHaveLength(0);

		// While casting with undefined nextSource -> skip (keep cast alive)
		expect(
			applyAndroidPlayerSource({
				player: fake.player,
				appliedRef,
				nextSource: undefined,
				explicitStartTime: undefined,
			}).action,
		).toBe("skip");
		expect(fake.assignments).toHaveLength(0);

		// Cast detaches (OmniPlayer transferred ep1 to localPlayer) -> progress tick must not reset
		fake.state.castStatus = "available";
		expect(
			applyAndroidPlayerSource({
				player: fake.player,
				appliedRef,
				nextSource: makeSource({ slug: "ep-1", startTime: 310 }),
				explicitStartTime: undefined,
			}).action,
		).toBe("skip");
		expect(fake.assignments).toHaveLength(0);

		// Switching to ep-2 while casting -> applies ep-2
		fake.state.castStatus = "connected";
		const castSwitch = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-2", startTime: 0 }),
			explicitStartTime: 0,
		});
		expect(castSwitch.action).toBe("apply");
		expect(fake.assignments).toHaveLength(1);
		expect(fake.assignments[0]?.castId).toContain("/ep-2");
	});

	// what android rebuilds for media the receiver loaded itself: headers,
	// subtitles and fonts are dropped and castId is the mediaId (the uri)
	const makeReconstructedSource = (source: Source): Source => ({
		...source,
		src: { uri: source.src.uri, mimeType: source.src.mimeType, headers: {} },
		startTime: undefined,
		subtitles: [],
		fonts: undefined,
		metadata: { title: source.metadata?.title ?? "" },
		castId: source.src.uri,
		castData: undefined,
	});

	it("isNativeSourceMatch accepts intrinsic and reconstructed native sources", () => {
		const source = makeSource();
		expect(isNativeSourceMatch(source, makeSource())).toBe(true);
		expect(isNativeSourceMatch(makeReconstructedSource(source), source)).toBe(
			true,
		);
		expect(isNativeSourceMatch(undefined, source)).toBe(false);
		expect(
			isNativeSourceMatch(
				makeReconstructedSource(makeSource({ slug: "ep-2" })),
				source,
			),
		).toBe(false);
		// a dropped-looking source whose castId is the consumer castId is not
		// a native rebuild, it is a genuinely different source
		expect(
			isNativeSourceMatch(
				{ ...makeReconstructedSource(source), castId: source.castId },
				source,
			),
		).toBe(false);
	});

	it("re-applies after an external clear and after an outdated native source", () => {
		const fake = createFakePlayer({ currentTime: 0 });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", startTime: 100 }),
			explicitStartTime: undefined,
		});
		expect(fake.assignments).toHaveLength(1);

		// something else clears the native source (mini-player, unload path)
		fake.state.source = undefined;
		fake.assignments.length = 0;
		const afterClear = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", startTime: 100 }),
			explicitStartTime: undefined,
		});
		expect(afterClear.action).toBe("apply");
		expect(fake.assignments).toHaveLength(1);

		// the native source is outdated (another media took over)
		fake.state.source = makeSource({ slug: "ep-2", startTime: 0 });
		fake.assignments.length = 0;
		const outdated = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", startTime: 100 }),
			explicitStartTime: undefined,
		});
		expect(outdated.action).toBe("apply");
		expect(fake.assignments[0]?.castId).toContain("/ep-1");
	});

	it("applies on a replaced player instance and does not carry the old clock", () => {
		const oldPlayer = createFakePlayer({ currentTime: 500 });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		applyAndroidPlayerSource({
			player: oldPlayer.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", sign: "sig-1", startTime: 100 }),
			explicitStartTime: undefined,
		});
		expect(oldPlayer.assignments).toHaveLength(1);

		// the provider replaces the player (android backend switch): the new
		// instance has no source and must not skip on the old record
		const newPlayer = createFakePlayer({ currentTime: 777 });
		const replaced = applyAndroidPlayerSource({
			player: newPlayer.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", sign: "sig-2", startTime: 100 }),
			explicitStartTime: undefined,
		});
		expect(replaced.action).toBe("apply");
		expect(newPlayer.assignments).toHaveLength(1);
		// the new player's clock is not the prior media's clock
		expect(newPlayer.assignments[0]?.startTime).toBe(100);
		expect(newPlayer.assignments[0]?.src.uri).toContain("x-presign=sig-2");
	});

	it("does not carry the live position when the loaded source is outdated", () => {
		const fake = createFakePlayer({ currentTime: 0 });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", sign: "sig-1", startTime: 100 }),
			explicitStartTime: undefined,
		});

		// the receiver advanced to ep-2 on its own and the player clock is
		// ep-2's; a sig refresh for ep-1 must not inherit that clock
		fake.state.source = makeSource({ slug: "ep-2", startTime: 0 });
		fake.state.currentTime = 900;
		fake.assignments.length = 0;
		const refresh = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", sign: "sig-2", startTime: 100 }),
			explicitStartTime: undefined,
		});
		expect(refresh.action).toBe("apply");
		expect(fake.assignments[0]?.startTime).toBe(100);
	});

	it("keeps the source after a genuine cast transfer and re-applies after detach plus clear", () => {
		const fake = createFakePlayer({ currentTime: 0 });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", startTime: 100 }),
			explicitStartTime: undefined,
		});
		expect(fake.assignments).toHaveLength(1);

		// cast starts, the native side hands the media to the receiver and
		// back; the own source is still loaded so still skip
		fake.state.castStatus = "connected";
		expect(
			applyAndroidPlayerSource({
				player: fake.player,
				appliedRef,
				nextSource: makeSource({ slug: "ep-1", startTime: 105 }),
				explicitStartTime: undefined,
			}).action,
		).toBe("skip");
		fake.state.castStatus = "available";
		expect(
			applyAndroidPlayerSource({
				player: fake.player,
				appliedRef,
				nextSource: makeSource({ slug: "ep-1", startTime: 110 }),
				explicitStartTime: undefined,
			}).action,
		).toBe("skip");
		expect(fake.assignments).toHaveLength(1);

		// detach while away from the watch screen clears the source: the
		// next evaluation (cast status changed) must re-apply it
		fake.state.source = undefined;
		fake.assignments.length = 0;
		const reopened = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", startTime: 110 }),
			explicitStartTime: undefined,
		});
		expect(reopened.action).toBe("apply");
		expect(fake.assignments).toHaveLength(1);
	});

	it("adopts a matching native-rebuilt source without reassigning", () => {
		const next = makeSource({ slug: "ep-1", startTime: 100 });
		const fake = createFakePlayer({
			currentTime: 300,
			source: makeReconstructedSource(next),
		});
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		const adopted = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", startTime: 305 }),
			explicitStartTime: undefined,
		});
		expect(adopted.action).toBe("skip");
		expect(fake.assignments).toHaveLength(0);
		expect(appliedRef.current?.source.castId).toContain("/ep-1");

		// and a foreign rebuilt source does not adopt
		const foreign = createFakePlayer({
			source: makeReconstructedSource(makeSource({ slug: "ep-2" })),
		});
		const foreignApplied: { current: AppliedAndroidSource | null } = {
			current: null,
		};
		const applied = applyAndroidPlayerSource({
			player: foreign.player,
			appliedRef: foreignApplied,
			nextSource: next,
			explicitStartTime: undefined,
		});
		expect(applied.action).toBe("apply");
		expect(foreign.assignments).toHaveLength(1);
	});

	it("clears a stale source on a replaced player when the next source is undefined", () => {
		const oldPlayer = createFakePlayer({ currentTime: 0 });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};
		applyAndroidPlayerSource({
			player: oldPlayer.player,
			appliedRef,
			nextSource: makeSource({ slug: "ep-1", startTime: 100 }),
			explicitStartTime: undefined,
		});

		const newPlayer = createFakePlayer({
			source: makeSource({ slug: "ep-1", startTime: 100 }),
		});
		const cleared = applyAndroidPlayerSource({
			player: newPlayer.player,
			appliedRef,
			nextSource: undefined,
			explicitStartTime: undefined,
		});
		expect(cleared.action).toBe("apply");
		expect(newPlayer.assignments).toEqual([undefined]);
		expect(newPlayer.state.source).toBeUndefined();
	});

	it("skips redundant clear when nothing is applied or loaded", () => {
		const fake = createFakePlayer({ currentTime: 0, source: undefined });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		const decision = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: undefined,
			explicitStartTime: undefined,
		});
		expect(decision.action).toBe("skip");
		expect(fake.assignments).toHaveLength(0);
	});

	it("updates local download source on castData.token change or removal without carrying old position", () => {
		const fake = createFakePlayer({ currentTime: 0 });
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};

		applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({
				localFile: "file:///downloads/ep-1.mkv",
				castToken: "tok-a",
				startTime: 40,
			}),
			explicitStartTime: undefined,
		});
		expect(fake.assignments).toHaveLength(1);
		expect(fake.assignments[0]?.castData?.token).toBe("tok-a");

		// Account switches to tok-b on the same local file: must apply and use new startTime
		fake.state.currentTime = 240;
		const switched = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({
				localFile: "file:///downloads/ep-1.mkv",
				castToken: "tok-b",
				startTime: 12,
			}),
			explicitStartTime: undefined,
		});
		expect(switched.action).toBe("apply");
		expect(fake.assignments).toHaveLength(2);
		expect(fake.assignments[1]?.castData?.token).toBe("tok-b");
		expect(fake.assignments[1]?.startTime).toBe(12);

		// Token removed (logout) on the same local file: must apply without token and without carrying 300s
		fake.state.currentTime = 300;
		const removed = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({
				localFile: "file:///downloads/ep-1.mkv",
				castToken: null,
				startTime: 0,
			}),
			explicitStartTime: undefined,
		});
		expect(removed.action).toBe("apply");
		expect(fake.assignments).toHaveLength(3);
		expect(fake.assignments[2]?.castData?.token).toBeUndefined();
		expect(fake.assignments[2]?.startTime).toBe(0);

		// Token added back on the same local file: must apply with new token and startTime
		fake.state.currentTime = 50;
		const added = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({
				localFile: "file:///downloads/ep-1.mkv",
				castToken: "tok-c",
				startTime: 25,
			}),
			explicitStartTime: undefined,
		});
		expect(added.action).toBe("apply");
		expect(fake.assignments).toHaveLength(4);
		expect(fake.assignments[3]?.castData?.token).toBe("tok-c");
		expect(fake.assignments[3]?.startTime).toBe(25);
	});

	it("re-applies local download after cast detach when account token changed or was removed while casting", () => {
		const localA = makeSource({
			localFile: "file:///downloads/ep-1.mkv",
			castToken: "tok-a",
			startTime: 100,
		});
		const fake = createFakePlayer({
			castStatus: "connected",
			currentTime: 300,
			source: localA,
		});
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: {
				source: localA,
				explicitStartTime: undefined,
				player: fake.player,
			},
		};

		// Token changes while casting same castId -> active cast guard still skips
		const whileCasting = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({
				localFile: "file:///downloads/ep-1.mkv",
				castToken: "tok-b",
				startTime: 15,
			}),
			explicitStartTime: undefined,
		});
		expect(whileCasting.action).toBe("skip");
		expect(fake.assignments).toHaveLength(0);

		// Cast detaches -> must apply tok-b and not reuse tok-a or 300s clock
		fake.state.castStatus = "available";
		const afterDetach = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({
				localFile: "file:///downloads/ep-1.mkv",
				castToken: "tok-b",
				startTime: 15,
			}),
			explicitStartTime: undefined,
		});
		expect(afterDetach.action).toBe("apply");
		expect(fake.assignments).toHaveLength(1);
		expect(fake.assignments[0]?.castData?.token).toBe("tok-b");
		expect(fake.assignments[0]?.startTime).toBe(15);

		// Cast again, remove token while casting, then detach -> must clear castData.token
		fake.state.castStatus = "connected";
		fake.state.currentTime = 450;
		expect(
			applyAndroidPlayerSource({
				player: fake.player,
				appliedRef,
				nextSource: makeSource({
					localFile: "file:///downloads/ep-1.mkv",
					castToken: null,
					startTime: 0,
				}),
				explicitStartTime: undefined,
			}).action,
		).toBe("skip");
		expect(fake.assignments).toHaveLength(1);

		fake.state.castStatus = "available";
		const afterDetachRemoved = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({
				localFile: "file:///downloads/ep-1.mkv",
				castToken: null,
				startTime: 0,
			}),
			explicitStartTime: undefined,
		});
		expect(afterDetachRemoved.action).toBe("apply");
		expect(fake.assignments).toHaveLength(2);
		expect(fake.assignments[1]?.castData?.token).toBeUndefined();
		expect(fake.assignments[1]?.startTime).toBe(0);

		// Cast again with token absent, add token while casting, then detach -> must apply token
		fake.state.castStatus = "connected";
		fake.state.currentTime = 500;
		expect(
			applyAndroidPlayerSource({
				player: fake.player,
				appliedRef,
				nextSource: makeSource({
					localFile: "file:///downloads/ep-1.mkv",
					castToken: "tok-c",
					startTime: 30,
				}),
				explicitStartTime: undefined,
			}).action,
		).toBe("skip");

		fake.state.castStatus = "available";
		const afterDetachAdded = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: makeSource({
				localFile: "file:///downloads/ep-1.mkv",
				castToken: "tok-c",
				startTime: 30,
			}),
			explicitStartTime: undefined,
		});
		expect(afterDetachAdded.action).toBe("apply");
		expect(fake.assignments).toHaveLength(3);
		expect(fake.assignments[2]?.castData?.token).toBe("tok-c");
		expect(fake.assignments[2]?.startTime).toBe(30);
	});

	it("does not allow native fallback to adopt or retain a stale credential", () => {
		const nextB = makeSource({
			localFile: "file:///downloads/ep-1.mkv",
			castToken: "tok-b",
			startTime: 10,
		});
		// Dropped-looking native source that still carries a stale castData.token
		const staleFallback: Source = {
			...makeReconstructedSource(nextB),
			castData: { token: "tok-a" },
		};
		expect(isNativeSourceMatch(staleFallback, nextB)).toBe(false);
		expect(
			isNativeSourceMatch(
				staleFallback,
				makeSource({
					localFile: "file:///downloads/ep-1.mkv",
					castToken: null,
				}),
			),
		).toBe(false);

		const fake = createFakePlayer({
			currentTime: 220,
			source: staleFallback,
		});
		const appliedRef: { current: AppliedAndroidSource | null } = {
			current: null,
		};
		const decision = applyAndroidPlayerSource({
			player: fake.player,
			appliedRef,
			nextSource: nextB,
			explicitStartTime: undefined,
		});
		expect(decision.action).toBe("apply");
		expect(fake.assignments).toHaveLength(1);
		expect(fake.assignments[0]?.castData?.token).toBe("tok-b");
		expect(fake.assignments[0]?.startTime).toBe(10);

		// Also when appliedRef holds tok-a and native reconstructed the player source
		// (castData: undefined), switching to tok-b must still apply and not carry 220s
		const priorA = makeSource({ slug: "ep-1", token: "tok-a", startTime: 50 });
		const fakeRebuilt = createFakePlayer({
			currentTime: 220,
			source: makeReconstructedSource(priorA),
		});
		const priorAppliedRef: { current: AppliedAndroidSource | null } = {
			current: {
				source: priorA,
				explicitStartTime: undefined,
				player: fakeRebuilt.player,
			},
		};
		const switchAfterRebuilt = applyAndroidPlayerSource({
			player: fakeRebuilt.player,
			appliedRef: priorAppliedRef,
			nextSource: makeSource({ slug: "ep-1", token: "tok-b", startTime: 5 }),
			explicitStartTime: undefined,
		});
		expect(switchAfterRebuilt.action).toBe("apply");
		expect(fakeRebuilt.assignments).toHaveLength(1);
		expect(fakeRebuilt.assignments[0]?.castData?.token).toBe("tok-b");
		expect(fakeRebuilt.assignments[0]?.startTime).toBe(5);
	});
});
