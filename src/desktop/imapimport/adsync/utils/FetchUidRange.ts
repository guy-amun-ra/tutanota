const { ImapFlow } = require('imapflow');

export class FetchUidRange {
	fromUid?: number
	toUid?: number | string
	currentDownloadBlockSize = 0
	private fromSeq: number = 1
	private toSeq?: number
	private readonly imapClient: typeof ImapFlow
	private readonly mailCount: number | null

	constructor(imapClient: typeof ImapFlow, mailCount: number | null) {
		this.imapClient = imapClient
		this.mailCount = mailCount
	}

	async initFetchUidRange(initialFrom: number, initialDownloadBlockSize: number, isUid: boolean) {
		// if the mail count is null we perform a full fetch without making use of the download block size
		if (this.mailCount == null) {
			this.fromUid = 1
			this.toUid = "*"
			return
		} else {
			await this.updateFetchUidRange(initialFrom, initialDownloadBlockSize, isUid)
		}
	}

	async continueFetchUidRange(downloadBlockSize: number) {
		await this.updateFetchUidRange(this.toSeq ? this.toSeq + 1 : 1, downloadBlockSize, false)
	}

	private async updateFetchUidRange(from: number, downloadBlockSize: number, isUid: boolean) {
		this.currentDownloadBlockSize = downloadBlockSize

		// if mail sequence number > mail count, we reached the end, and we can stop the download
		if (this.mailCount == null || !isUid && from > this.mailCount) {
			this.fromUid = undefined
			this.toUid = undefined
			return
		}

		let fetchFromSeqMail = await this.imapClient.fetchOne(`${from}`, { seq: true, uid: true }, { uid: isUid })
		this.fromSeq = fetchFromSeqMail.seq
		this.fromUid = fetchFromSeqMail.uid

		let fetchToSeq = fetchFromSeqMail.seq + downloadBlockSize
		if (fetchToSeq > this.mailCount) {
			fetchToSeq = this.mailCount
		}

		let fetchToSeqMail: FetchMessageObject = await this.imapClient.fetchOne(`${fetchToSeq}`, { seq: true, uid: true })
		this.toSeq = fetchToSeqMail.seq
		this.toUid = fetchToSeqMail.uid
	}
}
