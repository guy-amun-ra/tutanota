import { AdSyncEventListener } from "./AdSyncEventListener.js"
import { ImapSyncSession } from "./ImapSyncSession.js"
import { ImapSyncState } from "./ImapSyncState.js"

const defaultAdSyncConfig: AdSyncConfig = {
	isEnableParallelProcessesOptimizer: true,
	isEnableDownloadBlockSizeOptimizer: true,
	parallelProcessesOptimizationDifference: 2,
	downloadBlockSizeOptimizationDifference: 100,
	isEnableImapQresync: true,
	isEnableAttachmentDeduplication: true,
}

export interface AdSyncConfig {
	isEnableParallelProcessesOptimizer: boolean
	isEnableDownloadBlockSizeOptimizer: boolean
	parallelProcessesOptimizationDifference: number
	downloadBlockSizeOptimizationDifference: number
	isEnableImapQresync: boolean
	isEnableAttachmentDeduplication: boolean
}

export class ImapAdSync {
	private syncSession: ImapSyncSession

	constructor(adSyncEventListener: AdSyncEventListener, adSyncConfig: AdSyncConfig = defaultAdSyncConfig) {
		this.syncSession = new ImapSyncSession(adSyncEventListener, adSyncConfig)
	}

	async startAdSync(imapSyncState: ImapSyncState): Promise<void> {
		return this.syncSession.startSyncSession(imapSyncState)
	}

	async stopAdSync(): Promise<void> {
		return this.syncSession.stopSyncSession()
	}
}
