import { type ErrorBoundaryProps, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import {
	classifyError,
	createRetryCoordinator,
	type ErrorCategory,
	getErrorRetry,
	isTransientOutageError,
	type RetryCoordinator,
} from "~/data/error-utils";
import { Button, H1, P } from "~/primitives";
import "../global.css";
import "~/fonts.web.css";
import { Header, SafeAreaProviderCompat } from "expo-router/react-navigation";
import { useCSSVariable } from "uniwind";
import { canDownload } from "~/ui/download";
import { NavbarProfile, NavbarTitle } from "~/ui/navbar";

export function LayoutErrorBoundary({ error, retry }: ErrorBoundaryProps) {
	const accent = useCSSVariable("--color-accent");

	return (
		<SafeAreaProviderCompat>
			<View className="flex-1">
				<Header
					title="Kyoo"
					headerTitle={() => <NavbarTitle />}
					headerRight={() => <NavbarProfile />}
					headerStyle={{ backgroundColor: accent as string }}
				/>
				<ErrorView error={error} retry={retry} />
			</View>
		</SafeAreaProviderCompat>
	);
}

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
	return <ErrorView error={error} retry={retry} />;
}

const ERROR_COPY: Record<
	ErrorCategory,
	{ title: string; description?: string }
> = {
	offline: {
		title: "errors.offline-title",
		description: "errors.offline",
	},
	connection: {
		title: "errors.connection",
		description: "errors.connection-description",
	},
	temporary: {
		title: "errors.temporary",
		description: "errors.temporary-description",
	},
	"rate-limited": {
		title: "errors.rate-limited",
		description: "errors.rate-limited-description",
	},
	"session-expired": {
		title: "errors.session-expired",
		description: "errors.session-expired-description",
	},
	needAccount: {
		title: "errors.forbidden",
		description: "errors.needAccount",
	},
	forbidden: {
		title: "errors.forbidden",
		description: "errors.forbidden-description",
	},
	"need-verification": {
		title: "errors.needVerification",
	},
	"invalid-server": {
		title: "errors.invalid-server",
	},
	"not-found": {
		title: "errors.not-found",
		description: "errors.not-found-description",
	},
	"invalid-response": {
		title: "errors.invalid-response",
		description: "errors.invalid-response-description",
	},
	unknown: {
		title: "errors.unknown",
		description: "errors.unknown-description",
	},
};

function ErrorView({ error, retry }: ErrorBoundaryProps) {
	const { t } = useTranslation();
	const router = useRouter();
	const category = classifyError(error);
	const copy = ERROR_COPY[category];
	const isTransient = isTransientOutageError(error);
	const [isRetrying, setIsRetrying] = useState(false);
	const coordinatorRef = useRef<RetryCoordinator | null>(null);
	const autoRetriedError = useRef<Error | null>(null);

	useEffect(() => {
		// A disposed scope no longer publishes state. Start the new scope idle.
		setIsRetrying(false);
		const coordinator = createRetryCoordinator({
			beforeRetry: () => getErrorRetry(error)?.(),
			onRetry: retry,
			onStateChange: setIsRetrying,
		});
		coordinatorRef.current = coordinator;

		const onlineTarget =
			isTransient &&
			autoRetriedError.current !== error &&
			typeof window !== "undefined" &&
			typeof window.addEventListener === "function"
				? window
				: undefined;
		const handleOnline = () => {
			autoRetriedError.current = error;
			void coordinator.triggerOnlineRetry();
		};
		onlineTarget?.addEventListener("online", handleOnline, { once: true });

		return () => {
			onlineTarget?.removeEventListener("online", handleOnline);
			coordinator.dispose();
			coordinatorRef.current = null;
		};
	}, [error, isTransient, retry]);

	return (
		<View className="flex-1 items-center justify-center p-4">
			<View accessibilityRole="alert" className="items-center">
				<H1 className="mb-2 text-center text-xl">{t(copy.title as any)}</H1>
				{copy.description && (
					<P className="my-2 text-center">{t(copy.description as any)}</P>
				)}
			</View>
			<Button
				className="mt-5"
				text={t("errors.try-again")}
				disabled={isRetrying}
				onPress={() => {
					void coordinatorRef.current?.triggerManualRetry();
				}}
				hasTVPreferredFocus
			/>
			{isTransient && canDownload && (
				<Button
					className="mt-2"
					text={t("downloads.see")}
					onPress={() => router.navigate("/downloads")}
				/>
			)}
		</View>
	);
}
