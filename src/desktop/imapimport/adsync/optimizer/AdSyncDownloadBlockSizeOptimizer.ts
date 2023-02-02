import { AdSyncOptimizer, THROUGHPUT_THRESHOLD } from "./AdSyncOptimizer.js"
import { ImapSyncSessionMailbox } from "../ImapSyncSessionMailbox.js"

const OPTIMIZATION_INTERVAL = 10 // in seconds

export class AdSyncDownloadBlockSizeOptimizer extends AdSyncOptimizer {
	protected _optimizedSyncSessionMailbox: ImapSyncSessionMailbox
	protected scheduler?: NodeJS.Timer

	constructor(syncSessionMailbox: ImapSyncSessionMailbox, optimizationDifference: number) {
		super(optimizationDifference)
		this._optimizedSyncSessionMailbox = syncSessionMailbox
	}

	override startAdSyncOptimizer(): void {
		super.startAdSyncOptimizer()
		this.scheduler = setInterval(this.optimize.bind(this), OPTIMIZATION_INTERVAL * 1000) // every OPTIMIZATION_INTERVAL seconds
	}

	get optimizedSyncSessionMailbox(): ImapSyncSessionMailbox {
		return this._optimizedSyncSessionMailbox
	}

	protected optimize(): void {
		let currentInterval = this.getCurrentTimeStampInterval()
		let lastInterval = this.getLastTimeStampInterval()
		let averageThroughputCurrent = this.optimizedSyncSessionMailbox.getAverageThroughputInTimeInterval(currentInterval.fromTimeStamp, currentInterval.toTimeStamp)
		let averageThroughputLast = this.optimizedSyncSessionMailbox.getAverageThroughputInTimeInterval(lastInterval.fromTimeStamp, lastInterval.toTimeStamp)
		console.log("(DownloadBlockSizeOptimizer -> " + this.optimizedSyncSessionMailbox.mailboxState.path + " : last downloadBlockSize | " + this.optimizedSyncSessionMailbox.downloadBlockSize + " |) Throughput stats: ... | " + averageThroughputLast + " | " + averageThroughputCurrent + " |")

		let downloadBlockSizeCurrent = this.optimizedSyncSessionMailbox.getDownloadBlockSizeInTimeInterval(currentInterval.fromTimeStamp, currentInterval.toTimeStamp)
		let downloadBlockSizeLast = this.optimizedSyncSessionMailbox.getDownloadBlockSizeInTimeInterval(lastInterval.fromTimeStamp, lastInterval.toTimeStamp)
		let downloadBlockSizeDidIncrease = (downloadBlockSizeCurrent - downloadBlockSizeLast) >= 0

		if (averageThroughputCurrent + THROUGHPUT_THRESHOLD >= averageThroughputLast) {
			if (downloadBlockSizeDidIncrease) {
				this.optimizedSyncSessionMailbox.downloadBlockSize = (this.optimizedSyncSessionMailbox.downloadBlockSize + this.optimizationDifference)
			} else if (this.optimizedSyncSessionMailbox.downloadBlockSize - this.optimizationDifference > 0) {
				this.optimizedSyncSessionMailbox.downloadBlockSize = (this.optimizedSyncSessionMailbox.downloadBlockSize - this.optimizationDifference)
			}
		} else {
			if (downloadBlockSizeDidIncrease && this.optimizedSyncSessionMailbox.downloadBlockSize - this.optimizationDifference > 0) {
				this.optimizedSyncSessionMailbox.downloadBlockSize = (this.optimizedSyncSessionMailbox.downloadBlockSize - this.optimizationDifference)
			}
		}

		this.optimizerUpdateTimeStampHistory.push(currentInterval.toTimeStamp)
	}
}
