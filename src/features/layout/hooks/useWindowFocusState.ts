import { useEffect, useState } from "react";

export function useWindowFocusState() {
	const [isFocused, setIsFocused] = useState(() => {
		if (typeof document === "undefined") {
			return true;
		}
		return document.hasFocus();
	});

	useEffect(() => {
		let unlistenFocus: (() => void) | null = null;
		let unlistenBlur: (() => void) | null = null;

		const handleFocus = () => setIsFocused(true);
		const handleBlur = () => setIsFocused(false);
		const handleVisibility = () => {
			if (document.visibilityState === "visible") {
				handleFocus();
			} else {
				handleBlur();
			}
		};

		void import("@tauri-apps/api/window")
			.then(({ getCurrentWindow }) => {
				const windowHandle = getCurrentWindow();
				return Promise.allSettled([
					windowHandle.listen("tauri://focus", handleFocus),
					windowHandle.listen("tauri://blur", handleBlur),
				]);
			})
			.then((results) => {
				const focusResult = results?.[0];
				if (focusResult?.status === "fulfilled") {
					unlistenFocus = focusResult.value;
				}
				const blurResult = results?.[1];
				if (blurResult?.status === "fulfilled") {
					unlistenBlur = blurResult.value;
				}
			})
			.catch(() => {
				// In non-Tauri environments, the DOM listeners below still provide focus state.
			});

		window.addEventListener("focus", handleFocus);
		window.addEventListener("blur", handleBlur);
		document.addEventListener("visibilitychange", handleVisibility);

		return () => {
			if (unlistenFocus) {
				unlistenFocus();
			}
			if (unlistenBlur) {
				unlistenBlur();
			}
			window.removeEventListener("focus", handleFocus);
			window.removeEventListener("blur", handleBlur);
			document.removeEventListener("visibilitychange", handleVisibility);
		};
	}, []);

	return isFocused;
}
