import o from "ospec"
import { ImapAdSync } from "../../../../../src/desktop/imapimport/adsync/ImapAdSync.js"
import { ImapAccount, ImapSyncState, ImapMailboxState } from "../../../../../src/desktop/imapimport/adsync/ImapSyncState.js"
import { ImapImporter } from "../../../../../src/desktop/imapimport/ImapImporter.js"

o.spec("ImapAdSyncTest", function () {
	let imapImporter: ImapImporter

	o.beforeEach(function () {
		let imapAccount = new ImapAccount("192.168.178.83", 25, "johannes").setPassword("Wsw6r6dzEH7Y9mDJ")
		let mailboxStates = [new ImapMailboxState("\\Drafts", 0, 0, 0, new Map<number, IdTuple>())]
		let imapSyncState = new ImapSyncState(imapAccount, 2500, mailboxStates)
		let imapAdSync = new ImapAdSync(imapSyncState)
		imapImporter = new ImapImporter(imapAdSync)
	})

	o.only("trigger AdSyncEventListener onMail event", async function () {
		let importState = await imapImporter.continueImport()
	})
})
