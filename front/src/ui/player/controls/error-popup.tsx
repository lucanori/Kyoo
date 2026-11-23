import Close from "@material-symbols/svg-400/rounded/close-fill.svg";
import Refresh from "@material-symbols/svg-400/rounded/refresh-fill.svg";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button, Heading, IconButton, P } from "~/primitives";
import { cn } from "~/utils";

export const ErrorPopup = ({
	title,
	message,
	onRetry,
	retryLabel,
	dismiss,
}: {
	title?: string;
	message: string;
	onRetry?: () => void;
	retryLabel?: string;
	dismiss: () => void;
}) => {
	const { t } = useTranslation();
	return (
		<View
			accessibilityRole="alert"
			className={cn(
				"absolute inset-x-6 top-1/2 -translate-y-1/2 flex-row items-start justify-between gap-4",
				"rounded-xl border border-slate-700 bg-background p-5",
			)}
		>
			<View className="flex-1">
				<Heading className="my-2 shrink-0">
					{title ?? t("player.fatal")}
				</Heading>
				<P className="mt-2">{message}</P>
				{onRetry && (
					<View className="mt-4 flex-row">
						<Button
							icon={Refresh}
							text={retryLabel ?? t("player.recovery.retry")}
							onPress={onRetry}
						/>
					</View>
				)}
			</View>
			<IconButton
				icon={Close}
				aria-label={t("player.recovery.dismiss")}
				onPress={dismiss}
			/>
		</View>
	);
};
