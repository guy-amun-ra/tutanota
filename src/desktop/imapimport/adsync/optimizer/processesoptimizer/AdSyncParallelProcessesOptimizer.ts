import { OptimizerUpdateAction, THROUGHPUT_THRESHOLD } from "../AdSyncOptimizer.js"
import { AverageThroughput, TimeStamp } from "../../utils/AdSyncUtils.js"
import { ProgrammingError } from "../../../../../api/common/error/ProgrammingError.js"
import { AdSyncProcessesOptimizer, OptimizerProcess } from "./AdSyncProcessesOptimizer.js"

const OPTIMIZATION_INTERVAL = 5 // in seconds
export class AdSyncParallelProcessesOptimizer extends AdSyncProcessesOptimizer {

	private optimizerUpdateActionHistory: OptimizerUpdateAction[] = [OptimizerUpdateAction.NO_UPDATE]

	override startAdSyncOptimizer(): void {
		super.startAdSyncOptimizer()
		this.scheduler = setInterval(this.optimize.bind(this), OPTIMIZATION_INTERVAL * 1000) // every OPTIMIZATION_INTERVAL seconds
		this.optimize() // call once to start downloading of mails
	}

	// TODO IMAP server rate limits
	override optimize(): void {
		let currentInterval = this.getCurrentTimeStampInterval()
		let lastInterval = this.getLastTimeStampInterval()
		let averageCombinedThroughputCurrent = this.getAverageCombinedThroughputInTimeInterval(currentInterval.fromTimeStamp, currentInterval.toTimeStamp)
		let averageCombinedThroughputLast = this.getAverageCombinedThroughputInTimeInterval(lastInterval.fromTimeStamp, lastInterval.toTimeStamp)
		console.log("(ParallelProcessOptimizer) Throughput stats: ... | " + averageCombinedThroughputLast + " | " + averageCombinedThroughputCurrent + " |")

		let lastUpdateAction = this.optimizerUpdateActionHistory.at(-1)
		if (lastUpdateAction === undefined) {
			throw new ProgrammingError("The optimizerUpdateActionHistory has not been initialized correctly!")
		}

		if (averageCombinedThroughputCurrent + THROUGHPUT_THRESHOLD >= averageCombinedThroughputLast) {
			if (lastUpdateAction != OptimizerUpdateAction.DECREASE) {
				this.startSyncSessionProcesses(this.optimizationDifference)
				this.optimizerUpdateActionHistory.push(OptimizerUpdateAction.INCREASE)
			} else if (this.runningProcessMap.size > 1) {
				this.stopSyncSessionProcesses(1)
				this.optimizerUpdateActionHistory.push(OptimizerUpdateAction.DECREASE)
			}
		} else {
			if (lastUpdateAction == OptimizerUpdateAction.INCREASE && this.runningProcessMap.size > 1) {
				this.stopSyncSessionProcesses(1)
				this.optimizerUpdateActionHistory.push(OptimizerUpdateAction.DECREASE)
			}
		}

		this.optimizerUpdateTimeStampHistory.push(currentInterval.toTimeStamp)
	}

	private getAverageCombinedThroughputInTimeInterval(fromTimeStamp: TimeStamp, toTimeStamp: TimeStamp): AverageThroughput {
		if (this.runningProcessMap.size == 0) {
			return 0
		} else {
			let activeProcessCount = 0
			return [...this.runningProcessMap.values()].reduce<AverageThroughput>((acc: AverageThroughput, value: OptimizerProcess) => {
				if (value.syncSessionMailbox) {
					acc += value.syncSessionMailbox.getAverageThroughputInTimeInterval(fromTimeStamp, toTimeStamp)
					activeProcessCount += 1
				}
				return acc
			}, 0) / (activeProcessCount != 0 ? activeProcessCount : 1)
		}
	}
}
