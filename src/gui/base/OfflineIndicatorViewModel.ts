import {PROGRESS_DONE} from "./ProgressBar.js"
import Stream from "mithril/stream"
import {WorkerClient, WsConnectionState} from "../../api/main/WorkerClient.js"
import {ExposedCacheStorage} from "../../api/worker/rest/EntityRestCache.js"
import {ILoginListener} from "../../api/main/LoginListener.js"
import {LoginController} from "../../api/main/LoginController.js"
import {OfflineIndicatorAttrs, OfflineIndicatorState} from "./OfflineIndicator.js"

/**
 * the offline indicator must take into account information
 * from multiple different sources:
 * * ws connection state (connected, not connected) from the worker
 * * login state (logged out, partial login, full login)
 * * sync progress
 * * last sync time
 *
 * the state necessary to determine the right indicator state from
 * previous updates from these information sources
 * is maintained in this class
 */
export class OfflineIndicatorViewModel {

	private lastProgress: number = PROGRESS_DONE
	private lastWsState: WsConnectionState = WsConnectionState.connecting
	private lastUpdate: Date | null = null
	private wsWasConnectedBefore: boolean = false

	constructor(
		private readonly cacheStorage: ExposedCacheStorage,
		private readonly loginListener: ILoginListener,
		private readonly worker: WorkerClient,
		private readonly logins: LoginController,
		private readonly cb: () => void
	) {
		logins.waitForFullLogin().then(cb)
	}

	setProgressUpdateStream(progressStream: Stream<number>): void {
		progressStream.map(progress => this.onProgressUpdate(progress))
		this.onProgressUpdate(progressStream())
	}

	setWsStateStream(wsStream: Stream<WsConnectionState>): void {
		wsStream.map(state => {
			this.onWsStateChange(state)
		})
		this.onWsStateChange(wsStream()).then()
	}


	private onProgressUpdate(progress: number): void {
		this.lastProgress = progress
		this.cb()
	}

	private async onWsStateChange(newState: WsConnectionState): Promise<void> {
		this.lastWsState = newState
		if (newState !== WsConnectionState.connected) {
			await this.logins.waitForPartialLogin()
			const lastUpdate = await this.cacheStorage.getLastUpdateTime()
			this.lastUpdate = lastUpdate != null
				? new Date(lastUpdate)
				: null

		} else {
			this.wsWasConnectedBefore = true
		}
		this.cb()
	}

	getCurrentAttrs(): OfflineIndicatorAttrs {
		if (this.logins.isFullyLoggedIn() && this.wsWasConnectedBefore) {
			if (this.lastWsState === WsConnectionState.connected) {
				// normal, full login with a connected websocket
				if (this.lastProgress < PROGRESS_DONE) {
					return {state: OfflineIndicatorState.Synchronizing, progress: this.lastProgress}
				} else {
					return {state: OfflineIndicatorState.Online}
				}
			} else {
				// normal, full login with a disconnected websocket
				return {
					state: OfflineIndicatorState.Offline,
					lastUpdate: this.lastUpdate,
					reconnectAction: () => {
						console.log("try reconnect ws")
						this.worker.tryReconnectEventBus(true, true, 2000)
					}
				}
			}
		} else {
			// either not fully logged in or the websocket was not connected before
			// in cases where the indicator is visible, this is just offline login.
			if (this.loginListener.getFullLoginFailed()) {
				return {
					state: OfflineIndicatorState.Offline,
					lastUpdate: this.lastUpdate,
					reconnectAction: () => {
						console.log("try full login")
						this.logins.retryAsyncLogin().finally(() => this.cb())
					}
				}
			} else {
				// partially logged in, but the last login attempt didn't fail yet
				return {state: OfflineIndicatorState.Connecting}
			}
		}
	}

	/*
	* get the current progress for sync operations
	 */
	getProgress(): number {
		//getting the progress like this ensures that
		// the progress bar and sync percentage are consistent
		const a = this.getCurrentAttrs()
		return a.state === OfflineIndicatorState.Synchronizing
			? a.progress
			: 1
	}
}