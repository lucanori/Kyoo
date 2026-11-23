import {
	type ComponentRef,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { View } from "react-native";
import {
	MAX_AUTO_RETRIES,
	PlaybackRecoveryManager,
	type RecoverySnapshot,
} from "./recovery";

const INITIAL_SNAPSHOT: RecoverySnapshot = {
	sourceKey: "",
	phase: "idle",
	reason: null,
	attempts: 0,
	maxAttempts: MAX_AUTO_RETRIES,
	canManualRetry: false,
	resumeTime: null,
	restart: null,
};

export const useBrowserPlaybackRecovery = ({
	enabled,
	sourceKey,
	viewRef,
}: {
	enabled: boolean;
	sourceKey: string;
	viewRef: RefObject<ComponentRef<typeof View> | null>;
}) => {
	const [snapshot, setSnapshot] = useState<RecoverySnapshot>(INITIAL_SNAPSHOT);
	const managerRef = useRef<PlaybackRecoveryManager | null>(null);

	useLayoutEffect(() => {
		const manager = new PlaybackRecoveryManager({ onStateChange: setSnapshot });
		managerRef.current = manager;
		return () => {
			manager.dispose();
			managerRef.current = null;
		};
	}, []);

	useLayoutEffect(() => {
		managerRef.current?.setContext({ enabled, sourceKey });
	}, [enabled, sourceKey]);

	useEffect(() => {
		if (!enabled || typeof window === "undefined") {
			return;
		}
		const onOnline = () => managerRef.current?.handleOnline();
		const onOffline = () => managerRef.current?.handleOffline();
		window.addEventListener("online", onOnline);
		window.addEventListener("offline", onOffline);
		return () => {
			window.removeEventListener("online", onOnline);
			window.removeEventListener("offline", onOffline);
		};
	}, [enabled]);

	useEffect(() => {
		if (!enabled || !(viewRef.current instanceof HTMLElement)) return;
		const view = viewRef.current;
		// Read the attached video, not Omni's store (which can still report
		// the old tech's time or the new source's synthetic startTime).
		const onTime = (event: Event) => {
			const video = event.target;
			if (!(video instanceof HTMLVideoElement)) return;
			const ready =
				video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
				!video.error &&
				!video.seeking;
			managerRef.current?.reportProgress({
				currentTime: video.currentTime,
				isPlaying: event.type === "timeupdate" && !video.paused && !video.ended,
				status: ready ? "readyToPlay" : "loading",
			});
		};
		view.addEventListener("timeupdate", onTime, true);
		view.addEventListener("seeked", onTime, true);
		return () => {
			view.removeEventListener("timeupdate", onTime, true);
			view.removeEventListener("seeked", onTime, true);
		};
	}, [enabled, viewRef]);

	const handleError = useCallback(
		(type: string, message: string): { handled: boolean } => {
			if (!enabled || !managerRef.current) return { handled: false };
			return managerRef.current.handleError(type, message);
		},
		[enabled],
	);

	const manualRetry = useCallback(() => {
		managerRef.current?.manualRetry();
	}, []);

	const dismiss = useCallback(() => {
		managerRef.current?.dismiss();
	}, []);

	return {
		recovery: snapshot.sourceKey === sourceKey ? snapshot : INITIAL_SNAPSHOT,
		handleError,
		manualRetry,
		dismiss,
	};
};
