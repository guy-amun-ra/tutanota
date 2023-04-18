import { ImportImapAccount, ImportImapFolderSyncState } from "../../entities/tutanota/TypeRefs.js"
import { ImapAccount } from "../../../desktop/imapimport/adsync/ImapSyncState.js"
import { ImapMail, ImapMailAddress, ImapMailAttachment } from "../../../desktop/imapimport/adsync/imapmail/ImapMail.js"
import { CalendarMethod, calendarMethodToMailMethod, MailMethod, MailState, ReplyType } from "../../common/TutanotaConstants.js"
import { ImapMailbox, ImapMailboxSpecialUse } from "../../../desktop/imapimport/adsync/imapmail/ImapMailbox.js"
import { PartialRecipient, RecipientList } from "../../common/recipients/Recipient.js"
import { DataFile } from "../../common/DataFile.js"
import { sha256Hash } from "@tutao/tutanota-crypto"
import { ImapImportAttachments, ImapImportDataFile, ImapImportTutanotaFileId, ImportMailParams } from "../facades/lazy/ImportMailFacade.js"
import { uint8ArrayToString } from "@tutao/tutanota-utils"

const TEXT_CALENDAR_MIME_TYPE = "text/calendar"
const CALENDAR_METHOD_MIME_PARAMETER = "method"

const IMAP_FLAG_SEEN = "\\Seen"
const IMAP_FLAG_ANSWERED = "\\Answered"
const IMAP_FLAG_FORWARDED = "$Forwarded"

export function importImapAccountToImapAccount(importImapAccount: ImportImapAccount): ImapAccount {
	let imapAccount = new ImapAccount(importImapAccount.host, parseInt(importImapAccount.port), importImapAccount.userName)

	if (importImapAccount.password) {
		imapAccount.password = importImapAccount.password
	}

	if (importImapAccount.accessToken) {
		imapAccount.accessToken = importImapAccount.accessToken
	}

	return imapAccount
}

export function getFolderSyncStateForMailboxPath(mailboxPath: string, folderSyncStates: ImportImapFolderSyncState[]): ImportImapFolderSyncState | null {
	let folderSyncState = folderSyncStates.find((folderSyncState) => {
		return folderSyncState.path == mailboxPath
	})
	return folderSyncState ? folderSyncState : null
}

export function imapMailToImportMailParams(
	imapMail: ImapMail,
	folderSyncStateId: IdTuple,
	importedImapAttachmentHashToIdMap: Map<string, IdTuple>,
): ImportMailParams {
	let fromMailAddress = imapMail.envelope?.from?.at(0)?.address ?? ""
	let fromName = imapMail.envelope?.from?.at(0)?.name ?? ""
	let senderMailAddress = imapMail.envelope?.sender?.at(0)?.address ?? null

	let differentEnvelopeSender = senderMailAddress != fromMailAddress ? senderMailAddress : null

	let attachments = imapMail.attachments ? importAttachmentsFromImapMailAttachments(imapMail.attachments, importedImapAttachmentHashToIdMap) : null

	return {
		subject: imapMail.envelope?.subject ?? "",
		bodyText: imapMail.body?.html ?? imapMail.body?.plaintextAsHtml ?? "",
		sentDate: imapMail.envelope?.date ?? new Date(Date.now()),
		receivedDate: imapMail.internalDate ?? new Date(Date.now()),
		state: mailStateFromImapMailbox(imapMail.belongsToMailbox),
		unread: unreadFromImapMail(imapMail),
		messageId: imapMail.envelope?.messageId ?? null, // if null, a new messageId is generated on the tutadb server
		senderMailAddress: fromMailAddress,
		senderName: fromName,
		method: mailMethodFromImapMail(imapMail),
		replyType: replyTypeFromImapMail(imapMail),
		differentEnvelopeSender: differentEnvelopeSender, // null if sender == from in mail envelope
		headers: imapMail.headers ?? "",
		replyTos: imapMail.envelope?.replyTo ? recipientsFromImapMailAddresses(imapMail.envelope?.replyTo!) : [],
		toRecipients: imapMail.envelope?.to ? recipientsFromImapMailAddresses(imapMail.envelope?.to!) : [],
		ccRecipients: imapMail.envelope?.cc ? recipientsFromImapMailAddresses(imapMail.envelope?.cc!) : [],
		bccRecipients: imapMail.envelope?.bcc ? recipientsFromImapMailAddresses(imapMail.envelope?.bcc!) : [],
		attachments: attachments,
		inReplyTo: imapMail.envelope?.inReplyTo ?? null,
		references: imapMail.envelope?.references ?? [],
		imapUid: imapMail.uid,
		imapModSeq: imapMail.modSeq ?? null,
		imapFolderSyncState: folderSyncStateId,
	}
}

function mailStateFromImapMailbox(imapMailbox: ImapMailbox): MailState {
	let mailState: MailState
	switch (imapMailbox.specialUse) {
		case ImapMailboxSpecialUse.SENT:
			mailState = MailState.SENT
			break
		case ImapMailboxSpecialUse.DRAFTS:
			mailState = MailState.DRAFT
			break
		default:
			mailState = MailState.RECEIVED
	}
	return mailState
}

function unreadFromImapMail(imapMail: ImapMail): boolean {
	return !imapMail.flags?.has(IMAP_FLAG_SEEN) ?? true
}

function mailMethodFromImapMail(imapMail: ImapMail): MailMethod {
	let iCalAttachments = imapMail.attachments?.find((attachment) => {
		attachment.contentType == TEXT_CALENDAR_MIME_TYPE && attachment.headers.has(CALENDAR_METHOD_MIME_PARAMETER)
	})
	let calendarMethod = iCalAttachments?.headers.get(CALENDAR_METHOD_MIME_PARAMETER) as CalendarMethod
	return calendarMethod ? calendarMethodToMailMethod(calendarMethod) : MailMethod.NONE
}

function replyTypeFromImapMail(imapMail: ImapMail): ReplyType {
	let flags = imapMail.flags
	if (flags === undefined) {
		return ReplyType.NONE
	}

	let replyType: ReplyType
	if (flags.has(IMAP_FLAG_ANSWERED) && flags.has(IMAP_FLAG_FORWARDED)) {
		replyType = ReplyType.REPLY_FORWARD
	} else if (flags.has(IMAP_FLAG_ANSWERED)) {
		replyType = ReplyType.REPLY
	} else if (flags.has(IMAP_FLAG_FORWARDED)) {
		replyType = ReplyType.FORWARD
	} else {
		replyType = ReplyType.NONE
	}
	return replyType
}

function recipientsFromImapMailAddresses(imapMailAddresses: ImapMailAddress[]): RecipientList {
	return imapMailAddresses.map((imapMailAddress) => {
		let partialRecipient: PartialRecipient = {
			address: imapMailAddress.address ?? "",
			name: imapMailAddress.name,
		}
		return partialRecipient
	})
}

function importAttachmentsFromImapMailAttachments(
	imapMailAttachments: ImapMailAttachment[],
	importedImapAttachmentHashToIdMap: Map<string, IdTuple>,
): ImapImportAttachments {
	return imapMailAttachments.map((imapMailAttachment) => {
		// calculate fileHash to perform IMAP import attachment de-duplication
		let fileHash = uint8ArrayToString("utf-8", sha256Hash(imapMailAttachment.content))

		if (importedImapAttachmentHashToIdMap.has(fileHash)) {
			let imapImportTutanotaFileId: ImapImportTutanotaFileId = {
				_type: "ImapImportTutanotaFileId",
				_id: importedImapAttachmentHashToIdMap.get(fileHash)!,
			}
			return imapImportTutanotaFileId
		} else {
			let importDataFile: ImapImportDataFile = {
				_type: "DataFile",
				name: imapMailAttachment.filename ?? "filename", // TODO fix this
				data: imapMailAttachment.content,
				size: imapMailAttachment.size,
				mimeType: imapMailAttachment.contentType,
				cid: imapMailAttachment.cid,
				fileHash: fileHash,
			}
			return importDataFile
		}
	})
}
