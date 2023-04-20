import { ImapSyncSessionMailbox, SyncSessionMailboxImportance } from "./ImapSyncSessionMailbox.js"
import { ImapMailboxState, ImapSyncState } from "./ImapSyncState.js"
import { AdSyncEventListener, AdSyncEventType } from "./AdSyncEventListener.js"
import { AdSyncParallelProcessesOptimizer } from "./optimizer/processesoptimizer/AdSyncParallelProcessesOptimizer.js"
import { ImapSyncSessionProcess, SyncSessionProcessState } from "./ImapSyncSessionProcess.js"
import { AdSyncDownloadBlockSizeOptimizer } from "./optimizer/AdSyncDownloadBlockSizeOptimizer.js"
import { ProgrammingError } from "../../../api/common/error/ProgrammingError.js"
import { ImapFlow } from "imapflow"
import { ImapMailbox } from "./imapmail/ImapMailbox.js"
import { AdSyncConfig } from "./ImapAdSync.js"
import { AdSyncSingleProcessesOptimizer } from "./optimizer/processesoptimizer/AdSyncSingleProcessesOptimizer.js"
import { AdSyncProcessesOptimizer } from "./optimizer/processesoptimizer/AdSyncProcessesOptimizer.js"

const DOWNLOADED_QUOTA_SAFETY_THRESHOLD: number = 50000000 // in byte
const DEFAULT_POSTPONE_TIME: number = 24 * 60 * 60 * 1000 // 24 hours

export enum SyncSessionState {
	RUNNING,
	PAUSED,
	POSTPONED,
	FINISHED
}

export interface SyncSessionEventListener {
	onStartSyncSessionProcess(processId: number, syncSessionMailbox: ImapSyncSessionMailbox): void

	onStopSyncSessionProcess(processId: number): void

	onDownloadQuotaUpdate(downloadedQuota: number): void

	onAllMailboxesFinish(): Promise<void>
}

export class ImapSyncSession implements SyncSessionEventListener {
	private adSyncEventListener: AdSyncEventListener
	private adSyncConfig: AdSyncConfig
	private state: SyncSessionState
	private imapSyncState?: ImapSyncState
	private adSyncOptimizer?: AdSyncProcessesOptimizer
	private runningSyncSessionProcesses: Map<number, ImapSyncSessionProcess> = new Map()
	private downloadedQuota: number = 0

	constructor(adSyncEventListener: AdSyncEventListener, adSyncConfig: AdSyncConfig) {
		this.adSyncEventListener = adSyncEventListener
		this.adSyncConfig = adSyncConfig
		this.state = SyncSessionState.PAUSED
	}

	async startSyncSession(imapSyncState: ImapSyncState): Promise<void> {
		this.imapSyncState = imapSyncState
		this.state = SyncSessionState.RUNNING

		this.runSyncSession()
		return
	}

	async stopSyncSession(): Promise<void> {
		await this.shutDownSyncSession(false)
		return
	}

	private async shutDownSyncSession(isPostpone: boolean) {
		this.state = SyncSessionState.PAUSED

		this.adSyncOptimizer?.stopAdSyncOptimizer()
		this.runningSyncSessionProcesses.forEach((syncSessionProcess) => {
			syncSessionProcess.stopSyncSessionProcess()
		})
		this.runningSyncSessionProcesses.clear()

		if (isPostpone) {
			this.state = SyncSessionState.POSTPONED
			this.adSyncEventListener.onPostpone(new Date(Date.now() + DEFAULT_POSTPONE_TIME))
		}
	}

	private async runSyncSession() {
		let mailboxes = await this.setupSyncSession()

		if (this.adSyncConfig.isEnableParallelProcessesOptimizer) {
			this.adSyncOptimizer = new AdSyncParallelProcessesOptimizer(mailboxes, this.adSyncConfig.parallelProcessesOptimizationDifference, this)
		} else {
			// start AdSyncSingleProcessesOptimizer with optimizationDifference of zero (0) (always open only a single mailbox (i.e. folder) at a time)
			this.adSyncOptimizer = new AdSyncSingleProcessesOptimizer(mailboxes, this)
		}
		this.adSyncOptimizer.startAdSyncOptimizer()
	}

	private async setupSyncSession(): Promise<ImapSyncSessionMailbox[]> {
		if (!this.imapSyncState) {
			throw new ProgrammingError("The ImapSyncState has not been set!")
		}

		let knownMailboxes = this.imapSyncState.mailboxStates.map(mailboxState => {
			return new ImapSyncSessionMailbox(mailboxState)
		})

		let imapAccount = this.imapSyncState.imapAccount
		const imapClient = new ImapFlow({
			host: imapAccount.host,
			port: imapAccount.port,
			secure: true,
			tls: {
				rejectUnauthorized: false, // TODO deactivate after testing
			},
			auth: {
				user: imapAccount.username,
				pass: imapAccount.password,
				accessToken: imapAccount.accessToken
			},
			// @ts-ignore // TODO add type definitions
			qresync: this.adSyncConfig.isEnableImapQresync,
		})

		await imapClient.connect()
		let listTreeResponse = await imapClient.listTree()
		await imapClient.logout()

		let fetchedRootMailboxes = listTreeResponse.folders.map(listTreeResponse => {
			return ImapMailbox.fromImapFlowListTreeResponse(listTreeResponse, null)
		})

		return this.getSyncSessionMailboxes(knownMailboxes, fetchedRootMailboxes)
	}

	private getSyncSessionMailboxes(knownMailboxes: ImapSyncSessionMailbox[], fetchedRootMailboxes: ImapMailbox[]): ImapSyncSessionMailbox[] {
		let resultMailboxes: ImapSyncSessionMailbox[] = []
		fetchedRootMailboxes.forEach(fetchedRootMailbox => {
			resultMailboxes.push(...this.traverseImapMailboxes(knownMailboxes, fetchedRootMailbox))
		})

		knownMailboxes.map(knownMailbox => {
			let index = resultMailboxes.findIndex(mailbox => {
				return mailbox.mailboxState.path == knownMailbox.mailboxState.path
			})

			if (index == -1) {
				let deletedImapMailbox = ImapMailbox.fromSyncSessionMailbox(knownMailbox)
				this.adSyncEventListener.onMailbox(deletedImapMailbox, AdSyncEventType.DELETE)
				return true
			}

			return false
		})

		return resultMailboxes
	}

	private traverseImapMailboxes(knownMailboxes: ImapSyncSessionMailbox[], imapMailbox: ImapMailbox): ImapSyncSessionMailbox[] {
		let result = []

		let syncSessionMailbox = knownMailboxes.find(value => value.mailboxState.path == imapMailbox.path)
		if (syncSessionMailbox === undefined) {
			this.adSyncEventListener.onMailbox(imapMailbox, AdSyncEventType.CREATE)
			syncSessionMailbox = new ImapSyncSessionMailbox(ImapMailboxState.fromImapMailbox(imapMailbox))
		}

		if (imapMailbox.specialUse) {
			syncSessionMailbox.specialUse = imapMailbox.specialUse
		}

		// some settings lead to importance "NO_SYNC" which means that the mailbox should not be imported / migrated
		if (syncSessionMailbox.importance != SyncSessionMailboxImportance.NO_SYNC) {
			result.push(syncSessionMailbox)
		}

		imapMailbox.subFolders?.forEach(imapMailbox => {
			result.push(...this.traverseImapMailboxes(knownMailboxes, imapMailbox))
		})
		return result
	}

	onStartSyncSessionProcess(processId: number, nextMailboxToDownload: ImapSyncSessionMailbox): void {
		if (this.state == SyncSessionState.RUNNING) {
			console.log("onStartSyncSessionProcess : processId: " + processId + " -> " + nextMailboxToDownload.mailboxState.path)

			if (!this.adSyncOptimizer) {
				throw new ProgrammingError("The SyncSessionEventListener should be exclusively used by the AdSyncEfficiencyScoreOptimizer!")
			}

			if (!this.imapSyncState) {
				throw new ProgrammingError("The ImapSyncState has not been set!")
			}

			let adSyncDownloadBlockSizeOptimizer = new AdSyncDownloadBlockSizeOptimizer(nextMailboxToDownload, this.adSyncConfig.downloadBlockSizeOptimizationDifference)
			let syncSessionProcess = new ImapSyncSessionProcess(processId, adSyncDownloadBlockSizeOptimizer, this.adSyncOptimizer, this.adSyncConfig)

			this.runningSyncSessionProcesses.set(syncSessionProcess.processId, syncSessionProcess)
			syncSessionProcess.startSyncSessionProcess(this.imapSyncState.imapAccount, this.adSyncEventListener).then((state) => {
				if (state == SyncSessionProcessState.CONNECTION_FAILED) { // TODO we may have exceeded a rate limit on the number of parallel connections
					this.adSyncOptimizer?.forceStopSyncSessionProcess(processId)
				} else {
					if (this.adSyncConfig.isEnableDownloadBlockSizeOptimizer) {
						adSyncDownloadBlockSizeOptimizer.startAdSyncOptimizer()
					}
				}
			})
		}
	}

	onStopSyncSessionProcess(nextProcessIdToDrop: number): void {
		console.log("onStopSyncSessionProcess : processId: " + nextProcessIdToDrop)

		let syncSessionProcessToDrop = this.runningSyncSessionProcesses.get(nextProcessIdToDrop)

		syncSessionProcessToDrop?.stopSyncSessionProcess()
		this.runningSyncSessionProcesses.delete(nextProcessIdToDrop)
	}

	onDownloadQuotaUpdate(downloadedQuota: number): void {
		this.downloadedQuota += downloadedQuota

		if (!this.imapSyncState) {
			throw new ProgrammingError("The ImapSyncState has not been set!")
		}

		if (this.downloadedQuota > this.imapSyncState.maxQuota - DOWNLOADED_QUOTA_SAFETY_THRESHOLD) {
			this.shutDownSyncSession(true)
		}
	}

	async onAllMailboxesFinish(): Promise<void> {
		console.log("onAllMailboxesFinish")
		if (this.state != SyncSessionState.FINISHED) {
			this.state = SyncSessionState.FINISHED
			await this.shutDownSyncSession(false)
			this.adSyncEventListener.onFinish(this.downloadedQuota)
		}
	}
}
