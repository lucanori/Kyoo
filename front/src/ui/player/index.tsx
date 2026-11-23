import { Stack, useRouter } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import {
	type ComponentRef,
	useEffect,
	useEffectEvent,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import {
	OmniView,
	type Source,
	useEvent,
	usePlayer,
	usePlayerState,
} from "react-native-omni";
import { v4 as uuidv4 } from "uuid";
import { entryDisplayNumber } from "~/components/entries";
import { type QueryIdentifier, useDLE } from "~/data";
import { type Entry, type KyooError, Video, type VideoInfo } from "~/models";
import { showImages } from "~/models/utils/images";
import { Head } from "~/primitives";
import { useToken } from "~/providers/account-context";
import { useLocalSetting } from "~/providers/settings";
import { useDownload } from "~/ui/download";
import { Info } from "~/ui/info";
import { Remote } from "~/ui/remote";
import { useSetting } from "~/ui/settings/base";
import { useQueryState } from "~/utils";
import { CastingScreen } from "./casting-screen";
import { Controls, LoadingIndicator } from "./controls";
import { ErrorPopup } from "./controls/error-popup";
import { toggleFullscreen } from "./controls/misc";
import { PlayModeContext } from "./controls/tracks-menu";
import { EntriesMenu } from "./entries-menu";
import { setPlayerSource } from "./imperative";
import { useKeyboard } from "./keyboard";
import { useLanguagePreference } from "./language-preference";
import { DEFAULT_PLAY_MODE, type PlayMode } from "./play-mode";
import { usePresign } from "./presign";
import { useProgressObserver } from "./progress-observer";
import { type RecoverySnapshot, sanitizeErrorText } from "./recovery";
import { useBrowserPlaybackRecovery } from "./use-recovery";

const clientId = uuidv4();

// btoa only handles latin1, so give it the utf8 bytes instead of the string
export const base64UrlPath = (path: string) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(path)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");

const withPresign = (url: string, signature: string | null): string => {
	if (!url || !signature) return url;
	return `${url}${url.includes("?") ? "&" : "?"}x-presign=${signature}`;
};

export const Player = () => {
	const [slug, setSlug] = useQueryState<string>("slug", undefined!);
	const [startQ, setStartQ] = useQueryState<string | undefined>("t", undefined);
	const [start, setStart] = useState<string | undefined>(startQ);
	const requestedStart = startQ ?? start;

	useEffect(() => {
		if (startQ === undefined) return;
		setStart(startQ);
		setStartQ(undefined);
	}, [startQ, setStartQ]);

	const { data } = useDLE(Player.query(slug));
	const { data: info } = useDLE(Info.infoQuery(slug));
	// TODO: map current entry using entries' duration & the current playtime
	const currentEntry = 0;
	const entry = data?.entries?.[currentEntry] ?? data?.entries?.[0];
	const title = entry
		? entry.kind === "movie"
			? entry.name
			: `${entryDisplayNumber(entry)} - ${entry.name}`
		: data?.path;
	const [preferOriginal] = useSetting("preferOriginal", "non-logo");
	const images = useMemo(
		() => (data?.show ? showImages(data.show, preferOriginal) : null),
		[data, preferOriginal],
	);

	const { apiUrl, authToken } = useToken();
	const presign = usePresign(
		data
			? {
					for: [
						{ prefix: `/api/videos/${slug}`, verb: "GET" },
						{ url: "/api/ws", verb: "GET" },
						{ prefix: `/video/${base64UrlPath(data.path)}`, verb: "GET" },
						...[images?.poster?.id, images?.thumbnail?.id]
							.filter((id) => !!id)
							.map((id) => ({ url: `/api/images/${id}`, verb: "GET" })),
					],
					...(entry && { claims: { wsRoutes: [`watch/${entry.id}`] } }),
					duration: "24h",
				}
			: null,
	);
	// only read when the video changes, a download finishing midway would restart it
	const download = useDownload(slug);
	const file = download?.status === "done" ? download.file : null;
	const [local, setLocal] = useState({ slug, file });
	if (local.slug !== slug) setLocal({ slug, file });
	const sign = local.file ? null : presign;
	const [defaultPlayMode] = useLocalSetting<PlayMode>(
		"playMode",
		DEFAULT_PLAY_MODE,
	);
	const [playMode, setPlayMode] = useState(defaultPlayMode);
	const [playbackError, setPlaybackError] = useState<KyooError | undefined>();

	const player = usePlayer();
	const setAudioPreference = useLanguagePreference(
		info,
		data?.show?.original.language,
	);
	const playModeState = useMemo<
		[PlayMode, (mode: PlayMode, audio?: number) => void]
	>(
		() => [
			playMode,
			(mode, audio) => {
				if (audio !== undefined) setAudioPreference(audio);
				if (mode === playMode) return;
				// changing the mode reloads the video, restart it where we are now
				setStart(Math.round(player.currentTime).toString());
				setPlayMode(mode);
			},
		],
		[playMode, player, setAudioPreference],
	);

	const source = useMemo<Source | undefined>(() => {
		if (!data || !info || sign === undefined) return undefined;
		const mode = local.file ? "direct" : playMode;
		return {
			src: {
				uri:
					local.file ??
					withPresign(
						`${apiUrl}/api/videos/${slug}/${mode === "direct" ? "direct" : "master.m3u8"}?clientId=${clientId}`,
						sign,
					),
				// chrome based browsers support matroska but they tell they don't.
				// list ass in the codecs so android's auto backend can pick vlc
				// without opening the media in exoplayer first.
				mimeType:
					mode === "direct"
						? info.subtitles.some(
								(x) => x.codec === "ass" || x.codec === "ssa",
							) && info.mimeCodec?.endsWith('"')
							? info.mimeCodec
									.replace("x-matroska", "mp4")
									.replace(/"$/, ', ass"')
							: info.mimeCodec?.replace("x-matroska", "mp4")
						: "application/x-mpegURL",
				headers:
					authToken && !local.file
						? { Authorization: `Bearer ${authToken}` }
						: {},
			},
			startTime: requestedStart
				? Number.parseInt(requestedStart, 10)
				: data.progress && data.progress.percent >= 95
					? 0
					: data.progress?.time,
			subtitles: info.subtitles
				.map((x, i) => ({ sub: x, id: (x.index ?? i).toString() }))
				.filter(
					({ sub }) =>
						sub.link &&
						(Platform.OS === "web" || mode === "hls" || sub.isExternal),
				)
				.map(({ sub, id }) => ({
					id,
					link: withPresign(
						`${apiUrl}${sub.codec === "subrip" && Platform.OS === "web" ? `${sub.link}?format=vtt` : sub.link!}`,
						sign,
					),
					label: sub.title ?? "Unknown",
					language: sub.language ?? "und",
				})),
			fonts: info.fonts.map((x) => withPresign(`${apiUrl}${x}`, sign)),
			metadata: {
				title: title ?? data.path,
				artist: data.show?.name ?? undefined,
				imageLink: images?.thumbnail
					? withPresign(`${apiUrl}${images.thumbnail.high}`, sign)
					: undefined,
				hasPrev: !!data.previous?.video,
				hasNext: !!data.next?.video,
			},
			castId: `${apiUrl}/api/videos/${slug}`,
			castData: {
				apiUrl,
				slug,
				clientId,
				...(sign && { presign: sign }),
				// an android tv plays casts with the caster's account. not sent by the
				// tv itself, it reports its castData to every sender.
				...(authToken && !Platform.isTV && { token: authToken }),
				title: title ?? data.path,
				...(data.show?.name && { subtitle: data.show.name }),
				...(images?.poster?.id && {
					poster: `${apiUrl}/api/images/${images.poster.id}?quality=high${
						sign ? `&x-presign=${sign}` : ""
					}`,
				}),
			},
		};
	}, [
		apiUrl,
		slug,
		playMode,
		info,
		authToken,
		requestedStart,
		data,
		images,
		title,
		sign,
		local,
	]);

	const castStatus = usePlayerState("castStatus");
	const viewRef = useRef<ComponentRef<typeof View>>(null);
	const {
		recovery,
		handleError: handleBrowserPlaybackError,
		manualRetry,
		dismiss: dismissRecovery,
	} = useBrowserPlaybackRecovery({
		enabled:
			Platform.OS === "web" &&
			!!source &&
			!local.file &&
			castStatus !== "connected" &&
			castStatus !== "connecting",
		sourceKey: JSON.stringify([
			apiUrl,
			slug,
			playMode,
			local.file,
			requestedStart,
		]),
		viewRef,
	});
	const restartTime = recovery.restart?.startTime;
	const playbackSource = useMemo(
		() =>
			source && restartTime != null
				? { ...source, startTime: restartTime }
				: source,
		[source, restartTime],
	);

	useEffect(() => {
		if (
			Platform.OS !== "web" &&
			(player.castStatus === "connected" ||
				player.castStatus === "connecting") &&
			(!playbackSource || player.source?.castId === playbackSource.castId)
		) {
			// do not re-set the source when casting the correct content,
			// it would restart playback
			return;
		}
		setPlayerSource(player, playbackSource);
	}, [playbackSource, player]);

	// When leaving the watch screen, unload the player unless it is casting (the
	// mini-player then keeps driving the receiver).
	const unloadUnlessCasting = useEffectEvent(() => {
		const isCasting = castStatus === "connected" || castStatus === "connecting";
		if (!isCasting) setPlayerSource(player, undefined);
	});
	useEffect(() => {
		return () => unloadUnlessCasting();
	}, []);

	// The mini-player cannot stop a cast on its own (the media tech only lives
	// on this screen), so it navigates here with `?stopCast`. Once the tech is
	// live again (cast reconnected), tear the cast down and clear the flag.
	const [stopCast, setStopCast] = useQueryState<string | undefined>(
		"stopCast",
		undefined,
	);
	useEffect(() => {
		if (!stopCast || castStatus !== "connected") return;
		player.toggleCastStatus();
		setStopCast(undefined);
	}, [stopCast, castStatus, player, setStopCast]);

	const router = useRouter();
	const { t } = useTranslation();
	const isFocused = useIsFocused();

	const onEnd = () => {
		if (data?.next) {
			player.playNext();
			return;
		}
		setPlayerSource(player, undefined);
		if (data?.show?.href) router.replace(data.show.href);
	};

	useProgressObserver(
		data && entry
			? { videoId: data.id, entryId: entry.id, kind: entry.kind }
			: null,
	);

	useEvent("end", onEnd);
	useEvent("prev", () => {
		if (!isFocused || !data?.previous) return;
		if (!data.previous.video) {
			setPlaybackError({
				status: "not-available",
				message: t("player.not-available", {
					entry: `${entryDisplayNumber(data.previous.entry)} ${data.previous.entry.name}`,
				}),
			});
			return;
		}
		setPlaybackError(undefined);
		setStart("0");
		setSlug(data.previous.video);
	});
	useEvent("next", () => {
		if (!isFocused || !data?.next) return;
		if (!data.next.video) {
			setPlaybackError({
				status: "not-available",
				message: t("player.not-available", {
					entry: `${entryDisplayNumber(data.next.entry)} ${data.next.entry.name}`,
				}),
			});
			return;
		}
		setPlaybackError(undefined);
		setStart("0");
		setSlug(data.next.video);
	});

	const remote =
		Platform.OS !== "web" &&
		(castStatus === "connected" || castStatus === "connecting");

	const recoveryPopup = getRecoveryPopupProps(recovery, t, manualRetry);
	const hasError = !!playbackError || !!recoveryPopup;

	return (
		<View ref={viewRef} className="flex-1 bg-black">
			<Head
				title={title}
				description={entry?.description}
				image={images?.thumbnail?.high}
			/>
			<Stack.Screen
				options={{
					headerShown: false,
					navigationBarHidden: !remote,
					statusBarHidden: !remote,
					orientation: remote ? "default" : "landscape",
					contentStyle: { paddingLeft: 0, paddingRight: 0 },
				}}
			/>
			{remote ? (
				<Remote
					showHref={data?.show?.href}
					name={data?.show?.name ?? data?.path}
					poster={data ? (images?.poster ?? null) : undefined}
					subName={
						entry
							? [entryDisplayNumber(entry), entry.name]
									.filter((x) => x)
									.join(" - ")
							: data?.path
					}
					chapters={info?.chapters ?? []}
					hasPrev={!!data?.previous}
					hasNext={!!data?.next}
					seekEnd={onEnd}
				/>
			) : (
				<PlayModeContext.Provider value={playModeState}>
					<PlayerContent
						data={data}
						info={info}
						entry={entry}
						playMode={playMode}
						setPlayMode={playModeState[1]}
						setStart={setStart}
						playbackSource={playbackSource}
						techKey={recovery.restart?.key ?? 0}
						hasError={hasError}
						onPlaybackError={(type, message) => {
							// Remote web recovery handles every playback error
							// and shows generic copy. Reach this fallback only
							// where recovery is disabled (local, native, cast),
							// so keep the sanitized message there.
							const result = handleBrowserPlaybackError(type, message);
							if (result.handled) {
								setPlaybackError(undefined);
							} else {
								setPlaybackError({
									status: type,
									message: sanitizeErrorText(message),
								});
							}
						}}
						seekEnd={onEnd}
					/>
				</PlayModeContext.Provider>
			)}
			{playbackError ? (
				<ErrorPopup
					message={playbackError.message}
					dismiss={() => setPlaybackError(undefined)}
				/>
			) : (
				recoveryPopup && (
					<ErrorPopup
						title={recoveryPopup.title}
						message={recoveryPopup.message}
						onRetry={recoveryPopup.onRetry}
						dismiss={dismissRecovery}
					/>
				)
			)}
		</View>
	);
};

const getRecoveryPopupProps = (
	recovery: RecoverySnapshot,
	t: ReturnType<typeof useTranslation>["t"],
	manualRetry: () => void,
): { title: string; message: string; onRetry?: () => void } | null => {
	switch (recovery.phase) {
		case "idle":
			return null;
		case "scheduled":
			return {
				title: t("player.recovery.retryingTitle"),
				message: t("player.recovery.retrying"),
				onRetry: manualRetry,
			};
		case "offline":
			return {
				title: t("player.recovery.offlineTitle"),
				message: t("player.recovery.offline"),
				onRetry: manualRetry,
			};
		case "exhausted":
			return {
				title: t("player.fatal"),
				message: t("player.recovery.exhausted"),
				onRetry: manualRetry,
			};
		case "unknown":
			return {
				title: t("player.recovery.unknownTitle"),
				message: t("player.recovery.unknown"),
				onRetry: manualRetry,
			};
		case "unrecoverable": {
			const message =
				recovery.reason === "auth"
					? t("player.recovery.unsupportedAuth")
					: recovery.reason === "not-found"
						? t("player.recovery.unsupportedNotFound")
						: recovery.reason === "decode"
							? t("player.recovery.unsupportedDecode")
							: t("player.recovery.unsupported");
			return {
				title: t("player.fatal"),
				message,
			};
		}
	}
};

const PlayerContent = ({
	data,
	info,
	entry,
	playMode,
	setPlayMode,
	setStart,
	playbackSource,
	techKey,
	hasError,
	onPlaybackError,
	seekEnd,
}: {
	data?: Video;
	info?: VideoInfo;
	entry?: Entry;
	playMode: PlayMode;
	setPlayMode: (mode: PlayMode) => void;
	setStart: (start: string | undefined) => void;
	playbackSource?: Source;
	techKey: number;
	hasError: boolean;
	onPlaybackError: (type: string, message: string) => void;
	seekEnd: () => void;
}) => {
	const [entriesMenuOpen, setEntriesMenuOpen] = useState(false);
	const [preferOriginal] = useSetting("preferOriginal", "non-logo");
	const images = data?.show ? showImages(data.show, preferOriginal) : null;

	useKeyboard();

	useEffect(() => {
		if (Platform.OS !== "web") return;
		if (/Mobi/i.test(window.navigator.userAgent)) toggleFullscreen(true);
		return () => {
			if (!document.location.href.includes("/watch")) toggleFullscreen(false);
		};
	}, []);

	const appliedSource = usePlayerState("source");
	// OmniView builds the HLS engine (including startPosition) from the
	// provider's source. Unmount the old tech and wait for the new source
	// before mounting, so a retry cannot request media at the old time first.
	const mediaReady =
		Platform.OS !== "web" ||
		(!!playbackSource &&
			appliedSource?.src.uri === playbackSource.src.uri &&
			appliedSource.src.mimeType === playbackSource.src.mimeType &&
			Object.is(appliedSource.startTime, playbackSource.startTime));

	useEvent("error", (type: string, message: string) => {
		if (!mediaReady) return;
		if (type === "source/unsupported-content-type" && playMode === "direct")
			setPlayMode("hls");
		else onPlaybackError(type, message);
	});

	return (
		<>
			{mediaReady && (
				<OmniView
					key={techKey}
					autoplay
					autoPip
					style={StyleSheet.absoluteFill}
					subtitleAssets={{
						jassub: {
							workerUrl: "/jassub/jassub-worker.js",
							wasmUrl: "/jassub/jassub-worker.wasm",
							modernWasmUrl: "/jassub/jassub-worker-modern.wasm",
							fontUrl: "/jassub/default.woff2",
						},
						pgs: { workerUrl: "/libpgs/libpgs.worker.js" },
					}}
				/>
			)}
			<CastingScreen name={data?.show?.name ?? data?.path} />
			<LoadingIndicator />
			<Controls
				showHref={data?.show?.href}
				name={data?.show?.name ?? data?.path}
				poster={data ? (images?.poster ?? null) : undefined}
				showKind={data?.show?.kind}
				showLogo={images?.logo ?? null}
				subName={
					entry
						? [entryDisplayNumber(entry), entry.name]
								.filter((x) => x)
								.join(" - ")
						: data?.path
				}
				chapters={info?.chapters ?? []}
				hasPrev={!!data?.previous}
				hasNext={!!data?.next}
				seekEnd={seekEnd}
				onOpenEntriesMenu={
					data?.show?.kind === "serie"
						? () => setEntriesMenuOpen(true)
						: undefined
				}
				forceShow={hasError || entriesMenuOpen}
			/>
			{data?.show?.kind === "serie" && (
				<EntriesMenu
					isOpen={entriesMenuOpen}
					onClose={() => setEntriesMenuOpen(false)}
					showSlug={data.show.slug}
					season={entry?.kind === "episode" ? entry.seasonNumber : 0}
					currentEntrySlug={entry?.slug}
					setStart={setStart}
				/>
			)}
		</>
	);
};

Player.query = (slug: string): QueryIdentifier<Video> => ({
	path: ["api", "videos", slug],
	params: {
		with: ["next", "previous", "show"],
	},
	schema: Video,
});
