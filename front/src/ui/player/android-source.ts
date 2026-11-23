import type { OmniPlayer, Source, Subtitle } from "react-native-omni";
import { setPlayerSource } from "./imperative";

export type AndroidSourcePlayer = Pick<
	OmniPlayer,
	"castStatus" | "source" | "currentTime"
>;

export interface AppliedAndroidSource {
	source: Source;
	explicitStartTime: number | undefined;
	// player instance this source was applied to. the native provider can
	// replace the player (e.g. android backend switch), and a record from the
	// previous instance must not let the new one skip its first apply.
	player: AndroidSourcePlayer;
}

export type AndroidSourceDecision =
	| {
			action: "skip";
			applied: AppliedAndroidSource | null;
	  }
	| {
			action: "apply";
			source: Source | undefined;
			applied: AppliedAndroidSource | null;
	  };

export const parseExplicitStartTime = (
	requestedStart: string | undefined,
): number | undefined => {
	if (requestedStart === undefined) return undefined;
	const parsed = Number.parseInt(requestedStart, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
};

const areHeadersEqual = (
	a: Record<string, string | undefined>,
	b: Record<string, string | undefined>,
): boolean => {
	const aEntries = Object.entries(a).filter(([, v]) => v !== undefined);
	const bKeys = Object.keys(b).filter((k) => b[k] !== undefined);
	if (aEntries.length !== bKeys.length) return false;
	for (const [key, value] of aEntries) {
		if (!Object.hasOwn(b, key) || b[key] !== value) {
			return false;
		}
	}
	return true;
};

const areSubtitlesEqual = (a: Subtitle[], b: Subtitle[]): boolean => {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const sa = a[i];
		const sb = b[i];
		if (
			sa.id !== sb.id ||
			sa.link !== sb.link ||
			sa.mimeType !== sb.mimeType ||
			sa.language !== sb.language ||
			sa.label !== sb.label
		) {
			return false;
		}
	}
	return true;
};

const areStringArraysEqual = (
	a: string[] | undefined,
	b: string[] | undefined,
): boolean => {
	const aa = a ?? [];
	const bb = b ?? [];
	if (aa.length !== bb.length) return false;
	for (let i = 0; i < aa.length; i++) {
		if (aa[i] !== bb[i]) return false;
	}
	return true;
};

const areCastCredentialsEqual = (a: Source, b: Source): boolean =>
	a.castData?.token === b.castData?.token;

export const areSubstantiveSourcesEqual = (a: Source, b: Source): boolean => {
	return (
		a.src.uri === b.src.uri &&
		a.src.mimeType === b.src.mimeType &&
		areHeadersEqual(a.src.headers, b.src.headers) &&
		areSubtitlesEqual(a.subtitles, b.subtitles) &&
		areStringArraysEqual(a.fonts, b.fonts) &&
		a.mixAudio === b.mixAudio &&
		a.castId === b.castId &&
		areCastCredentialsEqual(a, b)
	);
};

// does the source actually loaded on the native player still represent
// `expected`? the native side rebuilds some sources (e.g. media the cast
// receiver loaded on its own) dropping headers, subtitles, fonts and
// castData and replacing castId with the mediaId (the uri), so strict
// equality is too strict there. uri + mimeType still identify that media
// without carrying a stale credential.
export const isNativeSourceMatch = (
	current: Source | undefined,
	expected: Source,
): boolean => {
	if (!current) return false;
	if (areSubstantiveSourcesEqual(current, expected)) return true;
	const droppedRepresentation =
		Object.keys(current.src.headers).length === 0 &&
		current.subtitles.length === 0 &&
		(current.fonts === undefined || current.fonts.length === 0) &&
		current.castId === current.src.uri &&
		(current.castData === undefined ||
			Object.keys(current.castData).length === 0);
	return (
		droppedRepresentation &&
		current.src.uri === expected.src.uri &&
		current.src.mimeType === expected.src.mimeType
	);
};

export const reconcileAndroidSource = ({
	applied,
	nextSource,
	explicitStartTime,
	player,
}: {
	applied: AppliedAndroidSource | null;
	nextSource: Source | undefined;
	explicitStartTime: number | undefined;
	player: AndroidSourcePlayer;
}): AndroidSourceDecision => {
	const isCasting =
		player.castStatus === "connected" || player.castStatus === "connecting";
	if (
		isCasting &&
		(!nextSource || player.source?.castId === nextSource.castId)
	) {
		return { action: "skip", applied };
	}

	if (!nextSource) {
		// nothing to clear when this player has no source, whatever a
		// previous player instance recorded as applied.
		if (player.source === undefined) {
			return { action: "skip", applied: null };
		}
		return { action: "apply", source: undefined, applied: null };
	}

	// only a record for this very player instance counts as applied. a
	// replaced player (android backend switch, provider re-create) starts
	// with no source, so the previous instance's record must not skip.
	const appliedForPlayer =
		applied !== null && applied.player === player ? applied : null;
	const currentMatchesNext = isNativeSourceMatch(player.source, nextSource);

	if (appliedForPlayer === null) {
		if (explicitStartTime === undefined && currentMatchesNext) {
			return {
				action: "skip",
				applied: { source: nextSource, explicitStartTime, player },
			};
		}
		return {
			action: "apply",
			source: nextSource,
			applied: { source: nextSource, explicitStartTime, player },
		};
	}

	const sameSubstantive = areSubstantiveSourcesEqual(
		appliedForPlayer.source,
		nextSource,
	);
	const explicitStartChanged =
		explicitStartTime !== undefined &&
		!Object.is(appliedForPlayer.explicitStartTime, explicitStartTime);

	// skipping requires evidence the source is still loaded on this
	// player: an externally cleared or outdated native source must be
	// re-applied instead of trusting the record alone.
	if (sameSubstantive && !explicitStartChanged && currentMatchesNext) {
		return { action: "skip", applied: appliedForPlayer };
	}

	const sameMediaAndAuth =
		appliedForPlayer.source.castId === nextSource.castId &&
		areHeadersEqual(
			appliedForPlayer.source.src.headers,
			nextSource.src.headers,
		) &&
		areCastCredentialsEqual(appliedForPlayer.source, nextSource);

	// carry the live position only when the source actually loaded on the
	// player still belongs to the prior media, so its clock is the prior
	// media's clock and not a replaced or outdated media's.
	const currentBelongsToPrior = isNativeSourceMatch(
		player.source,
		appliedForPlayer.source,
	);

	const resolvedSource =
		!sameSubstantive &&
		sameMediaAndAuth &&
		currentBelongsToPrior &&
		!explicitStartChanged &&
		Number.isFinite(player.currentTime) &&
		player.currentTime > 0
			? { ...nextSource, startTime: player.currentTime }
			: nextSource;

	return {
		action: "apply",
		source: resolvedSource,
		applied: { source: resolvedSource, explicitStartTime, player },
	};
};

export const applyAndroidPlayerSource = ({
	player,
	appliedRef,
	nextSource,
	explicitStartTime,
}: {
	player: OmniPlayer;
	appliedRef: { current: AppliedAndroidSource | null };
	nextSource: Source | undefined;
	explicitStartTime: number | undefined;
}): AndroidSourceDecision => {
	const decision = reconcileAndroidSource({
		applied: appliedRef.current,
		nextSource,
		explicitStartTime,
		player,
	});
	appliedRef.current = decision.applied;
	if (decision.action === "apply") {
		setPlayerSource(player, decision.source);
	}
	return decision;
};
