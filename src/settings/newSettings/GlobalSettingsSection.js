// @flow
import type {SettingsSection, SettingsTableAttrs, SettingsValue} from "./SettingsModel"
import {SettingsTable} from "./SettingsModel"
import type {EntityUpdateData} from "../../api/main/EventController"
import {isUpdateForTypeRef} from "../../api/main/EventController"
import stream from "mithril/stream/stream.js"
import type {TableAttrs, TableLineAttrs} from "../../gui/base/TableN"
import {ColumnWidth, createRowActions} from "../../gui/base/TableN"
import type {Customer} from "../../api/entities/sys/Customer"
import {CustomerTypeRef} from "../../api/entities/sys/Customer"
import {LazyLoaded} from "../../api/common/utils/LazyLoaded"
import type {CustomerInfo} from "../../api/entities/sys/CustomerInfo"
import {CustomerInfoTypeRef} from "../../api/entities/sys/CustomerInfo"
import {load, loadRange, update} from "../../api/main/Entity"
import {getCustomMailDomains, neverNull, noOp} from "../../api/common/utils/Utils"
import {logins} from "../../api/main/LoginController"
import {generatedIdToTimestamp, timestampToGeneratedId} from "../../api/common/utils/Encoding"
import {RejectedSenderTypeRef} from "../../api/entities/sys/RejectedSender"
import {GENERATED_MAX_ID, getElementId, sortCompareByReverseId} from "../../api/common/utils/EntityUtils"
import {formatDateTime, formatDateTimeFromYesterdayOn} from "../../misc/Formatter"
import {showRejectedSendersInfoDialog} from "../RejectedSendersInfoDialog"
import {attachDropdown, createDropdown} from "../../gui/base/DropdownN"
import {Icons} from "../../gui/base/icons/Icons"
import {ButtonType} from "../../gui/base/ButtonN"
import {getDomainPart} from "../../misc/parsing/MailAddressParser"
import {getSpamRuleFieldToName, getSpamRuleTypeNameMapping, showAddSpamRuleDialog} from "../AddSpamRuleDialog"
import {createEmailSenderListElement} from "../../api/entities/sys/EmailSenderListElement"
import {getSpamRuleField, GroupType, OperationType, SpamRuleFieldType, SpamRuleType} from "../../api/common/TutanotaConstants"
import {showProgressDialog} from "../../gui/dialogs/ProgressDialog"
import m from "mithril"
import {BootIcons} from "../../gui/base/icons/BootIcons"
import {showNotAvailableForFreeDialog} from "../../misc/SubscriptionDialogs"
import {showAddDomainWizard} from "../emaildomain/AddDomainWizard"
import {DAY_IN_MILLIS} from "../../api/common/utils/DateUtils"
import type {IUserController} from "../../api/main/UserController"
import {ofClass, promiseMap} from "../../api/common/utils/PromiseUtils"
import type {CustomerServerProperties} from "../../api/entities/sys/CustomerServerProperties"
import {CustomerServerPropertiesTypeRef} from "../../api/entities/sys/CustomerServerProperties"
import type {AuditLogEntry} from "../../api/entities/sys/AuditLogEntry"
import {AuditLogEntryTypeRef} from "../../api/entities/sys/AuditLogEntry"
import {worker} from "../../api/main/WorkerClient"
import {LockedError, NotAuthorizedError, PreconditionFailedError} from "../../api/common/error/RestError"
import {DomainDnsStatus} from "../DomainDnsStatus"
import {lang} from "../../misc/LanguageViewModel"
import {loadEnabledTeamMailGroups, loadEnabledUserMailGroups, loadGroupDisplayName} from "../LoadingUtils"
import {showDnsCheckDialog} from "../CheckDomainDnsStatusDialog"
import type {GroupInfo} from "../../api/entities/sys/GroupInfo"
import {GroupInfoTypeRef} from "../../api/entities/sys/GroupInfo"
import {Dialog} from "../../gui/base/Dialog"
import type {DomainInfo} from "../../api/entities/sys/DomainInfo"
import {GroupTypeRef} from "../../api/entities/sys/Group"
import {UserTypeRef} from "../../api/entities/sys/User"
import {getUserGroupMemberships} from "../../api/common/utils/GroupUtils"
import type {DropDownSelectorAttrs} from "../../gui/base/DropDownSelectorN"
import {DropDownSelectorN} from "../../gui/base/DropDownSelectorN"

// Number of days for that we load rejected senders
const REJECTED_SENDERS_TO_LOAD_MS = 5 * DAY_IN_MILLIS
// Max number of rejected sender entries that we display in the ui
const REJECTED_SENDERS_MAX_NUMBER = 100

export class GlobalSettingsSection implements SettingsSection {
	heading: string
	category: string
	settingsValues: Array<SettingsValue<any>>

	spamRuleLines: Stream<Array<TableLineAttrs>>
	rejectedSenderLines: Stream<Array<TableLineAttrs>>
	customDomainLines: Stream<Array<TableLineAttrs>>
	customer: Stream<Customer>
	customerInfo: LazyLoaded<CustomerInfo>
	auditLogLines: Stream<Array<TableLineAttrs>>
	domainDnsStatus: {[key: string]: DomainDnsStatus}
	props: Stream<CustomerServerProperties>;
	currentSaveIpAddressValue: Stream<boolean>
	currentPasswordUpdateValue: Stream<boolean>

	constructor(userController: IUserController) {
		this.heading = "Global"
		this.category = "Global"
		this.settingsValues = []

		this.auditLogLines = stream([])
		this.spamRuleLines = stream([])
		this.rejectedSenderLines = stream([])
		this.customDomainLines = stream([])
		this.customer = stream()
		this.domainDnsStatus = {}
		this.props = stream()
		this.currentSaveIpAddressValue = stream(false)
		this.currentPasswordUpdateValue = stream(false)
		this.customerInfo = new LazyLoaded(() => {
			return load(CustomerTypeRef, neverNull(userController.user.customer))
				.then(customer => load(CustomerInfoTypeRef, customer.customerInfo))
		})
		this.updateCustomerServerProperties()

		this.settingsValues.push(this.createSpamRulesSetting())
		this.settingsValues.push(this.createRejectedEmailsSettings())
		this.settingsValues.push(this.createSaveIpSettings())
		this.settingsValues.push(this.createPasswordUpdateSettings())
		this.settingsValues.push(this.createCustomDomainSettings(userController))
		this.settingsValues.push(this.createAuditLogSettings())
	}

	createSpamRulesSetting(): SettingsValue<SettingsTableAttrs> {

		const spamRuleTableAttrs: TableAttrs = {
			columnHeading: ["emailSender_label", "emailSenderRule_label"],
			columnWidths: [ColumnWidth.Largest, ColumnWidth.Small],
			showActionButtonColumn: true,
			addButtonAttrs: {
				label: "addSpamRule_action",
				click: () => showAddSpamRuleDialog(),
				icon: () => Icons.Add
			},
			lines: this.spamRuleLines()
		}

		const spamRuleSettingTableAttrs: SettingsTableAttrs = {
			tableHeading: "adminSpam_action",
			tableAttrs: spamRuleTableAttrs
		}

		return {
			name: "adminSpam_action",
			component: SettingsTable,
			attrs: spamRuleSettingTableAttrs
		}
	}

	createRejectedEmailsSettings(): SettingsValue<SettingsTableAttrs> {

		const rejectedSenderTableAttrs: TableAttrs = {
			columnHeading: ["emailSender_label"],
			columnWidths: [ColumnWidth.Largest],
			showActionButtonColumn: true,
			addButtonAttrs: {
				label: "refresh_action",
				click: () => {
					this.updateRejectedSenderTable()
				},
				icon: () => BootIcons.Progress
			},
			lines: this.rejectedSenderLines()
		}

		const rejectedSenderSettingsTableAttrs: SettingsTableAttrs = {
			tableHeading: "rejectedEmails_label",
			tableAttrs: rejectedSenderTableAttrs
		}

		return {
			name: "rejectedEmails_label",
			component: SettingsTable,
			attrs: rejectedSenderSettingsTableAttrs
		}
	}

	createSaveIpSettings(): SettingsValue<DropDownSelectorAttrs<boolean>> {

		const settingsAttrs: DropDownSelectorAttrs<boolean> = {
			label: "saveEncryptedIpAddress_label",
			items: [
				{name: lang.get("yes_label"), value: true},
				{name: lang.get("no_label"), value: false}
			],
			selectedValue: this.currentSaveIpAddressValue,
			selectionChangedHandler: (value) => {
				this.currentSaveIpAddressValue(value)
				const newProps: CustomerServerProperties = Object.assign({}, this.props(), {saveEncryptedIpAddressInSession: value})
				update(newProps)
			}
		}

		return {
			name: "saveEncryptedIpAddress_label",
			component: DropDownSelectorN,
			attrs: settingsAttrs
		}
	}

	createPasswordUpdateSettings(): SettingsValue<DropDownSelectorAttrs<boolean>> {

		const settingsAttrs: DropDownSelectorAttrs<boolean> = {
			label: "enforcePasswordUpdate_title",
			items: [
				{name: lang.get("yes_label"), value: true},
				{name: lang.get("no_label"), value: false}
			],
			selectedValue: this.currentPasswordUpdateValue,
			selectionChangedHandler: (value) => {
				this.currentPasswordUpdateValue(value)
				const newProps: CustomerServerProperties = Object.assign({}, this.props(), {requirePasswordUpdateAfterReset: value})
				update(newProps)
			}
		}

		return {
			name: "enforcePasswordUpdate_title",
			component: DropDownSelectorN,
			attrs: settingsAttrs
		}
	}

	createCustomDomainSettings(userController: IUserController): SettingsValue<SettingsTableAttrs> {

		const customDomainTableAttrs = {
			columnHeading: ["adminCustomDomain_label", "catchAllMailbox_label"],
			columnWidths: [ColumnWidth.Largest, ColumnWidth.Small],
			showActionButtonColumn: true,
			addButtonAttrs: {
				label: "addCustomDomain_action",
				click: () => {
					this.customerInfo.getAsync().then(customerInfo => {
						if (userController.isFreeAccount()) {
							showNotAvailableForFreeDialog(getCustomMailDomains(customerInfo).length === 0)
						} else {
							showAddDomainWizard("", customerInfo).then(() => {
								// _updateDomains()
								console.log("clicked")
							})
						}
					})
				},
				icon: () => Icons.Add
			},
			lines: this.customDomainLines()
		}

		const customDomainSettingsTableAttrs: SettingsTableAttrs = {
			tableHeading: "customEmailDomains_label",
			tableAttrs: customDomainTableAttrs
		}

		return {
			name: "customEmailDomains_label",
			component: SettingsTable,
			attrs: customDomainSettingsTableAttrs
		}
	}

	createAuditLogSettings(): SettingsValue<SettingsTableAttrs> {

		const auditLogTableAttrs: TableAttrs = {
			columnHeading: ["action_label", "modified_label", "time_label"],
			columnWidths: [ColumnWidth.Largest, ColumnWidth.Largest, ColumnWidth.Small],
			showActionButtonColumn: true,
			lines: this.auditLogLines()
		}

		const auditSettingsTableAttrs: SettingsTableAttrs = {
			tableHeading: "auditLog_title",
			tableAttrs: auditLogTableAttrs
		}

		return {
			name: "auditLog_title",
			component: SettingsTable,
			attrs: auditSettingsTableAttrs
		}
	}

	updateRejectedSenderTable(): void {
		const customer = this.customer()
		if (customer && customer.rejectedSenders) {
			// Rejected senders are written with TTL for seven days.
			// We have to avoid that we load too many (already deleted) rejected senders form the past.
			// First we load REJECTED_SENDERS_MAX_NUMBER items starting from the past timestamp into the future. If there are
			// more entries available we can safely load REJECTED_SENDERS_MAX_NUMBER from GENERATED_MAX_ID in reverse order.
			// Otherwise we will just use what has been returned in the first request.
			const senderListId = customer.rejectedSenders.items
			const startId = timestampToGeneratedId(Date.now() - REJECTED_SENDERS_TO_LOAD_MS)
			const loadingPromise = loadRange(RejectedSenderTypeRef, senderListId, startId, REJECTED_SENDERS_MAX_NUMBER, false)
				.then(rejectedSenders => {
					if (REJECTED_SENDERS_MAX_NUMBER === rejectedSenders.length) {
						// There are more entries available, we need to load from GENERATED_MAX_ID.
						// we don't need to sort here because we load in reverse direction
						return loadRange(RejectedSenderTypeRef, senderListId, GENERATED_MAX_ID, REJECTED_SENDERS_MAX_NUMBER, true)
					} else {
						// ensure that rejected senders are sorted in descending order
						return rejectedSenders.sort(sortCompareByReverseId)
					}
				})
				.then(rejectedSenders => {
					const tableEntries = rejectedSenders.map(rejectedSender => {
						const rejectDate = formatDateTime(new Date(generatedIdToTimestamp(getElementId(rejectedSender))))
						return {
							cells: () => {
								return [
									{
										main: rejectedSender.senderMailAddress,
										info: [`${rejectDate}, ${rejectedSender.senderHostname} (${rejectedSender.senderIp})`],
										click: () => showRejectedSendersInfoDialog(rejectedSender)
									}
								]
							},
							actionButtonAttrs: attachDropdown({
									label: "showMore_action",
									icon: () => Icons.More,
								},
								() => [
									{
										label: "showRejectReason_action",
										type: ButtonType.Dropdown,
										click: () => showRejectedSendersInfoDialog(rejectedSender)
									},
									{
										label: "addSpamRule_action",
										type: ButtonType.Dropdown,
										click: () => {
											const domainPart = getDomainPart(rejectedSender.senderMailAddress)
											showAddSpamRuleDialog(createEmailSenderListElement({
												value: domainPart ? domainPart : "",
												type: SpamRuleType.WHITELIST,
												field: SpamRuleFieldType.FROM,
											}))
										}
									},
								]
							)
						}
					})
					this.rejectedSenderLines(tableEntries)
				})
			showProgressDialog("loading_msg", loadingPromise).then(() => m.redraw())
		}
	}

	updateCustomerServerProperties(): Promise<void> {
		return worker.customerFacade.loadCustomerServerProperties().then(props => {
			this.props(props)
			this.props.map(props => this.currentPasswordUpdateValue(props.requirePasswordUpdateAfterReset))
			this.props.map(props => this.currentSaveIpAddressValue(props.saveEncryptedIpAddressInSession))
			const fieldToName = getSpamRuleFieldToName()
			this.spamRuleLines(props.emailSenderList.map((rule, index) => {
				return {
					cells: () => [
						{
							main: fieldToName[getSpamRuleField(rule)],
							info: [rule.value],
						},
						{
							main: neverNull(getSpamRuleTypeNameMapping().find(t => t.value === rule.type)).name,
						}
					],
					actionButtonAttrs: createRowActions({
						getArray: () => props.emailSenderList,
						updateInstance: () => update(props).catch(ofClass(LockedError, noOp))
					}, rule, index, [
						{
							label: "edit_action",
							click: () => showAddSpamRuleDialog(rule),
							type: ButtonType.Dropdown,
						}
					])
				}
			}))
			m.redraw()
		})
	}

	updateDomains(): Promise<void> {
		return this.customerInfo.getAsync().then(customerInfo => {
			let customDomainInfos = getCustomMailDomains(customerInfo)
			// remove dns status instances for all removed domains
			Object.keys(this.domainDnsStatus).forEach(domain => {
				if (!customDomainInfos.find(di => di.domain === domain)) {
					delete this.domainDnsStatus[domain]
				}
			})
			return promiseMap(customDomainInfos, domainInfo => {
				// create dns status instances for all new domains
				if (!this.domainDnsStatus[domainInfo.domain]) {
					this.domainDnsStatus[domainInfo.domain] = new DomainDnsStatus(domainInfo.domain)
					this.domainDnsStatus[domainInfo.domain].loadCurrentStatus().then(() => {
						m.redraw()
					})
				}
				let domainDnsStatus = this.domainDnsStatus[domainInfo.domain]
				let p = Promise.resolve(lang.get("comboBoxSelectionNone_msg"))
				if (domainInfo.catchAllMailGroup) {
					p = loadGroupDisplayName(domainInfo.catchAllMailGroup)
				}
				return p.then(catchAllGroupName => {
					return {
						cells: () => [
							{
								main: domainInfo.domain,
								info: [domainDnsStatus.getDnsStatusInfo()],
								click: (domainDnsStatus.status.isLoaded() && !domainDnsStatus.areAllRecordsFine()) ? () => {
									showDnsCheckDialog(domainDnsStatus)
								} : noOp
							},
							{
								main: catchAllGroupName,
							}
						],
						actionButtonAttrs: {
							label: "action_label",
							icon: () => Icons.More,
							click: createDropdown(() => (domainDnsStatus.status.isLoaded() && !domainDnsStatus.areAllRecordsFine() ? [
								{
									type: ButtonType.Dropdown,
									label: "resumeSetup_label",
									click: () => {
										showAddDomainWizard(domainDnsStatus.domain, customerInfo).then(() => {
											domainDnsStatus.loadCurrentStatus().then(() => m.redraw())
										})
									}
								}
							] : []).concat([
								{
									type: ButtonType.Dropdown,
									label: "setCatchAllMailbox_action",
									click: () => this.editCatchAllMailbox(domainInfo)
								},
								{
									type: ButtonType.Dropdown,
									label: "delete_action",
									click: () => this.deleteCustomDomain(domainInfo)
								}
							]), 260)
						}
					}
				})
			}).then(tableLines => {
				this.customDomainLines(tableLines)
				m.redraw()
			})
		})
	}

	deleteCustomDomain(domainInfo: DomainInfo) {
		Dialog.confirm(() => lang.get("confirmCustomDomainDeletion_msg", {"{domain}": domainInfo.domain}))
		      .then(confirmed => {
			      if (confirmed) {
				      worker.customerFacade.removeDomain(domainInfo.domain)
				            .catch(ofClass(PreconditionFailedError, e => {
					            let registrationDomains = this.props() != null ? this.props()
					                                                                 .whitelabelRegistrationDomains
					                                                                 .map(domainWrapper => domainWrapper.value) : []
					            if (registrationDomains.indexOf(domainInfo.domain) !== -1) {
						            Dialog.message(() => lang.get("customDomainDeletePreconditionWhitelabelFailed_msg", {"{domainName}": domainInfo.domain}))
					            } else {
						            Dialog.message(() => lang.get("customDomainDeletePreconditionFailed_msg", {"{domainName}": domainInfo.domain}))
					            }
				            }))
				            .catch(ofClass(LockedError, e => Dialog.message("operationStillActive_msg")))
			      }
		      })
	}

	editCatchAllMailbox(domainInfo: DomainInfo) {
		showProgressDialog("pleaseWait_msg", load(CustomerTypeRef, neverNull(logins.getUserController().user.customer))
			.then(customer => {
				return loadEnabledTeamMailGroups(customer)
					.then(teamMailGroups => loadEnabledUserMailGroups(customer)
						.then(userMailGroups => {
							let allMailGroups = teamMailGroups.concat(userMailGroups)
							let options = [
								{name: lang.get("comboBoxSelectionNone_msg"), value: null}
							].concat(allMailGroups.map(groupData => {
								return {name: groupData.displayName, value: groupData.groupId}
							}))
							let selectedPromise = Promise.resolve(null) // default is no selection
							if (domainInfo.catchAllMailGroup) {
								// the catch all group may be a user group, so load the mail group in that case
								selectedPromise = load(GroupTypeRef, domainInfo.catchAllMailGroup)
									.then(catchAllGroup => {
										if (catchAllGroup.type === GroupType.User) {
											return load(UserTypeRef, neverNull(catchAllGroup.user))
												.then(user => {
													return getUserGroupMemberships(user, GroupType.Mail)[0].group // the first is the users personal mail group
												})
										} else {
											return domainInfo.catchAllMailGroup
										}
									})
							}
							return selectedPromise.then(catchAllMailGroupId => {
								let selected = allMailGroups.find(g => g.groupId
									=== catchAllMailGroupId)
								return {available: options, selected: selected}
							})
						})
					)
			})
		).then(availableAndSelectedGroupDatas => {
			const valueStream = stream(availableAndSelectedGroupDatas.selected ? availableAndSelectedGroupDatas.selected.groupId : null)
			return Dialog.showDropDownSelectionDialog("setCatchAllMailbox_action", "catchAllMailbox_label", null, availableAndSelectedGroupDatas.available, valueStream, 250)
			             .then(selectedMailGroupId => {
				             return worker.customerFacade.setCatchAllGroup(domainInfo.domain, selectedMailGroupId)
			             })
		})
	}

	updateAuditLog(): Promise<void> {
		return load(CustomerTypeRef, neverNull(logins.getUserController().user.customer)).then(customer => {
			this.customer(customer)
			return loadRange(AuditLogEntryTypeRef, neverNull(customer.auditLog).items, GENERATED_MAX_ID, 200, true)
				.then(auditLog => {
					this.auditLogLines(auditLog.map(auditLogEntry => {
						return {
							cells: [auditLogEntry.action, auditLogEntry.modifiedEntity, formatDateTimeFromYesterdayOn(auditLogEntry.date)],
							actionButtonAttrs: {
								label: "showMore_action",
								icon: () => Icons.More,
								click: () => this.showAuditLogDetails(auditLogEntry, customer)
							}
						}
					}))
				})
		})
	}

	showAuditLogDetails(entry: AuditLogEntry, customer: Customer) {
		let modifiedGroupInfo: Stream<GroupInfo> = stream()
		let groupInfo = stream()
		let groupInfoLoadingPromises = []
		if (entry.modifiedGroupInfo) {
			groupInfoLoadingPromises.push(load(GroupInfoTypeRef, entry.modifiedGroupInfo)
				.then(gi => {
					modifiedGroupInfo(gi)
				})
				.catch(ofClass(NotAuthorizedError, e => {
					// If the admin is removed from the free group, he does not have the permission to access the groupinfo of that group anymore
				})))
		}
		if (entry.groupInfo) {
			groupInfoLoadingPromises.push(load(GroupInfoTypeRef, entry.groupInfo).then(gi => {
				groupInfo(gi)
			}).catch(ofClass(NotAuthorizedError, e => {
				// If the admin is removed from the free group, he does not have the permission to access the groupinfo of that group anymore
			})))
		}
		Promise.all(groupInfoLoadingPromises).then(() => {
			let dialog = Dialog.showActionDialog({
				title: lang.get("auditLog_title"),
				child: {
					view: () => m("table.pt", [
						m("tr", [
							m("td", lang.get("action_label")),
							m("td.pl", entry.action)
						]),
						m("tr", [
							m("td", lang.get("actor_label")),
							m("td.pl", entry.actorMailAddress)
						]),
						m("tr", [
							m("td", lang.get("IpAddress_label")),
							m("td.pl", entry.actorIpAddress ? entry.actorIpAddress : "")
						]),
						m("tr", [
							m("td", lang.get("modified_label")),
							m("td.pl", (modifiedGroupInfo()
								&& this.getGroupInfoDisplayText(modifiedGroupInfo()))
								? this.getGroupInfoDisplayText(modifiedGroupInfo())
								: entry.modifiedEntity),
						]),
						groupInfo() ? m("tr", [
							m("td", lang.get("group_label")),
							m("td.pl", customer.adminGroup === groupInfo().group
								? lang.get("globalAdmin_label")
								: this.getGroupInfoDisplayText(groupInfo())),
						]) : null,
						m("tr", [
							m("td", lang.get("time_label")),
							m("td.pl", formatDateTime(entry.date)),
						]),
					])
				},
				allowOkWithReturn: true,
				okAction: () => dialog.close(),
				allowCancel: false
			})
		})
	}

	getGroupInfoDisplayText(groupInfo: GroupInfo): string {
		if (groupInfo.name && groupInfo.mailAddress) {
			return groupInfo.name + " <" + groupInfo.mailAddress + ">"
		} else if (groupInfo.mailAddress) {
			return groupInfo.mailAddress
		} else {
			return groupInfo.name
		}
	}

	entityEventReceived(updates: $ReadOnlyArray<EntityUpdateData>, eventOwnerGroupId: Id): Promise<mixed> {
		return promiseMap(updates, update => {
			console.log("GlobalSettingsSection: entityEventReceived:")
			if (isUpdateForTypeRef(CustomerServerPropertiesTypeRef, update) && update.operation === OperationType.UPDATE) {
				return this.updateCustomerServerProperties()
			} else if (isUpdateForTypeRef(AuditLogEntryTypeRef, update)) {
				return this.updateAuditLog()
			} else if (isUpdateForTypeRef(CustomerInfoTypeRef, update) && update.operation === OperationType.UPDATE) {
				this.customerInfo.reset()
				return this.updateDomains()
			}
		}).then(noOp)
	}
}