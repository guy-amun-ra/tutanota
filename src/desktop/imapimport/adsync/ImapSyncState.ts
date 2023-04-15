import { ImapMailbox } from "./imapmail/ImapMailbox.js"

export class ImapAccount {
	host: string
	port: number
	username: string
	password?: string
	accessToken?: string

	constructor(host: string, port: number, username: string) {
		this.host = host
		this.port = port
		this.username = username
	}
}

export class ImapMailboxStateImportedIds {
	uid: number
	modSeq?: number
	externalMailId?: any

	constructor(uid: number) {
		this.uid = uid
	}
}

export class ImapMailboxState {
	path: string
	uidValidity?: bigint
	uidNext?: number
	highestModSeq?: bigint | null // null indicates that the CONDSTORE IMAP extension, and therefore highestModSeq, is not supported
	importedUidToIdsMap: Map<number, ImapMailboxStateImportedIds>

	constructor(path: string, importedUidToIdsMap: Map<number, ImapMailboxStateImportedIds>) {
		this.path = path
		this.importedUidToIdsMap = importedUidToIdsMap
	}

	static fromImapMailbox(imapMailbox: ImapMailbox) {
		return new ImapMailboxState(imapMailbox.path, new Map<number, ImapMailboxStateImportedIds>())
	}
}

export class ImapSyncState {
	imapAccount: ImapAccount
	maxQuota: number
	mailboxStates: ImapMailboxState[]
	importedAttachmentHashes: string[]

	constructor(imapAccount: ImapAccount, maxQuata: number, mailboxStates: ImapMailboxState[], importedAttachmentHashes) {
		this.imapAccount = imapAccount
		this.maxQuota = maxQuata
		this.mailboxStates = mailboxStates
		this.importedAttachmentHashes = importedAttachmentHashes
	}
}
