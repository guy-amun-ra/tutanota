import { ImapMailboxState } from "./ImapSyncState.js"
import {
	AverageEfficiencyScore,
	AverageThroughput,
	DownloadBlockSize,
	getAverageOfList,
	Throughput,
	TimeIntervalTimeStamp,
	TimeStamp
} from "./utils/AdSyncUtils.js"
import { ImapMailboxSpecialUse } from "./imapmail/ImapMailbox.js"

export enum SyncSessionMailboxImportance {
	NO_SYNC = 0,
	LOW = 1,
	MEDIUM = 2,
	HIGH = 3
}

export class ImapSyncSessionMailbox {
	mailboxState: ImapMailboxState
	mailCount: number | null = 0
	timeToLiveInterval: number = 10 // in seconds
	downloadBlockSize = 500
	importance: SyncSessionMailboxImportance = SyncSessionMailboxImportance.MEDIUM
	private _specialUse: ImapMailboxSpecialUse | null = null
	private throughputHistory: Map<TimeStamp, Throughput> = new Map<TimeStamp, Throughput>()
	private averageThroughputInTimeIntervalHistory: Map<TimeIntervalTimeStamp, AverageThroughput> = new Map<TimeIntervalTimeStamp, AverageThroughput>()
	private downloadBlockSizeHistory: Map<TimeStamp, DownloadBlockSize> = new Map<TimeStamp, DownloadBlockSize>()

	constructor(mailboxState: ImapMailboxState) {
		this.mailboxState = mailboxState
	}

	initSessionMailbox(mailCount?: number): void {
		this.mailCount = mailCount ? mailCount : null
	}

	get specialUse(): ImapMailboxSpecialUse | null {
		return this._specialUse
	}

	set specialUse(value: ImapMailboxSpecialUse | null) {
		this._specialUse = value

		switch (this._specialUse) {
			case ImapMailboxSpecialUse.INBOX:
				this.importance = SyncSessionMailboxImportance.HIGH
				break
			case ImapMailboxSpecialUse.TRASH:
			case ImapMailboxSpecialUse.ARCHIVE:
			case ImapMailboxSpecialUse.ALL:
			case ImapMailboxSpecialUse.SENT:
				this.importance = SyncSessionMailboxImportance.LOW
				break
			case ImapMailboxSpecialUse.JUNK:
				this.importance = SyncSessionMailboxImportance.NO_SYNC
				break
			default:
				this.importance = SyncSessionMailboxImportance.MEDIUM
				break
		}
	}

	getAverageThroughputInTimeInterval(fromTimeStamp: TimeStamp, toTimeStamp: TimeStamp): AverageThroughput {
		let throughputsInTimeInterval = [...this.throughputHistory.entries()]
			.filter(([timeStamp, _throughput]) => {
				return timeStamp >= fromTimeStamp && timeStamp < toTimeStamp
			})
			.map(([_timeStamp, throughput]) => {
				return throughput
			})
		let averageThroughputInTimeInterval = getAverageOfList(throughputsInTimeInterval)
		this.averageThroughputInTimeIntervalHistory.set(`${fromTimeStamp}${toTimeStamp}`, averageThroughputInTimeInterval)
		return averageThroughputInTimeInterval
	}

	getAverageEfficiencyScoreInTimeInterval(fromTimeStamp: TimeStamp, toTimeStamp: TimeStamp): AverageEfficiencyScore {
		let key = `${fromTimeStamp}${toTimeStamp}`
		let averageExists = this.averageThroughputInTimeIntervalHistory.has(key)
		return this.importance * (averageExists ? this.averageThroughputInTimeIntervalHistory.get(key)! : this.getAverageThroughputInTimeInterval(fromTimeStamp, toTimeStamp))
	}

	getDownloadBlockSizeInTimeInterval(fromTimeStamp: TimeStamp, toTimeStamp: TimeStamp): DownloadBlockSize {
		let downloadBlockSizeInTimeInterval = [...this.downloadBlockSizeHistory.entries()]
			.filter(([timeStamp, _downloadBlockSize]) => {
				return timeStamp >= fromTimeStamp && timeStamp < toTimeStamp
			})
			.map(([_timeStamp, downloadBlockSize]) => {
				return downloadBlockSize
			})
			.at(-1)
		if (downloadBlockSizeInTimeInterval !== undefined) {
			return downloadBlockSizeInTimeInterval
		} else {
			return this.downloadBlockSize
		}
	}

	reportCurrentThroughput(throughput: Throughput) {
		this.throughputHistory.set(Date.now(), throughput)
	}

	reportDownloadBlockSizeUsage(downloadBlockSize: DownloadBlockSize) {
		this.downloadBlockSizeHistory.set(Date.now(), downloadBlockSize)
	}
}
