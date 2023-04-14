import { ImapSyncSessionMailbox } from "./ImapSyncSessionMailbox.js"
import { AdSyncEventListener, AdSyncEventType } from "./AdSyncEventListener.js"
import { ImapAccount, ImapMailboxStateImportedIds } from "./ImapSyncState.js"
import { ImapMail } from "./imapmail/ImapMail.js"
// @ts-ignore // TODO define types
import { AdSyncDownloadBlockSizeOptimizer } from "./optimizer/AdSyncDownloadBlockSizeOptimizer.js"
import { ImapError } from "./imapmail/ImapError.js"
import { ImapMailbox, ImapMailboxStatus } from "./imapmail/ImapMailbox.js"
import { FetchUidRange } from "./utils/FetchUidRange.js"
import { AdSyncConfig } from "./ImapAdSync.js"
import { AdSyncProcessesOptimizerEventListener } from "./optimizer/processesoptimizer/AdSyncProcessesOptimizer.js"

const { ImapFlow } = require("imapflow")

export enum SyncSessionProcessState {
	NOT_STARTED,
	STOPPED,
	RUNNING,
	CONNECTION_FAILED,
}

export class ImapSyncSessionProcess {
	processId: number

	private state: SyncSessionProcessState = SyncSessionProcessState.NOT_STARTED
	private adSyncOptimizer: AdSyncDownloadBlockSizeOptimizer
	private adSyncProcessesOptimizerEventListener: AdSyncProcessesOptimizerEventListener
	private adSyncConfig: AdSyncConfig

	constructor(
		processId: number,
		adSyncOptimizer: AdSyncDownloadBlockSizeOptimizer,
		adSyncProcessesOptimizerEventListener: AdSyncProcessesOptimizerEventListener,
		adSyncConfig: AdSyncConfig,
	) {
		this.processId = processId
		this.adSyncOptimizer = adSyncOptimizer
		this.adSyncProcessesOptimizerEventListener = adSyncProcessesOptimizerEventListener
		this.adSyncConfig = adSyncConfig
	}

	async startSyncSessionProcess(imapAccount: ImapAccount, adSyncEventListener: AdSyncEventListener): Promise<SyncSessionProcessState> {
		const imapClient = new ImapFlow({
			host: imapAccount.host,
			port: imapAccount.port,
			secure: true,
			tls: {
				rejectUnauthorized: false, // TODO deactivate after testing
			},
			logger: false,
			auth: {
				user: imapAccount.username,
				pass: imapAccount.password,
				accessToken: imapAccount.accessToken,
			},
			// @ts-ignore
			qresync: this.adSyncConfig.isEnableImapQresync, // TODO add type definitions
		})

		try {
			await imapClient.connect()
			if (this.state == SyncSessionProcessState.NOT_STARTED) {
				this.runSyncSessionProcess(imapClient, adSyncEventListener)
				this.state = SyncSessionProcessState.RUNNING
			}
		} catch (error) {
			this.state = SyncSessionProcessState.CONNECTION_FAILED
		}
		return this.state
	}

	async stopSyncSessionProcess(): Promise<ImapSyncSessionMailbox> {
		this.state = SyncSessionProcessState.STOPPED
		this.adSyncOptimizer.stopAdSyncOptimizer()
		return this.adSyncOptimizer.optimizedSyncSessionMailbox
	}

	private async runSyncSessionProcess(imapClient: typeof ImapFlow, adSyncEventListener: AdSyncEventListener) {
		async function releaseLockAndLogout() {
			lock.release()
			await imapClient.logout()
		}

		let status = await imapClient.status(this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.path, {
			messages: true,
			uidNext: true,
			uidValidity: true,
			highestModseq: true,
		})

		let imapMailboxStatus = ImapMailboxStatus.fromImapFlowStatusObject(status)
		this.updateMailboxState(imapMailboxStatus)

		this.adSyncOptimizer.optimizedSyncSessionMailbox.initSessionMailbox(imapMailboxStatus.messageCount)
		adSyncEventListener.onMailboxStatus(imapMailboxStatus)

		let lock = await imapClient.getMailboxLock(this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.path, { readonly: true })

		try {
			let fetchUidRange = await this.initFetchUidRange(imapClient, this.adSyncConfig.isEnableImapQresync)

			let fetchOptions = {}
			if (this.adSyncConfig.isEnableImapQresync) {
				let importedModSequences = [...this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToIdsMap.values()].map((value) =>
					value.modSeq ? value.modSeq : 0,
				)
				let highestModSeq = Math.max(...importedModSequences)
				fetchOptions = {
					uid: true,
					changedSince: highestModSeq,
				}
			} else {
				fetchOptions = {
					uid: true,
				}
			}

			while (fetchUidRange.fromUid && fetchUidRange.toUid) {
				this.adSyncOptimizer.optimizedSyncSessionMailbox.reportDownloadBlockSizeUsage(fetchUidRange.currentDownloadBlockSize)

				let mailFetchStartTime = Date.now()
				let mails = imapClient.fetch(
					`${fetchUidRange.fromUid}:${fetchUidRange.toUid}`,
					{
						uid: true,
						source: true,
						labels: true,
						size: true,
						flags: true,
						internalDate: true,
						headers: true,
					},
					fetchOptions,
				)

				for await (const mail of mails) {
					if (this.state == SyncSessionProcessState.STOPPED) {
						await releaseLockAndLogout()
						return
					}

					let mailFetchEndTime = Date.now()
					let mailFetchTime = mailFetchEndTime - mailFetchStartTime

					//TODO Check why mail source is not always available
					if (mail.source) {
						let mailSize = mail.source.length
						let mailDownloadTime = mailFetchTime != 0 ? mailFetchTime : 1 // we approximate the mailFetchTime to minimum 1 millisecond
						let currenThroughput = mailSize / mailDownloadTime
						this.adSyncOptimizer.optimizedSyncSessionMailbox.reportCurrentThroughput(currenThroughput)

						this.adSyncProcessesOptimizerEventListener.onDownloadUpdate(this.processId, this.adSyncOptimizer.optimizedSyncSessionMailbox, mailSize)
					} else {
						adSyncEventListener.onError(new ImapError(mail))
					}

					let imapMail = await ImapMail.fromImapFlowFetchMessageObject(
						mail,
						ImapMailbox.fromSyncSessionMailbox(this.adSyncOptimizer.optimizedSyncSessionMailbox),
					)

					// TODO What happens if only flags updated but IMAP server does not support QRESYNC?
					// TODO Check if email is already downloaded before downloading the actual data
					let isMailUpdate = this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToIdsMap.has(imapMail.uid)
					if (isMailUpdate) {
						adSyncEventListener.onMail(imapMail, AdSyncEventType.UPDATE)
					} else {
						this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToIdsMap.set(
							imapMail.uid,
							new ImapMailboxStateImportedIds(imapMail.uid),
						)
						adSyncEventListener.onMail(imapMail, AdSyncEventType.CREATE)
					}
				}

				await fetchUidRange.continueFetchUidRange(this.adSyncOptimizer.optimizedSyncSessionMailbox.downloadBlockSize)
			}
		} catch (error: any) {
			adSyncEventListener.onError(new ImapError(error))
		} finally {
			await releaseLockAndLogout()
			this.adSyncProcessesOptimizerEventListener.onMailboxFinish(this.processId, this.adSyncOptimizer.optimizedSyncSessionMailbox)
		}
	}

	private async initFetchUidRange(imapClient: typeof ImapFlow, isEnableImapQresync: boolean) {
		let fetchUidRange = new FetchUidRange(imapClient, isEnableImapQresync ? null : this.adSyncOptimizer.optimizedSyncSessionMailbox.mailCount)
		let lastFetchedUid = Math.max(...this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState.importedUidToIdsMap.keys())
		let isInitialSeqFetch = isNaN(lastFetchedUid) || lastFetchedUid < 0 // TODO is < 0 sufficient?

		await fetchUidRange.initFetchUidRange(
			isInitialSeqFetch ? 1 : lastFetchedUid,
			this.adSyncOptimizer.optimizedSyncSessionMailbox.downloadBlockSize,
			!isInitialSeqFetch,
		)
		return fetchUidRange
	}

	private updateMailboxState(imapMailboxStatus: ImapMailboxStatus) {
		let mailboxState = this.adSyncOptimizer.optimizedSyncSessionMailbox.mailboxState
		mailboxState.uidValidity = imapMailboxStatus.uidValidity
		mailboxState.uidNext = imapMailboxStatus.uidNext
		mailboxState.highestModSeq = imapMailboxStatus.highestModSeq
	}
}
