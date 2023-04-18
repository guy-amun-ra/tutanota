import { AdSyncEventType } from "../../../desktop/imapimport/adsync/AdSyncEventListener"
import { ImportImapAccountSyncState, ImportImapAttachmentHashToIdTypeRef, ImportImapFolderSyncState, MailFolder } from "../../entities/tutanota/TypeRefs.js"
import { ImportImapFacade } from "../facades/lazy/ImportImapFacade.js"
import { ImportMailFacade } from "../facades/lazy/ImportMailFacade.js"
import { ImapImportState, ImportState } from "./ImapImportState.js"
import { getFolderSyncStateForMailboxPath, imapMailToImportMailParams, importImapAccountToImapAccount } from "./ImapImportUtils.js"
import { ImapMailboxState, ImapMailIds, ImapSyncState } from "../../../desktop/imapimport/adsync/ImapSyncState.js"
import { ImapMailbox, ImapMailboxStatus } from "../../../desktop/imapimport/adsync/imapmail/ImapMailbox.js"
import { ProgrammingError } from "../../common/error/ProgrammingError.js"
import { ImapMail } from "../../../desktop/imapimport/adsync/imapmail/ImapMail.js"
import { ImapError } from "../../../desktop/imapimport/adsync/imapmail/ImapError.js"
import { ImapImportSystemFacade } from "../../../native/common/generatedipc/ImapImportSystemFacade.js"
import { ImapImportFacade } from "../../../native/common/generatedipc/ImapImportFacade.js"
import { EntityUpdateData, isUpdateForTypeRef } from "../../main/EventController.js"

export interface InitializeImapImportParams {
	host: string
	port: string
	username: string
	password: string | null
	accessToken: string | null
	maxQuota: string
	rootImportMailFolderName: string
}

export class ImapImporter implements ImapImportFacade {
	private imapImportState: ImapImportState = new ImapImportState(ImportState.NOT_INITIALIZED)
	private importImapAccountSyncState: ImportImapAccountSyncState | null = null
	private importImapFolderSyncStates?: ImportImapFolderSyncState[]
	private importedImapAttachmentHashToIdMap?: Map<string, IdTuple>

	// TODO remove after evaluation
	private testMailCounter = 0
	private testDownloadStartTime: Date = new Date()

	constructor(
		private readonly imapImportSystemFacade: ImapImportSystemFacade,
		private readonly importImapFacade: ImportImapFacade,
		private readonly importMailFacade: ImportMailFacade,
	) {
	}

	async initializeImport(initializeParams: InitializeImapImportParams): Promise<ImapImportState> {
		let importImapAccountSyncState = await this.loadImportImapAccountSyncState()

		if (importImapAccountSyncState == null) {
			this.importImapAccountSyncState = await this.importImapFacade.initializeImapImport(initializeParams)
		} else {
			this.importImapAccountSyncState = await this.importImapFacade.updateImapImport(initializeParams, importImapAccountSyncState)
		}

		this.imapImportState = new ImapImportState(ImportState.PAUSED)
		return this.imapImportState
	}

	async continueImport(): Promise<ImapImportState> {
		if (this.imapImportState.state == ImportState.RUNNING) {
			return this.imapImportState
		}

		this.importImapAccountSyncState = await this.loadImportImapAccountSyncState()

		if (this.importImapAccountSyncState == null) {
			this.imapImportState = new ImapImportState(ImportState.NOT_INITIALIZED)
			return this.imapImportState
		}

		let postponedUntil = this.importImapAccountSyncState?.postponedUntil
		if (postponedUntil) {
			this.imapImportState.postponedUntil = new Date(postponedUntil)
		}

		if (this.imapImportState.postponedUntil.getTime() > Date.now()) {
			this.imapImportState.state = ImportState.POSTPONED
			return this.imapImportState
		}

		let imapAccount = importImapAccountToImapAccount(this.importImapAccountSyncState.imapAccount)
		let maxQuota = parseInt(this.importImapAccountSyncState.maxQuota)
		let imapMailboxStates = await this.getAllImapMailboxStates(this.importImapAccountSyncState.imapFolderSyncStateList)
		let imapSyncState = new ImapSyncState(imapAccount, maxQuota, imapMailboxStates)

		this.importedImapAttachmentHashToIdMap = await this.getImportedImapAttachmentHashToIdMap()

		await this.imapImportSystemFacade.startImport(imapSyncState)

		// TODO remove after evaluation
		this.testMailCounter = 0
		this.testDownloadStartTime.setTime(Date.now())

		this.imapImportState = new ImapImportState(ImportState.RUNNING)
		return this.imapImportState
	}

	async pauseImport(): Promise<ImapImportState> {
		await this.imapImportSystemFacade.stopImport()
		this.imapImportState = new ImapImportState(ImportState.PAUSED)
		return this.imapImportState
	}

	async deleteImport(): Promise<boolean> {
		// TODO delete imap import
		return true
	}

	async loadRootImportFolder(): Promise<MailFolder | null> {
		if (this.importImapAccountSyncState?.rootImportMailFolder == null) {
			return Promise.resolve(null)
		}

		return this.importImapFacade.getRootImportFolder(this.importImapAccountSyncState?.rootImportMailFolder)
	}

	async loadImportImapAccountSyncState(): Promise<ImportImapAccountSyncState | null> {
		return this.importImapFacade.getImportImapAccountSyncState()
	}

	async loadAllImportImapFolderSyncStates(importImapFolderSyncStateListId: Id): Promise<ImportImapFolderSyncState[]> {
		if (this.importImapAccountSyncState == null) {
			throw new ProgrammingError("ImportImapAccountSyncState not initialized!")
		}
		return this.importImapFacade.getAllImportImapFolderSyncStates(importImapFolderSyncStateListId)
	}

	private async getAllImapMailboxStates(importImapFolderSyncStateListId: Id): Promise<ImapMailboxState[]> {
		let imapMailboxStates: ImapMailboxState[] = []
		this.importImapFolderSyncStates = await this.loadAllImportImapFolderSyncStates(importImapFolderSyncStateListId)

		for (const folderSyncState of this.importImapFolderSyncStates) {
			let importedImapUidToMailIdsMap = new Map<number, ImapMailIds>()
			let importedImapUidToMailIdMapList = await this.importImapFacade.getImportedImapUidToMailIdsMapList(folderSyncState.importedImapUidToMailIdsMap)
			importedImapUidToMailIdMapList.forEach((importImapUidToMailIds) => {
				let imapUid = parseInt(importImapUidToMailIds.imapUid)
				let importedImapMailIds = new ImapMailIds(imapUid)
				if (importImapUidToMailIds.imapModSeq != null) {
					importedImapMailIds.modSeq = parseInt(importImapUidToMailIds.imapModSeq)
				}
				importedImapMailIds.externalMailId = importImapUidToMailIds.mail

				importedImapUidToMailIdsMap.set(imapUid, importedImapMailIds)
			})

			imapMailboxStates.push(new ImapMailboxState(folderSyncState.path, importedImapUidToMailIdsMap))
		}

		return imapMailboxStates
	}

	private async getImportedImapAttachmentHashToIdMap(): Promise<Map<string, IdTuple>> {
		if (this.importImapAccountSyncState == null) {
			throw new ProgrammingError("ImportImapAccountSyncState not initialized!")
		}

		let importedImapAttachmentHashToIdMap = new Map<string, IdTuple>()
		let importedImapAttachmentHashToIdMapList = await this.importImapFacade.getImportedImapAttachmentHashToIdMapList(
			this.importImapAccountSyncState.importedImapAttachmentHashToIdMap,
		)

		importedImapAttachmentHashToIdMapList.forEach((importedImapAttachmentHashToId) => {
			let imapAttachmentHash = importedImapAttachmentHashToId.imapAttachmentHash
			let attachmentId = importedImapAttachmentHashToId.attachment
			importedImapAttachmentHashToIdMap.set(imapAttachmentHash, attachmentId)
		})

		return importedImapAttachmentHashToIdMap
	}

	async onMailbox(imapMailbox: ImapMailbox, eventType: AdSyncEventType): Promise<void> {
		console.log("onMailbox")
		console.log(imapMailbox)

		if (this.importImapAccountSyncState == null) {
			throw new ProgrammingError("onMailbox event received but importImapAccountSyncState not initialized!")
		}

		switch (eventType) {
			case AdSyncEventType.CREATE:
				let parentFolderId = this.importImapAccountSyncState.rootImportMailFolder
				if (imapMailbox.parentFolder) {
					let parentFolderSyncState = getFolderSyncStateForMailboxPath(imapMailbox.parentFolder.path, this.importImapFolderSyncStates ?? [])
					parentFolderId = parentFolderSyncState?.mailFolder ? parentFolderSyncState.mailFolder : null
				}

				//TODO Check if folder is already existing
				let newFolderSyncState = await this.importImapFacade.createImportMailFolder(imapMailbox, this.importImapAccountSyncState, parentFolderId)

				if (newFolderSyncState) {
					this.importImapFolderSyncStates?.push(newFolderSyncState)
				}
				break
			case AdSyncEventType.UPDATE:
				break
			case AdSyncEventType.DELETE:
				break
		}

		return Promise.resolve()
	}

	async onMailboxStatus(imapMailboxStatus: ImapMailboxStatus): Promise<void> {
		console.log("onMailboxStatus")
		console.log(imapMailboxStatus)

		if (this.importImapFolderSyncStates === undefined) {
			throw new ProgrammingError("onMailboxStatus event received but importImapFolderSyncStates not initialized!")
		}

		let folderSyncState = getFolderSyncStateForMailboxPath(imapMailboxStatus.path, this.importImapFolderSyncStates)
		if (folderSyncState) {
			const newFolderSyncState = await this.importImapFacade.updateImportImapFolderSyncState(imapMailboxStatus, folderSyncState)

			let index = this.importImapFolderSyncStates.findIndex((folderSyncState) => folderSyncState.path == newFolderSyncState.path)
			this.importImapFolderSyncStates[index] = newFolderSyncState
		}

		return Promise.resolve()
	}

	onMail(imapMail: ImapMail, eventType: AdSyncEventType): Promise<void> {
		console.log("onMail")
		console.log(imapMail)

		// TODO remove after evaluation
		this.testMailCounter += 1

		if (this.importImapFolderSyncStates === undefined) {
			throw new ProgrammingError("onMail event received but importImapFolderSyncStates not initialized!")
		}

		if (this.importedImapAttachmentHashToIdMap === undefined) {
			throw new ProgrammingError("onMail event received but importedImapAttachmentHashToIdMap not initialized!")
		}

		let folderSyncState = getFolderSyncStateForMailboxPath(imapMail.belongsToMailbox.path, this.importImapFolderSyncStates)
		if (folderSyncState) {
			let importMailParams = imapMailToImportMailParams(imapMail, folderSyncState._id, this.importedImapAttachmentHashToIdMap)

			switch (eventType) {
				case AdSyncEventType.CREATE:
					// TODO handle Tutanota rate limits
					// if rate limit -> stop adSync and postpone
					this.importMailFacade.importMail(importMailParams)
					break
				case AdSyncEventType.UPDATE:
					//this.importMailFacade.updateMail(importMailParams) // TODO update mail properties through existing tutanota apis (unread / read, etc)
					break
				case AdSyncEventType.DELETE:
					break
			}
		}

		return Promise.resolve()
	}

	onPostpone(postponedUntil: Date): Promise<void> {
		console.log("onPostpone")
		console.log(postponedUntil)

		this.imapImportState = new ImapImportState(ImportState.POSTPONED, postponedUntil)
		return Promise.resolve()
	}

	onFinish(downloadedQuota: number): Promise<void> {
		console.log("onFinish")

		// TODO remove after evaluation
		let downloadTime = Date.now() - this.testDownloadStartTime.getTime()
		console.log("Downloaded data (byte): " + downloadedQuota)
		console.log("Took (ms): " + downloadTime)
		console.log("Average throughput (bytes/ms): " + downloadedQuota / downloadTime)
		console.log("# amount of mails downloaded: " + this.testMailCounter)

		this.imapImportState = new ImapImportState(ImportState.FINISHED)
		return Promise.resolve()
	}

	onError(imapError: ImapError): Promise<void> {
		console.log("onError")
		console.log(imapError)

		return Promise.resolve()
	}

	loadImapImportState(): ImapImportState {
		return this.imapImportState
	}

	// TODO make this work
	async entityEventsReceived(updates: ReadonlyArray<EntityUpdateData>): Promise<void> {
		for (const update of updates) {
			if (isUpdateForTypeRef(ImportImapAttachmentHashToIdTypeRef, update)) {
				if (this.importImapAccountSyncState) {
					let importedImapAttachmentToIdMap = await this.importImapFacade.getImportedImapAttachmentHashToIdMap([
						update.instanceListId,
						update.instanceListId,
					])
					this.importedImapAttachmentHashToIdMap?.set(importedImapAttachmentToIdMap.imapAttachmentHash, importedImapAttachmentToIdMap.attachment)
				}
			}
		}
	}
}
