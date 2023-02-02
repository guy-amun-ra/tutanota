import { GroupType, MailMethod, MailPhishingStatus, MailState, ReplyType } from "../../../common/TutanotaConstants.js"
import { RecipientList } from "../../../common/recipients/Recipient.js"
import { UserFacade } from "../UserFacade.js"
import { Attachments, MailFacade, recipientToDraftRecipient, recipientToEncryptedMailAddress } from "./MailFacade.js"
import { IServiceExecutor } from "../../../common/ServiceRequest.js"
import { EntityClient } from "../../../common/EntityClient.js"
import {
	createImportMailData,
	createImportMailDataMailReference,
	createImportMailPostIn,
	ImportMailDataMailReference,
	Mail,
	MailTypeRef
} from "../../../entities/tutanota/TypeRefs.js"
import { byteLength } from "@tutao/tutanota-utils"
import { UNCOMPRESSED_MAX_SIZE } from "../../Compression.js"
import { MailBodyTooLargeError } from "../../../common/error/MailBodyTooLargeError.js"
import { aes128RandomKey, encryptKey } from "@tutao/tutanota-crypto"
import { ImportMailService } from "../../../entities/tutanota/Services.js"

export interface ImportMailParams {
	subject: string
	bodyText: string
	sentDate: Date
	receivedDate: Date
	state: MailState
	unread: boolean
	messageId: string | null
	inReplyTo: string | null
	references: string[]
	senderMailAddress: string
	senderName: string
	method: MailMethod
	replyType: ReplyType
	differentEnvelopeSender: string | null
	headers: string
	replyTos: RecipientList
	toRecipients: RecipientList
	ccRecipients: RecipientList
	bccRecipients: RecipientList
	attachments: Attachments | null
	imapUid: number
	imapModSeq: BigInt | null
	imapFolderSyncState: IdTuple
}

/**
 * The ImportMailFacade is responsible for importing mails to the Tutanota server.
 * The facade communicates directly with the ImportMailService.
 */
export class ImportMailFacade {

	constructor(
		private readonly userFacade: UserFacade,
		private readonly mailFacade: MailFacade,
		private readonly serviceExecutor: IServiceExecutor,
		private readonly entityClient: EntityClient,
	) {
	}

	async importMail(
		{
			subject,
			bodyText,
			sentDate,
			receivedDate,
			state,
			unread,
			messageId,
			inReplyTo,
			references,
			senderMailAddress,
			senderName,
			method,
			replyType,
			differentEnvelopeSender,
			headers,
			replyTos,
			toRecipients,
			ccRecipients,
			bccRecipients,
			attachments,
			imapUid,
			imapModSeq,
			imapFolderSyncState,
		}: ImportMailParams
	): Promise<Mail> {
		if (byteLength(bodyText) > UNCOMPRESSED_MAX_SIZE) {
			throw new MailBodyTooLargeError(`Can not import mail, mail body too large (${byteLength(bodyText)})`)
		}

		const mailGroupId = this.userFacade.getGroupId(GroupType.Mail)
		const mailGroupKey = this.userFacade.getGroupKey(mailGroupId)
		const sk = aes128RandomKey()
		const service = createImportMailPostIn()
		service.ownerEncSessionKey = encryptKey(mailGroupKey, sk)
		service.ownerGroup = mailGroupId
		service.imapUid = imapUid.toString()
		service.imapModSeq = imapModSeq?.toString() ?? null
		service.imapFolderSyncState = imapFolderSyncState

		service.mailData = createImportMailData({
			subject,
			compressedBodyText: bodyText,
			sentDate,
			receivedDate,
			state,
			unread,
			messageId,
			inReplyTo,
			references: references.map(referenceToImportMailDataMailReference),
			senderMailAddress,
			senderName,
			confidential: false,
			method,
			replyType,
			differentEnvelopeSender,
			phishingStatus: MailPhishingStatus.UNKNOWN,
			compressedHeaders: headers,
			replyTos: replyTos.map(recipientToEncryptedMailAddress),
			toRecipients: toRecipients.map(recipientToDraftRecipient),
			ccRecipients: ccRecipients.map(recipientToDraftRecipient),
			bccRecipients: bccRecipients.map(recipientToDraftRecipient),
			addedAttachments: await this.mailFacade._createAddedAttachments(attachments, [], mailGroupId, mailGroupKey)
		})

		const importMailPostOut = await this.serviceExecutor.post(ImportMailService, service, { sessionKey: sk })
		return this.entityClient.load(MailTypeRef, importMailPostOut.mail)
	}
}

export function referenceToImportMailDataMailReference(reference: string): ImportMailDataMailReference {
	return createImportMailDataMailReference({
		reference: reference
	})
}
